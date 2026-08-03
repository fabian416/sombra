/**
 * Conformance suite for INDEXER.md.
 *
 * §8 defines conformance precisely: an implementation conforms iff it satisfies
 * §3–§5 and exposes C2, C3 and C4 (C1 is RECOMMENDED). Every case below is
 * titled with the clause it demonstrates, so the suite reads as a checklist
 * against the normative text rather than against this implementation's idea of
 * itself.
 *
 * No network. Events come from a fake `RpcSource` that serves a scripted event
 * stream, and storage is an in-memory SQLite database, so the ingestion
 * contract (§4) is exercised end to end without a chain.
 */
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { ArchiveDb } from "../src/db.js";
import type { Config } from "../src/config.js";
import { attributeTopics, eventTypeOf, formatSourceEventId, topicsToXdr } from "../src/events.js";
import { Ingester, gapsIn, toArchivedEvent } from "../src/ingest.js";
import type { GetEventsArgs, RawSourceEvent, SourceHealth, SourcePage } from "../src/source.js";
import type { RpcSource } from "../src/source.js";

// ---------------------------------------------------------------- test rig

function seeded(label: string, n: number): Buffer {
  const out = Buffer.alloc(n);
  let filled = 0;
  let i = 0;
  while (filled < n) {
    const chunk = createHash("sha256").update(`${label}/${i++}`).digest();
    chunk.copy(out, filled, 0, Math.min(chunk.length, n - filled));
    filled += chunk.length;
  }
  return out;
}

const account = (label: string): string =>
  Keypair.fromRawEd25519Seed(seeded(`acct/${label}`, 32)).publicKey();

const CONTRACT = StrKey.encodeContract(seeded("contract", 32));
const ALICE = account("alice");
const BOB = account("bob");
const SPENDER = account("spender");
/** Appears only as a transaction source, never in any topic (§3.3). */
const TX_SOURCE = account("tx-source");

interface EventSpec {
  ledger: number;
  txOrder?: number;
  eventIndex?: number;
  name: string;
  topics: string[];
  reverted?: boolean;
  txHash?: string;
}

/** Build a source event with real XDR topics, as the RPC would serve it. */
function sourceEvent(spec: EventSpec): RawSourceEvent {
  const topics = [
    xdr.ScVal.scvSymbol(spec.name),
    ...spec.topics.map((a) => Address.fromString(a).toScVal()),
  ];
  const txOrder = spec.txOrder ?? 1;
  const eventIndex = spec.eventIndex ?? 0;
  const data = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("b_tilde"),
      val: xdr.ScVal.scvBytes(seeded(`${spec.name}/${spec.ledger}/b`, 32)),
    }),
  ]);
  return {
    id: formatSourceEventId({ ledgerSeq: spec.ledger, txApplicationOrder: txOrder, opIndex: 0, eventIndex }),
    type: "contract",
    ledger: spec.ledger,
    ledgerClosedAt: new Date((1_750_000_000 + spec.ledger) * 1000).toISOString(),
    contractId: CONTRACT,
    txHash: spec.txHash ?? seeded(`tx/${spec.ledger}/${txOrder}/${eventIndex}`, 32).toString("hex"),
    topic: topicsToXdr(topics),
    value: data.toXDR("base64"),
    inSuccessfulContractCall: spec.reverted !== true,
    transactionIndex: txOrder,
    operationIndex: 0,
  };
}

/**
 * A source that serves a fixed event list, honouring `startLedger`/`endLedger`
 * and `limit` the way stellar-rpc does (verified against live testnet:
 * `endLedger` is exclusive).
 */
class FakeSource {
  calls: GetEventsArgs[] = [];

  constructor(
    private events: RawSourceEvent[],
    private headLedger: number,
    private oldest = 0,
  ) {}

  async health(): Promise<SourceHealth> {
    return {
      status: "healthy",
      latestLedger: this.headLedger,
      latestLedgerCloseTime: 1_750_000_000 + this.headLedger,
      oldestLedger: this.oldest,
      ledgerRetentionWindow: this.headLedger - this.oldest,
    };
  }

