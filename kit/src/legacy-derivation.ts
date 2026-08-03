/**
 * The **non-normative** derivation two superseded demo accounts are bound to.
 *
 * This file is separate from `keys.ts` so the specification-conformant path
 * stays uncontaminated and a reviewer can see at a glance which is which.
 * Nothing here is presented as SDK.md §5; it exists because of a fact about the
 * chain that no amount of correct code can undo.
 *
 * **What happened.** An earlier pass of `scripts/` derived two accounts'
 * spending keys as `sk = SHA-512(SEP-0053 signature) mod r` over a
 * Sombra-specific message — the shape the CT demo app uses
 * (`INTEGRATION.md:84-92` flags the fork), not the shape SDK.md §5.1
 * specifies. Those accounts are registered on testnet, and `register` is
 * **single-use**: the enrolled `Y = sk·H` is fixed on-chain forever. SDK.md
 * §5's opening paragraph is about exactly this hazard, and it is unrepairable
 * by fixing the client.
 *
 * The demo has since been re-cut against §5.1 with fresh accounts, and
 * `deployment.json` lists the originals under `supersededAccounts`. So this
 * module is no longer on the demo path:
 *
 *   - `keys.ts` — SDK.md §5.1 + §5.2. The conformance surface, and what every
 *     account the live demo uses is enrolled under.
 *   - this file — the only way to reach the two superseded accounts, whose
 *     events are still on-chain and still in the archive.
 *
 * The distinction is carried in the type system: {@link ConfidentialKeys.rootForm}
 * is `"legacy-demo"` for anything produced here, and SDK.md §5.3 makes
 * recording which form produced `sk` a MUST precisely so a user is never shown
 * a recovery affordance their account's form cannot satisfy.
 *
 * Do not extend this file, and do not reach for it by default. It exists so
 * that two abandoned accounts remain reachable, not as an alternative to §5.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";

import { addressToField, decodeStrkey } from "./crypto/address.js";
import { bytesEqual, frMod, fromBytesBE } from "./crypto/field.js";
import { publicViewingKey, spendingPublicKey } from "./crypto/grumpkin.js";
import { vkFromSk } from "./crypto/poseidon2.js";
import { type ConfidentialKeys, type MessageSigner, sep53Digest } from "./keys.js";

/**
 * The message `scripts/common.ts` signs. Reproduced here byte-for-byte — the
 * em dash, the blank lines and the trailing field order are all load-bearing,
 * since a single differing byte yields a different signature and therefore a
 * different account.
 */
export function demoSignerMessage(networkPassphrase: string, contractId: string): string {
  return [
    "Sombra — confidential key derivation v1",
    "",
    "Signing this message derives your confidential spending key.",
    "",
    `Network: ${networkPassphrase}`,
    `Token contract: ${contractId}`,
  ].join("\n");
}

export interface DemoDerivationContext {
  contractId: string;
  account: string;
  networkPassphrase: string;
}

/**
 * `sk = SHA-512(signature) mod r`, then the DESIGN.md §4 hierarchy above it.
 *
 * The hierarchy below `sk` is *not* legacy — `vk = Poseidon2(δ_vk, sk, addr_f)`,
 * `Y = sk·H`, `PVK = vk·H` are normative and identical in both paths. Only the
 * step that produces `sk` differs.
 *
 * Note the modulo bias: folding 64 hash bytes into F_r by reduction is not
 * uniform, unlike §5.1's rejection sampling. Harmless at this scale, and a
 * reason the spec does it the other way.
 */
export function demoKeysFromSignature(
  signature: Uint8Array,
  ctx: DemoDerivationContext,
): ConfidentialKeys {
  const sk = frMod(fromBytesBE(sha512(signature)));
  if (sk === 0n) throw new Error("degenerate key derivation (zero scalar)");
  const addrF = addressToField(ctx.contractId);
  const vk = vkFromSk(sk, addrF);
  return {
    sk,
    vk,
    Y: spendingPublicKey(sk),
    PVK: publicViewingKey(vk),
    addrF,
    acctF: addressToField(ctx.account),
    rejectionCounter: 0,
    rootForm: "legacy-demo",
  };
}

/**
 * The full legacy flow from a signer.
 *
 * The §5.2 signature-verification MUST is honoured even here — it costs one
 * verification and it is the only thing standing between a user and a wallet
 * that had a *different account selected* returning a well-formed signature
 * over the same message, yielding a wrong but entirely usable `sk`.
 */
export async function demoKeysFromSigner(
  signer: MessageSigner,
  ctx: DemoDerivationContext,
): Promise<ConfidentialKeys> {
  const expected = decodeStrkey(signer.publicKey);
  const message = demoSignerMessage(ctx.networkPassphrase, ctx.contractId);
  const signature = await signer.signMessage(message);
  if (signature.length !== 64) {
    throw new Error(`expected a 64-byte ed25519 signature, got ${signature.length} bytes`);
  }
  if (!ed25519.verify(signature, sep53Digest(message), expected.payload)) {
    throw new Error(`signature does not verify against ${signer.publicKey}`);
  }
  const keys = demoKeysFromSignature(signature, ctx);
  return { ...keys, enrolledSigner: signer.publicKey };
}

/** From a raw 32-byte ed25519 seed, for Node-side tooling and tests. */
export async function demoKeysFromEd25519Secret(
  secretKey: Uint8Array,
  ctx: DemoDerivationContext,
): Promise<ConfidentialKeys> {
  const pub = ed25519.getPublicKey(secretKey);
  if (!bytesEqual(pub, decodeStrkey(ctx.account).payload)) {
    throw new Error("the supplied ed25519 secret does not control ctx.account");
  }
  const message = demoSignerMessage(ctx.networkPassphrase, ctx.contractId);
  return demoKeysFromSignature(ed25519.sign(sep53Digest(message), secretKey), ctx);
}
