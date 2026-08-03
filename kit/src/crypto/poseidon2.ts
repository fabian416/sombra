/**
 * The protocol's Poseidon2 surface — DESIGN.md §2.5, SDK.md §4.3.
 *
 * The raw width-4 BN254 permutation comes from `@zkpassport/poseidon2`, which
 * carries Barretenberg's round constants and matrices. Everything above the
 * permutation — the sponge, the IV placement, the padding rule, the two-lane
 * squeeze, and the domain-tagged funnel — is implemented here against the
 * normative text, because that layer is where the protocol makes choices that
 * a generic Poseidon2 library has no reason to share.
 *
 * The sponge (DESIGN.md §2.5), verbatim:
 *
 *   1. `M` = number of absorbed elements, **counting the leading domain tag**.
 *      `iv = M * 2^64`.
 *   2. state = `[0, 0, 0, iv]` — the IV sits in the capacity lane, state[3].
 *   3. Per full block of three inputs: **add** into lanes 0..2 (addition in
 *      F_r, not assignment), then permute.
 *   4. A trailing partial block is added in and permuted once more. This also
 *      happens when `M = 0`, so the empty input does not hash to zero.
 *   5. Output state[0].
 *
 * Step 3's "add, not assign" is the detail worth naming: with a single block
 * the two are indistinguishable, so an implementation that assigns passes
 * every fixture here (all of which are one block) and diverges only on longer
 * inputs. It is written as addition because the spec says addition.
 */
import { permute } from "@zkpassport/poseidon2";

import { FR, frMod, frSub } from "./field.js";

/**
 * Domain separation tags, DESIGN_cont.md §13. That table is the only
 * authoritative source and implementations MUST hardcode these exact values;
 * the binding is positional and the numbers carry no meaning.
 */
export const DOMAIN = {
  /** Address compression (§2.7). Absorbed on-chain by the contract. */
  ADDRESS: 1n,
  /** Viewing key from spending key (§4.2). */
  VK: 2n,
  /** Delegation viewing key (§4.4). */
  DVK: 3n,
  /** Deterministic randomness for the spendable balance (§5.2). */
  SPEND_R: 4n,
  /** ECDH-derived transfer blinding (§5.3). */
  TRANSFER_BLINDING: 5n,
  /** ECDH-derived transfer amount encryption (§5.3). */
  TRANSFER_AMOUNT: 6n,
  /** Encrypted balance scalar (§5.5) — the checkpoint mask. */
  ENC_BAL: 7n,
  /** Encrypted allowance scalar (§6.2). */
  ENC_ALLOW: 8n,
  /** Deterministic randomness for allowance commitments (§6.2). */
  ALLOW_R: 9n,
  /** Delegation key escrow (§7.11). */
  ESC_DVK: 10n,
  /** Sender/owner-auditor channel sponge (§8.1). Two-mask mode. */
  AUDITOR_SENDER: 11n,
  /** Recipient-auditor channel sponge (§8.1). Two-mask mode. */
  AUDITOR_RECIPIENT: 12n,
  /** ECDH shared-secret extraction (§2.4). */
  ECDH: 13n,
  /** Deterministic ephemeral scalar (§5.3). Derived off-circuit. */
  EPHEMERAL: 14n,
  /** Disclosure binding, aggregate variant. Off-chain layer. */
  DISCLOSURE_BIND: 15n,
  /** Disclosure ciphertext. Off-chain layer. */
  DISCLOSURE: 16n,
} as const;

/**
 * The bare sponge of DESIGN.md §2.5 over an already-assembled input vector.
 *
 * Callers should reach for {@link poseidonWithDomain} instead; this is
 * exported because the fixture suite pins the sponge itself.
 */
export function sponge(inputs: readonly bigint[]): bigint {
  const state = spongeState(inputs);
  return state[0]!;
}

/**
 * Run the sponge and return the whole final state, so the two-lane squeeze of
 * §2.5 can read lane 1 without a second permutation.
 */
