/**
 * `ScVal`, `LedgerKey` and `LedgerEntryData` — the three XDR shapes recovery
 * touches, decoded straight from the wire.
 *
 * Two consumers:
 *
 *   - **Events.** The Archive serves `topics_xdr` / `data_xdr` verbatim, which
 *     is what INDEXER.md §3.1 RECOMMENDS precisely so the wallet decodes the
 *     on-chain wire form rather than trusting the indexer's field naming. Soroban
 *     27's `#[contractevent]` publishes data as an **`ScMap` keyed by field-name
 *     symbols**; canonical XDR sorts map keys, so wire order is not Rust
 *     declaration order and decoding positionally is a silent corruption
 *     waiting to happen. Everything here reads by name.
 *   - **Chain state.** DESIGN.md §5.2 step 7 compares the reconstructed opening
 *     against the on-chain commitments, which live in a `ContractData` entry.
 *     Reading it through `getLedgerEntries` needs a `LedgerKey` encoder and a
 *     `LedgerEntryData` decoder, and that pair is the whole reason the writer
 *     in `codec.ts` exists.
 *
 * Reading the entry directly rather than simulating `confidential_balance()`
 * is deliberate: it needs no source account, no sequence number and no
 * transaction envelope, and — unlike the contract call, which extends the
 * entry's TTL on read (`storage.rs:1260-1276`) — it has no side effect on
 * chain state at all.
 */
import { type AddressKind, decodeStrkey, encodeStrkey } from "../crypto/address.js";
import { XdrReader, XdrWriter } from "./codec.js";

/** `ScValType`, stellar-core's `Stellar-contract.x`. */
const SCV = {
  BOOL: 0,
  VOID: 1,
  ERROR: 2,
  U32: 3,
  I32: 4,
  U64: 5,
  I64: 6,
  TIMEPOINT: 7,
  DURATION: 8,
  U128: 9,
  I128: 10,
  U256: 11,
  I256: 12,
  BYTES: 13,
  STRING: 14,
  SYMBOL: 15,
  VEC: 16,
  MAP: 17,
  ADDRESS: 18,
  CONTRACT_INSTANCE: 19,
  LEDGER_KEY_CONTRACT_INSTANCE: 20,
  LEDGER_KEY_NONCE: 21,
} as const;

/** `SCAddressType`. Only the two forms a confidential-token topic can hold. */
const SC_ADDRESS_ACCOUNT = 0;
const SC_ADDRESS_CONTRACT = 1;

/** `LedgerEntryType.CONTRACT_DATA`. */
const LEDGER_ENTRY_CONTRACT_DATA = 6;

/** `ContractDataDurability`. Account entries are persistent (`storage.rs`). */
export const DURABILITY_TEMPORARY = 0;
export const DURABILITY_PERSISTENT = 1;

export type ScVal =
  | { type: "bool"; value: boolean }
  | { type: "void" }
  | { type: "u32"; value: number }
  | { type: "i32"; value: number }
  | { type: "u64"; value: bigint }
  | { type: "i64"; value: bigint }
  | { type: "timepoint"; value: bigint }
  | { type: "duration"; value: bigint }
  | { type: "u128"; value: bigint }
  | { type: "i128"; value: bigint }
  | { type: "u256"; value: bigint }
  | { type: "i256"; value: bigint }
  | { type: "bytes"; value: Uint8Array }
  | { type: "string"; value: string }
  | { type: "symbol"; value: string }
  | { type: "vec"; value: ScVal[] | null }
  | { type: "map"; value: ScMapEntry[] | null }
  | { type: "address"; value: string };

export interface ScMapEntry {
  key: ScVal;
  val: ScVal;
}

// ------------------------------------------------------------------ decoding

function readScAddress(r: XdrReader): string {
  const type = r.readU32();
  if (type === SC_ADDRESS_ACCOUNT) {
    // AccountID is a PublicKey union; ed25519 is its only arm to date.
    const keyType = r.readU32();
    if (keyType !== 0) throw new Error(`unsupported AccountID key type ${keyType}`);
    return encodeStrkey("account", r.readFixedBytes(32));
  }
  if (type === SC_ADDRESS_CONTRACT) {
    return encodeStrkey("contract", r.readFixedBytes(32));
  }
  // Muxed accounts, claimable balances and liquidity pools cannot appear in a
  // confidential-token topic; naming the discriminant beats a generic failure.
  throw new Error(`unsupported ScAddress type ${type}`);
}

function writeScAddress(w: XdrWriter, strkey: string): void {
  const { kind, payload } = decodeStrkey(strkey);
  if (kind === "account") {
    w.writeU32(SC_ADDRESS_ACCOUNT).writeU32(0).writeFixedBytes(payload);
  } else {
    w.writeU32(SC_ADDRESS_CONTRACT).writeFixedBytes(payload);
  }
}