  async latestLedger(): Promise<number> {
    return this.headLedger;
  }

  async getEvents(args: GetEventsArgs & { limit: number }): Promise<SourcePage> {
    this.calls.push(args);
    const ordered = [...this.events].sort(
      (a, b) =>
        a.ledger - b.ledger ||
        (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0) ||
        a.id.localeCompare(b.id),
    );
    let pool = ordered;
    if ("cursor" in args) {
      const idx = ordered.findIndex((e) => e.id === args.cursor);
      pool = idx >= 0 ? ordered.slice(idx + 1) : ordered;
    } else {
      pool = ordered.filter((e) => e.ledger >= args.startLedger);
      if (args.endLedger !== undefined) {
        pool = pool.filter((e) => e.ledger < args.endLedger!); // exclusive
      }
    }
    const page = pool.slice(0, args.limit);
    return {
      events: page,
      cursor: page.length > 0 ? page[page.length - 1]!.id : null,
      latestLedger: this.headLedger,
    };
  }
}

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    rpcUrl: "http://fake",
    contractIds: [CONTRACT],
    pollIntervalMs: 10,
    pageLimit: 100,
    startLedger: 100,
    retentionMargin: 0,
    pollWindowLedgers: 1000,
    dbPath: ":memory:",
    port: 0,
    host: "127.0.0.1",
    corsOrigin: true,
    apiOnly: false,
    allowFixtureDb: false,
    ...over,
  };
}

function makeIngester(db: ArchiveDb, source: FakeSource, cfg = makeConfig()): Ingester {
  return new Ingester(db, source as unknown as RpcSource, cfg);
}

/** Ingest a scripted stream into a fresh DB and return both. */
async function ingest(
  events: EventSpec[],
  opts: { head?: number; cfg?: Partial<Config> } = {},
): Promise<{ db: ArchiveDb; source: FakeSource }> {
  const db = new ArchiveDb(":memory:");
  const head = opts.head ?? 200;
  const source = new FakeSource(events.map(sourceEvent), head);
  const ing = makeIngester(db, source, makeConfig(opts.cfg));
  await ing.recordRetentionIntent();
  await ing.pollContract(CONTRACT);
  return { db, source };
}

// A history exercising every recovery role in §3.2.
const HISTORY: EventSpec[] = [
  { ledger: 100, name: "register", topics: [ALICE] },
  { ledger: 105, name: "deposit", topics: [ALICE, ALICE] },
  { ledger: 110, name: "merge", topics: [ALICE] },
  { ledger: 120, name: "transfer", topics: [ALICE, BOB] }, // ALICE's checkpoint
  { ledger: 130, name: "transfer", topics: [BOB, ALICE] }, // BOB's checkpoint
  { ledger: 140, name: "set_spender", topics: [ALICE, SPENDER] },
  { ledger: 150, name: "spender_transfer", topics: [SPENDER, ALICE, BOB] },
  { ledger: 160, name: "merge", topics: [ALICE] },
  { ledger: 170, name: "withdraw", topics: [ALICE, BOB] },
];

// ---------------------------------------------------------------- §3 model

