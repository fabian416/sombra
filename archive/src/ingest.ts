/**
 * The ingestion loop — INDEXER.md §4.
 *
 * The whole design turns on one question: after a page of events comes back,
 * *which ledgers can the archive honestly claim to have fully scanned?* Getting
 * that wrong is how an indexer silently serves an incomplete history as
 * complete, which §4 and §6 C3 exist to prevent. Two cases:
 *
 *   - A **short page** (fewer events than the limit) means the node scanned the
 *     entire requested window and found nothing more, so coverage extends
 *     through the window's end — `latestLedger` for an open-ended scan.
 *   - A **full page** means the scan stopped on the limit, possibly partway
 *     through the last ledger it touched. Coverage may then be claimed only up
 *     to the ledger *before* that one; the rest is re-read from the cursor.
 *
 * Coverage is therefore never extrapolated from what arrived — it is derived
 * from what the source promises it looked at. Everything else here (dedup,
 * gap detection, backfill) follows from that.
 */
import type { Config } from "./config.js";
import type { ArchivedEvent, ArchiveDb, LedgerRange } from "./db.js";
import { attributeTopics, eventCoords, eventTypeOf, topicsFromXdr } from "./events.js";
import { closeTimeToUnix, type RawSourceEvent, type RpcSource } from "./source.js";

export interface IngestStats {
  contractId: string;
  fetched: number;
  inserted: number;
  /** True when the source has more events immediately available. */
  more: boolean;
  coveredThrough: number | null;
}

/**
 * Map a source event onto the §3.1 archived record.
 *
 * Decoding is deliberately best-effort and never fatal. §3.1 makes the
 * verbatim XDR the payload and the decoded columns merely something an indexer
 * "MAY additionally store"; §4 ("Fidelity") puts decoding on the read side. So
 * an event whose topics this build's XDR decoder cannot parse is still
 * archived in full — it just arrives without an event type or topic index.
 *
 * This is not hypothetical. Testnet is on protocol 27, and a decoder predating
 * a protocol's new `ScAddress` variants throws on any topic using one. Letting
 * that abort ingestion would mean a stale dependency silently punching a
 * permanent hole in an archive whose entire purpose is that no hole exists —
 * the bytes were on the wire and recoverable, and only our reading of them was
 * behind. Storage must outlive the decoder.
 */
export function toArchivedEvent(raw: RawSourceEvent): ArchivedEvent {
  const coords = eventCoords(raw);
  let eventType: string | null = null;
  let topics: ArchivedEvent["topics"] = [];
  try {
    const decoded = topicsFromXdr(raw.topic);
    eventType = eventTypeOf(decoded);
    topics = attributeTopics(decoded);
  } catch {
    // Undecodable under this build: keep the bytes, lose only the index.
  }
  return {
    contractId: raw.contractId,
    ledgerSeq: coords.ledgerSeq,
    ledgerCloseTime: closeTimeToUnix(raw.ledgerClosedAt),
    txHash: raw.txHash,
    txApplicationOrder: coords.txApplicationOrder,
    opIndex: coords.opIndex,
    eventIndex: coords.eventIndex,
    topicsXdr: raw.topic,
    dataXdr: raw.value,
    eventType,
    // Default true: a source that omits the flag is reporting final state.
    inSuccessfulContractCall: raw.inSuccessfulContractCall !== false,
    rpcEventId: raw.id,
    topics,
  };
}

export class Ingester {
  private running = false;
  /** True once the background loop has been started at least once. */
  private started = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private resolveStopped: (() => void) | null = null;