function spongeState(inputs: readonly bigint[]): bigint[] {
  const m = inputs.length;
  // The IV lives in the capacity lane and encodes the absorbed length, which
  // is what makes `[a, b]` and `[a, b, 0]` hash differently.
  let state: bigint[] = [0n, 0n, 0n, BigInt(m) * (1n << 64n)];

  // Strictly greater, not >=: the last block is always absorbed by the
  // trailing step below, whether it is full or partial. Absorbing it here
  // instead would permute once more than the construction calls for, and the
  // total permutation count is ceil(M/3) with a floor of one.
  let i = 0;
  while (m - i > 3) {
    for (let lane = 0; lane < 3; lane++) {
      state[lane] = frMod(state[lane]! + frMod(inputs[i + lane]!));
    }
    state = permute(state);
    i += 3;
  }

  // The trailing permutation is unconditional, which is what gives the empty
  // input a nonzero hash (`permute([0,0,0,0])[0]`) rather than zero.
  for (let lane = 0; i < m; lane++, i++) {
    state[lane] = frMod(state[lane]! + frMod(inputs[i]!));
  }
  return permute(state);
}

/**
 * The single Poseidon2 entry point of SDK.md §4.3: the domain tag is the
 * **first absorbed element**, so it is counted in `M` and shifts every
 * subsequent input by one lane.
 */
export function poseidonWithDomain(domain: bigint, inputs: readonly bigint[]): bigint {
  return sponge([domain, ...inputs]);
}

/**
 * The two-mask form, DESIGN.md §2.5 *Two-mask mode*.
 *
 * `(δ, s, σ)` is exactly one rate-3 block, so the two masks are two lanes of a
 * **single** permutation output rather than two sequential squeezes. Lane 0 is
 * always an amount mask; lane 1 is always a balance / allowance / randomness
 * mask. Single-ciphertext channels take lane 1 and leave lane 0 unused, so a
 * checkpoint pad can never coincide with an amount pad.
 *
 * Mode exclusivity (§2.5) is why this is not just a convenience wrapper:
 * `spongeSqueeze2(δ, s, σ)[0]` is the *same field element* as
 * `poseidonWithDomain(δ, [s, σ])`, so a tag used in both modes would leak one
 * mode's mask as the other's output. Tags 11 and 12 are the only two-mask
 * tags in the protocol.
 */
export function spongeSqueeze2(domain: bigint, s: bigint, sigma: bigint): [bigint, bigint] {
  const state = spongeState([domain, s, sigma]);
  return [state[0]!, state[1]!];
}

// ------------------------------------------------------------ key derivation

/** `vk = Poseidon2(δ_vk, sk, addr_f)` — DESIGN.md §4.2. */
export function vkFromSk(sk: bigint, addrF: bigint): bigint {
  return poseidonWithDomain(DOMAIN.VK, [sk, addrF]);
}

/** `dvk_i = Poseidon2(δ_dvk, vk, op_i)` — DESIGN.md §4.4. */
export function dvkFromVkOp(vk: bigint, opI: bigint): bigint {
  return poseidonWithDomain(DOMAIN.DVK, [vk, opI]);
}

/** `r' = Poseidon2(δ_spend_r, vk, σ)` — DESIGN.md §5.2. */
export function deriveSpendR(vk: bigint, sigma: bigint): bigint {
  return poseidonWithDomain(DOMAIN.SPEND_R, [vk, sigma]);
}

/** `r_a = Poseidon2(δ_allow_r, dvk, σ_a)` — DESIGN.md §6.2. */
export function deriveAllowR(dvk: bigint, sigmaA: bigint): bigint {
  return poseidonWithDomain(DOMAIN.ALLOW_R, [dvk, sigmaA]);
}

/** `r_e = Poseidon2(δ_eph, vk, σ)` — DESIGN.md §5.3. */
export function deriveEphemeralScalar(vk: bigint, sigma: bigint): bigint {
  return poseidonWithDomain(DOMAIN.EPHEMERAL, [vk, sigma]);
}

