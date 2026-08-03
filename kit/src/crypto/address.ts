/**
 * Address compression — DESIGN.md §2.7, SDK.md §4.9.
 *
 * `address_to_field(a) = Poseidon2(δ_addr, lo(a), hi(a))` where the input is
 * the 56-character ASCII strkey (SEP-23) and `lo` / `hi` interpret its lower
 * and upper 28 bytes in **little-endian** order.
 *
 * This is the one primitive with two independent implementations — the
 * contract computes it on-chain and every client computes it off-chain, with
 * no Noir version in between, since the circuits receive `addr_f` as an opaque
 * public input. That is exactly why `address_to_field.json` exists and why the
 * fixture suite reads it.
 *
 * The strkey is the *input*, not something to be derived: the protocol commits
 * to those 56 ASCII bytes. So no base32 round-trip is needed to compute the
 * field element, and this module decodes the strkey only to *validate* it —
 * a mistyped address that still hashes cleanly would otherwise produce a
 * plausible `acct_f` for an account that does not exist.
 */
import { fromBytesLE } from "./field.js";
import { DOMAIN, poseidonWithDomain } from "./poseidon2.js";

const STRKEY_LEN = 56;
const LIMB_LEN = 28;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** SEP-23 version bytes for the two address types the protocol accepts. */
const VERSION_ACCOUNT = 0x30; // "G…" — a Stellar ed25519 account
const VERSION_CONTRACT = 0x10; // "C…" — a Soroban contract instance

export type AddressKind = "account" | "contract";

function base32Decode(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character in strkey: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** CRC16-XModem (poly 0x1021, init 0) — the SEP-23 checksum. */
function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export interface DecodedStrkey {
  kind: AddressKind;
  /** The 32-byte payload: an ed25519 public key or a contract hash. */
  payload: Uint8Array;
}

/**
 * Validate a strkey and return its type and payload.
 *
 * Checks length, alphabet, version byte and CRC — the checksum is the reason
 * to bother, since it is what catches a transposed character before it becomes
 * a silently wrong `acct_f`.
 */
export function decodeStrkey(strkey: string): DecodedStrkey {
  if (strkey.length !== STRKEY_LEN) {
    throw new Error(`strkey must be ${STRKEY_LEN} characters, got ${strkey.length}`);
  }
  const raw = base32Decode(strkey);
  if (raw.length !== 35) {
    throw new Error(`strkey decodes to ${raw.length} bytes, expected 35`);
  }
  const version = raw[0]!;
  const payload = raw.subarray(1, 33);
  const checksum = raw[33]! | (raw[34]! << 8); // little-endian
  if (crc16(raw.subarray(0, 33)) !== checksum) {
    throw new Error(`strkey checksum mismatch: ${strkey}`);
  }
  if (version === VERSION_ACCOUNT) return { kind: "account", payload };
  if (version === VERSION_CONTRACT) return { kind: "contract", payload };
  throw new Error(`unsupported strkey version byte 0x${version.toString(16)}`);
}

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 31];
    }
  }
  // 35 bytes is 280 bits = exactly 56 base32 characters, so no partial group
  // and no `=` padding ever arises for a strkey.
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The inverse of {@link decodeStrkey}: a 32-byte payload back to its `G…` or
 * `C…` form. Needed because the wire carries addresses as raw ed25519 keys and
 * contract hashes inside `ScAddress`, while every other layer of this package —
 * and every account the caller names — speaks strkeys.
 */
export function encodeStrkey(kind: AddressKind, payload: Uint8Array): string {
  if (payload.length !== 32) {
    throw new Error(`a strkey payload is 32 bytes, got ${payload.length}`);
  }
  const body = new Uint8Array(33);
  body[0] = kind === "account" ? VERSION_ACCOUNT : VERSION_CONTRACT;
  body.set(payload, 1);
  const checksum = crc16(body);
  const full = new Uint8Array(35);
  full.set(body, 0);
  full[33] = checksum & 0xff; // little-endian, per SEP-23
  full[34] = (checksum >> 8) & 0xff;
  return base32Encode(full);
}

export function isValidStrkey(strkey: string): boolean {
  try {
    decodeStrkey(strkey);
    return true;
  } catch {
    return false;
  }
}

/**
 * `address_to_field` — the 56 ASCII bytes of the strkey split into two
 * little-endian 28-byte limbs and absorbed under δ_addr.
 *
 * Each limb is at most 2^224, comfortably inside F_r, so no reduction is
 * involved and the map is injective on well-formed strkeys.
 */
export function addressToField(strkey: string): bigint {
  decodeStrkey(strkey); // validate before committing to the bytes
  const ascii = new TextEncoder().encode(strkey);
  const lo = fromBytesLE(ascii.subarray(0, LIMB_LEN));
  const hi = fromBytesLE(ascii.subarray(LIMB_LEN, STRKEY_LEN));
  return poseidonWithDomain(DOMAIN.ADDRESS, [lo, hi]);
}