describe("§3 Data Model", () => {
  it("§3.1 persists every required record field, with topics and data as verbatim XDR", async () => {
    const { db } = await ingest([HISTORY[0]!]);
    const [e] = db.contractEvents({
      contractId: CONTRACT,
      fromLedger: 0,
      toLedger: 1000,
      limit: 10,
    });
    expect(e).toBeDefined();

    // The seven fields §3.1 tabulates.
    expect(e!.contractId).toBe(CONTRACT);
    expect(e!.ledgerSeq).toBe(100);
    expect(e!.ledgerCloseTime).toBe(1_750_000_100);
    expect(e!.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e!.txApplicationOrder).toBe(1);
    expect(e!.eventIndex).toBe(0);
    expect(e!.topicsXdr.length).toBeGreaterThan(0);
    expect(e!.dataXdr.length).toBeGreaterThan(0);

    // Verbatim: the stored XDR must decode back to the event as emitted.
    const decoded = e!.topicsXdr.map((t) => xdr.ScVal.fromXDR(t, "base64"));
    expect(eventTypeOf(decoded)).toBe("register");
    expect(Address.fromScVal(decoded[1]!).toString()).toBe(ALICE);
    expect(() => xdr.ScVal.fromXDR(e!.dataXdr, "base64")).not.toThrow();
  });

  it("§3.3 attributes a Transfer to BOTH sender and recipient", async () => {
    const { db } = await ingest(HISTORY);
    const forAlice = db.accountEvents({
      contractId: CONTRACT, account: ALICE, fromLedger: 120, toLedger: 120, limit: 10,
    });
    const forBob = db.accountEvents({
      contractId: CONTRACT, account: BOB, fromLedger: 120, toLedger: 120, limit: 10,
    });
    expect(forAlice.map((e) => e.eventType)).toEqual(["transfer"]);
    expect(forBob.map((e) => e.eventType)).toEqual(["transfer"]);
  });

  it("§3.3 attributes a SpenderTransfer to owner, recipient AND spender", async () => {
    const { db } = await ingest(HISTORY);
    for (const who of [ALICE, BOB, SPENDER]) {
      const got = db.accountEvents({
        contractId: CONTRACT, account: who, fromLedger: 150, toLedger: 150, limit: 10,
      });
      expect(got.map((e) => e.eventType)).toEqual(["spender_transfer"]);
    }
  });

  it("§3.3 never attributes an event to the transaction source account", async () => {
    // TX_SOURCE signs nothing here and appears in no topic; attribution is a
    // function of the topics alone, so it must own no history.
    const { db } = await ingest(HISTORY);
    const got = db.accountEvents({
      contractId: CONTRACT, account: TX_SOURCE, fromLedger: 0, toLedger: 1000, limit: 100,
    });
    expect(got).toEqual([]);
  });

  it("§3.4 returns events in (ledger_seq, tx_application_order, event_index) order", async () => {
    // Deliberately out of order, with two events in one ledger (differing tx
    // order) and two events in one transaction (differing event index).
    const scrambled: EventSpec[] = [
      { ledger: 210, txOrder: 2, eventIndex: 0, name: "merge", topics: [ALICE] },
      { ledger: 200, txOrder: 5, eventIndex: 1, name: "deposit", topics: [ALICE, ALICE] },
      { ledger: 210, txOrder: 1, eventIndex: 0, name: "deposit", topics: [ALICE, ALICE] },
      { ledger: 200, txOrder: 5, eventIndex: 0, name: "register", topics: [ALICE] },
      { ledger: 200, txOrder: 1, eventIndex: 0, name: "register", topics: [ALICE] },
    ];
    const { db } = await ingest(scrambled, { head: 300, cfg: { startLedger: 200 } });
    const got = db.accountEvents({
      contractId: CONTRACT, account: ALICE, fromLedger: 0, toLedger: 1000, limit: 100,
    });
    expect(got.map((e) => [e.ledgerSeq, e.txApplicationOrder, e.eventIndex])).toEqual([
      [200, 1, 0],
      [200, 5, 0],
      [200, 5, 1],
      [210, 1, 0],
      [210, 2, 0],
    ]);
  });
});

// ------------------------------------------------------------ §4 ingestion

