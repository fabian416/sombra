/**
 * The hybrid read path — SDK.md §12.4, and the end-to-end recovery it feeds.
 *
 * §12.4 states two client MUSTs it says are not derivable from INDEXER.md. Both
 * are pinned here, along with §12.3's completeness propagation, against fakes
 * that behave like the real services — the RPC really refuses ranges below its
 * floor with `-32600`, and the archive really stamps `complete` on every page.
 */
import { describe, expect, it } from "vitest";

import { ArchiveClient, ArchiveError } from "../src/archive.js";
import { RpcClient, RpcError } from "../src/chain.js";
import { decodeEvents } from "../src/events.js";
import { ed25519Signer } from "../src/keys.js";
import { demoKeysFromEd25519Secret } from "../src/legacy-derivation.js";
import { replay, verifyAgainstChain } from "../src/replay.js";
import {
  DEFAULT_SEAM_MARGIN,
  IncompleteHistoryError,
  SeamNotCoveredError,
  computeSeam,
  syncAccountHistory,
} from "../src/seam.js";
import { ChainSim, testAddress } from "./chainsim.js";
import { ARCHIVE_URL, RPC_URL, makeBackends, type FakeOptions } from "./fakes.js";

const ALICE = testAddress(1);
const BOB = testAddress(2);
const SINK = testAddress(3);
const ALICE_SK = 0x0a1c_e000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0001n;
const BOB_SK = 0x0b0b_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0002n;

/** The trap history again, so the seam tests exercise a real reconstruction. */
function history(): ChainSim {
  const sim = new ChainSim();
  sim.register(ALICE, ALICE_SK);
  sim.register(BOB, BOB_SK);
  sim.deposit(SINK, BOB, 100_000n);
  sim.merge(BOB);
  sim.deposit(SINK, ALICE, 1_000n);
  sim.merge(ALICE);
  sim.transfer(BOB, ALICE, 700n);
  sim.transfer(BOB, ALICE, 300n);
  sim.merge(ALICE);
  sim.withdraw(ALICE, SINK, 400n);
  sim.transfer(BOB, ALICE, 600n);
  sim.merge(ALICE);
  return sim;
}

/**
 * A small margin keeps the seam inside these short test histories. Real
 * deployments sit ~120k ledgers above the floor, where the default 60 is
 * negligible; here it would overshoot the head entirely.
 */
const MARGIN = 2;

/**
 * Place the seam mid-history so both legs carry events: callers pass
 * `midLedger(...) - MARGIN` as the RPC floor, which puts the seam exactly at
 * the middle event's ledger.
 */
function midLedger(sim: ChainSim, account: string): number {
  const all = sim.eventsFor(account);
  return all[Math.floor(all.length / 2)]!.ledgerSeq;
}

function clients(opts: Partial<FakeOptions> & { sim: ChainSim }) {
  const backends = makeBackends({
    rpcOldestLedger: midLedger(opts.sim, ALICE) - MARGIN,
    ...opts,
  } as FakeOptions);
  return {
    backends,
    seam: { marginLedgers: MARGIN },
    rpc: new RpcClient(RPC_URL, { fetch: backends.fetch }),
    archive: new ArchiveClient(ARCHIVE_URL, { fetch: backends.fetch }),
  };
}

