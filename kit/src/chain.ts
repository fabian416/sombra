/**
 * Stellar RPC — the recent-tail event source, and the chain state DESIGN.md
 * §5.2 step 7 verifies against.
 *
 * A hand-written JSON-RPC client over `fetch` rather than `@stellar/stellar-sdk`,
 * for the same reason `xdr/codec.ts` is hand-written: the SDK's RPC module
 * carries `Buffer` and a transaction-builder dependency chain that a browser
 * bundle would have to polyfill, and recovery needs exactly four methods.
 *
 * The on-chain account is read through **`getLedgerEntries`**, not by simulating
 * `confidential_balance()`. That choice matters three ways: no source account,
 * sequence number or signed envelope is involved; the read has no side effect,
 * whereas the contract call extends the entry's TTL (`storage.rs:1260-1276`);
 * and the reply is a `ContractDataEntry` this package already decodes.
 */
import { type Point, pointFromBytes } from "./crypto/grumpkin.js";
import type { EventPosition, RawEvent } from "./events.js";
import type { OnChainAccount } from "./replay.js";
import {
  accountEntryKey,
  contractDataLedgerKey,
  decodeContractDataEntry,
  scMapFields,
  scU32,
  scBytes,
} from "./xdr/scval.js";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly method: string,
    /** JSON-RPC error code. `-32600` is the out-of-retention refusal. */
    readonly code?: number,
  ) {
    super(message);
    this.name = "RpcError";
  }

  /**
   * True when the node refused a range below its retention floor.
   *
   * This is the error the whole product exists because of, so it is worth
   * naming: it is what a wallet gets when it asks RPC for history older than
   * seven days, and showing it beside the Archive answering that same range is
   * the demonstration of the thesis.
   */
  get isOutOfRetention(): boolean {
    return this.code === -32600;
  }
}

export interface RpcHealth {
  status: string;
  /** The retention floor. The seam MUST sit strictly above it (SDK.md §12.4). */
  oldestLedger: number;
  latestLedger: number;
  ledgerRetentionWindow: number;
}

export interface GetEventsQuery {
  startLedger: number;
  /** Exclusive upper bound, per the RPC's own convention. */
  endLedger?: number;
  contractIds?: readonly string[];
  limit?: number;
  cursor?: string;
}

export interface RpcClientOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** One event as stellar-rpc serves it. Field names have drifted across versions. */
interface WireRpcEvent {
  type: string;
  ledger: number;
  ledgerClosedAt?: string;
  contractId: string;
  id: string;
  pagingToken?: string;
  topic?: string[];
  topicXdr?: string[];
  value?: string;
  valueXdr?: string;
  inSuccessfulContractCall?: boolean;
  txHash: string;
  transactionIndex?: number;
  operationIndex?: number;
}

const TOID_OP_MASK = 0xfffn;
const TOID_TX_MASK = 0xfffffn;

/**
 * Decode the §3.4 ordering triple packed into an RPC event id.
 *
 * The id is `<toid>-<eventOrder>`, where the TOID packs
 * `ledger_seq << 32 | tx_application_order << 12 | op_index`. Nodes from
 * protocol 23 serve `transactionIndex` / `operationIndex` directly; those are
 * believed over the packing when present, and the ledger always comes from the
 * response field, which is authoritative.
 */
export function positionOfRpcEvent(e: WireRpcEvent): EventPosition {
  const [toidStr, orderStr] = e.id.split("-");
  const toid = BigInt(toidStr ?? "0");
  return {
    ledgerSeq: e.ledger,
    txApplicationOrder: e.transactionIndex ?? Number((toid >> 12n) & TOID_TX_MASK),
    opIndex: e.operationIndex ?? Number(toid & TOID_OP_MASK),
    eventIndex: Number(orderStr ?? "0"),
  };
}

export class RpcClient {
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof globalThis.fetch;
  private nextId = 1;

  constructor(url: string, options: RpcClientOptions = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.doFetch = options.fetch ?? globalThis.fetch;
    if (typeof this.doFetch !== "function") {
      throw new Error("no fetch implementation available; pass one via options.fetch");
    }
  }