  constructor(
    private readonly db: ArchiveDb,
    private readonly source: RpcSource,
    private readonly cfg: Config,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {}

  // ------------------------------------------------------------------ loop

  start(): void {
    if (this.running) return;
    this.running = true;
    this.started = true;
    this.stopped = false;
    void this.loop();
  }

  /** Stop after the in-flight tick settles. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
  }

  private async loop(): Promise<void> {
    try {
      await this.recordRetentionIntent();
    } catch (err) {
      this.log("could not record retention intent", { error: String(err) });
    }

    // §4 "Gaps": look for holes left by earlier downtime before streaming the
    // head, while their ledgers may still be inside the source's retention.
    try {
      await this.backfillGaps();
    } catch (err) {
      this.log("backfill failed", { error: String(err) });
    }

    while (this.running) {
      let busy = false;
      try {
        for (const contractId of this.cfg.contractIds) {
          if (!this.running) break;
          const stats = await this.pollContract(contractId);
          if (stats.inserted > 0 || stats.more) {
            this.log("ingested", {
              contract: contractId,
              fetched: stats.fetched,
              inserted: stats.inserted,
              coveredThrough: stats.coveredThrough,
            });
          }
          busy ||= stats.more;
        }
      } catch (err) {
        this.log("poll failed", { error: String(err) });
      }
      // A full page means more is waiting; keep draining without the delay.
      if (this.running && !busy) await this.sleep(this.cfg.pollIntervalMs);
    }

    this.stopped = true;
    this.resolveStopped?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }

  // --------------------------------------------------------------- polling

  /**
   * Advance one contract by one bounded window.
   *
   * The window is closed on both ends before the first request goes out, and
   * `scanRange` drains it. That matters for more than tidiness: it is what
   * lets coverage rest on the *request*. The earlier shape asked open-endedly
   * from `windowStart` and, on a short page, claimed coverage through the
   * node's reported `latestLedger` — which assumes `getEvents` always scans to
   * the head when it returns fewer than `limit` events. That is plausible
   * behaviour of stellar-rpc but is not part of the JSON-RPC contract, and a
   * provider imposing its own scan bound would have had the archive record
   * coverage over ledgers nobody looked at, making C3 report an incomplete
   * history as complete. Bounding the request removes the assumption.
   */
  async pollContract(contractId: string): Promise<IngestStats> {
    const health = await this.source.health();
    this.db.setMeta("latest_ledger", String(health.latestLedger));
    this.db.setMeta("latest_ledger_close_time", String(health.latestLedgerCloseTime));
    this.db.setMeta("oldest_ledger", String(health.oldestLedger));

    const state = this.db.getIngestState(contractId);
    let windowStart = state?.lastLedger ?? this.coldStartLedger(health.oldestLedger);

    // §4 "Freshness": the archive fell below the source's retention floor, so
    // [windowStart, oldestLedger - 1] is gone from this source. Skip forward
    // WITHOUT recording coverage — the hole stays a hole, and C3 reports any
    // range crossing it as incomplete rather than serving it as whole.
    if (windowStart < health.oldestLedger) {
      this.log("retention floor passed the archive; gap is now permanent for this source", {
        contract: contractId,
        missingFrom: windowStart,
        missingTo: health.oldestLedger - 1,
      });
      windowStart = health.oldestLedger;
    }

    if (windowStart > health.latestLedger) {
      return { contractId, fetched: 0, inserted: 0, more: false, coveredThrough: null };
    }

    const windowEnd = Math.min(
      windowStart + this.cfg.pollWindowLedgers - 1,
      health.latestLedger,
    );
    const result = await this.scanRange(contractId, windowStart, windowEnd);
    this.db.setIngestState(contractId, null, windowEnd + 1);

    return {
      contractId,
      fetched: result.fetched,
      inserted: result.inserted,
      // More chain remains beyond this window; drain it without sleeping.
      more: windowEnd < health.latestLedger,
      coveredThrough: windowEnd,
    };
  }

  /**
   * Where a contract with no recorded state begins.
   *
   * `START_LEDGER=<n>` is the honest choice for a real deployment — the
   * contract's deploy ledger, so the archive holds the whole history §5
   * requires. `auto` starts at the retention floor, which yields a conforming
   * archive going forward but one that never held the pre-floor history; the
   * coverage table reflects exactly that, and C3 will not claim otherwise.
   */
  private coldStartLedger(oldestLedger: number): number {
    const floor = oldestLedger + this.cfg.retentionMargin;
    if (this.cfg.startLedger === "auto") return floor;
    return Math.max(this.cfg.startLedger, oldestLedger);
  }

  /**
   * Record, per contract, the ledger from which this archive *intends* to hold
   * history, and whether that intent covers the contract's whole life (§5).
   *
   * The distinction is the difference between a conforming archive and a 7-day
   * cache. `START_LEDGER=auto` starts at the RPC's retention floor, so the
   * archive has never held anything older than the window it exists to
   * outlive. That is a fine dev default but a §5 violation in production, and
   * without this marker it is indistinguishable at the API from a deployment
   * started at the contract's deploy ledger.
   *
   * Written once and never overwritten: it is the archive's standing intent,
   * not a fact about the current process.
   */
  async recordRetentionIntent(): Promise<void> {
    if (this.cfg.contractIds.length === 0) return;
    const health = await this.source.health();
    for (const contractId of this.cfg.contractIds) {
      if (this.db.getRetentionIntent(contractId) !== null) continue;
      const from = this.coldStartLedger(health.oldestLedger);
      const configured = this.cfg.startLedger !== "auto";
      this.db.setRetentionIntent(contractId, from, configured);
      if (!configured) {
        this.log(
          "WARNING START_LEDGER=auto: starting at the RPC retention floor, so this archive " +
            "has never held history older than the ~7-day window. INDEXER.md §5 requires " +
            "retaining full per-account history indefinitely; set START_LEDGER to the " +
            "contract's deploy ledger for a conforming deployment. Reporting " +
            "holds_full_history=false.",
          { contract: contractId, retainsFrom: from },
        );
      }
    }
  }

  // -------------------------------------------------------------- backfill

  /**
   * §4 "Gaps": *"Detect and backfill any gap while its ledgers are still
   * retrievable from a source."*
   *
   * Holes below the retention floor are unrecoverable from this source and are
   * left recorded as holes — that is the permanent-gap case the spec says MUST
   * NOT be served as complete.
   */
  async backfillGaps(): Promise<void> {
    if (this.cfg.contractIds.length === 0) return;
    const health = await this.source.health();

    for (const contractId of this.cfg.contractIds) {
      for (const gap of gapsIn(this.db.coverage(contractId))) {
        const from = Math.max(gap.fromLedger, health.oldestLedger);
        const to = Math.min(gap.toLedger, health.latestLedger);
        if (to < from) {
          this.log("gap is permanently unfillable (below retention)", {
            contract: contractId,
            from: gap.fromLedger,
            to: gap.toLedger,
          });
          continue;
        }
        this.log("backfilling gap", { contract: contractId, from, to });
        await this.scanRange(contractId, from, to);
      }
    }
  }

  /**
   * Drain a bounded ledger range, recording coverage only as it is proven.
   *
   * Only the first request can carry `endLedger` — resuming from a cursor
   * drops the upper bound, since the RPC refuses to combine the two. So the
   * bound is re-imposed here: a page reaching past `to` means everything up to
   * `to` was scanned, and the scan stops there rather than claiming the extra.
   */
  async scanRange(
    contractId: string,
    from: number,
    to: number,
  ): Promise<{ fetched: number; inserted: number }> {
    let windowStart = from;
    let cursor: string | null = null;
    let fetched = 0;
    let inserted = 0;
    if (to < from) return { fetched, inserted };

    for (;;) {
      const page = await this.source.getEvents(
        cursor !== null
          ? { contractId, cursor, limit: this.cfg.pageLimit }
          : { contractId, startLedger: windowStart, endLedger: to + 1, limit: this.cfg.pageLimit },
      );
      fetched += page.events.length;
      inserted += this.db.insertEvents(page.events.map(toArchivedEvent));

      if (page.events.length < this.cfg.pageLimit) {
        // Window exhausted: everything through `to` is proven scanned.
        this.db.recordIngestedRange(contractId, windowStart, to);
        return { fetched, inserted };
      }
      const lastLedger = page.events[page.events.length - 1]!.ledger;
      if (lastLedger > to) {
        // Ran past the target window, so the target window is fully covered.
        this.db.recordIngestedRange(contractId, windowStart, to);
        return { fetched, inserted };
      }
      this.db.recordIngestedRange(contractId, windowStart, lastLedger - 1);
      windowStart = lastLedger;
      cursor = page.cursor;
      if (cursor === null) {
        this.db.recordIngestedRange(contractId, windowStart, to);
        return { fetched, inserted };
      }
      /*
       * Cancellation breaks the loop rather than gating entry to it. Gating
       * entry on `this.running` would make a directly-invoked scan (a one-shot
       * backfill command, or a test) stop after a single page with the gap
       * only partly filled — it under-claims coverage, so C3 stays honest, but
       * the gap silently stops being backfilled.
       */
      if (this.started && !this.running) return { fetched, inserted };
    }
  }
}

/** The holes between contiguous covered ranges (§4 gap tracking). */
export function gapsIn(coverage: LedgerRange[]): LedgerRange[] {
  const gaps: LedgerRange[] = [];
  for (let i = 1; i < coverage.length; i++) {
    const prev = coverage[i - 1]!;
    const next = coverage[i]!;
    if (next.fromLedger > prev.toLedger + 1) {
      gaps.push({ fromLedger: prev.toLedger + 1, toLedger: next.fromLedger - 1 });
    }
  }
  return gaps;
}
