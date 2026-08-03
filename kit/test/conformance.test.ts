/**
 * Cross-language conformance — SDK.md §6.1.
 *
 * "An implementation MUST reproduce every output in every file byte-for-byte.
 *  Its test suite MUST read those files rather than transcribe their values
 *  into source."
 *
 * Both halves are honoured here: every expected value below is read from
 * `circuits/lib/testdata/*.json` at run time, and the final test asserts that
 * **every file in the directory is consumed by a test in this file** — so a
 * new fixture added upstream fails the suite instead of being quietly ignored.
 *
 * Each test is titled with the primitive and the design-doc section it pins.
 */
import { describe, expect, it } from "vitest";

import { addressToField } from "../src/crypto/address.js";
import { FQ, FR, fqAdd, frAdd, toHex32 } from "../src/crypto/field.js";
import {
  H,
  commit,
  ecdh,
  pointAdd,
  publicViewingKey,
  scalarMul,
} from "../src/crypto/grumpkin.js";
import {
  deriveAllowR,
  deriveSpendR,
  deriveTransferBlinding,
  dvkFromVkOp,
  encryptAllowance,
  encryptAmount,
  encryptAuditorSenderBalance,
  encryptBalance,
  encryptEscrowedDvk,
  poseidonWithDomain,
  spongeSqueeze2,
  vkFromSk,
} from "../src/crypto/poseidon2.js";
import { fixtureNames, fx, fxPoint, loadFixture, testdataAvailable } from "./fixtures.js";

/** Files this suite consumes. Cross-checked against the directory listing. */
const consumed = new Set<string>();

function fixture<I, O>(name: string) {
  consumed.add(`${name}.json`);
  return loadFixture<I, O>(name);
}

/** Points compare by coordinate, but report as hex so a diff is readable. */
function expectPoint(actual: { x: bigint; y: bigint }, expected: { x: bigint; y: bigint }): void {
  expect([toHex32(actual.x), toHex32(actual.y)]).toEqual([
    toHex32(expected.x),
    toHex32(expected.y),
  ]);
}

