/**
 * The replay engine — DESIGN.md §5.2 steps 1–7.
 *
 * Every case here runs against `ChainSim`, which computes the on-chain
 * commitments from the *sender's* side of the protocol. So a passing test means
 * the replayed opening re-commits to a point derived independently of the
 * replay, which is precisely what step 7 checks against a real chain. Tests are
 * titled by the clause they pin.
 */
import { describe, expect, it } from "vitest";

import { FR, FQ, fqAdd, frAdd } from "../src/crypto/field.js";
import { commit, ecdh } from "../src/crypto/grumpkin.js";
import {
  decryptBalance,
  deriveSpendR,
  deriveTransferBlinding,
} from "../src/crypto/poseidon2.js";
import {
  checkpointPayload,
  compareEvents,
  decodeEvents,
  incomingTransferPayload,
  isSelfTransfer,
  sortEvents,
} from "../src/events.js";
import { findLatestCheckpoint, replay, resolveT0, verifyAgainstChain } from "../src/replay.js";
import { ChainSim, testAddress } from "./chainsim.js";

const ALICE = testAddress(1);
const BOB = testAddress(2);
const SINK = testAddress(3);

const ALICE_SK = 0x0a1c_e000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0001n;
const BOB_SK = 0x0b0b_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0002n;

/** Set up a sim with both accounts registered and Bob funded. */
function setup(): ChainSim {
  const sim = new ChainSim();
  sim.register(ALICE, ALICE_SK);
  sim.register(BOB, BOB_SK);
  sim.deposit(SINK, BOB, 100_000n);
  sim.merge(BOB); // Bob needs spendable funds to send from
  return sim;
}

function recoverAlice(sim: ChainSim) {
  const events = decodeEvents(sim.eventsFor(ALICE));
  return replay({ account: ALICE, vk: sim.account(ALICE).vk, events });
}

describe("DESIGN.md §5.2 — recovery", () => {
  it("step 1 no-checkpoint case: W_spend = (0,0) and T_0 = Register", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 500n);

    const r = recoverAlice(sim);

    expect(r.checkpoint).toBeNull();
    expect(r.spendable).toEqual({ v: 0n, r: 0n });
    expect(r.t0Anchor).toBe("register");
    expect(r.receiving.v).toBe(500n);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("steps 2-4 recover the spendable opening from the checkpoint alone", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    sim.merge(ALICE);
    sim.transfer(ALICE, BOB, 250n); // Alice's checkpoint

    const r = recoverAlice(sim);

    expect(r.checkpoint?.type).toBe("transfer");
    // No history was needed for the spendable side: it came from (b̃, σ).
    expect(r.spendable).toEqual(sim.account(ALICE).spendable);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("step 6 deposit rule accumulates (amount, 0) — zero blinding", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 300n);
    sim.deposit(SINK, ALICE, 700n);

    const r = recoverAlice(sim);

    expect(r.receiving).toEqual({ v: 1_000n, r: 0n });
    expect(r.counts.deposits).toBe(2);
  });

  it("step 6 incoming-transfer rule: ECDH decrypt reproduces the sender's opening", () => {
    const sim = setup();
    sim.transfer(BOB, ALICE, 4_200n);

    const r = recoverAlice(sim);

    // The recipient derived (v, r) from its own vk and the event's R_e; the
    // sim derived them from r_e and the recipient's PVK. Equality here is
    // ECDH commutativity holding across two independent derivations.
    expect(r.receiving).toEqual(sim.account(ALICE).receiving);
    expect(r.receiving.v).toBe(4_200n);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("step 6 merge rule folds receiving into spendable and resets it", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 900n);
    sim.transfer(BOB, ALICE, 100n);
    sim.merge(ALICE);

    const r = recoverAlice(sim);

    expect(r.receiving).toEqual({ v: 0n, r: 0n });
    expect(r.spendable.v).toBe(1_000n);
    expect(r.counts.merges).toBe(1);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("step 6 self-transfer is applied in BOTH roles", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    sim.merge(ALICE);
    const ev = sim.transfer(ALICE, ALICE, 400n); // from === to

    const events = decodeEvents(sim.eventsFor(ALICE));
    const self = events.find((e) => e.id === ev.id)!;
    expect(isSelfTransfer(self, ALICE)).toBe(true);

    const r = replay({ account: ALICE, vk: sim.account(ALICE).vk, events });

    // Sender side: spendable overwritten from (b̃, σ) → 600.
    expect(r.spendable.v).toBe(600n);
    // Recipient side: the same event also credits 400 to receiving.
    expect(r.receiving.v).toBe(400n);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("step 7 fails closed when one event is withheld", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    sim.transfer(BOB, ALICE, 500n);

    const all = decodeEvents(sim.eventsFor(ALICE));
    const withheld = all.filter((e) => e.type !== "deposit");
    const r = replay({ account: ALICE, vk: sim.account(ALICE).vk, events: withheld });

    const v = verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE));
    expect(v.ok).toBe(false);
    expect(v.receivingOk).toBe(false);
    // §10.6 requires naming which accumulator diverged.
    expect(v.detail).toMatch(/receiving/);
  });

  it("step 7 fails closed on a duplicated credit", () => {
    const sim = setup();
    sim.transfer(BOB, ALICE, 500n);

    const events = decodeEvents(sim.eventsFor(ALICE));
    const transfer = events.find((e) => e.type === "transfer")!;
    // A duplicate that dedup did not catch, e.g. a mangled event id.
    const doubled = [...events, { ...transfer, id: `${transfer.id}-dup` }];
    const r = replay({ account: ALICE, vk: sim.account(ALICE).vk, events: doubled });

    expect(r.receiving.v).toBe(1_000n);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(false);
  });

  it("a wrong viewing key is refused by step 7, not silently accepted", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    sim.merge(ALICE);
    sim.transfer(ALICE, BOB, 100n);

    const events = decodeEvents(sim.eventsFor(ALICE));
    const r = replay({ account: ALICE, vk: sim.account(BOB).vk, events });

    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(false);
  });
});