/** Reassemble a two's-complement wide integer from its 64-bit parts. */
function fromParts(parts: bigint[], signed: boolean): bigint {
  let acc = 0n;
  for (const p of parts) acc = (acc << 64n) | p;
  const width = BigInt(parts.length * 64);
  return signed && acc >= 1n << (width - 1n) ? acc - (1n << width) : acc;
}

export function readScVal(r: XdrReader): ScVal {
  const type = r.readU32();
  switch (type) {
    case SCV.BOOL:
      return { type: "bool", value: r.readU32() !== 0 };
    case SCV.VOID:
      return { type: "void" };
    case SCV.U32:
      return { type: "u32", value: r.readU32() };
    case SCV.I32:
      return { type: "i32", value: r.readI32() };
    case SCV.U64:
      return { type: "u64", value: r.readU64() };
    case SCV.I64:
      return { type: "i64", value: r.readI64() };
    case SCV.TIMEPOINT:
      return { type: "timepoint", value: r.readU64() };
    case SCV.DURATION:
      return { type: "duration", value: r.readU64() };
    case SCV.U128: {
      // UInt128Parts { hi, lo } — high half first on the wire.
      const hi = r.readU64();
      const lo = r.readU64();
      return { type: "u128", value: fromParts([hi, lo], false) };
    }
    case SCV.I128: {
      // Int128Parts { int64 hi; uint64 lo } — only the top half is signed,
      // which is why the sign is applied to the reassembled 128-bit value
      // rather than to `hi` on its own. Public amounts are i128.
      const hi = r.readU64();
      const lo = r.readU64();
      return { type: "i128", value: fromParts([hi, lo], true) };
    }
    case SCV.U256: {
      const parts = [r.readU64(), r.readU64(), r.readU64(), r.readU64()];
      return { type: "u256", value: fromParts(parts, false) };
    }
    case SCV.I256: {
      const parts = [r.readU64(), r.readU64(), r.readU64(), r.readU64()];
      return { type: "i256", value: fromParts(parts, true) };
    }
    case SCV.BYTES:
      return { type: "bytes", value: r.readVarBytes() };
    case SCV.STRING:
      return { type: "string", value: r.readString() };
    case SCV.SYMBOL:
      return { type: "symbol", value: r.readString() };
    case SCV.VEC:
      return {
        type: "vec",
        value: r.readOptional((rr) => {
          const len = rr.readU32();
          const out: ScVal[] = [];
          for (let i = 0; i < len; i++) out.push(readScVal(rr));
          return out;
        }),
      };
    case SCV.MAP:
      return {
        type: "map",
        value: r.readOptional((rr) => {
          const len = rr.readU32();
          const out: ScMapEntry[] = [];
          for (let i = 0; i < len; i++) out.push({ key: readScVal(rr), val: readScVal(rr) });
          return out;
        }),
      };
    case SCV.ADDRESS:
      return { type: "address", value: readScAddress(r) };
    default:
      throw new Error(
        `ScVal type ${type} is not decodable by sombra-kit — no confidential-token ` +
          "event or account entry uses it",
      );
  }
}

export function writeScVal(w: XdrWriter, v: ScVal): void {
  switch (v.type) {
    case "bool":
      w.writeU32(SCV.BOOL).writeU32(v.value ? 1 : 0);
      return;
    case "void":
      w.writeU32(SCV.VOID);
      return;
    case "u32":
      w.writeU32(SCV.U32).writeU32(v.value);
      return;
    case "i32":
      w.writeU32(SCV.I32).writeU32(v.value >>> 0);
      return;
    case "u64":
      w.writeU32(SCV.U64).writeU64(v.value);
      return;
    case "i64":
      w.writeU32(SCV.I64).writeI64(v.value);
      return;
    case "bytes":
      w.writeU32(SCV.BYTES).writeVarBytes(v.value);
      return;
    case "string":
      w.writeU32(SCV.STRING).writeString(v.value);
      return;
    case "symbol":
      w.writeU32(SCV.SYMBOL).writeString(v.value);
      return;
    case "address":
      w.writeU32(SCV.ADDRESS);
      writeScAddress(w, v.value);
      return;
    case "vec":
      w.writeU32(SCV.VEC);
      if (v.value === null) {
        w.writeU32(0);
        return;
      }
      w.writeU32(1).writeU32(v.value.length);
      for (const item of v.value) writeScVal(w, item);
      return;
    case "map":
      w.writeU32(SCV.MAP);
      if (v.value === null) {
        w.writeU32(0);
        return;
      }
      w.writeU32(1).writeU32(v.value.length);
      for (const e of v.value) {
        writeScVal(w, e.key);
        writeScVal(w, e.val);
      }
      return;
    default:
      throw new Error(`sombra-kit does not encode ScVal type ${(v as ScVal).type}`);
  }
}

