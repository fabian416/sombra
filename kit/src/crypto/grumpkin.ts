/**
 * Grumpkin curve operations — DESIGN.md §2.2–§2.4, DESIGN_cont.md §10.4.
 *
 * Grumpkin is `y² = x³ − 17` over F_r, forming a 2-cycle with BN254: its
 * coordinate field is BN254's scalar field and its scalar field is BN254's
 * base field. It has prime order and cofactor 1, so every point on the curve
 * is in the group and no subgroup check is needed.
 *
 * Point arithmetic comes from `@noble/curves`'s audited short-Weierstrass
 * implementation, instantiated here with Grumpkin's parameters — Grumpkin is
 * not one of noble's shipped curves. What this module adds on top is the
 * protocol's own layer: the two Pedersen generators, the identity-tolerant
 * scalar multiplication the spec requires, the flat 64-byte encoding the
 * contract uses, and the ECDH derivation.
 */
import { weierstrassN } from "@noble/curves/abstract/weierstrass.js";

import { FQ, FR, bytesEqual, concatBytes, fromBytesBE, toBytes32BE } from "./field.js";
import { DOMAIN, poseidonWithDomain } from "./poseidon2.js";

/**
 * Barretenberg's `derive_generators("DEFAULT_DOMAIN_SEPARATOR")` at index 0.
 * DESIGN_cont.md §10.4 lists the coordinates; they are part of the toolchain's
 * audited surface and the soundness assumption that `log_G H` is unknown is
 * inherited with them.
 */
export const G_X = 0x083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5an;
export const G_Y = 0x1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935dn;

/** The same domain at index 1. No known discrete-log relation to G. */
export const H_X = 0x054aa86a73cb8a34525e5bbed6e43ba1198e860f5f3950268f71df4591bde402n;
export const H_Y = 0x209dcfbf2cfb57f9f6046f44d71ac6faf87254afc7407c04eb621a6287cac126n;

/** An affine Grumpkin point. The identity is represented as `(0, 0)`. */
export interface Point {
  x: bigint;
  y: bigint;
}

/**
 * `b = −17 mod r`. Written as a reduction rather than a literal so the curve
 * equation stays legible next to DESIGN.md §2.2.
 */
const CURVE_B = FR - 17n;

/**
 * `allowInfinityPoint` is not optional here: a registered account's balance
 * commitments *are* the identity until its first credit (DESIGN.md §5.2
 * *Initialization*), so the identity is a routine value in this protocol
 * rather than an error condition.
 */
const GrumpkinPoint = weierstrassN(
  { p: FR, n: FQ, h: 1n, a: 0n, b: CURVE_B, Gx: G_X, Gy: G_Y },
  { allowInfinityPoint: true },
);

/** The identity element `O`, encoded on-chain as 64 zero bytes. */
export const IDENTITY: Point = { x: 0n, y: 0n };

/** Pedersen generator G. */
export const G: Point = { x: G_X, y: G_Y };

/** Pedersen generator H — the ECDH base and the blinding generator. */
export const H: Point = { x: H_X, y: H_Y };

export function isIdentity(p: Point): boolean {
  return p.x === 0n && p.y === 0n;
}

export function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function toInternal(p: Point) {
  if (isIdentity(p)) return GrumpkinPoint.ZERO;
  return GrumpkinPoint.fromAffine({ x: p.x, y: p.y });
}

function fromInternal(p: InstanceType<typeof GrumpkinPoint>): Point {
  if (p.is0()) return IDENTITY;
  const a = p.toAffine();
  return { x: a.x, y: a.y };
}

/** True iff the point satisfies the curve equation (or is the identity). */
export function isOnCurve(p: Point): boolean {
  if (isIdentity(p)) return true;
  try {
    GrumpkinPoint.fromAffine({ x: p.x, y: p.y }).assertValidity();
    return true;
  } catch {
    return false;
  }
}

export function assertOnCurve(p: Point, what: string): Point {
  if (!isOnCurve(p)) throw new Error(`${what} is not a Grumpkin point`);
  return p;
}

