/**
 * The hybrid read path — SDK.md §12.4, INDEXER.md §1.
 *
 * RPC and the archive compose: the RPC serves the recent tail, the archive
 * everything older, and the client stitches them at a *seam*. §12.4 specifies
 * two rules it says explicitly are **not** derivable from INDEXER.md, and both
 * are MUSTs on the client. They are the whole content of this module.
 *
 * **1. The seam sits strictly above the RPC's retention floor, by a margin.**
 * The floor advances while the client works — between reading it and issuing
 * the range query, with an archive request in between taking real time — so a
 * seam placed at the observed floor intermittently produces a rejected query.
 * The archive covers everything below the seam, so the margin loses no events.
 * The two legs are put on **disjoint** ranges so correctness never depends on
 * cross-source id equality, and they are still deduplicated as a guard.
 *
 * **2. A configured archive's failure fails the whole sync.** Every path out of
 * this module on an archive error is a throw. There is no try/catch that
 * degrades to RPC-only, deliberately: degrading would persist a sync position
 * derived from the RPC leg alone, moving it past the pre-window range so that
 * every later sync takes a warm path that never consults the archive — turning
 * one transient 500 into permanently unrecoverable openings. The archive's
 * availability is load-bearing for *correctness* here, not just for UX.
 *
 * `complete: false` is a third case and is treated differently from an error,
 * because it is an honest answer rather than a failure. It still fails the sync
 * closed by default, but through {@link IncompleteHistoryError}, which carries
 * the coverage and the partial result so a caller can say *"the archive does
 * not hold ledgers X–Y"* rather than *"verification failed"*. SDK.md §12.3
 * requires exactly that distinction to survive to the caller.
 */
import { ArchiveClient, ArchiveError, type LedgerRange } from "./archive.js";
import { RpcClient } from "./chain.js";
import {
  type ConfidentialEvent,
  type RawEvent,
  RECOVERY_EVENT_TYPES,
  creditsAccount,
  decodeEvents,
  dedupeEvents,
  isCheckpointFor,
  participant,
  sortEvents,
} from "./events.js";

/**
 * Ledgers between the RPC retention floor and the seam. 60 ledgers is about
 * five minutes at Stellar's close interval — comfortably longer than an archive
 * round-trip, which is what the margin has to outlast.
 */
export const DEFAULT_SEAM_MARGIN = 60;

export interface Seam {
  /** The ledger the client switches sources at. Archive owns below, RPC at and above. */
  ledger: number;
  /** What the seam would have been from the live floor. */
  naturalLedger: number;
  rpcOldestLedger: number;
  headLedger: number;
  margin: number;
  /**
   * True when an override moved the seam off the live floor.
   *
   * The demo compresses the seam so the mechanism is visible inside a live
   * demo, since an archive started today can never hold >7-day-old events for a
   * contract deployed today — the RPC it ingests from does not retain them
   * either. The code path is identical; only the number moves. A UI showing
   * this flag must say so, because an unlabelled "beyond the 7-day window"
   * badge over two-hour-old data is not a compressed timescale, it is a false
   * claim.
   */
  compressed: boolean;
}

export interface SyncLeg {
  fromLedger: number;
  toLedger: number;
  events: number;
}

export interface SyncResult {
  /** Decoded, attributed, deduplicated, in INDEXER.md §3.4 order. */
  events: ConfidentialEvent[];
  seam: Seam;
  /** C3, conjoined across every archive page. */
  complete: boolean;
  /** The contiguous ranges the archive holds for this contract. */
  coverage: LedgerRange[];
  /** Gaps the archive reports. Empty when `complete` is true. */
  gaps: LedgerRange[];
  archiveLeg: SyncLeg;
  rpcLeg: SyncLeg;
}

/**
 * The archive answered, and answered honestly that it cannot cover the range.
 *
 * Distinct from {@link ArchiveError} on purpose: that one means the archive
 * failed, this one means it succeeded and told the truth. Only the second is
 * safe to present to a user as "this history is missing", and conflating them
 * is what SDK.md §12.3 warns produces the same refusal for two different causes.
 */
export class IncompleteHistoryError extends Error {
  override readonly name = "IncompleteHistoryError";
  constructor(
    message: string,
    readonly coverage: LedgerRange[],
    readonly gaps: LedgerRange[],
    /** The sync as far as it got, for a UI that wants to show the shortfall. */
    readonly partial: SyncResult,
  ) {
    super(message);
  }
}

/** The archive has not ingested up to the seam, so a range neither source covers. */
export class SeamNotCoveredError extends Error {
  override readonly name = "SeamNotCoveredError";
  constructor(
    message: string,
    readonly seam: number,
    readonly ingestedThrough: number | null,
  ) {
    super(message);
  }
}

export interface SeamOptions {
  marginLedgers?: number;
  /**
   * Pin the seam. Wired to `VITE_DEMO_SEAM_LEDGER` in the wallet.
   * See {@link Seam.compressed} for the honesty obligation this carries.
   */
  overrideSeamLedger?: number;
}

/**
 * Compute the seam from live RPC state.
 *
 * An override below `oldestLedger + margin` is refused rather than accepted:
 * it would place the RPC leg's lower bound inside — or below — the retention
 * floor, and the node answers that with `-32600`. Failing here names the cause;
 * failing at the RPC does not.
 */
