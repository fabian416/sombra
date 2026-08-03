/**
 * The HTTP surface — INDEXER.md §6.
 *
 * C2 (ordered history), C3 (completeness signal) and C4 (ingestion status) are
 * normative; C1 (latest checkpoint) is RECOMMENDED and implemented here because
 * it is what makes recovery for a dormant account cheap.
 *
 * Two rules shape every handler:
 *
 *   - **C3 is not optional and not advisory.** Every response carries
 *     `complete`, and it is `true` only when a single contiguous ingested range
 *     covers the whole *requested* window. A short answer is never dressed up
 *     as a whole one.
 *   - **`types` filters after attribution (§6).** It narrows this response;
 *     it never narrows what was stored or which accounts an event was
 *     attributed to.
 *
 * Field names are snake_case to match the spec's recommended shape verbatim,
 * even though the rest of the codebase is camelCase — the wire format is the
 * spec's, not ours.
 */
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import type { Config } from "./config.js";
import type { ArchivedEvent, ArchiveDb, OrderKey } from "./db.js";
import { formatEventId, normalizeEventType } from "./events.js";
import { gapsIn } from "./ingest.js";
import type { RpcSource } from "./source.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/**
 * Stellar closes a ledger roughly every 5 seconds. Used only to express the
 * §6 `lag_seconds` field, which is derived from a ledger delta; `lag_ledgers`
 * beside it is exact and is the value to trust.
 */
const AVG_LEDGER_SECONDS = 5;

// --------------------------------------------------------------- serializing

/**
 * One §3.1 record on the wire.
 *
 * `topics_xdr` / `data_xdr` are the verbatim base64 XDR §3.1 recommends and are
 * what a recovering wallet actually decodes. `event_type` and `accounts` are
 * the decoded convenience columns §3.1 permits ("indexers MAY additionally
 * store decoded columns for querying") — derived from the XDR, never a
 * replacement for it.
 */
function serializeEvent(e: ArchivedEvent): Record<string, unknown> {
  return {
    id: formatEventId(e.ledgerSeq, e.txHash, e.eventIndex),
    contract_id: e.contractId,
    ledger_seq: e.ledgerSeq,
    ledger_close_time: e.ledgerCloseTime,
    tx_hash: e.txHash,
    tx_application_order: e.txApplicationOrder,
    event_index: e.eventIndex,
    topics_xdr: e.topicsXdr,
    data_xdr: e.dataXdr,
    event_type: e.eventType,
    accounts: e.topics
      .filter((t) => t.kind === "address")
      .map((t) => ({ role: t.role, address: t.value, checkpoint_owner: t.isCheckpointOwner })),
  };
}

/**
 * Pagination cursor: the §3.4 order key, opaque to clients. Encoding the whole
 * triple (rather than an offset) is what makes paging stable while ingestion
 * appends behind the reader.
 */
function encodeCursor(e: ArchivedEvent): string {
  return Buffer.from(`${e.ledgerSeq}.${e.txApplicationOrder}.${e.eventIndex}`).toString("base64url");
}

function decodeCursor(raw: string): OrderKey {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split(".");
  const nums = parts.map((p) => Number.parseInt(p, 10));
  if (nums.length !== 3 || nums.some((n) => !Number.isFinite(n))) {
    throw new BadRequest(`malformed cursor: ${raw}`);
  }
  return { ledgerSeq: nums[0]!, txApplicationOrder: nums[1]!, eventIndex: nums[2]! };
}

class BadRequest extends Error {}

// ------------------------------------------------------------------- params

interface RangeQuery {
  from_ledger?: string;
  to_ledger?: string;
  types?: string;
  cursor?: string;
  limit?: string;
}

function parseInteger(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new BadRequest(`${name} must be a non-negative integer`);
  return n;
}

function parseTypes(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const types = raw
    .split(",")
    .map((t) => normalizeEventType(t))
    .filter(Boolean);
  return types.length > 0 ? types : undefined;
}

