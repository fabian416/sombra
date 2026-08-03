/**
 * The hand-rolled XDR grammar, pinned against `@stellar/stellar-base`.
 *
 * `codec.ts` explains why the grammar is hand-rolled (browser reach without a
 * `Buffer` polyfill). This suite is the price of that decision: every value
 * sombra-kit decodes off the wire is encoded here by the reference
 * implementation and decoded by ours, and vice-versa, so "browser-safe" never
 * costs correctness. `stellar-base` is a devDependency and none of it reaches
 * the shipped bundle.
 */
import { Address, StrKey, xdr } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";

import { decodeStrkey, encodeStrkey } from "../src/crypto/address.js";
import { base64Decode, base64Encode } from "../src/xdr/codec.js";
import {
  DURABILITY_PERSISTENT,
  type ScVal,
  accountEntryKey,
  contractDataLedgerKey,
  decodeContractDataEntry,
  decodeScVal,
  encodeScVal,
  scInt,
  scMapFields,
} from "../src/xdr/scval.js";

const ACCOUNT = "GCKBD5H2T6TJ7H3SYBSFWE4WTPETTTPOUVV7VZTDZ2YN2ZN6WAK5JECM";
const CONTRACT = "CC2Z2B4X4IIFPEHTAAXSZMXVOFUFLDFQ2HVOOQUY3UTFNNKKZPEK4ZAC";

/** Reference encoding of an ScVal, as base64. */
function reference(v: xdr.ScVal): string {
  return v.toXDR("base64");
}

describe("base64", () => {
  it("round-trips every input length mod 3", () => {
    for (let n = 0; n < 12; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
  });

  it("agrees with the reference encoder on binary payloads", () => {
    const bytes = Uint8Array.from({ length: 64 }, (_, i) => (i * 251) & 0xff);
    expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  it("accepts base64url without padding", () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbe, 0x00]);
    const url = Buffer.from(bytes).toString("base64url");
    expect(base64Decode(url)).toEqual(bytes);
  });
});

describe("strkey", () => {
  it("encodes both address kinds back to the reference form", () => {
    expect(encodeStrkey("account", decodeStrkey(ACCOUNT).payload)).toBe(ACCOUNT);
    expect(encodeStrkey("contract", decodeStrkey(CONTRACT).payload)).toBe(CONTRACT);
  });

  it("payload matches the reference decoder", () => {
    expect(decodeStrkey(ACCOUNT).payload).toEqual(new Uint8Array(StrKey.decodeEd25519PublicKey(ACCOUNT)));
    expect(decodeStrkey(CONTRACT).payload).toEqual(new Uint8Array(StrKey.decodeContract(CONTRACT)));
  });
});