describe("§4 Ingestion Contract", () => {
  it("§4 idempotency: re-ingesting an overlapping window inserts nothing new", async () => {
    const db = new ArchiveDb(":memory:");
    const source = new FakeSource(HISTORY.map(sourceEvent), 200);
    const ing = makeIngester(db, source);

    const first = await ing.scanRange(CONTRACT, 100, 200);
    expect(first.inserted).toBe(HISTORY.length);

    // Same window again, plus a wider one straddling it.
    const second = await ing.scanRange(CONTRACT, 100, 200);
    const third = await ing.scanRange(CONTRACT, 90, 200);
    expect(second.inserted).toBe(0);
    expect(third.inserted).toBe(0);
    expect(db.countEvents(CONTRACT)).toBe(HISTORY.length);
  });

  it("§4 gap tracking: a hole between ingested ranges is reported and never merged away", async () => {
    const db = new ArchiveDb(":memory:");
    db.recordIngestedRange(CONTRACT, 100, 150);
    db.recordIngestedRange(CONTRACT, 200, 250);

    expect(gapsIn(db.coverage(CONTRACT))).toEqual([{ fromLedger: 151, toLedger: 199 }]);
    expect(db.ingestionStatus(CONTRACT).gaps).toBe(1);

    // Adjacent ranges DO collapse — a row boundary is not a gap.
    db.recordIngestedRange(CONTRACT, 251, 300);
    expect(db.coverage(CONTRACT)).toEqual([
      { fromLedger: 100, toLedger: 150 },
      { fromLedger: 200, toLedger: 300 },
    ]);

    // Filling the hole exactly collapses everything into one range.
    db.recordIngestedRange(CONTRACT, 151, 199);
    expect(gapsIn(db.coverage(CONTRACT))).toEqual([]);
    expect(db.coverage(CONTRACT)).toEqual([{ fromLedger: 100, toLedger: 300 }]);
  });

  it("§4 coverage is bounded by the request, never by the node's reported head", async () => {
    // The source's head is 5000, but the poll window is 50 ledgers. Coverage
    // must stop at the window the request bounded — claiming through
    // `latestLedger` would assert scanning of ledgers nobody asked about.
    const { db, source } = await ingest(HISTORY, {
      head: 5000,
      cfg: { startLedger: 100, pollWindowLedgers: 50 },
    });
    expect(db.ingestionStatus(CONTRACT).ingestedThrough).toBe(149);

    // And every request carried an explicit exclusive upper bound.
    const ranged = source.calls.filter((c) => !("cursor" in c));
    expect(ranged.length).toBeGreaterThan(0);
    for (const call of ranged) {
      expect((call as { endLedger?: number }).endLedger).toBe(150);
    }
  });

  it("§4 fidelity: an event whose topics cannot be decoded is still archived in full", () => {
    const raw = sourceEvent({ ledger: 100, name: "register", topics: [ALICE] });
    const corrupt: RawSourceEvent = { ...raw, topic: ["!!!not-valid-xdr!!!"] };

    const archived = toArchivedEvent(corrupt);
    // The bytes survive; only the decoded index is lost.
    expect(archived.topicsXdr).toEqual(["!!!not-valid-xdr!!!"]);
    expect(archived.dataXdr).toBe(raw.value);
    expect(archived.ledgerSeq).toBe(100);
    expect(archived.eventType).toBeNull();
    expect(archived.topics).toEqual([]);
  });

  it("§4 source: rolled-back sub-call events are stored but excluded from reads", async () => {
    const withReverted: EventSpec[] = [
      ...HISTORY,
      // A deposit emitted by a sub-call that panicked: never affected state.
      { ledger: 180, name: "deposit", topics: [ALICE, ALICE], reverted: true },
    ];
    const { db } = await ingest(withReverted);

    // Stored (§4 Fidelity: filter on read, do not drop at ingest).
    expect(db.countEvents(CONTRACT)).toBe(withReverted.length);
    const audited = db.accountEvents({
      contractId: CONTRACT, account: ALICE, fromLedger: 180, toLedger: 180,
      limit: 10, includeReverted: true,
    });
    expect(audited).toHaveLength(1);
    expect(audited[0]!.inSuccessfulContractCall).toBe(false);

    // Excluded from the C2 read a wallet would replay — accumulating it would
    // credit value the chain never did, failing the §7 commitment check.
    const replayed = db.accountEvents({
      contractId: CONTRACT, account: ALICE, fromLedger: 180, toLedger: 180, limit: 10,
    });
    expect(replayed).toEqual([]);
  });
});

// ------------------------------------------------------------ §5 retention