  async call<T>(method: string, params: unknown = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(this.url, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      });
    } catch (err) {
      throw new RpcError(
        `RPC request failed: ${err instanceof Error ? err.message : String(err)}`,
        method,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw new RpcError(`RPC returned HTTP ${res.status}`, method);

    const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error !== undefined) {
      throw new RpcError(body.error.message ?? "RPC error", method, body.error.code);
    }
    if (body.result === undefined) throw new RpcError("RPC response carried no result", method);
    return body.result;
  }

  async health(): Promise<RpcHealth> {
    const r = await this.call<{
      status: string;
      oldestLedger: number;
      latestLedger: number;
      ledgerRetentionWindow: number;
    }>("getHealth");
    return r;
  }

  async latestLedger(): Promise<number> {
    const r = await this.call<{ sequence: number }>("getLatestLedger");
    return r.sequence;
  }

  /**
   * One page of `getEvents`.
   *
   * Events from sub-calls the host rolled back carry
   * `inSuccessfulContractCall: false` and did not affect final state. They are
   * dropped here: replaying a rolled-back `Deposit` credits value the chain
   * never granted, and the §7 check then fails against an honest archive with
   * no way to tell that apart from tampering.
   */
  async getEvents(query: GetEventsQuery): Promise<{ events: RawEvent[]; cursor: string | null; latestLedger: number }> {
    const params: Record<string, unknown> = {
      startLedger: query.startLedger,
      pagination: {
        limit: query.limit ?? 200,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      filters: [
        {
          type: "contract",
          ...(query.contractIds === undefined ? {} : { contractIds: [...query.contractIds] }),
        },
      ],
    };
    if (query.endLedger !== undefined) params.endLedger = query.endLedger;
    // A cursor already encodes the position; sending startLedger alongside it
    // is rejected by the node.
    if (query.cursor !== undefined) delete params.startLedger;

    const r = await this.call<{ events: WireRpcEvent[]; cursor?: string; latestLedger: number }>(
      "getEvents",
      params,
    );

    const events: RawEvent[] = [];
    for (const e of r.events ?? []) {
      if (e.inSuccessfulContractCall === false) continue;
      const pos = positionOfRpcEvent(e);
      const topics = e.topic ?? e.topicXdr;
      if (topics === undefined) throw new RpcError(`event ${e.id} carried no topics`, "getEvents");
      events.push({
        // The §2 id shape, so it matches the archive's byte-for-byte.
        id: `${e.ledger}-${e.txHash}-${pos.eventIndex}`,
        sourceEventId: e.id,
        contractId: e.contractId,
        txHash: e.txHash,
        ledgerCloseTime:
          e.ledgerClosedAt === undefined ? null : Math.floor(Date.parse(e.ledgerClosedAt) / 1000),
        topicsXdr: topics,
        dataXdr: e.value ?? e.valueXdr ?? null,
        ...pos,
      });
    }
    return { events, cursor: r.cursor ?? null, latestLedger: r.latestLedger };
  }

  /** `getEvents` across every page of a range. */
  async getEventsRange(query: GetEventsQuery): Promise<{ events: RawEvent[]; latestLedger: number }> {
    const all: RawEvent[] = [];
    let cursor: string | undefined;
    let latestLedger = 0;
    let pages = 0;
    for (;;) {
      const page = await this.getEvents({ ...query, cursor });
      all.push(...page.events);
      latestLedger = page.latestLedger;
      if (page.cursor === null || page.events.length === 0) break;
      cursor = page.cursor;
      if (++pages > 10_000) throw new RpcError("getEvents paged without terminating", "getEvents");
    }
    return { events: all, latestLedger };
  }

  /**
   * Read an account's `ConfidentialAccount` entry.
   *
   * `null` means the entry is absent — the account is not registered, or it is
   * registered on a different deployment. That is a legitimate answer, not an
   * error: the contract would panic `AccountNotRegistered = 3501`, but a ledger
   * read simply returns nothing.
   */
  async confidentialAccount(contractId: string, account: string): Promise<OnChainAccount | null> {
    const key = contractDataLedgerKey(contractId, accountEntryKey(account));
    const r = await this.call<{ entries?: { key: string; xdr?: string; dataXdr?: string }[] }>(
      "getLedgerEntries",
      { keys: [key] },
    );
    const entry = r.entries?.[0];
    if (entry === undefined) return null;

    const raw = entry.xdr ?? entry.dataXdr;
    if (raw === undefined) throw new RpcError("ledger entry carried no XDR", "getLedgerEntries");

    const fields = scMapFields(decodeContractDataEntry(raw).val, "ConfidentialAccount");
    const point = (name: string): Point =>
      pointFromBytes(scBytes(fields.get(name), `ConfidentialAccount.${name}`));

    return {
      spendingPublicKey: point("spending_public_key"),
      viewingPublicKey: point("viewing_public_key"),
      spendableCommitment: point("spendable_commitment"),
      receivingCommitment: point("receiving_commitment"),
      auditorId: scU32(fields.get("auditor_id"), "ConfidentialAccount.auditor_id"),
    };
  }
}