// ------------------------------------------------------- the two decrypt rules
//
// Both are additive one-time pads over F_r, so decryption is the same sponge
// call and a subtraction. They are the whole of what recovery needs from the
// encryption layer: rule one opens the checkpoint's spendable balance, rule
// two opens an incoming transfer.

/** `b̃ = v_new + Poseidon2(δ_enc_bal, vk, σ)` — DESIGN.md §5.5. */
export function encryptBalance(vNew: bigint, vk: bigint, sigma: bigint): bigint {
  return frMod(vNew + poseidonWithDomain(DOMAIN.ENC_BAL, [vk, sigma]));
}

/**
 * Rule 1 — the checkpoint rule. `v_s = b̃ − Poseidon2(δ_enc_bal, vk, σ)`.
 * DESIGN.md §5.2 recovery step 2. Needs only `vk` and the event.
 */
export function decryptBalance(bTilde: bigint, vk: bigint, sigma: bigint): bigint {
  return frSub(bTilde, poseidonWithDomain(DOMAIN.ENC_BAL, [vk, sigma]));
}

/** `ṽ = v_transfer + Poseidon2(δ_transfer_amount, s, σ)` — DESIGN.md §5.3. */
export function encryptAmount(vTransfer: bigint, s: bigint, sigma: bigint): bigint {
  return frMod(vTransfer + poseidonWithDomain(DOMAIN.TRANSFER_AMOUNT, [s, sigma]));
}

/**
 * Rule 2 — the incoming-transfer rule.
 * `v_transfer = ṽ − Poseidon2(δ_transfer_amount, s, σ)`, DESIGN.md §5.2 step 6,
 * where `s` is the ECDH scalar the recipient derives from its own `vk` and the
 * event's `R_e`.
 */
export function decryptAmount(vTilde: bigint, s: bigint, sigma: bigint): bigint {
  return frSub(vTilde, poseidonWithDomain(DOMAIN.TRANSFER_AMOUNT, [s, sigma]));
}

/**
 * The blinding half of rule 2: `r_transfer = Poseidon2(δ_transfer_blind, s, σ)`.
 * DESIGN.md §5.4 constrains the sender to have used exactly this value, which
 * is what stops a malicious sender from poisoning the recipient's accumulator.
 */
export function deriveTransferBlinding(s: bigint, sigma: bigint): bigint {
  return poseidonWithDomain(DOMAIN.TRANSFER_BLINDING, [s, sigma]);
}

/** `ã = v_a + Poseidon2(δ_enc_allow, dvk, σ_a)` — DESIGN.md §6.2. */
export function encryptAllowance(vA: bigint, dvk: bigint, sigmaA: bigint): bigint {
  return frMod(vA + poseidonWithDomain(DOMAIN.ENC_ALLOW, [dvk, sigmaA]));
}

/** `escrowed_dvk = dvk + Poseidon2(δ_esc_dvk, s, op_i)` — DESIGN.md §7.11. */
export function encryptEscrowedDvk(dvk: bigint, s: bigint, opI: bigint): bigint {
  return frMod(dvk + poseidonWithDomain(DOMAIN.ESC_DVK, [s, opI]));
}

/**
 * The sender-auditor balance checkpoint, DESIGN.md W_a3/W_a4:
 * `b̃_aud_s = v_new + SpongeSqueeze_2(δ_aud_s, s_a_s, σ)[1]`.
 *
 * Lane **1**, not lane 0 — see {@link spongeSqueeze2}.
 */
export function encryptAuditorSenderBalance(vNew: bigint, sAudS: bigint, sigma: bigint): bigint {
  return frMod(vNew + spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sAudS, sigma)[1]);
}

/** Re-export for callers that want the modulus without importing field.js. */
export const POSEIDON_FIELD = FR;
