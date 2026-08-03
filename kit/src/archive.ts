/**
 * Typed client for a Sombra Archive — the INDEXER.md §6 capability surface.
 *
 * The routes are `archive/src/api.ts`'s, which follow §6's RECOMMENDED shape
 * verbatim (snake_case on the wire, because the wire format is the spec's).
 * What this module adds is the client half of two obligations the server
 * cannot discharge alone:
 *
 *   - **C3 is carried, never swallowed.** Every response's `complete` is
 *     surfaced on the result. SDK.md §12.3 makes this a MUST and gives the
 *     reason: "an incomplete range and a tampered range both end in the same
 *     refusal at §10.6, and only that signal distinguishes them." A wallet that
 *     drops it can tell the user recovery failed but not whether the archive is
 *     missing ledgers or someone tampered with the history.
 *   - **Failures are loud.** No retry-into-silence, no partial page treated as
 *     a whole one. Every error path throws {@link ArchiveError}; §12.4's
 *     fail-closed rule is enforced one layer up, in `seam.ts`, and depends on
 *     this layer never quietly returning less than it was asked for.
 *
 * `fetch` is taken from the environment rather than imported, so the same code
 * runs in a browser and under Node 20+.
 */
import type { RawEvent } from "./events.js";

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface LedgerRange {
  fromLedger: number;
  toLedger: number;
}

export interface ArchiveContractStatus {
  contractId: string;
  ingestedThrough: number | null;
  contiguousFrom: number | null;
  gaps: LedgerRange[];
  events: number;
}

export interface ArchiveHealth {
  status: string;
  latestLedger: number | null;
  /** C4 — the ledger the archive has fully ingested through. */
  ingestedThrough: number | null;
  lagSeconds: number | null;
  lagLedgers: number | null;
  oldestSourceLedger: number | null;
  contracts: ArchiveContractStatus[];
}

export interface ArchiveCoverage extends ArchiveContractStatus {
  coverage: LedgerRange[];
  eventLedgerMin: number | null;
  eventLedgerMax: number | null;
}

export interface EventPage {
  events: RawEvent[];
  cursor: string | null;
  complete: boolean;
  fromLedger: number;
  toLedger: number;
}

export interface CheckpointResponse {
  event: RawEvent | null;
  complete: boolean;
  atLedger: number;
  coverage: LedgerRange[];
}

export interface HistoryQuery {
  fromLedger?: number;
  toLedger?: number;
  types?: readonly string[];
  /** Page size. The server caps this at 1000. */
  limit?: number;
}

export interface ArchiveClientOptions {
  /** Per-request timeout. A hung archive must fail, not stall a recovery. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Shape of one §3.1 record on the wire. */
interface WireEvent {
  id: string;
  source_event_id?: string | null;
  contract_id: string;
  ledger_seq: number;
  ledger_close_time?: number | null;
  tx_hash: string;
  tx_application_order: number;
  op_index: number;
  event_index: number;
  topics_xdr: string[];
  data_xdr: string | null;
}

function toRawEvent(w: WireEvent): RawEvent {
  return {
    id: w.id,
    sourceEventId: w.source_event_id ?? null,
    contractId: w.contract_id,
    ledgerSeq: w.ledger_seq,
    ledgerCloseTime: w.ledger_close_time ?? null,
    txHash: w.tx_hash,
    txApplicationOrder: w.tx_application_order,
    opIndex: w.op_index,
    eventIndex: w.event_index,
    topicsXdr: w.topics_xdr,
    dataXdr: w.data_xdr ?? null,
  };
}

function toRange(r: { from_ledger: number; to_ledger: number }): LedgerRange {
  return { fromLedger: r.from_ledger, toLedger: r.to_ledger };
}

export class ArchiveClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(baseUrl: string, options: ArchiveClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.doFetch = options.fetch ?? globalThis.fetch;
    if (typeof this.doFetch !== "function") {
      throw new Error("no fetch implementation available; pass one via options.fetch");
    }
  }

  private async get<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const href = url.toString();