describe("ScVal — decoding matches @stellar/stellar-base", () => {
  const cases: { name: string; ref: xdr.ScVal; expected: ScVal }[] = [
    { name: "symbol", ref: xdr.ScVal.scvSymbol("transfer"), expected: { type: "symbol", value: "transfer" } },
    {
      name: "symbol with a non-multiple-of-4 length (padding)",
      ref: xdr.ScVal.scvSymbol("merge"),
      expected: { type: "symbol", value: "merge" },
    },
    { name: "void", ref: xdr.ScVal.scvVoid(), expected: { type: "void" } },
    { name: "u32", ref: xdr.ScVal.scvU32(4_294_967_295), expected: { type: "u32", value: 4_294_967_295 } },
    { name: "bool", ref: xdr.ScVal.scvBool(true), expected: { type: "bool", value: true } },
    {
      name: "account address",
      ref: new Address(ACCOUNT).toScVal(),
      expected: { type: "address", value: ACCOUNT },
    },
    {
      name: "contract address",
      ref: new Address(CONTRACT).toScVal(),
      expected: { type: "address", value: CONTRACT },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(decodeScVal(reference(c.ref))).toEqual(c.expected);
    });
  }

  it("bytes — a 64-byte Grumpkin point survives verbatim", () => {
    const point = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);
    const decoded = decodeScVal(reference(xdr.ScVal.scvBytes(Buffer.from(point))));
    expect(decoded).toEqual({ type: "bytes", value: point });
  });

  it("i128 — positive, negative, and both 64-bit boundaries", () => {
    // Public amounts are i128 (SEP-41). The sign lives in the reassembled
    // 128-bit value, not in the `hi` limb alone, so a value that is negative
    // overall while `lo` is large is the case that catches a wrong split.
    const values = [0n, 1n, -1n, 1000n, (1n << 63n) - 1n, 1n << 63n, (1n << 127n) - 1n, -(1n << 127n), -(1n << 64n) + 5n];
    for (const value of values) {
      const ref = xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: xdr.Int64.fromString(String(BigInt.asIntN(64, value >> 64n))),
          lo: xdr.Uint64.fromString(String(BigInt.asUintN(64, value))),
        }),
      );
      expect(scInt(decodeScVal(reference(ref)), "amount")).toBe(value);
    }
  });

  it("u256 — four limbs, unsigned", () => {
    const value = (1n << 255n) + 12345n;
    const ref = xdr.ScVal.scvU256(
      new xdr.UInt256Parts({
        hiHi: xdr.Uint64.fromString(String(BigInt.asUintN(64, value >> 192n))),
        hiLo: xdr.Uint64.fromString(String(BigInt.asUintN(64, value >> 128n))),
        loHi: xdr.Uint64.fromString(String(BigInt.asUintN(64, value >> 64n))),
        loLo: xdr.Uint64.fromString(String(BigInt.asUintN(64, value))),
      }),
    );
    expect(scInt(decodeScVal(reference(ref)), "u256")).toBe(value);
  });

  it("map — indexed by symbol name, not by wire position", () => {
    // Canonical XDR sorts map keys, so this map's wire order is
    // amount, r_e_point, sigma — not the declaration order it is written in.
    const ref = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("sigma"), val: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: xdr.ScVal.scvU32(700) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("r_e_point"), val: xdr.ScVal.scvBytes(Buffer.alloc(64, 2)) }),
    ]);
    const fields = scMapFields(decodeScVal(reference(ref)), "transfer data");
    expect([...fields.keys()].sort()).toEqual(["amount", "r_e_point", "sigma"]);
    expect(scInt(fields.get("amount"), "amount")).toBe(700n);
  });

  it("vec — the storage-key shape, nested address included", () => {
    const ref = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), new Address(ACCOUNT).toScVal()]);
    expect(decodeScVal(reference(ref))).toEqual({
      type: "vec",
      value: [
        { type: "symbol", value: "Account" },
        { type: "address", value: ACCOUNT },
      ],
    });
  });

  it("rejects a truncated stream instead of decoding a short value", () => {
    const full = base64Decode(reference(xdr.ScVal.scvBytes(Buffer.alloc(64, 9))));
    expect(() => decodeScVal(base64Encode(full.subarray(0, full.length - 8)))).toThrow(/truncated/);
  });

  it("rejects trailing bytes", () => {
    const full = base64Decode(reference(xdr.ScVal.scvU32(1)));
    const padded = new Uint8Array(full.length + 4);
    padded.set(full);
    expect(() => decodeScVal(base64Encode(padded))).toThrow(/trailing/);
  });
});

describe("ScVal — encoding matches @stellar/stellar-base", () => {
  it("produces byte-identical XDR for the storage key shape", () => {
    const ours = encodeScVal(accountEntryKey(ACCOUNT));
    const theirs = reference(
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), new Address(ACCOUNT).toScVal()]),
    );
    expect(ours).toBe(theirs);
  });
});

describe("LedgerKey / LedgerEntryData", () => {
  it("contractDataLedgerKey is byte-identical to the reference encoder", () => {
    const ours = contractDataLedgerKey(CONTRACT, accountEntryKey(ACCOUNT));
    const theirs = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), new Address(ACCOUNT).toScVal()]),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    ).toXDR("base64");
    expect(ours).toBe(theirs);
  });

  it("decodes a ContractDataEntry the reference encoder produced", () => {
    // The shape `confidential_balance` stores: a struct is an ScMap keyed by
    // field-name symbols (storage.rs:51-64).
    const val = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("auditor_id"), val: xdr.ScVal.scvU32(0) }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("receiving_commitment"),
        val: xdr.ScVal.scvBytes(Buffer.alloc(64, 0)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("spendable_commitment"),
        val: xdr.ScVal.scvBytes(Buffer.alloc(64, 3)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("spending_public_key"),
        val: xdr.ScVal.scvBytes(Buffer.alloc(64, 4)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("viewing_public_key"),
        val: xdr.ScVal.scvBytes(Buffer.alloc(64, 5)),
      }),
    ]);
    const entry = xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
        contract: new Address(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), new Address(ACCOUNT).toScVal()]),
        durability: xdr.ContractDataDurability.persistent(),
        val,
      }),
    ).toXDR("base64");

    const decoded = decodeContractDataEntry(entry);
    expect(decoded.contract).toBe(CONTRACT);
    expect(decoded.durability).toBe(DURABILITY_PERSISTENT);
    const fields = scMapFields(decoded.val, "ConfidentialAccount");
    expect([...fields.keys()]).toEqual([
      "auditor_id",
      "receiving_commitment",
      "spendable_commitment",
      "spending_public_key",
      "viewing_public_key",
    ]);
  });
});