function parseLimit(raw: string | undefined): number {
  const n = parseInteger("limit", raw) ?? DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

// -------------------------------------------------------------------- server

export function buildApi(db: ArchiveDb, cfg: Config, source: RpcSource | null): FastifyInstance {
  const app = Fastify({ logger: false });

  void app.register(cors, { origin: cfg.corsOrigin, methods: ["GET", "OPTIONS"] });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
    return reply.code(500).send({ error: err.message });
  });

  /**
   * Resolve the effective ledger window for a query.
   *
   * Both bounds default to what the archive actually holds for the contract,
   * so an unqualified query asks for the held history and can legitimately
   * answer `complete: true`. A client that explicitly asks for ledger 0, or
   * for a ledger past `ingested_through`, is asking about ledgers the archive
   * does not hold and gets `complete: false` — which is the honest answer, not
   * a defect.
   */
  function resolveRange(contractId: string, q: RangeQuery): { from: number; to: number } {
    const coverage = db.coverage(contractId);
    const status = db.ingestionStatus(contractId);
    const bounds = db.eventLedgerBounds(contractId);
    const defaultFrom = coverage[0]?.fromLedger ?? bounds.min ?? 0;
    const defaultTo = status.ingestedThrough ?? bounds.max ?? 0;
    const from = parseInteger("from_ledger", q.from_ledger) ?? defaultFrom;
    const to = parseInteger("to_ledger", q.to_ledger) ?? defaultTo;
    return { from, to };
  }

  // -------------------------------------------------------------- C4: health

  app.get("/v1/health", async () => {
    const contracts = new Set([...cfg.contractIds, ...db.knownContracts()]);
    const perContract = [...contracts].sort().map((contractId) => {
      const status = db.ingestionStatus(contractId);
      return {
        contract_id: contractId,
        ingested_through: status.ingestedThrough,
        contiguous_from: status.contiguousFrom,
        gaps: gapsIn(db.coverage(contractId)).map((g) => ({
          from_ledger: g.fromLedger,
          to_ledger: g.toLedger,
        })),
        events: db.countEvents(contractId),
      };
    });

    // Refresh the head from the source when there is no ingestion loop to keep
    // `meta` warm (API_ONLY, or a seeded demo DB).
    let latestLedger = Number(db.getMeta("latest_ledger") ?? "") || null;
    if (source !== null && latestLedger === null) {
      try {
        latestLedger = await source.latestLedger();
        db.setMeta("latest_ledger", String(latestLedger));
      } catch {
        /* source unreachable; report what the archive knows */
      }
    }

    // The archive is only as fresh as its least-advanced contract.
    const throughs = perContract
      .map((c) => c.ingested_through)
      .filter((v): v is number => v !== null);
    const ingestedThrough = throughs.length > 0 ? Math.min(...throughs) : null;

    const lagLedgers =
      latestLedger !== null && ingestedThrough !== null
        ? Math.max(0, latestLedger - ingestedThrough)
        : null;

    return {
      status: "ok",
      latest_ledger: latestLedger,
      ingested_through: ingestedThrough,
      // Derived from the ledger delta at Stellar's ~5s close interval;
      // `lag_ledgers` is the exact figure.
      lag_seconds: lagLedgers === null ? null : lagLedgers * AVG_LEDGER_SECONDS,
      lag_ledgers: lagLedgers,
      oldest_source_ledger: Number(db.getMeta("oldest_ledger") ?? "") || null,
      contracts: perContract,
    };
  });

  // ------------------------------------------------ C2 + C3: account history

  app.get<{ Params: { contract_id: string; account: string }; Querystring: RangeQuery }>(
    "/v1/tokens/:contract_id/accounts/:account/events",
    async (req) => {
      const { contract_id: contractId, account } = req.params;
      const { from, to } = resolveRange(contractId, req.query);
      const limit = parseLimit(req.query.limit);
      const after = req.query.cursor ? decodeCursor(req.query.cursor) : undefined;

      const events = db.accountEvents({
        contractId,
        account,
        fromLedger: from,
        toLedger: to,
        types: parseTypes(req.query.types),
        after,
        limit: limit + 1, // one extra probes for a next page
      });
      const page = events.slice(0, limit);
      const hasMore = events.length > limit;

      return {
        events: page.map(serializeEvent),
        cursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
        complete: db.isRangeComplete(contractId, from, to),
        from_ledger: from,
        to_ledger: to,
      };
    },
  );

  // ------------------------------------------------------- C1: checkpoint

  app.get<{ Params: { contract_id: string; account: string }; Querystring: { at_ledger?: string } }>(
    "/v1/tokens/:contract_id/accounts/:account/checkpoint",
    async (req) => {
      const { contract_id: contractId, account } = req.params;
      const status = db.ingestionStatus(contractId);
      const atLedger =
        parseInteger("at_ledger", req.query.at_ledger) ??
        status.ingestedThrough ??
        db.eventLedgerBounds(contractId).max ??
        0;

      const event = db.latestCheckpoint(contractId, account, atLedger);
      const coverage = db.coverage(contractId);

      /*
       * C3 for C1 asks a sharper question than "is the window covered": is this
       * really the *latest* checkpoint? A gap anywhere between the returned
       * event and `at_ledger` could be hiding a newer one, which would hand the
       * wallet a stale (b_tilde, sigma). So completeness is measured from the
       * event found — or from the bottom of coverage when none was, since then
       * a gap anywhere below could be hiding the checkpoint entirely.
       */
      const completenessFrom = event?.ledgerSeq ?? coverage[0]?.fromLedger ?? atLedger;
      return {
        event: event ? serializeEvent(event) : null,
        complete: db.isRangeComplete(contractId, completenessFrom, atLedger),
        at_ledger: atLedger,
        coverage: coverage.map((r) => ({ from_ledger: r.fromLedger, to_ledger: r.toLedger })),
      };
    },
  );

  // -------------------------------------- C2 alternative: per-contract stream

  app.get<{ Params: { contract_id: string }; Querystring: RangeQuery }>(
    "/v1/tokens/:contract_id/events",
    async (req) => {
      const contractId = req.params.contract_id;
      const { from, to } = resolveRange(contractId, req.query);
      const limit = parseLimit(req.query.limit);
      const after = req.query.cursor ? decodeCursor(req.query.cursor) : undefined;

      const events = db.contractEvents({
        contractId,
        fromLedger: from,
        toLedger: to,
        types: parseTypes(req.query.types),
        after,
        limit: limit + 1,
      });
      const page = events.slice(0, limit);
      const hasMore = events.length > limit;

      return {
        events: page.map(serializeEvent),
        cursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
        complete: db.isRangeComplete(contractId, from, to),
        from_ledger: from,
        to_ledger: to,
      };
    },
  );

  /**
   * Coverage detail. Not in §6, but it is what a hybrid client (§1) needs to
   * choose a seam: it must see the archive's contiguous top range reach the
   * RPC retention floor before it can trust the two sources to compose.
   */
  app.get<{ Params: { contract_id: string } }>("/v1/tokens/:contract_id/status", async (req) => {
    const contractId = req.params.contract_id;
    const status = db.ingestionStatus(contractId);
    const bounds = db.eventLedgerBounds(contractId);
    return {
      contract_id: contractId,
      ingested_through: status.ingestedThrough,
      contiguous_from: status.contiguousFrom,
      events: db.countEvents(contractId),
      event_ledger_min: bounds.min,
      event_ledger_max: bounds.max,
      coverage: db
        .coverage(contractId)
        .map((r) => ({ from_ledger: r.fromLedger, to_ledger: r.toLedger })),
      gaps: gapsIn(db.coverage(contractId)).map((g) => ({
        from_ledger: g.fromLedger,
        to_ledger: g.toLedger,
      })),
    };
  });

  return app;
}
