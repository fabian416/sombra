/**
 * The XDR primitives (RFC 4506) this package needs, and base64.
 *
 * Written rather than taken from `@stellar/stellar-base` for one reason:
 * browser reach. `stellar-base` is built around `Buffer`, which Vite does not
 * polyfill by default (INTEGRATION.md §A notes the same hazard in the reference
 * SDK's `chain/payload.ts`). Recovery is the one flow that must work in a
 * browser with no build-time archaeology, so the ~200 bytes of XDR grammar it
 * actually touches are implemented here over `Uint8Array` and nothing else.
 *
 * The surface is deliberately tiny: unsigned/signed 32- and 64-bit integers,
 * counted opaque, strings, and the 4-byte padding rule. That is the whole of
 * what `ScVal`, `LedgerKey` and `LedgerEntryData` are built from.
 *
 * `test/xdr.test.ts` pins every codec in this directory against
 * `@stellar/stellar-base` — a devDependency, so the pin costs nothing at
 * runtime while still proving the hand-rolled grammar agrees with the
 * reference encoder byte-for-byte.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Reverse table, built once. `-1` marks a character outside the alphabet. */
const BASE64_LOOKUP = /* @__PURE__ */ (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${BASE64_ALPHABET[(n >> 18) & 63]!}${BASE64_ALPHABET[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${BASE64_ALPHABET[(n >> 18) & 63]!}${BASE64_ALPHABET[(n >> 12) & 63]!}${BASE64_ALPHABET[(n >> 6) & 63]!}=`;
  }
  return out;
}

export function base64Decode(text: string): Uint8Array {
  // Tolerate both alphabets: an archive or RPC that hands back base64url is
  // still unambiguous, and refusing it would be a gratuitous failure mode.
  const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/[\s=]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = BASE64_LOOKUP[clean.charCodeAt(i)]!;
    if (v < 0) throw new Error(`invalid base64 character at index ${i}: ${clean[i]}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/**
 * A cursor over an XDR byte stream.
 *
 * Every read is bounds-checked. That matters more than it looks: the input is
 * whatever an archive served, and a truncated payload that silently decoded to
 * a short value would become a wrong balance rather than an error — the exact
 * outcome INDEXER.md §7 promises cannot happen.
 */
export class XdrReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  static fromBase64(text: string): XdrReader {
    return new XdrReader(base64Decode(text));
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(n: number): Uint8Array {
    if (this.offset + n > this.bytes.length) {
      throw new Error(
        `XDR stream truncated: wanted ${n} bytes at offset ${this.offset}, ` +
          `only ${this.remaining} remain`,
      );
    }
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  readU32(): number {
    const b = this.take(4);
    // `>>> 0` keeps the top bit unsigned; without it a discriminant above
    // 2^31 would read as negative and miss every case label.
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }

  readI32(): number {
    const b = this.take(4);
    return (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!;
  }

  readU64(): bigint {
    let acc = 0n;
    for (const byte of this.take(8)) acc = (acc << 8n) | BigInt(byte);
    return acc;
  }

  readI64(): bigint {
    const u = this.readU64();
    return u >= 1n << 63n ? u - (1n << 64n) : u;
  }

  /** Fixed-length opaque — no length prefix, no padding. */
  readFixedBytes(n: number): Uint8Array {
    return new Uint8Array(this.take(n));
  }

  /**
   * Counted opaque / string: a `uint32` length then the bytes, padded with
   * zeroes to the next 4-byte boundary. The padding is consumed but not
   * validated — a non-zero pad is malformed XDR, and rejecting it would trade
   * a working recovery for pedantry against encoders we do not control.
   */
  readVarBytes(): Uint8Array {
    const len = this.readU32();
    const body = new Uint8Array(this.take(len));
    const pad = (4 - (len % 4)) % 4;
    if (pad > 0) this.take(pad);
    return body;
  }

  readString(): string {
    return new TextDecoder().decode(this.readVarBytes());
  }

  /** An XDR optional: a `bool` presence flag ahead of the value. */
  readOptional<T>(read: (r: XdrReader) => T): T | null {
    return this.readU32() === 0 ? null : read(this);
  }

  /** Assert the stream was consumed exactly — a cheap decoder self-check. */
  assertConsumed(what: string): void {
    if (this.remaining !== 0) {
      throw new Error(`${what}: ${this.remaining} trailing bytes after decoding`);
    }
  }
}

/** The write half. Only what encoding a `LedgerKey` requires. */
export class XdrWriter {
  private readonly chunks: Uint8Array[] = [];

  writeU32(v: number): this {
    const b = new Uint8Array(4);
    b[0] = (v >>> 24) & 0xff;
    b[1] = (v >>> 16) & 0xff;
    b[2] = (v >>> 8) & 0xff;
    b[3] = v & 0xff;
    this.chunks.push(b);
    return this;
  }

  writeU64(v: bigint): this {
    const b = new Uint8Array(8);
    let x = v & ((1n << 64n) - 1n);
    for (let i = 7; i >= 0; i--) {
      b[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    this.chunks.push(b);
    return this;
  }

  writeI64(v: bigint): this {
    return this.writeU64(v < 0n ? v + (1n << 64n) : v);
  }

  writeFixedBytes(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    return this;
  }

  writeVarBytes(bytes: Uint8Array): this {
    this.writeU32(bytes.length);
    this.chunks.push(bytes);
    const pad = (4 - (bytes.length % 4)) % 4;
    if (pad > 0) this.chunks.push(new Uint8Array(pad));
    return this;
  }

  writeString(s: string): this {
    return this.writeVarBytes(new TextEncoder().encode(s));
  }

  bytes(): Uint8Array {
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  base64(): string {
    return base64Encode(this.bytes());
  }
}