describe("SDK.md §6.1 — conformance fixtures", () => {
  it("the testdata directory is present", () => {
    // A skipped conformance suite reports green, which is worse than red.
    expect(testdataAvailable()).toBe(true);
  });

  it("poseidon_with_domain — DESIGN.md §2.5 sponge, domain tag absorbed first", () => {
    const f = fixture<{ domain: string; inputs: string[] }, string>("poseidon_with_domain");
    for (const v of f.vectors) {
      const out = poseidonWithDomain(fx(v.inputs.domain), v.inputs.inputs.map(fx));
      expect(toHex32(out)).toBe(v.output);
    }
  });

  it("sponge_squeeze_2 — DESIGN.md §2.5 two-mask mode, both channel tags", () => {
    const f = fixture<{ d: string; s: string; sigma: string }, string[]>("sponge_squeeze_2");
    for (const v of f.vectors) {
      const [lane0, lane1] = spongeSqueeze2(fx(v.inputs.d), fx(v.inputs.s), fx(v.inputs.sigma));
      expect([toHex32(lane0), toHex32(lane1)]).toEqual(v.output);
    }
  });

  it("sponge_squeeze_2 lane 0 equals poseidon_with_domain on the same inputs (§4.3 self-check)", () => {
    // SDK.md §4.3: "An implementation that reproduces both has the block
    // layout and the IV lane right." Derived from the fixture, not asserted
    // against a transcribed constant.
    const f = loadFixture<{ d: string; s: string; sigma: string }, string[]>("sponge_squeeze_2");
    for (const v of f.vectors) {
      const single = poseidonWithDomain(fx(v.inputs.d), [fx(v.inputs.s), fx(v.inputs.sigma)]);
      expect(toHex32(single)).toBe(v.output[0]);
    }
  });

  it("vk_from_sk — DESIGN.md §4.2, contract-bound viewing key", () => {
    const f = fixture<{ sk: string; wrap: string }, string>("vk_from_sk");
    for (const v of f.vectors) {
      expect(toHex32(vkFromSk(fx(v.inputs.sk), fx(v.inputs.wrap)))).toBe(v.output);
    }
  });

  it("pvk_from_vk — DESIGN.md §4.3, PVK = vk·H", () => {
    const f = fixture<{ vk: string }, { x: string; y: string }>("pvk_from_vk");
    for (const v of f.vectors) {
      expectPoint(publicViewingKey(fx(v.inputs.vk)), fxPoint(v.output));
    }
  });

  it("dvk_from_vk_op — DESIGN.md §4.4, delegation viewing key", () => {
    const f = fixture<{ vk: string; op_i: string }, string>("dvk_from_vk_op");
    for (const v of f.vectors) {
      expect(toHex32(dvkFromVkOp(fx(v.inputs.vk), fx(v.inputs.op_i)))).toBe(v.output);
    }
  });

  it("scalar_mul — DESIGN.md §4.1, Y = sk·H on Grumpkin", () => {
    const f = fixture<{ scalar: string; point: string }, { x: string; y: string }>("scalar_mul");
    for (const v of f.vectors) {
      expect(v.inputs.point).toBe("H");
      expectPoint(scalarMul(fx(v.inputs.scalar), H), fxPoint(v.output));
    }
  });

  it("commit — DESIGN.md §2.3, Pedersen v·G + r·H", () => {
    const f = fixture<{ value: string; randomness: string }, { x: string; y: string }>("commit");
    for (const v of f.vectors) {
      expectPoint(commit(fx(v.inputs.value), fx(v.inputs.randomness)), fxPoint(v.output));
    }
  });

  it("ecdh — DESIGN.md §2.4, both coordinates of S absorbed", () => {
    const f = fixture<{ scalar: string; point: string }, string>("ecdh");
    for (const v of f.vectors) {
      expect(v.inputs.point).toBe("H");
      expect(toHex32(ecdh(fx(v.inputs.scalar), H))).toBe(v.output);
    }
  });

  it("derive_spend_r — DESIGN.md §5.2, deterministic spendable blinding", () => {
    const f = fixture<{ vk: string; sigma: string }, string>("derive_spend_r");
    for (const v of f.vectors) {
      expect(toHex32(deriveSpendR(fx(v.inputs.vk), fx(v.inputs.sigma)))).toBe(v.output);
    }
  });

  it("derive_allow_r — DESIGN.md §6.2, allowance blinding", () => {
    const f = fixture<{ dvk: string; sigma_a: string }, string>("derive_allow_r");
    for (const v of f.vectors) {
      expect(toHex32(deriveAllowR(fx(v.inputs.dvk), fx(v.inputs.sigma_a)))).toBe(v.output);
    }
  });

  it("derive_transfer_blind — DESIGN.md §5.3, the anti-poisoning blinding", () => {
    const f = fixture<{ s: string; sigma: string }, string>("derive_transfer_blind");
    for (const v of f.vectors) {
      expect(toHex32(deriveTransferBlinding(fx(v.inputs.s), fx(v.inputs.sigma)))).toBe(v.output);
    }
  });

  it("encrypt_balance — DESIGN.md §5.5, the checkpoint ciphertext b̃", () => {
    const f = fixture<{ v_new: string; vk: string; sigma: string }, string>("encrypt_balance");
    for (const v of f.vectors) {
      expect(toHex32(encryptBalance(fx(v.inputs.v_new), fx(v.inputs.vk), fx(v.inputs.sigma)))).toBe(
        v.output,
      );
    }
  });

  it("encrypt_amount — DESIGN.md §5.3, the incoming-transfer ciphertext ṽ", () => {
    const f = fixture<{ v_transfer: string; s: string; sigma: string }, string>("encrypt_amount");
    for (const v of f.vectors) {
      expect(
        toHex32(encryptAmount(fx(v.inputs.v_transfer), fx(v.inputs.s), fx(v.inputs.sigma))),
      ).toBe(v.output);
    }
  });

  it("encrypt_allowance — DESIGN.md §6.2, allowance ciphertext ã", () => {
    const f = fixture<{ v_a: string; dvk: string; sigma_a: string }, string>("encrypt_allowance");
    for (const v of f.vectors) {
      expect(
        toHex32(encryptAllowance(fx(v.inputs.v_a), fx(v.inputs.dvk), fx(v.inputs.sigma_a))),
      ).toBe(v.output);
    }
  });

  it("encrypt_esc_dvk — DESIGN.md §7.11, delegation-key escrow", () => {
    const f = fixture<{ dvk: string; s: string; op_i: string }, string>("encrypt_esc_dvk");
    for (const v of f.vectors) {
      expect(
        toHex32(encryptEscrowedDvk(fx(v.inputs.dvk), fx(v.inputs.s), fx(v.inputs.op_i))),
      ).toBe(v.output);
    }
  });

  it("encrypt_auditor_sender_balance — W_a3/W_a4, lane 1 of the sender channel", () => {
    const f = fixture<{ v_new: string; s_a_s: string; sigma: string }, string>(
      "encrypt_auditor_sender_balance",
    );
    for (const v of f.vectors) {
      expect(
        toHex32(
          encryptAuditorSenderBalance(fx(v.inputs.v_new), fx(v.inputs.s_a_s), fx(v.inputs.sigma)),
        ),
      ).toBe(v.output);
    }
  });

  it("address_to_field — DESIGN.md §2.7, the one primitive with two implementations", () => {
    const f = fixture<{ strkey: string }, string>("address_to_field");
    for (const v of f.vectors) {
      expect(toHex32(addressToField(v.inputs.strkey))).toBe(v.output);
    }
  });

  /**
   * SDK.md §4.6 — blinding accumulation is mod **q**, never mod **r**.
   *
   * INTEGRATION.md calls this "a correctness landmine, not a convenience". It
   * has no fixture of its own, so the vectors come from the fixtures that
   * produce the blindings the replay engine actually accumulates:
   * `derive_transfer_blind` (the recipient-channel blinding) and
   * `derive_spend_r` (the post-checkpoint spendable blinding). Both are
   * full-size F_r elements, and `q` is only marginally above `r`, so a pair of
   * them crosses `q` about half the time — §4.6's own estimate of how often the
   * bug bites.
   */
  it("blinding accumulation is mod q, not mod r — SDK.md §4.6", () => {
    const blindings: bigint[] = [];
    for (const name of ["derive_transfer_blind", "derive_spend_r", "derive_allow_r"]) {
      const f = loadFixture<Record<string, string>, string>(name);
      for (const v of f.vectors) blindings.push(fx(v.output));
    }
    expect(blindings.length).toBeGreaterThan(1);

    // A pair whose integer sum crosses q. Its existence is the point: these are
    // real protocol blindings, not values chosen to make the test work.
    let crossing: [bigint, bigint] | null = null;
    for (let i = 0; i < blindings.length && crossing === null; i++) {
      for (let j = i + 1; j < blindings.length; j++) {
        if (blindings[i]! + blindings[j]! >= FQ) {
          crossing = [blindings[i]!, blindings[j]!];
          break;
        }
      }
    }
    expect(crossing).not.toBeNull();
    const [a, b] = crossing!;

    // Both sums reduce exactly once, and r < q, so the mod-r sum overshoots by
    // exactly q − r — the off-by-amount §4.6 names.
    expect(fqAdd(a, b)).not.toBe(frAdd(a, b));
    expect(frAdd(a, b) - fqAdd(a, b)).toBe(FQ - FR);

    // Only the mod-q sum preserves the Pedersen homomorphism, which is the
    // property step 7's re-commitment check actually tests.
    const value = 1_000n;
    const combined = pointAdd(commit(value, a), commit(0n, b));
    expectPoint(commit(value, fqAdd(a, b)), combined);
    expect(commit(value, frAdd(a, b))).not.toEqual(combined);
  });

  it("consumes every fixture in the directory", () => {
    // README.md in testdata/ is not a fixture; everything else must be covered.
    const present = fixtureNames();
    const missed = present.filter((n) => !consumed.has(n));
    expect(missed).toEqual([]);
    expect(consumed.size).toBe(present.length);
  });
});
