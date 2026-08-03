/**
 * Key derivation — SDK.md §5.
 *
 * DESIGN.md §4 specifies the hierarchy *below* `sk`. It does not say where
 * `sk` comes from, and SDK.md §5 supplies that, for a reason worth restating
 * because it is the reason this file cannot take shortcuts: two clients given
 * the same backup material would otherwise derive different accounts, and
 * `register` is single-use, so the divergence is **unrepairable**. An account
 * enrolled under the wrong derivation is not recoverable by fixing the code
 * later; the address is burned.
 *
 * That is also why this package deliberately does *not* implement the CT demo
 * app's `sk = SHA-512(signature) mod r`. The two produce different keys from
 * the same signature, and only one of them is the specification.
 *
 * The chain implemented here:
 *
 *   msg  = "openzeppelin/confidential-token/v1/sk" ‖ 0x0a ‖ enc(contract) ‖ 0x0a ‖ enc(account)
 *   root = Ed25519-Sign(sk_ed, SHA-256("Stellar Signed Message:\n" ‖ msg))     (§5.2, 64 bytes)
 *   sk   = RS(HKDF-SHA-512(IKM = root,
 *                          salt = "openzeppelin/confidential-token/v1/sk",
 *                          info = be32(addr_f) ‖ be32(acct_f) ‖ le4(j)))       (§5.1)
 *   vk   = Poseidon2(δ_vk, sk, addr_f)      Y = sk·H      PVK = vk·H           (DESIGN.md §4)
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha512 } from "@noble/hashes/sha2.js";

import { addressToField, decodeStrkey } from "./crypto/address.js";
import { FR, bytesEqual, concatBytes, fromBytesBE, toBytes32BE, toBytes4LE } from "./crypto/field.js";
import { type Point, publicViewingKey, spendingPublicKey } from "./crypto/grumpkin.js";
import { vkFromSk } from "./crypto/poseidon2.js";

/**
 * The §5.1 HKDF salt and the §5.2 message label are the same ASCII string.
 * It is a protocol constant: changing it changes every account's `sk`.
 */
export const SK_LABEL = "openzeppelin/confidential-token/v1/sk";

/** SEP-0053's 24-byte signing-domain prefix. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

/** Length of the §5.2 message: 37 + 1 + 56 + 1 + 56. */
export const SIGNER_MESSAGE_LENGTH = 151;

/**
 * What produced an account's `sk`. SDK.md §5.3 makes recording this a MUST,
 * because the three forms differ in what regenerates the key — a live signer,
 * a stored 32-byte value, or nothing beyond the stored `sk` — and "a user MUST
 * NOT be shown a recovery affordance an account's form cannot satisfy".
 */
export type RootForm = "signer" | "raw" | "import";

export interface ConfidentialKeys {
  /** Spending key, `sk ∈ [1, r)`. */
  sk: bigint;
  /** Viewing key, `vk = Poseidon2(δ_vk, sk, addr_f)`. */
  vk: bigint;
  /** `Y = sk·H` — compared against the on-chain `spending_public_key`. */
  Y: Point;
  /** `PVK = vk·H` — the ECDH target senders encrypt to. */
  PVK: Point;
  /** `address_to_field` of the token contract. */
  addrF: bigint;
  /** `address_to_field` of the account being recovered. */
  acctF: bigint;
  /** The rejection counter `j` that produced this key. Almost always 0. */
  rejectionCounter: number;
  /** Which §5 form produced `sk`. */
  rootForm: RootForm;
  /**
   * The ed25519 public key (`G…`) that signed the §5.2 message, when the form
   * is `signer`. §5.2: implementations MUST record it and MUST NOT assume it
   * is the account's master key.
   */
  enrolledSigner?: string;
}

export interface DerivationContext {
  /** The confidential token contract, `C…`. */
  contractId: string;
  /** The address being registered / recovered, `G…` or `C…`. */
  account: string;
}

/**
 * The disclosure SDK.md §5.2 requires an implementation to state at the point
 * where it offers to create a confidential account. Exported as text so the
 * wallet renders the same words the spec asks for rather than paraphrasing.
 */
export const SIGNING_KEY_DISCLOSURE =
  "This account's confidentiality is bounded by the secrecy of the Stellar key that signs for it. " +
  "Anyone who obtains that key can recompute your spending key and both view and spend this " +
  "confidential balance. Registration is single-use, so the spending key cannot be rotated in " +
  "place — remediation means registering a fresh address and moving the funds.";

// ------------------------------------------------------------ §5.2 the message

/**
 * The §5.2 message. It carries the two **strkeys**, not their §4.9
 * compressions, so a wallet rendering a SEP-0053 message as text shows the
 * user addresses they can compare against the deployment they intend to use.
 *
 * Binding both addresses into the message — rather than relying on §5.1's
 * `info` alone — is what bounds a harvested signature: a dapp that tricks a
 * user into signing once obtains the root for *that* account on *that*
 * deployment, not for every account the key controls everywhere.
 */