describe("§5 Retention Obligations", () => {
  it("§5 an archive started at the retention floor reports holds_full_history=false", async () => {
    const db = new ArchiveDb(":memory:");
    const source = new FakeSource(HISTORY.map(sourceEvent), 200, 100);
    await makeIngester(db, source, makeConfig({ startLedger: "auto" })).recordRetentionIntent();

    const intent = db.getRetentionIntent(CONTRACT);
    expect(intent?.holdsFullHistory).toBe(false);
  });

  it("§5 an archive started at the contract's deploy ledger reports holds_full_history=true", async () => {
    const db = new ArchiveDb(":memory:");
    const source = new FakeSource(HISTORY.map(sourceEvent), 200, 50);
    await makeIngester(db, source, makeConfig({ startLedger: 100 })).recordRetentionIntent();

    expect(db.getRetentionIntent(CONTRACT)).toEqual({ retainsFrom: 100, holdsFullHistory: true });
  });

  it("§5 nothing prunes: retention intent is recorded once and never revised", async () => {
    const db = new ArchiveDb(":memory:");
    const source = new FakeSource(HISTORY.map(sourceEvent), 200, 50);
    await makeIngester(db, source, makeConfig({ startLedger: 100 })).recordRetentionIntent();
    // A later restart with a different (worse) configuration must not rewrite
    // the standing intent.
    await makeIngester(db, source, makeConfig({ startLedger: 190 })).recordRetentionIntent();

    expect(db.getRetentionIntent(CONTRACT)?.retainsFrom).toBe(100);
  });
});

// ------------------------------------------------------------------ §6 API

