/**
 * The two moduli, and the arithmetic that must not confuse them.
 *
 * SDK.md §4.1 names this the "q/p notation hazard", and it is the single
 * highest-consequence detail in this package:
 *
 *   - `FR` is the BN254 scalar field. It is Noir's `Field`, the type every
 *     Poseidon2 output and every scalar the protocol *encodes* lives in, and
 *     it is Grumpkin's **coordinate** field.
 *   - `FQ` is the BN254 base field. It is Grumpkin's **scalar** field — i.e.
 *     the order of the group — and therefore the modulus under which blinding
 *     factors accumulate (SDK.md §4.6, DESIGN.md §2.3 *Homomorphism*).
 *
 * `FR < FQ`, so every F_r element is already a valid Grumpkin scalar with no
 * reduction. That is what makes the confusion survivable long enough to reach
 * production: a wrong-modulus sum is a perfectly well-formed scalar, it just
 * opens a different commitment. SDK.md §4.6 quantifies it — for two full-size
 * blindings the integer sum crosses `q` roughly half the time, so the bug
 * presents as funds that are spendable about 50% of the time.
 *
 * Hence {@link frAdd} and {@link fqAdd} are deliberately separate functions
 * with names that cannot be typo'd into each other, and every blinding
 * accumulation in the replay engine calls `fqAdd`.
 */

/** BN254 scalar field. Grumpkin's coordinate field. SDK.md §4.1. */
export const FR = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/**
 * BN254 base field = the Grumpkin group order, i.e. Grumpkin's scalar field.
 * Called `p` in the pairing literature and `FP_MODULUS` in the reference SDK;
 * DESIGN.md and SDK.md both call it `q`, which is the naming used here.
 */
export const FQ = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

/** Upper bound on any committed value, DESIGN.md §2.6. */
export const VALUE_BOUND = 1n << 127n;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Reduce into `[0, r)`. */
export function frMod(a: bigint): bigint {
  return mod(a, FR);
}

/** Reduce into `[0, q)`. */
export function fqMod(a: bigint): bigint {
  return mod(a, FQ);
}

/** Addition in F_r. For field elements — never for blinding accumulation. */
export function frAdd(a: bigint, b: bigint): bigint {
  return mod(a + b, FR);
}

/** Subtraction in F_r. The decrypt rules of DESIGN.md §5.2 are F_r subtractions. */
export function frSub(a: bigint, b: bigint): bigint {
  return mod(a - b, FR);
}

/**
 * Addition in F_q — the Grumpkin scalar field.
 *
 * **This is the one to use for blinding factors.** SDK.md §4.6 makes it a MUST
 * for merge (DESIGN.md §7.4) and for receiving-balance credit (DESIGN.md §5.2
 * *Update rules*).
 */
export function fqAdd(a: bigint, b: bigint): bigint {
  return mod(a + b, FQ);
}

/** True iff `v` is a canonical F_r representative, SDK.md §4.2. */
export function isCanonicalFr(v: bigint): boolean {
  return v >= 0n && v < FR;
}

/**
 * Assert canonicality at the package boundary rather than deferring to the
 * contract's check (SDK.md §4.2: "A client that produces non-canonical bytes
 * has already lost byte-uniqueness in the local state that recovery reads
 * from"). The Soroban host silently reduces `x >= r`, so two byte strings
 * would otherwise decode to one element.
 */
export function assertCanonicalFr(v: bigint, what: string): bigint {
  if (!isCanonicalFr(v)) {
    throw new Error(`${what} is not a canonical F_r element: 0x${v.toString(16)}`);
  }
  return v;
}

// --------------------------------------------------------------- byte codecs

/** Big-endian bytes to a bigint. */
export function fromBytesBE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return acc;
}

/** Little-endian bytes to a bigint. Used by the §2.7 address limbs. */
export function fromBytesLE(bytes: Uint8Array): bigint {
  let acc = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) acc = (acc << 8n) | BigInt(bytes[i]!);
  return acc;
}

/** A field element as 32 big-endian bytes — the on-chain `BytesN<32>` form. */
export function toBytes32BE(v: bigint): Uint8Array {
  if (v < 0n) throw new Error("negative value has no BytesN<32> encoding");
  const out = new Uint8Array(32);
  let x = v;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("value exceeds 32 bytes");
  return out;
}

/** Four little-endian bytes — the `le4(j)` of the SDK.md §5.1 `info` string. */
export function toBytes4LE(v: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = v & 0xff;
  out[1] = (v >>> 8) & 0xff;
  out[2] = (v >>> 16) & 0xff;
  out[3] = (v >>> 24) & 0xff;
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const padded = clean.length % 2 === 0 ? clean : `0${clean}`;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** `0x`-prefixed, zero-padded to 32 bytes. The form the fixtures use. */
export function toHex32(v: bigint): string {
  return `0x${toHex(toBytes32BE(v))}`;
}

/** Parse a hex scalar (fixture inputs, event payloads) into a bigint. */
export function hexToBigInt(hex: string): bigint {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return clean === "" ? 0n : BigInt(`0x${clean}`);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