describe("INDEXER.md §2 — T_0 is the last Merge AT OR BEFORE the checkpoint", () => {
  /**
   * The trap the spec flags hardest, and the exact history
   * `scripts/deployment.json` was built to contain:
   *
   *   deposit → merge(M1) → transfers in → merge(M2) → withdraw(CP) → merge(M3)
   *
   * M3 lands after the checkpoint. An implementation that anchors at "the last
   * merge overall" takes M3, replays nothing, and reconstructs a receiving side
   * that is correct — while the spendable side is short by whatever M3 folded
   * in. The receiving check still passes, which is what makes it quiet.
   */
  function trapHistory(): ChainSim {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    sim.merge(ALICE); // M1
    sim.transfer(BOB, ALICE, 700n);
    sim.transfer(BOB, ALICE, 300n);
    sim.merge(ALICE); // M2 — the correct T_0
    sim.withdraw(ALICE, SINK, 400n); // CP — the latest checkpoint
    sim.transfer(BOB, ALICE, 600n); // credit after the checkpoint
    sim.merge(ALICE); // M3 — AFTER the checkpoint
    return sim;
  }

  it("resolves T_0 to the merge before the checkpoint, not the last merge overall", () => {
    const sim = trapHistory();
    const events = sortEvents(decodeEvents(sim.eventsFor(ALICE)));
    const checkpoint = findLatestCheckpoint(events, ALICE);
    expect(checkpoint?.type).toBe("withdraw");

    const merges = events.filter((e) => e.type === "merge");
    expect(merges).toHaveLength(3);
    const { t0, anchor } = resolveT0(events, ALICE, checkpoint);

    expect(anchor).toBe("merge");
    // M2, not M3.
    expect(t0?.id).toBe(merges[1]!.id);
    expect(t0!.ledgerSeq).toBeLessThan(checkpoint!.ledgerSeq);
    expect(merges[2]!.ledgerSeq).toBeGreaterThan(checkpoint!.ledgerSeq);
  });

  it("reconstructs the opening the chain actually holds", () => {
    const sim = trapHistory();
    const r = recoverAlice(sim);

    expect(r.spendable).toEqual(sim.account(ALICE).spendable);
    expect(r.receiving).toEqual(sim.account(ALICE).receiving);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("anchoring at the last merge overall is short on the spendable side only", () => {
    const sim = trapHistory();
    const vk = sim.account(ALICE).vk;
    const events = sortEvents(decodeEvents(sim.eventsFor(ALICE)));

    // The wrong implementation, written out. Steps 1-4 are identical — it finds
    // the same checkpoint and decrypts the same (b̃, σ) — and only step 5
    // differs: T_0 is taken as the account's last merge *overall*.
    const checkpoint = findLatestCheckpoint(events, ALICE)!;
    const { bTilde, sigma } = checkpointPayload(checkpoint);
    const wrongSpendable = { v: decryptBalance(bTilde, vk, sigma), r: deriveSpendR(vk, sigma) };
    const merges = events.filter((e) => e.type === "merge");
    const wrongT0 = merges[merges.length - 1]!;
    // Nothing in this history follows M3, so the wrong window is empty and
    // W_spend is left at its checkpoint value, never folding in M3's credits.
    expect(events.filter((e) => compareEvents(e, wrongT0) > 0)).toHaveLength(0);
    const wrongReceiving = { v: 0n, r: 0n };

    const right = recoverAlice(sim);

    // The receiving side still verifies — that is what makes the bug quiet.
    expect(wrongReceiving).toEqual(right.receiving);
    // The spendable side is short by exactly what M3 folded in (the 600 credit).
    expect(right.spendable.v).toBe(2_200n);
    expect(wrongSpendable.v).toBe(1_600n);
    expect(right.spendable.v - wrongSpendable.v).toBe(600n);
    expect(verifyAgainstChain(wrongSpendable, wrongReceiving, sim.onChain(ALICE)).ok).toBe(false);
    expect(verifyAgainstChain(right.spendable, right.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("T_0 falls back to Register when every merge is after the checkpoint", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    sim.merge(ALICE);
    sim.transfer(ALICE, BOB, 100n); // checkpoint, but the merge above precedes it

    const events = sortEvents(decodeEvents(sim.eventsFor(ALICE)));
    const cp = findLatestCheckpoint(events, ALICE);
    // Sanity: this history's merge IS before the checkpoint.
    expect(resolveT0(events, ALICE, cp).anchor).toBe("merge");

    // Now the same history with the merge removed from view.
    const withoutMerge = events.filter((e) => e.type !== "merge");
    expect(resolveT0(withoutMerge, ALICE, cp).anchor).toBe("register");
  });

  it("reports stream-start when the history does not reach registration", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 100n);
    const events = decodeEvents(sim.eventsFor(ALICE)).filter((e) => e.type !== "register");
    const r = replay({ account: ALICE, vk: sim.account(ALICE).vk, events });
    expect(r.t0Anchor).toBe("stream-start");
  });
});

describe("INDEXER.md §3.4 — ordering", () => {
  it("a merge and a deposit in one ledger reconstruct by tx_application_order", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 1_000n);
    // Two operations sharing a ledger: the merge applies first, then the
    // deposit credits the receiving side it just reset. Ordering by ledger
    // alone cannot distinguish this from the reverse.
    sim.merge(ALICE);
    sim.deposit(SINK, ALICE, 250n);

    const r = recoverAlice(sim);
    expect(r.spendable.v).toBe(1_000n);
    expect(r.receiving.v).toBe(250n);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("replay is order-insensitive at the input: shuffled events sort back", () => {
    const sim = setup();
    sim.deposit(SINK, ALICE, 500n);
    sim.transfer(BOB, ALICE, 300n);
    sim.merge(ALICE);
    sim.transfer(BOB, ALICE, 200n);

    const events = decodeEvents(sim.eventsFor(ALICE));
    const shuffled = [...events].reverse();
    expect(replay({ account: ALICE, vk: sim.account(ALICE).vk, events: shuffled })).toEqual(
      replay({ account: ALICE, vk: sim.account(ALICE).vk, events }),
    );
  });
});

describe("INDEXER.md §3.2 — a Transfer checkpoints its sender only", () => {
  it("the recipient does not adopt the sender's (b_tilde, sigma)", () => {
    const sim = setup();
    sim.transfer(BOB, ALICE, 900n);

    const events = decodeEvents(sim.eventsFor(ALICE));
    // The transfer is in Alice's history (she is the `to`), but it is not
    // her checkpoint — adopting it would decrypt Bob's balance with her vk.
    expect(findLatestCheckpoint(events, ALICE)).toBeNull();

    const r = replay({ account: ALICE, vk: sim.account(ALICE).vk, events });
    expect(r.spendable).toEqual({ v: 0n, r: 0n });
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
  });

  it("the same event IS the sender's checkpoint", () => {
    const sim = setup();
    sim.transfer(BOB, ALICE, 900n);

    const bobEvents = decodeEvents(sim.eventsFor(BOB));
    expect(findLatestCheckpoint(bobEvents, BOB)?.type).toBe("transfer");

    const r = replay({ account: BOB, vk: sim.account(BOB).vk, events: bobEvents });
    expect(r.spendable).toEqual(sim.account(BOB).spendable);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(BOB)).ok).toBe(true);
  });
});

describe("SDK.md §4.6 — blindings accumulate mod q, never mod r", () => {
  it("the two moduli are different and F_r < F_q", () => {
    expect(FR).toBeLessThan(FQ);
  });

  it("a many-credit history only verifies under mod-q accumulation", () => {
    // Enough incoming transfers that the blinding sum crosses q with
    // overwhelming probability — each r_transfer is a near-full-size F_r
    // element, so the running sum wraps repeatedly.
    const sim = setup();
    sim.deposit(SINK, BOB, 10_000_000n);
    sim.merge(BOB);
    for (let i = 0; i < 12; i++) sim.transfer(BOB, ALICE, BigInt(100 + i));

    const r = recoverAlice(sim);
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);

    // Re-accumulate the same per-transfer blindings mod r instead of mod q and
    // confirm it opens a different commitment — the failure SDK.md §4.6 says
    // presents as funds that are spendable about half the time.
    const events = sortEvents(decodeEvents(sim.eventsFor(ALICE)));
    let modQ = 0n;
    let modR = 0n;
    for (const e of events) {
      if (e.type !== "transfer") continue;
      const p = incomingTransferPayload(e);
      const blind = deriveTransferBlinding(ecdh(sim.account(ALICE).vk, p.rEPoint), p.sigma);
      modQ = fqAdd(modQ, blind);
      modR = frAdd(modR, blind);
    }
    expect(modQ).not.toBe(modR);
    expect(r.receiving.r).toBe(modQ);
    expect(commit(r.receiving.v, modR)).not.toEqual(sim.onChain(ALICE).receivingCommitment);
  });
});