/**
 * Scalar multiplication `s·P`.
 *
 * SDK.md §4.4 requires a **zero scalar to map to the identity rather than
 * error**, because a zero blinding is legitimate — deposits commit with
 * `r = 0` (DESIGN.md §7.3). noble rejects a zero scalar, so the case is
 * handled here rather than papered over by nudging the scalar.
 *
 * The scalar is reduced mod `q` (the group order) rather than rejected: every
 * F_r value is already in range, and a post-merge blinding legitimately lives
 * in F_q (DESIGN.md §5.2).
 */
export function scalarMul(scalar: bigint, p: Point): Point {
  const s = ((scalar % FQ) + FQ) % FQ;
  if (s === 0n || isIdentity(p)) return IDENTITY;
  return fromInternal(toInternal(p).multiply(s));
}

export function pointAdd(a: Point, b: Point): Point {
  if (isIdentity(a)) return b;
  if (isIdentity(b)) return a;
  return fromInternal(toInternal(a).add(toInternal(b)));
}

export function pointNegate(p: Point): Point {
  if (isIdentity(p)) return IDENTITY;
  return { x: p.x, y: FR - p.y };
}

/**
 * The Pedersen commitment `Com(v, r) = v·G + r·H` (DESIGN.md §2.3).
 *
 * This is the function that closes the loop in DESIGN.md §5.2 step 7: a
 * reconstructed opening is only trustworthy because re-committing it and
 * comparing against the on-chain point is a check an untrusted archive cannot
 * fool.
 */
export function commit(v: bigint, r: bigint): Point {
  return pointAdd(scalarMul(v, G), scalarMul(r, H));
}

/**
 * How the shared point is reduced to a shared scalar.
 *
 * `poseidon2` is DESIGN.md §2.4 / SDK.md §4.5 as they stand, and it is what
 * `circuits/lib/testdata/` pins. `x-only` is the rule the earlier revision
 * specified and the one the CT demo's deployed contract still implements —
 * including the token this project recovers against, so it is not a legacy
 * curiosity but a live deployment's behaviour.
 *
 * The difference is a real security property, not a formatting choice: `P` and
 * `−P` share an x-coordinate and `−PVK` is itself a valid canonical
 * registration, so `x-only` collapses each `(vk, −vk)` pair onto one shared
 * secret. Which is why the two are named rather than silently unified, and why
 * `poseidon2` is the default everywhere.
 */
export type EcdhRule = "poseidon2" | "x-only";

/**
 * ECDH shared-secret scalar — DESIGN.md §2.4, SDK.md §4.5.
 *
 * `S = a·B`, then `s = Poseidon2(δ_ecdh, S.x, S.y)` under the default rule.
 *
 * The derivation **fails** on an identity `S` (SDK.md §4.5): σ is public, so
 * an identity shared secret makes every derived ciphertext trivially
 * decryptable. That holds under either rule.
 */
export function ecdh(scalar: bigint, point: Point, rule: EcdhRule = "poseidon2"): bigint {
  const s = scalarMul(scalar, point);
  if (isIdentity(s)) {
    throw new Error("ECDH shared secret is the identity — refusing to derive (SDK.md §4.5)");
  }
  return rule === "x-only" ? s.x : poseidonWithDomain(DOMAIN.ECDH, [s.x, s.y]);
}

// ------------------------------------------------------------------ encoding

/**
 * The on-chain `Point = BytesN<64>` encoding: flat `be(x) ‖ be(y)`, with the
 * identity as 64 zero bytes.
 */
export function pointToBytes(p: Point): Uint8Array {
  return concatBytes(toBytes32BE(p.x), toBytes32BE(p.y));
}

export function pointFromBytes(bytes: Uint8Array): Point {
  if (bytes.length !== 64) {
    throw new Error(`a Grumpkin point is 64 bytes, got ${bytes.length}`);
  }
  const zero = new Uint8Array(64);
  if (bytesEqual(bytes, zero)) return IDENTITY;
  const p = {
    x: fromBytesBE(bytes.subarray(0, 32)),
    y: fromBytesBE(bytes.subarray(32, 64)),
  };
  return assertOnCurve(p, "decoded point");
}

/** `Y = sk·H`, the spending public key — DESIGN.md §4.1. */
export function spendingPublicKey(sk: bigint): Point {
  return scalarMul(sk, H);
}

/** `PVK = vk·H`, the public viewing key — DESIGN.md §4.3. */
export function publicViewingKey(vk: bigint): Point {
  return scalarMul(vk, H);
}
