/**
 * Normative confidential-key derivation — SDK.md §5.1 + §5.2.
 *
 * DESIGN.md §4 specifies the hierarchy *below* `sk`: `vk` from `(sk, addr_f)`,
 * `Y = sk·H`, `PVK = vk·H`. It does not say where `sk` itself comes from.
 * SDK.md §5 supplies that, and the reason it is normative rather than advisory
 * is the reason this file cannot take a shortcut: two clients given the same
 * backup material would otherwise derive different accounts, and `register` is
 * single-use (DESIGN_cont.md §11), so the divergence is **unrepairable**. An
 * account enrolled under the wrong derivation is not fixed by later correcting
 * the code — the address is burned and remediation means registering a fresh
 * one and transferring the funds out.
 *
 * The chain implemented here:
 *
 *   msg  = "openzeppelin/confidential-token/v1/sk" ‖ 0x0a ‖ enc(contract) ‖ 0x0a ‖ enc(account)
 *   root = Ed25519-Sign(sk_ed, SHA-256("Stellar Signed Message:\n" ‖ msg))    §5.2, 64 bytes
 *   sk   = RS(HKDF-SHA-512(IKM  = root,
 *                          salt = "openzeppelin/confidential-token/v1/sk",
 *                          info = be32(addr_f) ‖ be32(acct_f) ‖ le4(j)))      §5.1
 *   vk   = Poseidon2(δ_vk, [sk, addr_f]);  Y = sk·H;  PVK = vk·H              DESIGN.md §4
 *
 * This deliberately does **not** implement the CT demo app's
 * `sk = SHA-512(signature) mod r`. Both fold the same SEP-0053 signature, and
 * they produce different keys; only one of them is the specification. The
 * shortcut additionally omits `acct_f`, so one signer registering two addresses
 * would publish an identical `PVK` under both — a public link between two
 * addresses that are otherwise unlinkable (§5.1, *Bound to acct_f*).
 *
 * Everything below `sk` is delegated to `@ctd/sdk`'s `deriveKeys`, so the
 * Poseidon2 and Grumpkin implementations that generate proofs here are the same
 * ones the on-chain verifier was tested against. Only the §5 layer — the layer
 * the SDK leaves to its caller — is implemented here.
 *
 * `sombra-kit` implements the identical spec browser-side in `kit/src/keys.ts`
 * against an independent crypto core (@noble + @zkpassport/poseidon2). Since a
 * mismatch between the two is exactly the unrepairable failure §5 exists to
 * prevent, `--parity` executes both over the shared vector below.
 *
 * Usage:
 *   tsx derive.ts             print the parity vector
 *   tsx derive.ts --parity    also run kit/src/keys.ts over it and compare
 */

import { createHash, hkdfSync } from "node:crypto";

import { Keypair } from "@stellar/stellar-sdk";
import {
  FR_MODULUS,
  addressToField,
  deriveKeys,
  fromBytesBE,
  toBytes32BE,
  toHex32,
  type KeyPair,
} from "@ctd/sdk";

import type { AccountVector, KeyDerivationRecord } from "./common.js";

/** Public derivation outputs for one account, for `deployment.json`. */
export function accountVector(label: string, keys: NormativeKeys, account: string): AccountVector {
  return {
    label,
    account,
    acctF: toHex32(keys.acctF),
    rejectionCounter: keys.rejectionCounter,
    rootForm: keys.rootForm,
    Y: [toHex32(keys.Y.x), toHex32(keys.Y.y)],
    PVK: [toHex32(keys.PVK.x), toHex32(keys.PVK.y)],
  };
}

/**
 * The §5.1 HKDF salt and the §5.2 message label are the same ASCII string.
 * It is a protocol constant: changing it changes every account's `sk`.
 */
export const SK_LABEL = "openzeppelin/confidential-token/v1/sk";

/** SEP-0053's 24-byte signing-domain prefix. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

/** Length of the §5.2 message: 37 + 1 + 56 + 1 + 56. */
export const SIGNER_MESSAGE_LENGTH = 151;

