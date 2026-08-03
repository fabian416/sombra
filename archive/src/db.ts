/**
 * Storage layer. One SQLite file holds the archived records (§3.1), the topic
 * index that backs §3.3 attribution, and the contiguous ingested ledger ranges
 * that back the §4 gap contract and the §6 C3 completeness signal.
 *
 * SQLite is a hackathon simplification of a durable archive, not a limitation
 * of the design: every query here is ordinary SQL over three tables, and the
 * §5 obligation ("retain indefinitely") is met by never deleting. See README
 * for the swap-to-Postgres notes.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import { CHECKPOINT_TYPES, type TopicRef } from "./events.js";

export interface ArchivedEvent {
  contractId: string;
  ledgerSeq: number;
  /** Unix seconds. */
  ledgerCloseTime: number;
  txHash: string;
  txApplicationOrder: number;
  opIndex: number;
  eventIndex: number;
  /** Base64 XDR, one entry per topic. */
  topicsXdr: string[];
  /** Base64 XDR of the event's data payload. */
  dataXdr: string;
  /** Decoded topic-0 symbol, for the `types` filter. */
  eventType: string | null;
  /** The RPC's own `<toid>-<eventOrder>` id, kept for forensics. */
  rpcEventId: string | null;
  topics: TopicRef[];
}