    // AbortSignal.timeout is not universal yet (older Safari, Node 18 without
    // flags), so the controller is driven by hand.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(href, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ArchiveError(`archive request failed: ${reason}`, href);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 300);
      } catch {
        /* the status alone is enough to fail on */
      }
      throw new ArchiveError(`archive returned ${res.status}${body ? `: ${body}` : ""}`, href, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new ArchiveError(
        `archive response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        href,
        res.status,
      );
    }
  }

  /** C4 — ingestion status. */
  async health(): Promise<ArchiveHealth> {
    const r = await this.get<{
      status: string;
      latest_ledger: number | null;
      ingested_through: number | null;
      lag_seconds: number | null;
      lag_ledgers: number | null;
      oldest_source_ledger: number | null;
      contracts: {
        contract_id: string;
        ingested_through: number | null;
        contiguous_from: number | null;
        gaps: { from_ledger: number; to_ledger: number }[];
        events: number;
      }[];
    }>("/v1/health");
    return {
      status: r.status,
      latestLedger: r.latest_ledger,
      ingestedThrough: r.ingested_through,
      lagSeconds: r.lag_seconds,
      lagLedgers: r.lag_ledgers,
      oldestSourceLedger: r.oldest_source_ledger,
      contracts: (r.contracts ?? []).map((c) => ({
        contractId: c.contract_id,
        ingestedThrough: c.ingested_through,
        contiguousFrom: c.contiguous_from,
        gaps: (c.gaps ?? []).map(toRange),
        events: c.events,
      })),
    };
  }

  /**
   * Per-contract coverage detail. Not part of §6 — the Archive exposes it
   * because a hybrid client needs to see the contiguous top range reach the
   * seam before it can trust the two sources to compose.
   */
  async contractStatus(contractId: string): Promise<ArchiveCoverage> {
    const r = await this.get<{
      contract_id: string;
      ingested_through: number | null;
      contiguous_from: number | null;
      events: number;
      event_ledger_min: number | null;
      event_ledger_max: number | null;
      coverage: { from_ledger: number; to_ledger: number }[];
      gaps: { from_ledger: number; to_ledger: number }[];
    }>(`/v1/tokens/${encodeURIComponent(contractId)}/status`);
    return {
      contractId: r.contract_id,
      ingestedThrough: r.ingested_through,
      contiguousFrom: r.contiguous_from,
      events: r.events,
      eventLedgerMin: r.event_ledger_min,
      eventLedgerMax: r.event_ledger_max,
      coverage: (r.coverage ?? []).map(toRange),
      gaps: (r.gaps ?? []).map(toRange),
    };
  }

  /** C1 — the latest checkpoint at or before `atLedger`. */
  async checkpoint(
    contractId: string,
    account: string,
    atLedger?: number,
  ): Promise<CheckpointResponse> {
    const r = await this.get<{
      event: WireEvent | null;
      complete: boolean;
      at_ledger: number;
      coverage: { from_ledger: number; to_ledger: number }[];
    }>(
      `/v1/tokens/${encodeURIComponent(contractId)}/accounts/${encodeURIComponent(account)}/checkpoint`,
      { at_ledger: atLedger === undefined ? undefined : String(atLedger) },
    );
    return {
      event: r.event === null ? null : toRawEvent(r.event),
      complete: r.complete,
      atLedger: r.at_ledger,
      coverage: (r.coverage ?? []).map(toRange),
    };
  }

  /** One page of C2. Prefer {@link accountHistory}, which drains the cursor. */
  async accountEvents(
    contractId: string,
    account: string,
    query: HistoryQuery & { cursor?: string } = {},
  ): Promise<EventPage> {
    const r = await this.get<{
      events: WireEvent[];
      cursor: string | null;
      complete: boolean;
      from_ledger: number;
      to_ledger: number;
    }>(
      `/v1/tokens/${encodeURIComponent(contractId)}/accounts/${encodeURIComponent(account)}/events`,
      {
        from_ledger: query.fromLedger === undefined ? undefined : String(query.fromLedger),
        to_ledger: query.toLedger === undefined ? undefined : String(query.toLedger),
        types: query.types === undefined ? undefined : query.types.join(","),
        limit: query.limit === undefined ? undefined : String(query.limit),
        cursor: query.cursor,
      },
    );
    return {
      events: (r.events ?? []).map(toRawEvent),
      cursor: r.cursor,
      complete: r.complete,
      fromLedger: r.from_ledger,
      toLedger: r.to_ledger,
    };
  }

  /**
   * C2 across every page.
   *
   * `complete` is the **conjunction** over pages: one incomplete page makes the
   * whole range incomplete, which is the only reading that keeps the flag
   * meaningful once a range is split by pagination.
   */
  async accountHistory(
    contractId: string,
    account: string,
    query: HistoryQuery = {},
  ): Promise<EventPage> {
    const events: RawEvent[] = [];
    let cursor: string | undefined;
    let complete = true;
    let fromLedger = query.fromLedger ?? 0;
    let toLedger = query.toLedger ?? 0;
    let pages = 0;

    do {
      const page: EventPage = await this.accountEvents(contractId, account, { ...query, cursor });
      events.push(...page.events);
      complete = complete && page.complete;
      if (pages === 0) {
        fromLedger = page.fromLedger;
        toLedger = page.toLedger;
      }
      cursor = page.cursor ?? undefined;
      pages++;
      if (pages > 10_000) {
        // A server that always returns a cursor would otherwise spin forever.
        throw new ArchiveError(
          `archive paged past ${pages} pages for ${account}; refusing to continue`,
          this.baseUrl,
        );
      }
    } while (cursor !== undefined);

    return { events, cursor: null, complete, fromLedger, toLedger };
  }
}