/** Guard against an unbounded loop if the root is somehow pathological. */
const MAX_REJECTIONS = 256;

/**
 * Which §5 form produced `sk`. §5.3 makes recording this a MUST: the three
 * forms differ in what regenerates the key — a live signer, a stored 32-byte
 * value, or nothing beyond the stored `sk` — so a user must not be offered a
 * recovery affordance their account's form cannot satisfy.
 */
export type RootForm = "signer" | "raw" | "import";

export interface DerivationContext {
  /** The confidential token contract, `C…`. */
  contractId: string;
  /** The address being registered / recovered, `G…` or `C…`. */
  account: string;
}

/** `@ctd/sdk`'s DESIGN.md §4 key set, plus what §5 additionally pins down. */
export interface NormativeKeys extends KeyPair {
  /** `address_to_field` of the account — §5.1's `acct_f`, absent from `KeyPair`. */
  acctF: bigint;
  /** The rejection counter `j` that produced this key. Almost always 0. */
  rejectionCounter: number;
  /** Which §5 form produced `sk`. */
  rootForm: RootForm;
  /**
   * The ed25519 public key that signed the §5.2 message, when the form is
   * `signer`. §5.2 requires recording it: `sk` is keyed to the *address*
   * through `acct_f`, not to the key that signed for it, so which signer
   * enrolled an account is not recoverable from chain state.
   */
  enrolledSigner?: string;
}

// --------------------------------------------------------- §5.2 the message

/**
 * The §5.2 message. It carries the two **strkeys** rather than their §4.9
 * compressions so that a wallet rendering a SEP-0053 message as text shows the
 * user addresses they can compare against the deployment they intend to
 * register on.
 *
 * Binding both addresses into the message — rather than relying on §5.1's
 * `info` alone — is what bounds a harvested signature: a dapp that tricks a
 * user into signing once obtains the root for *that* account on *that*
 * deployment, not for every account the key controls everywhere.
 */
export function signerMessage(ctx: DerivationContext): string {
  if (!/^C[A-Z2-7]{55}$/.test(ctx.contractId)) {
    throw new Error(`contractId must be a 56-character C… strkey, got ${ctx.contractId}`);
  }
  if (!/^[GC][A-Z2-7]{55}$/.test(ctx.account)) {
    throw new Error(`account must be a 56-character G… or C… strkey, got ${ctx.account}`);
  }
  const msg = `${SK_LABEL}\n${ctx.contractId}\n${ctx.account}`;
  if (msg.length !== SIGNER_MESSAGE_LENGTH) {
    throw new Error(`§5.2 message must be ${SIGNER_MESSAGE_LENGTH} bytes, built ${msg.length}`);
  }
  return msg;
}

/**
 * The SEP-0053 preimage: `SHA-256(prefix ‖ msg)`. This is the digest an
 * ed25519 signer actually signs — a wallet's `signMessage` computes it
 * internally, and this is exported so a caller holding a raw secret reproduces
 * identical bytes.
 */
export function sep53Digest(message: string | Uint8Array): Uint8Array {
  const body = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const payload = Buffer.concat([Buffer.from(SEP53_PREFIX, "utf8"), Buffer.from(body)]);
  return new Uint8Array(createHash("sha256").update(payload).digest());
}

/**
 * A SEP-0053 message signer. A local keypair, Freighter, or a hardware wallet
 * all fit behind this; `signMessage` returns the 64-byte RFC 8032 signature
 * `R ‖ S` over `SHA-256(prefix ‖ message)`.
 */
export interface MessageSigner {
  /** The `G…` address expected to have signed. */
  publicKey: string;
  signMessage(message: string): Promise<Uint8Array>;
}

/** A local-secret signer, for these scripts and for the parity vector. */
export function keypairMessageSigner(kp: Keypair): MessageSigner {
  return {
    publicKey: kp.publicKey(),
    async signMessage(message: string) {
      return new Uint8Array(kp.sign(Buffer.from(sep53Digest(message))));
    },
  };
}

