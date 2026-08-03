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

/** Map a source event onto the §3.1 archived record. */
export function toArchivedEvent(raw: RawSourceEvent): ArchivedEvent {
  const coords = eventCoords(raw);
  const topics = topicsFromXdr(raw.topic);
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
    eventType: eventTypeOf(topics),
    rpcEventId: raw.id,
    topics: attributeTopics(topics),
  };
}

export class Ingester {
  private running = false;
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
   * Advance one contract by a single page.
   *
   * The cursor and the coverage bookkeeping are deliberately separate. The
   * cursor says where to *read* next; `windowStart` says where the unproven
   * region *begins*. They diverge whenever a page ends mid-ledger, and
   * conflating them is what would let a half-scanned ledger be recorded as
   * covered.
   */
  async pollContract(contractId: string): Promise<IngestStats> {
    const health = await this.source.health();
    this.db.setMeta("latest_ledger", String(health.latestLedger));
    this.db.setMeta("latest_ledger_close_time", String(health.latestLedgerCloseTime));
    this.db.setMeta("oldest_ledger", String(health.oldestLedger));

    const state = this.db.getIngestState(contractId);
    let windowStart = state?.lastLedger ?? this.coldStartLedger(health.oldestLedger);
    let cursor = state?.pagingToken ?? null;

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
      cursor = null;
    }

    if (windowStart > health.latestLedger) {
      return { contractId, fetched: 0, inserted: 0, more: false, coveredThrough: null };
    }

    const page = await this.source.getEvents(
      cursor !== null
        ? { contractId, cursor, limit: this.cfg.pageLimit }
        : { contractId, startLedger: windowStart, limit: this.cfg.pageLimit },
    );

    const inserted = this.db.insertEvents(page.events.map(toArchivedEvent));
    const full = page.events.length >= this.cfg.pageLimit;

    if (full) {
      const lastLedger = page.events[page.events.length - 1]!.ledger;
      // The limit may have cut this ledger in half: prove only up to the one
      // before it, and re-enter it through the cursor.
      this.db.recordIngestedRange(contractId, windowStart, lastLedger - 1);
      this.db.setIngestState(contractId, page.cursor, lastLedger);
      return { contractId, fetched: page.events.length, inserted, more: true, coveredThrough: lastLedger - 1 };
    }

    // Short page: the node scanned right through to the head it reported.
    this.db.recordIngestedRange(contractId, windowStart, page.latestLedger);
    this.db.setIngestState(contractId, null, page.latestLedger + 1);
    return {
      contractId,
      fetched: page.events.length,
      inserted,
      more: false,
      coveredThrough: page.latestLedger,
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

  /** Drain a bounded ledger range, recording coverage as it is proven. */
  private async scanRange(contractId: string, from: number, to: number): Promise<void> {
    let windowStart = from;
    let cursor: string | null = null;

    while (this.running || cursor === null) {
      const page: Awaited<ReturnType<RpcSource["getEvents"]>> = await this.source.getEvents(
        cursor !== null
          ? { contractId, cursor, endLedger: to + 1, limit: this.cfg.pageLimit }
          : { contractId, startLedger: windowStart, endLedger: to + 1, limit: this.cfg.pageLimit },
      );
      this.db.insertEvents(page.events.map(toArchivedEvent));

      if (page.events.length < this.cfg.pageLimit) {
        // Exhausted the bounded window: everything up to `to` is proven.
        this.db.recordIngestedRange(contractId, windowStart, to);
        return;
      }
      const lastLedger = page.events[page.events.length - 1]!.ledger;
      this.db.recordIngestedRange(contractId, windowStart, lastLedger - 1);
      windowStart = lastLedger;
      cursor = page.cursor;
      if (cursor === null) {
        this.db.recordIngestedRange(contractId, windowStart, to);
        return;
      }
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