export function signerMessage(ctx: DerivationContext): string {
  const contract = decodeStrkey(ctx.contractId);
  if (contract.kind !== "contract") {
    throw new Error(`contractId must be a C… strkey, got ${ctx.contractId}`);
  }
  decodeStrkey(ctx.account);
  const msg = `${SK_LABEL}\n${ctx.contractId}\n${ctx.account}`;
  if (msg.length !== SIGNER_MESSAGE_LENGTH) {
    throw new Error(`§5.2 message must be ${SIGNER_MESSAGE_LENGTH} bytes, built ${msg.length}`);
  }
  return msg;
}

/**
 * The SEP-0053 preimage digest: `SHA-256(prefix ‖ msg)`. This is what an
 * ed25519 signer actually signs; a wallet's `signMessage` computes it
 * internally, and this export exists so a caller holding a raw secret can
 * reproduce the identical bytes.
 */
export function sep53Digest(message: string | Uint8Array): Uint8Array {
  const body = typeof message === "string" ? new TextEncoder().encode(message) : message;
  return sha256(concatBytes(new TextEncoder().encode(SEP53_PREFIX), body));
}

/**
 * A SEP-0053 message signer. Freighter, a hardware wallet, or a local keypair
 * all fit behind this.
 *
 * `signMessage` MUST return the 64-byte RFC 8032 signature `R ‖ S` over
 * `SHA-256(prefix ‖ message)` — i.e. SEP-0053 semantics, which is what wallets
 * implementing the SEP already do with the plain message as input.
 */
export interface MessageSigner {
  /** The `G…` address expected to have signed. */
  publicKey: string;
  signMessage(message: string): Promise<Uint8Array>;
}

/** A local-secret signer, for Node scripts and tests. */
export function ed25519Signer(secretKey: Uint8Array, publicKey: string): MessageSigner {
  return {
    publicKey,
    async signMessage(message: string) {
      return ed25519.sign(sep53Digest(message), secretKey);
    },
  };
}

// ---------------------------------------------------------------- §5.1 the KDF

/**
 * Rejection sampling over the HKDF output — the `RS` of §5.1, which is §4.7's
 * procedure applied to a derived 32 bytes rather than to a CSPRNG draw.
 *
 * Clearing the top **2** bits yields a 254-bit candidate; `r` is just under
 * 2^254, so the retry probability is small but not negligible and `j` is a
 * real code path rather than a formality.
 */
function rejectionSample(okm: Uint8Array): bigint | null {
  const candidate = fromBytesBE(okm) & ((1n << 254n) - 1n);
  if (candidate === 0n || candidate >= FR) return null;
  return candidate;
}

/**
 * The §5.1 derivation from an already-obtained root.
 *
 * `root` is the raw IKM: the 64 signature bytes of §5.2 or the 32 raw bytes of
 * §5.3, verbatim — HKDF-Extract accepts input keying material of any length,
 * so nothing is hashed or truncated on the way in.
 */
export function deriveKeysFromRoot(
  root: Uint8Array,
  ctx: DerivationContext,
  form: RootForm = "raw",
): ConfidentialKeys {
  const addrF = addressToField(ctx.contractId);
  const acctF = addressToField(ctx.account);
  const salt = new TextEncoder().encode(SK_LABEL);
  const addrBytes = toBytes32BE(addrF);
  const acctBytes = toBytes32BE(acctF);

  for (let j = 0; j < 256; j++) {
    const info = concatBytes(addrBytes, acctBytes, toBytes4LE(j));
    const okm = hkdf(sha512, root, salt, info, 32);
    const sk = rejectionSample(okm);
    if (sk === null) continue;

    // R5 requires vk ≠ 0, so a candidate whose vk collapses is rejected here
    // rather than at registration. Astronomically unlikely; cheap to honour.
    const vk = vkFromSk(sk, addrF);
    if (vk === 0n) continue;

    return {
      sk,
      vk,
      Y: spendingPublicKey(sk),
      PVK: publicViewingKey(vk),
      addrF,
      acctF,
      rejectionCounter: j,
      rootForm: form,
    };
  }
  throw new Error("§5.1 rejection sampling failed 256 times — the root is almost certainly wrong");
}

/**
 * §5.3 raw root: exactly 32 bytes from whatever custody mechanism controls the
 * address. Required for contract addresses, for signers with no SEP-0053 path,
 * and as the explicit-backup fallback.
 */
export function deriveKeysFromRawRoot(
  root: Uint8Array,
  ctx: DerivationContext,
): ConfidentialKeys {
  if (root.length !== 32) {
    throw new Error(`a §5.3 raw root is 32 bytes, got ${root.length}`);
  }
  return deriveKeysFromRoot(root, ctx, "raw");
}