// ------------------------------------------------------------- §5.1 the KDF

/** 4-byte little-endian encoding of the rejection counter `j`. */
function le4(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, true);
  return out;
}

/**
 * §5.1's `RS`: §4.7's rejection procedure applied to a derived 32 bytes rather
 * than to a CSPRNG draw. Clearing the top **2** bits yields a 254-bit
 * candidate; `r` is just under 2^254, so a retry is unlikely but real, and `j`
 * is a genuine code path rather than a formality.
 */
function rejectionSample(okm: Uint8Array): bigint | null {
  const candidate = fromBytesBE(okm) & ((1n << 254n) - 1n);
  if (candidate === 0n || candidate >= FR_MODULUS) return null;
  return candidate;
}

/**
 * The §5.1 derivation from an already-obtained root.
 *
 * `root` is the raw IKM — the 64 signature bytes of §5.2 or the 32 raw bytes of
 * §5.3, verbatim. HKDF-Extract accepts input keying material of any length, so
 * nothing is hashed or truncated on the way in.
 */
export function deriveFromRoot(
  root: Uint8Array,
  ctx: DerivationContext,
  form: RootForm = "raw",
): NormativeKeys {
  const addrF = addressToField(ctx.contractId);
  const acctF = addressToField(ctx.account);
  const salt = new TextEncoder().encode(SK_LABEL);
  const addrBytes = toBytes32BE(addrF);
  const acctBytes = toBytes32BE(acctF);

  for (let j = 0; j < MAX_REJECTIONS; j++) {
    const info = Buffer.concat([Buffer.from(addrBytes), Buffer.from(acctBytes), Buffer.from(le4(j))]);
    const okm = new Uint8Array(hkdfSync("sha512", root, salt, info, 32));
    const sk = rejectionSample(okm);
    if (sk === null) continue;

    // Registration constraint R5 requires vk ≠ 0, so a candidate whose vk
    // collapses is rejected here rather than at registration. Astronomically
    // unlikely; cheap to honour, and `register` gets no second attempt.
    const keys = deriveKeys(sk, addrF);
    if (keys.vk === 0n) continue;

    return { ...keys, acctF, rejectionCounter: j, rootForm: form };
  }
  throw new Error(`§5.1 rejection sampling failed ${MAX_REJECTIONS} times — the root is almost certainly wrong`);
}

/**
 * §5.3 raw root: exactly 32 bytes from whatever custody mechanism controls the
 * address. Required for contract addresses, for signers with no SEP-0053 path,
 * and as the explicit-backup fallback.
 */
export function deriveFromRawRoot(root: Uint8Array, ctx: DerivationContext): NormativeKeys {
  if (root.length !== 32) throw new Error(`a §5.3 raw root is 32 bytes, got ${root.length}`);
  return deriveFromRoot(root, ctx, "raw");
}

// ---------------------------------------------------- §5.2 the signer protocol

export interface SignerDerivationOptions {
  /**
   * Obtain the signature twice from independent invocations and abort if they
   * differ (§5.2). Defaults to on. Skipped only for a local RFC 8032 keypair,
   * where determinism holds by construction and the second call would be
   * checking this process against itself.
   */
  verifyDeterminism?: boolean;
}

/**
 * The full §5.2 flow: message → signature → verification → §5.1 → key set.
 *
 * Three MUSTs are enforced here:
 *
 *  1. **Verify the signature against the expected signer.** A wallet with a
 *     *different account selected* returns a perfectly well-formed signature
 *     over the same message, yielding a wrong but entirely usable `sk`:
 *     registration succeeds, and the account is then unreproducible from the
 *     key the user believes controls it. This check is the only thing standing
 *     between a user and that outcome, which is why §5.2 says a `Y` mismatch
 *     must be read as "this account uses a root I do not hold" rather than as a
 *     derivation defect.
 *  2. **Sign twice from independent invocations.** RFC 8032 ed25519 is
 *     deterministic, but threshold and MPC signers randomise the nonce per
 *     session and simply do not reproduce.
 *  3. **Record the enrolled signer**, since it is not recoverable from the
 *     address or from chain state.
 */
