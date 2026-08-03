/**
 * The ingestion source (INDEXER.md §4). Stellar RPC is one of the conforming
 * sources the spec names — "any source that yields the complete, final event
 * stream". This module is the only place that knows it is RPC, so swapping in
 * Horizon or a captive core means reimplementing this interface and nothing
 * else.
 *
 * Two properties of the RPC drive the ingestion loop's shape (`ingest.ts`),
 * and both were verified against a live testnet node rather than inferred:
 *
 *   - `startLedger` MUST fall inside `[oldestLedger, latestLedger]`; outside it
 *     the node returns JSON-RPC -32600 rather than an empty page. Falling below
 *     `oldestLedger` is exactly the §4 freshness failure, so the loop clamps
 *     and leaves the uncovered ledgers recorded as a gap.
 *   - `endLedger` is EXCLUSIVE. (`startLedger: n, endLedger: n + 2` returns
 *     ledgers n and n+1.) Backfill relies on this to bound a gap scan.
 */
import { rpc as StellarRpc } from "@stellar/stellar-sdk";

/**
 * The RPC's retention window and chain head — the §2 "seam" inputs. A hybrid
 * client sets its seam above `oldestLedger`; the archive must have ingested
 * through that seam for the two sources to compose without a hole.
 *
 * `@stellar/stellar-sdk` v13 types `getHealth()` as `{ status }` only, but the
 * node has returned the retention fields since protocol 21 and every one of
 * them is load-bearing here, so the response is re-typed at the boundary.
 */
export interface SourceHealth {
  status: string;
  latestLedger: number;
  latestLedgerCloseTime: number;
  oldestLedger: number;
  ledgerRetentionWindow: number;
}

interface RawHealthResponse {
  status: string;
  latestLedger?: number;
  latestLedgerCloseTime?: string | number;
  oldestLedger?: number;
  ledgerRetentionWindow?: number;
}

/**
 * One event as the RPC serves it, topics and data left as base64 XDR — the
 * verbatim payload §3.1 recommends, untouched between the wire and the DB.
 *
 * `transactionIndex` and `operationIndex` are absent from the SDK's
 * `RawEventResponse` type but are present on the wire (protocol 23+), and
 * `transactionIndex` *is* the `tx_application_order` §3.1 requires. Across 200
 * live testnet events they agreed with the id-encoded ordering in every case,
 * so they are preferred and the id decode in `events.ts` is the fallback for
 * older nodes.
 */
export interface RawSourceEvent {
  id: string;
  type: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  txHash: string;
  topic: string[];
  value: string;
  inSuccessfulContractCall: boolean;
  transactionIndex?: number;
  operationIndex?: number;
}

export interface SourcePage {
  events: RawSourceEvent[];
  /** RPC paging token; resumes strictly after the last event returned. */
  cursor: string | null;
  /**
   * The chain head as of this response. When a page comes back short of the
   * limit, the node scanned the whole window up to here — which is what lets
   * the loop claim coverage through this ledger and no further.
   */
  latestLedger: number;
}

export interface GetEventsArgs {
  contractId: string;
  /** Inclusive. Mutually exclusive with `cursor`. */
  startLedger?: number;
  /** EXCLUSIVE upper bound. */
  endLedger?: number;
  cursor?: string;
  limit: number;
}

export class RpcSource {
  readonly server: StellarRpc.Server;

  constructor(readonly url: string) {
    this.server = new StellarRpc.Server(url, { allowHttp: url.startsWith("http://") });
  }

  async health(): Promise<SourceHealth> {
    const raw = (await this.server.getHealth()) as RawHealthResponse;
    if (raw.latestLedger === undefined || raw.oldestLedger === undefined) {
      throw new Error(
        `RPC ${this.url} omitted latestLedger/oldestLedger from getHealth; ` +
          `Sombra Archive needs the retention window to bound ingestion (§4)`,
      );
    }
    return {
      status: raw.status,
      latestLedger: raw.latestLedger,
      latestLedgerCloseTime: Number(raw.latestLedgerCloseTime ?? 0),
      oldestLedger: raw.oldestLedger,
      ledgerRetentionWindow: raw.ledgerRetentionWindow ?? 0,
    };
  }

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  /**
   * One page of contract events, XDR left verbatim.
   *
   * `_getEvents` is the SDK's raw variant: the public `getEvents` eagerly
   * decodes topics and data into `ScVal` objects, which would mean re-encoding
   * them to store the §3.1 payload — a lossy round-trip for no gain, since the
   * decode this archive actually needs is only the topic index (§3.3).
   */
  async getEvents(args: GetEventsArgs): Promise<SourcePage> {
    const req: StellarRpc.Server.GetEventsRequest = {
      filters: [{ type: "contract", contractIds: [args.contractId] }],
      limit: args.limit,
    };
    if (args.cursor !== undefined) req.cursor = args.cursor;
    else if (args.startLedger !== undefined) req.startLedger = args.startLedger;
    if (args.endLedger !== undefined) req.endLedger = args.endLedger;

    const resp = (await this.server._getEvents(req)) as unknown as {
      events: RawSourceEvent[];
      cursor?: string;
      latestLedger: number;
    };
    return {
      events: resp.events ?? [],
      cursor: resp.cursor && resp.cursor.length > 0 ? resp.cursor : null,
      latestLedger: resp.latestLedger,
    };
  }
}

/** Close time of a ledger as unix seconds, from the RPC's ISO-8601 string. */
export function closeTimeToUnix(ledgerClosedAt: string): number {
  const ms = Date.parse(ledgerClosedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}