// -------------------------------------------------------- §5.2 signer protocol

export interface SignerDerivationOptions {
  /**
   * Obtain the signature twice from independent invocations and abort if they
   * differ (§5.2). Defaults to on: it is four lines and it is a MUST.
   *
   * It detects the common case and not every case — a signer can be
   * deterministic within a session and not across sessions — which is why
   * §5.2 also requires offering `sk` export as a direct-import backup.
   */
  verifyDeterminism?: boolean;
}

/**
 * The full §5.2 flow: message → signature → verification → §5.1 → key set.
 *
 * Three MUSTs are enforced here, in order:
 *
 *  1. **Verify the signature against the expected signer.** A wallet with a
 *     *different account selected* returns a perfectly well-formed signature
 *     over the same message, yielding a wrong but entirely usable `sk`:
 *     registration succeeds and the account is then unreproducible from the
 *     key the user believes controls it. This check is the only thing between
 *     a user and that outcome.
 *  2. **Sign twice from independent invocations.** RFC 8032 ed25519 is
 *     deterministic, but threshold and MPC signers randomise the nonce per
 *     session and simply do not reproduce.
 *  3. **Record the enrolled signer.** `sk` is keyed to the *address* through
 *     `acct_f`, not to the key that signed for it, so which signer enrolled is
 *     not recoverable from the address or from chain state.
 */
export async function deriveKeysFromSigner(
  signer: MessageSigner,
  ctx: DerivationContext,
  options: SignerDerivationOptions = {},
): Promise<ConfidentialKeys> {
  const message = signerMessage(ctx);
  const expected = decodeStrkey(signer.publicKey);
  if (expected.kind !== "account") {
    throw new Error(`a §5.2 signer must be a G… ed25519 account, got ${signer.publicKey}`);
  }

  const root = await signer.signMessage(message);
  if (root.length !== 64) {
    throw new Error(`a §5.2 root is a 64-byte ed25519 signature, got ${root.length} bytes`);
  }

  const digest = sep53Digest(message);
  if (!ed25519.verify(root, digest, expected.payload)) {
    throw new Error(
      `signature does not verify against ${signer.publicKey} — the signer holds a different key ` +
        "than the one this account is being derived for (SDK.md §5.2)",
    );
  }

  if (options.verifyDeterminism !== false) {
    const again = await signer.signMessage(message);
    if (!bytesEqual(root, again)) {
      throw new Error(
        "the signer returned two different signatures for the same message — its nonce is " +
          "randomised (threshold/MPC ed25519), so this root will not reproduce and the account " +
          "would be unrecoverable. Use a raw root (SDK.md §5.3) and back it up explicitly.",
      );
    }
  }

  const keys = deriveKeysFromRoot(root, ctx, "signer");
  return { ...keys, enrolledSigner: signer.publicKey };
}

/**
 * Convenience for Node-side tooling that holds the raw ed25519 secret: builds
 * the signer and runs §5.2 unchanged.
 *
 * §5.2 requires the SEP-0053 envelope **even where the secret is extractable**
 * — a client holding the raw secret MUST compute this signature rather than
 * use the secret's 32 bytes as IKM directly, so that one form covers both
 * custody shapes and an account enrolled through a wallet prompt is
 * reproducible by a client that later imports the secret.
 *
 * `secretKey` is the 32-byte ed25519 seed (`Keypair.rawSecretKey()`).
 */
export async function deriveKeysFromEd25519Secret(
  secretKey: Uint8Array,
  ctx: DerivationContext,
): Promise<ConfidentialKeys> {
  const pub = ed25519.getPublicKey(secretKey);
  const account = decodeStrkey(ctx.account);
  if (!bytesEqual(pub, account.payload)) {
    throw new Error("the supplied ed25519 secret does not control ctx.account");
  }
  // Determinism is guaranteed by construction for a local RFC 8032 signer, so
  // the double invocation is skipped rather than performed against ourselves.
  return deriveKeysFromSigner(ed25519Signer(secretKey, ctx.account), ctx, {
    verifyDeterminism: false,
  });
}

/**
 * §5.3 direct import of a previously exported `sk`. The only path that
 * recovers an account whose root is neither held nor reproducible.
 */
export function keysFromSpendingKey(sk: bigint, ctx: DerivationContext): ConfidentialKeys {
  if (sk <= 0n || sk >= FR) throw new Error("sk must be a nonzero canonical F_r element");
  const addrF = addressToField(ctx.contractId);
  const vk = vkFromSk(sk, addrF);
  if (vk === 0n) throw new Error("degenerate key: vk = 0 violates registration constraint R5");
  return {
    sk,
    vk,
    Y: spendingPublicKey(sk),
    PVK: publicViewingKey(vk),
    addrF,
    acctF: addressToField(ctx.account),
    rejectionCounter: 0,
    rootForm: "import",
  };
}