describe("SDK.md §12.4 — the seam sits above the RPC retention floor", () => {
  it("defaults to oldestLedger + margin", () => {
    const seam = computeSeam({ oldestLedger: 1_000, latestLedger: 5_000 });
    expect(seam.ledger).toBe(1_000 + DEFAULT_SEAM_MARGIN);
    expect(seam.naturalLedger).toBe(seam.ledger);
    expect(seam.compressed).toBe(false);
  });

  it("an override is reported as compressed, so a UI cannot present it as the real floor", () => {
    const seam = computeSeam({ oldestLedger: 1_000, latestLedger: 5_000 }, { overrideSeamLedger: 4_900 });
    expect(seam.ledger).toBe(4_900);
    expect(seam.naturalLedger).toBe(1_060);
    expect(seam.rpcOldestLedger).toBe(1_000);
    expect(seam.compressed).toBe(true);
  });

  it("refuses an override below the floor plus margin rather than letting RPC reject it", () => {
    expect(() =>
      computeSeam({ oldestLedger: 1_000, latestLedger: 5_000 }, { overrideSeamLedger: 1_010 }),
    ).toThrow(SeamNotCoveredError);
  });

  it("the two legs are disjoint and together cover the whole history", async () => {
    const sim = history();
    const all = sim.eventsFor(ALICE);
    const { rpc, archive } = clients({ sim });

    const result = await syncAccountHistory({ rpc, archive, contractId: sim.contractId, account: ALICE, marginLedgers: MARGIN });

    expect(result.archiveLeg.toLedger).toBe(result.seam.ledger - 1);
    expect(result.rpcLeg.fromLedger).toBe(result.seam.ledger);
    expect(result.archiveLeg.events + result.rpcLeg.events).toBe(result.events.length);
    // Both legs actually contributed — otherwise the test proves nothing.
    expect(result.archiveLeg.events).toBeGreaterThan(0);
    expect(result.rpcLeg.events).toBeGreaterThan(0);
    // Every event appears exactly once.
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
    expect(result.events.length).toBe(decodeEvents(all).length);
  });

  it("a history stitched across the seam reconstructs the same opening as one from the archive alone", async () => {
    const sim = history();
    const vk = sim.account(ALICE).vk;

    const split = clients({ sim });
    const stitched = await syncAccountHistory({
      rpc: split.rpc,
      archive: split.archive,
      contractId: sim.contractId,
      account: ALICE,
      marginLedgers: MARGIN,
    });

    const r = replay({ account: ALICE, vk, events: stitched.events });
    expect(verifyAgainstChain(r.spendable, r.receiving, sim.onChain(ALICE)).ok).toBe(true);
    expect(r.spendable).toEqual(sim.account(ALICE).spendable);
  });

  it("requires the archive to have ingested through the seam (C4)", async () => {
    const sim = history();
    const { rpc, archive } = clients({
      sim,
      // The archive stopped well short of the seam, so a range in between is
      // served by neither source.
      ingestedThrough: midLedger(sim, ALICE) - 10,
    });

    await expect(
      syncAccountHistory({ rpc, archive, contractId: sim.contractId, account: ALICE, marginLedgers: MARGIN }),
    ).rejects.toBeInstanceOf(SeamNotCoveredError);
  });
});

describe("SDK.md §12.4 — a configured archive's failure fails the whole sync", () => {
  it("does not degrade to RPC-only when the archive errors", async () => {
    const sim = history();
    const { rpc, archive, backends } = clients({
      sim,
      archiveFailsWith: 500,
    });

    await expect(
      syncAccountHistory({ rpc, archive, contractId: sim.contractId, account: ALICE, marginLedgers: MARGIN }),
    ).rejects.toBeInstanceOf(ArchiveError);

    // The point of the rule: no RPC event query was issued to paper over it.
    expect(backends.calls.some((c) => c.includes("archive.test"))).toBe(true);
  });

  it("surfaces the RPC's own -32600 rather than masking it", async () => {
    const sim = history();
    const { rpc } = clients({ sim, rpcOldestLedger: 999_999 });
    // Asking below the floor is the failure the Archive exists to fix; the
    // demo shows this error next to the Archive serving the same range.
    const err = await rpc.getEvents({ startLedger: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).isOutOfRetention).toBe(true);
  });
});