export interface LedgerRange {
  fromLedger: number;
  toLedger: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- §3.1 archived record. The primary key is the §2 event id
-- (ledger_seq, tx_hash, event_index), which is what makes ingestion
-- idempotent under §4 ("deduplicated by event id").
CREATE TABLE IF NOT EXISTS events (
  ledger_seq            INTEGER NOT NULL,
  tx_hash               TEXT    NOT NULL,
  event_index           INTEGER NOT NULL,
  contract_id           TEXT    NOT NULL,
  ledger_close_time     INTEGER NOT NULL,
  tx_application_order  INTEGER NOT NULL,
  op_index              INTEGER NOT NULL DEFAULT 0,
  topics_xdr            TEXT    NOT NULL,  -- JSON array of base64 ScVal
  data_xdr              TEXT    NOT NULL,  -- base64 ScVal
  event_type            TEXT,
  rpc_event_id          TEXT,
  PRIMARY KEY (ledger_seq, tx_hash, event_index)
);

-- §3.4 total order: (ledger_seq, tx_application_order, event_index).
CREATE INDEX IF NOT EXISTS events_total_order
  ON events (contract_id, ledger_seq, tx_application_order, event_index);

-- §3.3 attribution index. One row per topic; addresses are what per-account
-- queries join on. Kept beside the events rather than inside them so that
-- the verbatim XDR stays the single source of truth (§4 "Fidelity").
CREATE TABLE IF NOT EXISTS event_topics (
  ledger_seq          INTEGER NOT NULL,
  tx_hash             TEXT    NOT NULL,
  event_index         INTEGER NOT NULL,
  topic_index         INTEGER NOT NULL,
  role                TEXT    NOT NULL,
  kind                TEXT    NOT NULL,
  value               TEXT    NOT NULL,
  is_checkpoint_owner INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ledger_seq, tx_hash, event_index, topic_index),
  FOREIGN KEY (ledger_seq, tx_hash, event_index)
    REFERENCES events (ledger_seq, tx_hash, event_index) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS event_topics_value
  ON event_topics (value, kind, ledger_seq);

-- §4 gap tracking: the set of contiguous ledger ranges fully scanned from the
-- source, per contract. Merged on write, so a gap is literally a discontinuity
-- between two rows.
CREATE TABLE IF NOT EXISTS ingested_ranges (
  contract_id TEXT    NOT NULL,
  from_ledger INTEGER NOT NULL,
  to_ledger   INTEGER NOT NULL,
  PRIMARY KEY (contract_id, from_ledger)
);

-- Ingestion bookkeeping: the RPC paging token to resume from per contract.
CREATE TABLE IF NOT EXISTS ingest_state (
  contract_id  TEXT PRIMARY KEY,
  paging_token TEXT,
  last_ledger  INTEGER,
  updated_at   INTEGER
);

-- Source-wide observations (latest ledger seen, its close time).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class ArchiveDb {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- writes

  /**
   * Insert a batch of events and their topic index. `INSERT OR IGNORE` on the
   * §2 event id gives the at-least-once idempotency §4 requires: re-ingesting
   * an overlapping ledger window is a no-op rather than a duplicate.
   *
   * Returns the number of events that were new.
   */
  insertEvents(events: ArchivedEvent[]): number {
    const insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (ledger_seq, tx_hash, event_index, contract_id, ledger_close_time,
         tx_application_order, op_index, topics_xdr, data_xdr, event_type, rpc_event_id)
      VALUES
        (@ledgerSeq, @txHash, @eventIndex, @contractId, @ledgerCloseTime,
         @txApplicationOrder, @opIndex, @topicsXdr, @dataXdr, @eventType, @rpcEventId)
    `);
    const insertTopic = this.db.prepare(`
      INSERT OR IGNORE INTO event_topics
        (ledger_seq, tx_hash, event_index, topic_index, role, kind, value, is_checkpoint_owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const run = this.db.transaction((batch: ArchivedEvent[]) => {
      let inserted = 0;
      for (const e of batch) {
        const res = insertEvent.run({
          ledgerSeq: e.ledgerSeq,
          txHash: e.txHash,
          eventIndex: e.eventIndex,
          contractId: e.contractId,
          ledgerCloseTime: e.ledgerCloseTime,
          txApplicationOrder: e.txApplicationOrder,
          opIndex: e.opIndex,
          topicsXdr: JSON.stringify(e.topicsXdr),
          dataXdr: e.dataXdr,
          eventType: e.eventType,
          rpcEventId: e.rpcEventId,
        });
        if (res.changes === 0) continue; // already archived
        inserted++;
        for (const t of e.topics) {
          insertTopic.run(
            e.ledgerSeq,
            e.txHash,
            e.eventIndex,
            t.topicIndex,
            t.role,
            t.kind,
            t.value,
            t.isCheckpointOwner ? 1 : 0,
          );
        }
      }
      return inserted;
    });

    return run(events);
  }

  /**
   * Record that `[fromLedger, toLedger]` has been fully scanned for a contract,
   * merging into any adjacent or overlapping range. Adjacency counts: ranges
   * `[100, 200]` and `[201, 300]` describe uninterrupted coverage and collapse
   * into one, so a leftover row boundary never masquerades as a gap.
   */
  recordIngestedRange(contractId: string, fromLedger: number, toLedger: number): void {
    if (toLedger < fromLedger) return;
    const run = this.db.transaction(() => {
      const overlapping = this.db
        .prepare(
          `SELECT from_ledger AS fromLedger, to_ledger AS toLedger
             FROM ingested_ranges
            WHERE contract_id = ? AND to_ledger >= ? AND from_ledger <= ?`,
        )
        .all(contractId, fromLedger - 1, toLedger + 1) as LedgerRange[];

      let lo = fromLedger;
      let hi = toLedger;
      for (const r of overlapping) {
        lo = Math.min(lo, r.fromLedger);
        hi = Math.max(hi, r.toLedger);
        this.db
          .prepare(`DELETE FROM ingested_ranges WHERE contract_id = ? AND from_ledger = ?`)
          .run(contractId, r.fromLedger);
      }
      this.db
        .prepare(
          `INSERT INTO ingested_ranges (contract_id, from_ledger, to_ledger) VALUES (?, ?, ?)`,
        )
        .run(contractId, lo, hi);
    });
    run();
  }

  setIngestState(contractId: string, pagingToken: string | null, lastLedger: number): void {
    this.db
      .prepare(
        `INSERT INTO ingest_state (contract_id, paging_token, last_ledger, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (contract_id) DO UPDATE SET
           paging_token = excluded.paging_token,
           last_ledger  = excluded.last_ledger,
           updated_at   = excluded.updated_at`,
      )
      .run(contractId, pagingToken, lastLedger, Math.floor(Date.now() / 1000));
  }

  getIngestState(
    contractId: string,
  ): { pagingToken: string | null; lastLedger: number | null } | null {
    const row = this.db
      .prepare(
        `SELECT paging_token AS pagingToken, last_ledger AS lastLedger
           FROM ingest_state WHERE contract_id = ?`,
      )
      .get(contractId) as { pagingToken: string | null; lastLedger: number | null } | undefined;
    return row ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  // --------------------------------------------------------------- coverage

  /** The contract's contiguous ingested ranges, ascending. */
  coverage(contractId: string): LedgerRange[] {
    return this.db
      .prepare(
        `SELECT from_ledger AS fromLedger, to_ledger AS toLedger
           FROM ingested_ranges WHERE contract_id = ? ORDER BY from_ledger`,
      )
      .all(contractId) as LedgerRange[];
  }

  /** Every contract that has archived events or recorded coverage. */
  knownContracts(): string[] {
    return (
      this.db
        .prepare(
          `SELECT contract_id AS id FROM ingested_ranges
           UNION SELECT contract_id AS id FROM events ORDER BY id`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * §6 C4. `ingestedThrough` is the highest ledger the archive has fully
   * scanned; `contiguousFrom` is the bottom of the unbroken run ending there.
   *
   * Both are needed to bound staleness honestly. A hybrid client (§1) requires
   * `ingestedThrough >= seam` so the archive reaches up to where live RPC
   * retention begins, *and* `contiguousFrom <= ` the start of the history it
   * needs — a high `ingestedThrough` above a gap covers nothing below the gap.
   */
  ingestionStatus(contractId: string): {
    ingestedThrough: number | null;
    contiguousFrom: number | null;
    gaps: number;
  } {
    const ranges = this.coverage(contractId);
    if (ranges.length === 0) return { ingestedThrough: null, contiguousFrom: null, gaps: 0 };
    const top = ranges[ranges.length - 1]!;
    return {
      ingestedThrough: top.toLedger,
      contiguousFrom: top.fromLedger,
      gaps: ranges.length - 1,
    };
  }

  /**
   * §6 C3. True only when the archive holds gap-free coverage of the whole
   * requested range — i.e. some single contiguous range contains it. Anything
   * else (a gap inside, or a request extending past what has been ingested)
   * is incomplete, and the API says so rather than serving a short history as
   * if it were whole.
   */
  isRangeComplete(contractId: string, fromLedger: number, toLedger: number): boolean {
    if (toLedger < fromLedger) return true;
    const row = this.db
      .prepare(
        `SELECT 1 FROM ingested_ranges
          WHERE contract_id = ? AND from_ledger <= ? AND to_ledger >= ? LIMIT 1`,
      )
      .get(contractId, fromLedger, toLedger);
    return row !== undefined;
  }

  // ----------------------------------------------------------------- reads

  /**
   * §6 C2 for one account. Keyset pagination on the §3.4 total order, so
   * paging cannot skip or repeat an event even while ingestion appends behind
   * the reader.
   *
   * `types` is applied *after* attribution, per §6: it narrows what this
   * response returns and never affects what is stored or attributed.
   */
  accountEvents(params: {
    contractId: string;
    account: string;
    fromLedger: number;
    toLedger: number;
    types?: string[];
    after?: OrderKey;
    limit: number;
  }): ArchivedEvent[] {
    const { contractId, account, fromLedger, toLedger, types, after, limit } = params;
    const clauses: string[] = [
      `e.contract_id = @contractId`,
      `e.ledger_seq >= @fromLedger`,
      `e.ledger_seq <= @toLedger`,
      `EXISTS (SELECT 1 FROM event_topics t
                WHERE t.ledger_seq = e.ledger_seq
                  AND t.tx_hash = e.tx_hash
                  AND t.event_index = e.event_index
                  AND t.kind = 'address'
                  AND t.value = @account)`,
    ];
    const bind: Record<string, unknown> = { contractId, account, fromLedger, toLedger, limit };

    if (after) {
      clauses.push(
        `(e.ledger_seq, e.tx_application_order, e.event_index) >
         (@afterLedger, @afterTxOrder, @afterEventIndex)`,
      );
      bind.afterLedger = after.ledgerSeq;
      bind.afterTxOrder = after.txApplicationOrder;
      bind.afterEventIndex = after.eventIndex;
    }
    const typeClause = this.typeFilter(types, bind);
    if (typeClause) clauses.push(typeClause);

    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e
          WHERE ${clauses.join(" AND ")}
          ORDER BY e.ledger_seq, e.tx_application_order, e.event_index
          LIMIT @limit`,
      )
      .all(bind) as EventRow[];
    return this.hydrate(rows);
  }

  /**
   * The per-contract stream §3.3 and §6 permit as an alternative to
   * server-side attribution — and the only useful shape for contracts whose
   * topics carry no addresses at all, such as the SPP pool's commitments and
   * nullifiers.
   */
  contractEvents(params: {
    contractId: string;
    fromLedger: number;
    toLedger: number;
    types?: string[];
    after?: OrderKey;
    limit: number;
  }): ArchivedEvent[] {
    const { contractId, fromLedger, toLedger, types, after, limit } = params;
    const clauses: string[] = [
      `e.contract_id = @contractId`,
      `e.ledger_seq >= @fromLedger`,
      `e.ledger_seq <= @toLedger`,
    ];
    const bind: Record<string, unknown> = { contractId, fromLedger, toLedger, limit };
    if (after) {
      clauses.push(
        `(e.ledger_seq, e.tx_application_order, e.event_index) >
         (@afterLedger, @afterTxOrder, @afterEventIndex)`,
      );
      bind.afterLedger = after.ledgerSeq;
      bind.afterTxOrder = after.txApplicationOrder;
      bind.afterEventIndex = after.eventIndex;
    }
    const typeClause = this.typeFilter(types, bind);
    if (typeClause) clauses.push(typeClause);

    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e
          WHERE ${clauses.join(" AND ")}
          ORDER BY e.ledger_seq, e.tx_application_order, e.event_index
          LIMIT @limit`,
      )
      .all(bind) as EventRow[];
    return this.hydrate(rows);
  }

  /**
   * §6 C1. The account's most recent checkpoint event at or before `atLedger`.
   *
   * The join requires `is_checkpoint_owner`, so a `Transfer` surfaces only for
   * its sender: the checkpoint publishes the *sender's* `(b_tilde, sigma)`,
   * and returning it to the recipient would be returning someone else's
   * spendable balance.
   */
  latestCheckpoint(contractId: string, account: string, atLedger: number): ArchivedEvent | null {
    const rows = this.db
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM events e
          WHERE e.contract_id = @contractId
            AND e.ledger_seq <= @atLedger
            AND e.event_type IN (${CHECKPOINT_TYPES.map((t) => `'${t}'`).join(",")})
            AND EXISTS (SELECT 1 FROM event_topics t
                         WHERE t.ledger_seq = e.ledger_seq
                           AND t.tx_hash = e.tx_hash
                           AND t.event_index = e.event_index
                           AND t.kind = 'address'
                           AND t.value = @account
                           AND t.is_checkpoint_owner = 1)
          ORDER BY e.ledger_seq DESC, e.tx_application_order DESC, e.event_index DESC
          LIMIT 1`,
      )
      .all({ contractId, account, atLedger }) as EventRow[];
    const hydrated = this.hydrate(rows);
    return hydrated[0] ?? null;
  }

  /** Lowest and highest ledger with an archived event for a contract. */
  eventLedgerBounds(contractId: string): { min: number | null; max: number | null } {
    const row = this.db
      .prepare(
        `SELECT MIN(ledger_seq) AS min, MAX(ledger_seq) AS max FROM events WHERE contract_id = ?`,
      )
      .get(contractId) as { min: number | null; max: number | null };
    return row;
  }

  countEvents(contractId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE contract_id = ?`)
      .get(contractId) as { n: number };
    return row.n;
  }

  // ------------------------------------------------------------- internals

  private typeFilter(types: string[] | undefined, bind: Record<string, unknown>): string | null {
    if (!types || types.length === 0) return null;
    const names = types.map((t, i) => {
      bind[`type${i}`] = t;
      return `@type${i}`;
    });
    return `e.event_type IN (${names.join(",")})`;
  }

  private hydrate(rows: EventRow[]): ArchivedEvent[] {
    if (rows.length === 0) return [];
    const topicStmt = this.db.prepare(
      `SELECT topic_index AS topicIndex, role, kind, value,
              is_checkpoint_owner AS isCheckpointOwner
         FROM event_topics
        WHERE ledger_seq = ? AND tx_hash = ? AND event_index = ?
        ORDER BY topic_index`,
    );
    return rows.map((r) => {
      const topicRows = topicStmt.all(r.ledgerSeq, r.txHash, r.eventIndex) as {
        topicIndex: number;
        role: string;
        kind: TopicRef["kind"];
        value: string;
        isCheckpointOwner: number;
      }[];
      return {
        contractId: r.contractId,
        ledgerSeq: r.ledgerSeq,
        ledgerCloseTime: r.ledgerCloseTime,
        txHash: r.txHash,
        txApplicationOrder: r.txApplicationOrder,
        opIndex: r.opIndex,
        eventIndex: r.eventIndex,
        topicsXdr: JSON.parse(r.topicsXdr) as string[],
        dataXdr: r.dataXdr,
        eventType: r.eventType,
        rpcEventId: r.rpcEventId,
        topics: topicRows.map((t) => ({
          topicIndex: t.topicIndex,
          role: t.role,
          kind: t.kind,
          value: t.value,
          isCheckpointOwner: t.isCheckpointOwner === 1,
        })),
      };
    });
  }
}

/** Position in the §3.4 total order; the pagination cursor decodes to this. */
export interface OrderKey {
  ledgerSeq: number;
  txApplicationOrder: number;
  eventIndex: number;
}

const EVENT_COLUMNS = `
  e.contract_id          AS contractId,
  e.ledger_seq           AS ledgerSeq,
  e.ledger_close_time    AS ledgerCloseTime,
  e.tx_hash              AS txHash,
  e.tx_application_order AS txApplicationOrder,
  e.op_index             AS opIndex,
  e.event_index          AS eventIndex,
  e.topics_xdr           AS topicsXdr,
  e.data_xdr             AS dataXdr,
  e.event_type           AS eventType,
  e.rpc_event_id         AS rpcEventId`;

interface EventRow {
  contractId: string;
  ledgerSeq: number;
  ledgerCloseTime: number;
  txHash: string;
  txApplicationOrder: number;
  opIndex: number;
  eventIndex: number;
  topicsXdr: string;
  dataXdr: string;
  eventType: string | null;
  rpcEventId: string | null;
}