export async function deriveFromSigner(
  signer: MessageSigner,
  ctx: DerivationContext,
  options: SignerDerivationOptions = {},
): Promise<NormativeKeys> {
  const message = signerMessage(ctx);
  const root = await signer.signMessage(message);
  if (root.length !== 64) {
    throw new Error(`a §5.2 root is a 64-byte ed25519 signature, got ${root.length} bytes`);
  }

  const digest = Buffer.from(sep53Digest(message));
  if (!Keypair.fromPublicKey(signer.publicKey).verify(digest, Buffer.from(root))) {
    throw new Error(
      `signature does not verify against ${signer.publicKey} — the signer holds a different key ` +
        "than the one this account is being derived for (SDK.md §5.2)",
    );
  }

  if (options.verifyDeterminism !== false) {
    const again = await signer.signMessage(message);
    if (Buffer.compare(Buffer.from(root), Buffer.from(again)) !== 0) {
      throw new Error(
        "the signer returned two different signatures for the same message — its nonce is " +
          "randomised (threshold/MPC ed25519), so this root will not reproduce and the account " +
          "would be unrecoverable. Use a raw root (SDK.md §5.3) and back it up explicitly.",
      );
    }
  }

  const keys = deriveFromRoot(root, ctx, "signer");
  return { ...keys, enrolledSigner: signer.publicKey };
}

/**
 * Node-side convenience for a caller holding the Stellar secret.
 *
 * §5.2 requires the SEP-0053 envelope **even where the secret is extractable**:
 * a client holding the raw secret MUST compute this signature rather than use
 * the secret's 32 bytes as IKM directly. That is what makes one form cover both
 * custody shapes — an account enrolled through a wallet prompt is reproducible
 * by a client that later imports the secret, and the reverse. Which is the
 * whole point for Sombra: these scripts enrol the accounts, and the browser
 * wallet has to arrive at the same `sk` from a Freighter prompt alone.
 */
export function deriveForAccount(kp: Keypair, contractId: string): Promise<NormativeKeys> {
  return deriveFromSigner(
    keypairMessageSigner(kp),
    { contractId, account: kp.publicKey() },
    { verifyDeterminism: false },
  );
}

/**
 * §5.3 direct import of a previously exported `sk` — the only path that
 * recovers an account whose root is neither held nor reproducible.
 */
export function keysFromSpendingKey(sk: bigint, ctx: DerivationContext): NormativeKeys {
  if (sk <= 0n || sk >= FR_MODULUS) throw new Error("sk must be a nonzero canonical F_r element");
  const keys = deriveKeys(sk, addressToField(ctx.contractId));
  if (keys.vk === 0n) throw new Error("degenerate key: vk = 0 violates registration constraint R5");
  return {
    ...keys,
    acctF: addressToField(ctx.account),
    rejectionCounter: 0,
    rootForm: "import",
  };
}

// ------------------------------------------------------------- parity vector

/**
 * A fixed, published input for cross-implementation comparison. The seed is a
 * constant — 32 bytes of 0x01 — not an account anyone funds, so the vector can
 * live in `deployment.json` and in `kit`'s test fixtures without disclosing
 * anything. The contract is the real deployment, because `addr_f` is an input
 * to both the message and the KDF's `info` and a vector that fakes it would not
 * exercise the binding.
 */
export const PARITY_SEED = new Uint8Array(32).fill(1);