describe("§6 API Surface", () => {
  it("§6 C2 returns the account's history in order, paginated without loss or repeat", async () => {
    const { db } = await ingest(HISTORY);
    const all: string[] = [];
    let after = undefined as undefined | ReturnType<typeof key>;
    function key(e: { ledgerSeq: number; txApplicationOrder: number; opIndex: number; eventIndex: number }) {
      return {
        ledgerSeq: e.ledgerSeq,
        txApplicationOrder: e.txApplicationOrder,
        opIndex: e.opIndex,
        eventIndex: e.eventIndex,
      };
    }
    for (let page = 0; page < 20; page++) {
      const got = db.accountEvents({
        contractId: CONTRACT, account: ALICE, fromLedger: 0, toLedger: 1000, limit: 2, after,
      });
      if (got.length === 0) break;
      all.push(...got.map((e) => `${e.ledgerSeq}:${e.eventType}`));
      after = key(got[got.length - 1]!);
    }
    // ALICE touches everything except BOB's own 130 transfer... which she also
    // receives. So: all nine events, each exactly once, ascending.
    expect(all).toEqual([
      "100:register", "105:deposit", "110:merge", "120:transfer", "130:transfer",
      "140:set_spender", "150:spender_transfer", "160:merge", "170:withdraw",
    ]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("§6 C3 a range spanning a gap returns complete:false", async () => {
    const db = new ArchiveDb(":memory:");
    db.recordIngestedRange(CONTRACT, 100, 150);
    db.recordIngestedRange(CONTRACT, 200, 250);

    expect(db.isRangeComplete(CONTRACT, 100, 150)).toBe(true);
    expect(db.isRangeComplete(CONTRACT, 200, 250)).toBe(true);
    expect(db.isRangeComplete(CONTRACT, 100, 250)).toBe(false); // spans the hole
    expect(db.isRangeComplete(CONTRACT, 140, 210)).toBe(false);
  });

  it("§6 C3 a range extending past ingested_through returns complete:false", async () => {
    const { db } = await ingest(HISTORY, { head: 200, cfg: { pollWindowLedgers: 50 } });
    const through = db.ingestionStatus(CONTRACT).ingestedThrough!;
    expect(db.isRangeComplete(CONTRACT, 100, through)).toBe(true);
    expect(db.isRangeComplete(CONTRACT, 100, through + 1)).toBe(false);
  });

  it("§6 C4 exposes the latest fully-ingested ledger and its contiguous floor", async () => {
    const { db } = await ingest(HISTORY, { head: 300, cfg: { pollWindowLedgers: 100 } });
    const status = db.ingestionStatus(CONTRACT);
    expect(status.ingestedThrough).toBe(199);
    expect(status.contiguousFrom).toBe(100);
    expect(status.gaps).toBe(0);
  });

  it("§6 C1 a Transfer is the SENDER's checkpoint and not the recipient's", async () => {
    const { db } = await ingest(HISTORY);
    // At ledger 135 the only checkpoints so far are the two transfers:
    // 120 (ALICE -> BOB) and 130 (BOB -> ALICE).
    const forAlice = db.latestCheckpoint(CONTRACT, ALICE, 135);
    const forBob = db.latestCheckpoint(CONTRACT, BOB, 135);

    expect(forAlice?.ledgerSeq).toBe(120); // she sent it
    expect(forBob?.ledgerSeq).toBe(130); // he sent it

    // The sharp assertion: BOB is the recipient at 120 and it must NOT be his
    // checkpoint — that (b_tilde, sigma) is ALICE's spendable balance, and
    // handing it to BOB yields an opening that fails §7 against the chain.
    const bobBefore = db.latestCheckpoint(CONTRACT, BOB, 125);
    expect(bobBefore).toBeNull();
  });

  it("§6 C1 a spender gets no checkpoint from SetSpender/RevokeSpender", async () => {
    // §3.2: these are owner checkpoints only — a spender recovers allowance
    // state from the on-chain delegation entry, not from the archive.
    const { db } = await ingest(HISTORY);
    expect(db.latestCheckpoint(CONTRACT, SPENDER, 1000)).toBeNull();
    expect(db.latestCheckpoint(CONTRACT, ALICE, 145)?.eventType).toBe("set_spender");
  });

  it("§6 C1 a self-transfer is its own checkpoint", async () => {
    // §3.2: a self-transfer carries both roles at once — sender-side
    // checkpoint and recipient-side replay event.
    const { db } = await ingest([
      { ledger: 100, name: "register", topics: [ALICE] },
      { ledger: 120, name: "transfer", topics: [ALICE, ALICE] },
    ]);
    const cp = db.latestCheckpoint(CONTRACT, ALICE, 1000);
    expect(cp?.ledgerSeq).toBe(120);
    expect(cp?.eventType).toBe("transfer");

    // And it is still in her replayable history as a received event.
    const history = db.accountEvents({
      contractId: CONTRACT, account: ALICE, fromLedger: 120, toLedger: 120, limit: 10,
    });
    expect(history).toHaveLength(1);
    const roles = history[0]!.topics.filter((t) => t.kind === "address").map((t) => t.role);
    expect(roles).toEqual(["from", "to"]);
  });

  it("§6 the types filter narrows the response without changing attribution", async () => {
    const { db } = await ingest(HISTORY);
    const base = { contractId: CONTRACT, fromLedger: 0, toLedger: 1000, limit: 100 };

    const unfiltered = db.accountEvents({ ...base, account: ALICE });
    const filtered = db.accountEvents({ ...base, account: ALICE, types: ["transfer"] });

    // A strict subset of the same attributed set — never widened, never
    // re-attributed. §6: servers MUST apply `types` AFTER attribution.
    expect(filtered.map((e) => e.eventType)).toEqual(["transfer", "transfer"]);
    const ids = new Set(unfiltered.map((e) => e.rpcEventId));
    for (const e of filtered) expect(ids.has(e.rpcEventId)).toBe(true);

    // Filtering ALICE's view does not change who else the events belong to:
    // the 120 transfer is still BOB's, and 150 still reaches the spender.
    expect(
      db.accountEvents({ ...base, account: BOB, types: ["transfer"] }).map((e) => e.ledgerSeq),
    ).toEqual([120, 130]);
    expect(
      db.accountEvents({ ...base, account: SPENDER }).map((e) => e.ledgerSeq),
    ).toEqual([140, 150]);
  });

  it("§2 T_0 is the last Merge at or BEFORE the checkpoint, not the last Merge overall", async () => {
    /*
     * The trap §2 spells out. ALICE merges at 160, checkpoints (withdraw) at
     * 170, then merges AGAIN at 180. Anchoring the replay at her last merge
     * overall (180) reconstructs the receiving side correctly but leaves the
     * spendable opening short by whatever the 180 merge folded in, because the
     * checkpoint at 170 predates it.
     */
    const { db } = await ingest([...HISTORY, { ledger: 180, name: "merge", topics: [ALICE] }]);

    const checkpoint = db.latestCheckpoint(CONTRACT, ALICE, 1000);
    expect(checkpoint?.ledgerSeq).toBe(170);

    const t0 = db.latestEventOfTypes(CONTRACT, ALICE, ["merge"], checkpoint!.ledgerSeq);
    expect(t0?.ledgerSeq).toBe(160);
    expect(t0?.ledgerSeq).not.toBe(180);
  });

  it("§2 T_0 falls back to Register when the account never merged before its checkpoint", async () => {
    const { db } = await ingest([
      { ledger: 100, name: "register", topics: [ALICE] },
      { ledger: 110, name: "deposit", topics: [ALICE, ALICE] },
      { ledger: 120, name: "withdraw", topics: [ALICE, BOB] },
    ]);
    const cp = db.latestCheckpoint(CONTRACT, ALICE, 1000);
    expect(cp?.ledgerSeq).toBe(120);
    expect(db.latestEventOfTypes(CONTRACT, ALICE, ["merge"], cp!.ledgerSeq)).toBeNull();
    expect(db.latestEventOfTypes(CONTRACT, ALICE, ["register"], cp!.ledgerSeq)?.ledgerSeq).toBe(100);
  });
});

// ------------------------------------------------------- storage integrity

describe("Storage integrity", () => {
  let db: ArchiveDb;
  beforeEach(() => {
    db = new ArchiveDb(":memory:");
  });

  it("distinct events sharing the §2 id triple are both retained", () => {
    /*
     * §2 asserts (ledger_seq, tx_hash, event_index) is unique "because a
     * Soroban transaction carries a single operation". On live testnet it is
     * not: a transaction's fee-phase and application-phase events share both
     * tx_hash and event_index, differing only in tx_application_order. Keying
     * storage on the §2 triple silently discarded ~1.4% of real events.
     */
    const shared = seeded("shared-tx", 32).toString("hex");
    const a = sourceEvent({ ledger: 300, txOrder: 0, eventIndex: 0, name: "deposit", topics: [ALICE, ALICE], txHash: shared });
    const b = sourceEvent({ ledger: 300, txOrder: 1, eventIndex: 0, name: "merge", topics: [ALICE], txHash: shared });

    expect(db.insertEvents([a, b].map(toArchivedEvent))).toBe(2);
    expect(db.countEvents(CONTRACT)).toBe(2);
  });

  it("re-ingesting refreshes the attribution index rather than skipping it", () => {
    const raw = sourceEvent({ ledger: 100, name: "transfer", topics: [ALICE, BOB] });
    db.insertEvents([toArchivedEvent(raw)]);

    // Simulate an attribution index that lost its rows (as a stale build, or
    // a corrected `attributeTopics`, would leave it).
    db.db.prepare("DELETE FROM event_topics").run();
    expect(
      db.accountEvents({ contractId: CONTRACT, account: ALICE, fromLedger: 0, toLedger: 999, limit: 10 }),
    ).toEqual([]);

    // Re-ingesting the same event must rebuild it even though the event row
    // already exists.
    db.insertEvents([toArchivedEvent(raw)]);
    expect(
      db.accountEvents({ contractId: CONTRACT, account: ALICE, fromLedger: 0, toLedger: 999, limit: 10 }),
    ).toHaveLength(1);
  });

  it("a directly-invoked scanRange drains a multi-page range to completion", async () => {
    // M1: gating the loop on a `running` flag made a scan invoked outside the
    // background loop stop after one page, leaving the gap half-filled.
    const many: EventSpec[] = Array.from({ length: 25 }, (_, i) => ({
      ledger: 100 + i,
      name: "deposit",
      topics: [ALICE, ALICE],
    }));
    const source = new FakeSource(many.map(sourceEvent), 200);
    const ing = makeIngester(db, source, makeConfig({ pageLimit: 5 }));

    const res = await ing.scanRange(CONTRACT, 100, 130);
    expect(res.inserted).toBe(25);
    expect(db.coverage(CONTRACT)).toEqual([{ fromLedger: 100, toLedger: 130 }]);
  });
});