export function computeSeam(
  health: { oldestLedger: number; latestLedger: number },
  options: SeamOptions = {},
): Seam {
  const margin = options.marginLedgers ?? DEFAULT_SEAM_MARGIN;
  const naturalLedger = health.oldestLedger + margin;
  const override = options.overrideSeamLedger;

  if (override !== undefined && override < naturalLedger) {
    throw new SeamNotCoveredError(
      `seam override ${override} sits below the RPC retention floor plus margin ` +
        `(${health.oldestLedger} + ${margin} = ${naturalLedger}); the RPC leg would be ` +
        "refused with -32600",
      override,
      null,
    );
  }

  // A seam past the head means the RPC's retained range plus the margin covers
  // nothing that has closed yet, so the RPC leg has nothing to contribute.
  // Clamping to `head + 1` keeps the legs disjoint and leaves the archive
  // responsible for everything — which is what INDEXER.md §1 says a client
  // reading the whole history from the archive is: equally conformant.
  const desired = override ?? naturalLedger;
  return {
    ledger: Math.min(desired, health.latestLedger + 1),
    naturalLedger,
    rpcOldestLedger: health.oldestLedger,
    headLedger: health.latestLedger,
    margin,
    compressed: override !== undefined,
  };
}

export interface SyncOptions extends SeamOptions {
  /**
   * Throw {@link IncompleteHistoryError} when the archive reports
   * `complete: false`. Default true — §12.4's fail-closed posture. Set false
   * only to inspect a partial history; never to spend from one.
   */
  failOnIncomplete?: boolean;
  /** Narrow the archive query. Defaults to every recovery-relevant type. */
  types?: readonly string[];
}

export interface SyncRequest extends SyncOptions {
  rpc: RpcClient;
  /**
   * Required. §12.4 distinguishes a *configured* archive that fails (must fail
   * the sync) from one that is absent — but recovery past the RPC window is
   * this package's entire purpose, so absent is not an option it offers.
   */
  archive: ArchiveClient;
  contractId: string;
  account: string;
}

/**
 * Fetch an account's full history across the seam.
 *
 * The two legs are disjoint by construction: archive `[coverage_start, seam-1]`,
 * RPC `[seam, head]`. Attribution on the RPC leg happens client-side — the RPC
 * has no per-account query — using the same topic-derived roles as the archive,
 * which INDEXER.md §3.3 explicitly permits ("both conform, since attribution is
 * a pure function of the topics").
 */
export async function syncAccountHistory(req: SyncRequest): Promise<SyncResult> {
  const { rpc, archive, contractId, account } = req;

  const rpcHealth = await rpc.health();
  const seam = computeSeam(rpcHealth, req);

  // C4: the archive must have ingested through the seam, or a range opens that
  // neither source covers (INDEXER.md §4 *Freshness*).
  const status = await archive.contractStatus(contractId);
  if (status.ingestedThrough === null || status.ingestedThrough < seam.ledger - 1) {
    throw new SeamNotCoveredError(
      `archive has ingested through ${status.ingestedThrough ?? "nothing"} but the seam is at ` +
        `${seam.ledger}; ledgers ${(status.ingestedThrough ?? 0) + 1}–${seam.ledger - 1} would be ` +
        "served by neither source",
      seam.ledger,
      status.ingestedThrough,
    );
  }

  // ---- archive leg. Any failure propagates: no try/catch, by design (§12.4).
  const archivePage = await archive.accountHistory(contractId, account, {
    toLedger: seam.ledger - 1,
    types: req.types ?? RECOVERY_EVENT_TYPES,
  });

  // ---- RPC leg. Empty when the seam is at or past the head.
  let rpcRaw: RawEvent[] = [];
  if (seam.ledger <= rpcHealth.latestLedger) {
    const page = await rpc.getEventsRange({
      startLedger: seam.ledger,
      endLedger: rpcHealth.latestLedger + 1,
      contractIds: [contractId],
    });
    rpcRaw = page.events;
  }

  const archiveEvents = decodeEvents(archivePage.events);
  // Attribute the RPC leg to this account from topics alone, never from the
  // transaction source account (INDEXER.md §3.3).
  const rpcEvents = decodeEvents(rpcRaw).filter(
    (e) =>
      creditsAccount(e, account) ||
      isCheckpointFor(e, account) ||
      participant(e, "account") === account ||
      participant(e, "from") === account ||
      participant(e, "to") === account ||
      participant(e, "spender") === account,
  );

  const events = sortEvents(dedupeEvents([...archiveEvents, ...rpcEvents]));

  const result: SyncResult = {
    events,
    seam,
    complete: archivePage.complete,
    coverage: status.coverage,
    gaps: status.gaps,
    archiveLeg: {
      fromLedger: archivePage.fromLedger,
      toLedger: archivePage.toLedger,
      events: archiveEvents.length,
    },
    rpcLeg: {
      fromLedger: seam.ledger,
      toLedger: rpcHealth.latestLedger,
      events: rpcEvents.length,
    },
  };

  if (!result.complete && req.failOnIncomplete !== false) {
    const where =
      status.gaps.length > 0
        ? status.gaps.map((g) => `${g.fromLedger}–${g.toLedger}`).join(", ")
        : "below the range it holds";
    throw new IncompleteHistoryError(
      `the archive does not hold a gap-free history for this range (missing: ${where}). ` +
        "A reconstructed opening from an incomplete history cannot be distinguished from a " +
        "tampered one, so the sync is refused rather than reported as verified.",
      status.coverage,
      status.gaps,
      result,
    );
  }

  return result;
}

export { ArchiveError };