export function parityVector(contractId: string) {
  const kp = Keypair.fromRawEd25519Seed(Buffer.from(PARITY_SEED));
  const ctx: DerivationContext = { contractId, account: kp.publicKey() };
  const message = signerMessage(ctx);
  const digest = sep53Digest(message);
  const root = new Uint8Array(kp.sign(Buffer.from(digest)));
  const keys = deriveFromRoot(root, ctx, "signer");
  return { kp, ctx, message, digest, root, keys };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The exact parameters, for `deployment.json`. Written from the same constants
 * the derivation actually uses, so the record cannot drift from the code: a
 * reader reproducing `sk` from this block alone gets the same answer these
 * scripts got, which is the only reason to publish it.
 */
export function keyDerivationRecord(
  contractId: string,
  accountVectors?: AccountVector[],
): KeyDerivationRecord {
  const v = parityVector(contractId);
  return {
    ...(accountVectors && accountVectors.length > 0 ? { accountVectors } : {}),
    spec: "OpenZeppelin Confidential Token SDK.md §5.1 (derivation) + §5.2 (signer root); hierarchy below sk is DESIGN.md §4",
    scheme:
      'sk = RS(HKDF-SHA-512(IKM = root, salt = "openzeppelin/confidential-token/v1/sk", ' +
      "info = be32(addr_f) ‖ be32(acct_f) ‖ le4(j)))",
    root: {
      form: "signer (§5.2) — a SEP-0053 ed25519 signature, used as the 64-byte IKM verbatim",
      messageTemplate: `${SK_LABEL}\\n{contract}\\n{account}`,
      messageLength: SIGNER_MESSAGE_LENGTH,
      sep53Prefix: SEP53_PREFIX,
      digest: "SHA-256(prefix ‖ msg) — the bytes the ed25519 key signs",
      signature: "64-byte RFC 8032 R ‖ S; verified against the expected signer before use (§5.2 MUST)",
    },
    hkdf: {
      hash: "SHA-512",
      ikm: "the root bytes, verbatim — not hashed, not truncated",
      salt: SK_LABEL,
      info: "be32(addr_f) ‖ be32(acct_f) ‖ le4(j)  — 68 bytes",
      outputBytes: 32,
    },
    rejection:
      "§4.7 applied to the 32-byte OKM: clear the top 2 bits, accept iff in [1, r), " +
      "else j += 1 and re-derive. Also re-rolled if vk == 0 (registration constraint R5).",
    belowSk: "vk = Poseidon2(δ_vk=2, [sk, addr_f]);  Y = sk·H;  PVK = vk·H  (DESIGN.md §4)",
    testVector: {
      note:
        "Published input for cross-implementation parity. The seed is the constant 32×0x01, " +
        "not a funded account; the contract is the real deployment because addr_f is an input " +
        "to both the §5.2 message and the §5.1 info, so a faked one would not exercise the binding. " +
        "Reproduce with: npm run derive -- --parity",
      seedHex: hex(PARITY_SEED),
      contract: contractId,
      account: v.ctx.account,
      message: v.message,
      sep53DigestHex: hex(v.digest),
      rootSignatureHex: hex(v.root),
      addrF: toHex32(v.keys.addrF),
      acctF: toHex32(v.keys.acctF),
      rejectionCounter: v.keys.rejectionCounter,
      sk: toHex32(v.keys.sk),
      vk: toHex32(v.keys.vk),
      Y: [toHex32(v.keys.Y.x), toHex32(v.keys.Y.y)],
      PVK: [toHex32(v.keys.PVK.x), toHex32(v.keys.PVK.y)],
      verifiedBy: [
        "scripts/derive.ts — Node hkdfSync + @ctd/sdk Poseidon2/Grumpkin",
        "kit/src/keys.ts — @noble/hashes hkdf + @zkpassport/poseidon2 + @noble/curves",
      ],
    },
  };
}

/**
 * Run `kit/src/keys.ts` over the same vector. The kit is an independent
 * implementation — @noble/hashes HKDF against Node's `hkdfSync`,
 * @zkpassport/poseidon2 against the SDK's Poseidon2, @noble/curves Grumpkin
 * against the SDK's — so agreement on `sk` *and* on `vk`/`Y`/`PVK` is a real
 * cross-check of both the §5 layer and the DESIGN.md §4 layer beneath it.
 *
 * Returns null when the kit is not checked out or not yet implemented; a
 * missing sibling package is not a failure of this script.
 */
async function kitParity(contractId: string): Promise<Record<string, string> | null> {
  let kit: typeof import("../kit/src/keys.js");
  try {
    kit = await import("../kit/src/keys.js");
  } catch (e) {
    console.log(`  kit/src/keys.ts not loadable — skipping parity (${(e as Error).message.split("\n")[0]})`);
    return null;
  }
  const kp = Keypair.fromRawEd25519Seed(Buffer.from(PARITY_SEED));
  const keys = await kit.deriveKeysFromEd25519Secret(PARITY_SEED, {
    contractId,
    account: kp.publicKey(),
  });
  return {
    sk: toHex32(keys.sk),
    vk: toHex32(keys.vk),
    Yx: toHex32(keys.Y.x),
    Yy: toHex32(keys.Y.y),
    PVKx: toHex32(keys.PVK.x),
    PVKy: toHex32(keys.PVK.y),
    acctF: toHex32(keys.acctF),
    rejectionCounter: String(keys.rejectionCounter),
  };
}

async function main(): Promise<void> {
  const { loadDeployment } = await import("./common.js");
  const contractId = loadDeployment().contractId;
  const v = parityVector(contractId);

  const mine: Record<string, string> = {
    sk: toHex32(v.keys.sk),
    vk: toHex32(v.keys.vk),
    Yx: toHex32(v.keys.Y.x),
    Yy: toHex32(v.keys.Y.y),
    PVKx: toHex32(v.keys.PVK.x),
    PVKy: toHex32(v.keys.PVK.y),
    acctF: toHex32(v.keys.acctF),
    rejectionCounter: String(v.keys.rejectionCounter),
  };

  console.log("SDK.md §5.1 + §5.2 — parity vector\n");
  console.log(`  contract   ${contractId}`);
  console.log(`  addr_f     ${toHex32(v.keys.addrF)}`);
  console.log(`  seed       ${hex(PARITY_SEED)}  (32 × 0x01, a published constant)`);
  console.log(`  account    ${v.ctx.account}`);
  console.log(`  acct_f     ${mine.acctF}`);
  console.log(`  message    ${JSON.stringify(v.message)}`);
  console.log(`             ${v.message.length} bytes`);
  console.log(`  sep53      ${hex(v.digest)}`);
  console.log(`  root       ${hex(v.root)}`);
  console.log(`  j          ${mine.rejectionCounter}`);
  console.log(`  sk         ${mine.sk}`);
  console.log(`  vk         ${mine.vk}`);
  console.log(`  Y          (${mine.Yx},\n              ${mine.Yy})`);
  console.log(`  PVK        (${mine.PVKx},\n              ${mine.PVKy})`);

  if (!process.argv.includes("--parity")) return;

  console.log("\nparity against kit/src/keys.ts (independent crypto core):");
  const theirs = await kitParity(contractId);
  if (!theirs) return;

  const diffs = Object.keys(mine).filter((k) => mine[k] !== theirs[k]);
  for (const k of Object.keys(mine)) {
    const same = mine[k] === theirs[k];
    console.log(`  ${same ? "✓" : "✗"} ${k.padEnd(17)} ${same ? mine[k] : `\n      scripts ${mine[k]}\n      kit     ${theirs[k]}`}`);
  }
  if (diffs.length > 0) {
    throw new Error(
      `derivation parity FAILED on ${diffs.join(", ")} — the two implementations would enrol ` +
        "different accounts from the same signature, which `register` being single-use makes unrepairable",
    );
  }
  console.log("\n✅ both implementations derive the same key set from the same signature");
}

// Only when run directly — this module is imported by history.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("\n❌", e);
    process.exit(1);
  });
}