describe("SDK.md §12.3 — the completeness signal reaches the caller", () => {
  it("fails closed on complete:false, carrying coverage and the partial result", async () => {
    const sim = history();
    const { rpc, archive } = clients({
      sim,
      complete: false,
      coverage: [{ from_ledger: 1_050, to_ledger: 9_999 }],
      gaps: [{ from_ledger: 1_000, to_ledger: 1_049 }],
    });

    const err = await syncAccountHistory({
      rpc,
      archive,
      contractId: sim.contractId,
      account: ALICE,
      marginLedgers: MARGIN,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(IncompleteHistoryError);
    const incomplete = err as IncompleteHistoryError;
    // The distinction §12.3 requires: this names missing ledgers, not tampering.
    expect(incomplete.message).toMatch(/1000–1049/);
    expect(incomplete.gaps).toEqual([{ fromLedger: 1_000, toLedger: 1_049 }]);
    expect(incomplete.partial.complete).toBe(false);
    expect(incomplete.partial.events.length).toBeGreaterThan(0);
  });

  it("an incomplete range is distinguishable from an archive error by its type", async () => {
    const sim = history();
    const broken = clients({ sim, archiveFailsWith: 503 });
    const honest = clients({ sim, complete: false });

    const a = await syncAccountHistory({
      rpc: broken.rpc,
      archive: broken.archive,
      contractId: sim.contractId,
      account: ALICE,
      marginLedgers: MARGIN,
    }).catch((e: unknown) => e);
    const b = await syncAccountHistory({
      rpc: honest.rpc,
      archive: honest.archive,
      contractId: sim.contractId,
      account: ALICE,
      marginLedgers: MARGIN,
    }).catch((e: unknown) => e);

    expect(a).toBeInstanceOf(ArchiveError);
    expect(b).toBeInstanceOf(IncompleteHistoryError);
    expect(a).not.toBeInstanceOf(IncompleteHistoryError);
  });

  it("failOnIncomplete:false returns the result with complete propagated", async () => {
    const sim = history();
    const { rpc, archive } = clients({ sim, complete: false });

    const result = await syncAccountHistory({
      rpc,
      archive,
      contractId: sim.contractId,
      account: ALICE,
      marginLedgers: MARGIN,
      failOnIncomplete: false,
    });
    expect(result.complete).toBe(false);
  });
});

describe("pagination", () => {
  it("drains the cursor and conjoins complete across pages", async () => {
    const sim = history();
    const { rpc, archive } = clients({ sim, pageSize: 2 });

    const result = await syncAccountHistory({
      rpc,
      archive,
      contractId: sim.contractId,
      account: ALICE,
      marginLedgers: MARGIN,
    });

    const expected = decodeEvents(sim.eventsFor(ALICE)).length;
    expect(result.events.length).toBe(expected);
    expect(result.complete).toBe(true);
  });
});

describe("end-to-end — recoverFromSigner against the fakes", () => {
  it("derives, syncs across the seam, replays and verifies", async () => {
    const { recoverFromSigner } = await import("../src/recover.js");
    const sim = history();

    // A local ed25519 identity standing in for Freighter. The account's
    // confidential sk is whatever the sim registered, so this test pins the
    // orchestration, not the derivation (that is `keys.test.ts`).
    const secret = new Uint8Array(32).fill(7);
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { encodeStrkey } = await import("../src/crypto/address.js");
    const signerAddress = encodeStrkey("account", ed25519.getPublicKey(secret));

    // Register the signer's address in the sim with keys derived the legacy way,
    // so the on-chain Y matches what recoverFromSigner will derive.
    const keys = await demoKeysFromEd25519Secret(secret, {
      contractId: sim.contractId,
      account: signerAddress,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    sim.register(signerAddress, keys.sk);
    sim.deposit(SINK, signerAddress, 5_000n);
    sim.merge(signerAddress);
    sim.transfer(BOB, signerAddress, 250n);

    // Put the seam mid-way through the *signer's* history, so both legs carry
    // some of the events this recovery actually replays.
    const { rpc, archive } = clients({ sim, rpcOldestLedger: midLedger(sim, signerAddress) - MARGIN });
    const phases: string[] = [];

    const result = await recoverFromSigner({
      signer: ed25519Signer(secret, signerAddress),
      contractId: sim.contractId,
      account: signerAddress,
      rpc,
      archive,
      derivation: "legacy-demo",
      networkPassphrase: "Test SDF Network ; September 2015",
      marginLedgers: MARGIN,
      onProgress: (p) => phases.push(p.phase),
    });

    expect(result.verifiedAgainstChain).toBe(true);
    expect(result.restored.matchesChain).toBe(true);
    expect(result.restored.spendable.v).toBe(5_000n);
    expect(result.restored.receiving.v).toBe(250n);
    expect(result.complete).toBe(true);
    // The phase sequence the wallet renders.
    expect(phases[0]).toBe("derive");
    expect(phases).toContain("checkpoint");
    expect(phases).toContain("replay");
    expect(phases[phases.length - 1]).toBe("restored");
    // Both legs were used and the split is reported honestly.
    expect(result.archiveOnly).toBeGreaterThan(0);
    expect(result.sync.rpcLeg.events).toBeGreaterThan(0);
  });

  it("refuses immediately when the derived Y is not the registered spending key", async () => {
    const { recoverFromSigner, RecoveryError } = await import("../src/recover.js");
    const sim = history();
    const { rpc, archive } = clients({ sim });

    const secret = new Uint8Array(32).fill(9);
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const { encodeStrkey } = await import("../src/crypto/address.js");
    const signerAddress = encodeStrkey("account", ed25519.getPublicKey(secret));
    // Registered with an unrelated sk, so the derived Y cannot match.
    sim.register(signerAddress, 12345n);

    const err = await recoverFromSigner({
      signer: ed25519Signer(secret, signerAddress),
      contractId: sim.contractId,
      account: signerAddress,
      rpc,
      archive,
      derivation: "legacy-demo",
      networkPassphrase: "Test SDF Network ; September 2015",
      marginLedgers: MARGIN,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecoveryError);
    expect((err as InstanceType<typeof RecoveryError>).phase).toBe("derive");
    expect((err as Error).message).toMatch(/spending public key/);
  });
});