export function decodeScVal(base64: string): ScVal {
  const r = XdrReader.fromBase64(base64);
  const v = readScVal(r);
  r.assertConsumed("ScVal");
  return v;
}

export function encodeScVal(v: ScVal): string {
  const w = new XdrWriter();
  writeScVal(w, v);
  return w.base64();
}

// --------------------------------------------------------------- ScVal access
//
// Typed accessors rather than casts at the call site. Each names what it wanted
// and what it got, because these run against archive-served bytes and a decoded
// event with the wrong shape must be a legible error rather than `undefined`
// propagating into a balance.

export function scSymbol(v: ScVal | undefined, what: string): string {
  if (v?.type !== "symbol") throw new Error(`${what}: expected an ScSymbol, got ${describe(v)}`);
  return v.value;
}

export function scAddress(v: ScVal | undefined, what: string): string {
  if (v?.type !== "address") throw new Error(`${what}: expected an ScAddress, got ${describe(v)}`);
  return v.value;
}

export function scBytes(v: ScVal | undefined, what: string): Uint8Array {
  if (v?.type !== "bytes") throw new Error(`${what}: expected ScBytes, got ${describe(v)}`);
  return v.value;
}

export function scInt(v: ScVal | undefined, what: string): bigint {
  if (v === undefined) throw new Error(`${what}: missing`);
  switch (v.type) {
    case "i128":
    case "u128":
    case "i64":
    case "u64":
    case "i256":
    case "u256":
      return v.value;
    case "u32":
    case "i32":
      return BigInt(v.value);
    default:
      throw new Error(`${what}: expected an integer ScVal, got ${describe(v)}`);
  }
}

export function scU32(v: ScVal | undefined, what: string): number {
  if (v?.type !== "u32") throw new Error(`${what}: expected ScU32, got ${describe(v)}`);
  return v.value;
}

function describe(v: ScVal | undefined): string {
  return v === undefined ? "nothing" : `Sc${v.type}`;
}

/**
 * Index an `ScMap` by its symbol keys.
 *
 * This is the function that discharges the "never decode positionally" rule:
 * canonical XDR sorts map keys by symbol, so the wire order of a `Transfer`'s
 * data fields is alphabetical, not the declaration order DESIGN_cont §11.2
 * lists them in.
 */
export function scMapFields(v: ScVal | undefined, what: string): Map<string, ScVal> {
  if (v?.type !== "map" || v.value === null) {
    throw new Error(`${what}: expected an ScMap, got ${describe(v)}`);
  }
  const out = new Map<string, ScVal>();
  for (const entry of v.value) {
    out.set(scSymbol(entry.key, `${what} key`), entry.val);
  }
  return out;
}

// ----------------------------------------------------------- ledger key/entry

/**
 * `LedgerKey` for a contract-data entry.
 *
 * The confidential token keys its per-account entry with the
 * `ConfidentialTokenStorageKey::Account(Address)` variant (`storage.rs:19-38`).
 * soroban-sdk encodes an enum variant carrying a payload as
 * `ScVec[ScSymbol("Account"), <payload>]`, which is what {@link accountEntryKey}
 * builds.
 */
export function contractDataLedgerKey(
  contractId: string,
  key: ScVal,
  durability: number = DURABILITY_PERSISTENT,
): string {
  const w = new XdrWriter();
  w.writeU32(LEDGER_ENTRY_CONTRACT_DATA);
  writeScAddress(w, contractId);
  writeScVal(w, key);
  w.writeU32(durability);
  return w.base64();
}

/** The `Account(Address)` storage key of `ConfidentialTokenStorageKey`. */
export function accountEntryKey(account: string): ScVal {
  return {
    type: "vec",
    value: [
      { type: "symbol", value: "Account" },
      { type: "address", value: account },
    ],
  };
}

export interface ContractDataEntry {
  contract: string;
  key: ScVal;
  durability: number;
  val: ScVal;
}

/**
 * Decode the `LedgerEntryData` that `getLedgerEntries` returns per entry.
 *
 * `ContractDataEntry` opens with an `ExtensionPoint` — a union on `int v` whose
 * only arm is `v = 0: void` — so the leading `uint32` is consumed and checked
 * rather than skipped.
 */
export function decodeContractDataEntry(base64: string): ContractDataEntry {
  const r = XdrReader.fromBase64(base64);
  const entryType = r.readU32();
  if (entryType !== LEDGER_ENTRY_CONTRACT_DATA) {
    throw new Error(`expected a CONTRACT_DATA ledger entry, got type ${entryType}`);
  }
  const ext = r.readU32();
  if (ext !== 0) throw new Error(`unsupported ContractDataEntry extension point v=${ext}`);
  const contract = readScAddress(r);
  const key = readScVal(r);
  const durability = r.readU32();
  const val = readScVal(r);
  return { contract, key, durability, val };
}

export type { AddressKind };
