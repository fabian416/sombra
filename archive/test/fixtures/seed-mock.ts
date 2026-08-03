/**
 * Seed a synthetic event history — a **test fixture**, not a data source.
 *
 * It lives under `test/` and stamps `meta.source = "seeded-fixture"` on every
 * database it writes, which `/v1/health` reports and which the server refuses
 * to serve without `ALLOW_FIXTURE_DB=1`. The point is that a seeded archive
 * must never be mistakable for one that ingested a real chain: an archive whose
 * conformance properties are demonstrated against data this repo authored has
 * demonstrated nothing. The real deployment ingests the testnet contract.
 *
 * What it is legitimately for: driving the conformance tests, and exercising
 * the API before a contract is deployed.
 *
 * The events are fake but not fictional: topics and data are real XDR, built to
 * the exact shapes `stellar-contracts` publishes (`#[contractevent]` structs in
 * `packages/tokens/src/confidential/mod.rs`, tabulated in DESIGN_cont §11.2) —
 * snake_case event name at topic 0, `#[topic]` fields after it, remaining
 * fields as an `ScMap` payload. So a client decodes seeded events with exactly
 * the code it will use on real ones; only the cryptographic material is noise,
 * which no archive-side path interprets.
 *
 * The timeline is built to exercise recovery rather than to look busy: it ends
 * with a checkpoint (`RevokeSpender`) that sits *after* the account's last
 * `Merge`, which is precisely the §2 case where anchoring the replay window at
 * the last merge overall gives the wrong answer.
 *
 *   npm run seed:mock            # coherent, gap-free history
 *   npm run seed:mock -- --gap   # same, minus a ledger range: C3 -> false
 */
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

import { loadConfig } from "../../src/config.js";
import { ArchiveDb, type ArchivedEvent } from "../../src/db.js";
import {
  attributeTopics,
  eventTypeOf,
  formatSourceEventId,
  topicsToXdr,
} from "../../src/events.js";

const START_LEDGER = Number.parseInt(process.env.MOCK_START_LEDGER ?? "3800000", 10);
const LEDGER_CLOSE_INTERVAL = 5;
const BASE_CLOSE_TIME = 1_750_000_000;

/** Deterministic bytes, so re-seeding is idempotent under the §2 event id. */
function seededBytes(label: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let filled = 0;
  let counter = 0;
  while (filled < length) {
    const chunk = createHash("sha256").update(`sombra/${label}/${counter++}`).digest();
    chunk.copy(out, filled, 0, Math.min(chunk.length, length - filled));
    filled += chunk.length;
  }
  return out;
}

function seededAccount(label: string): string {
  return Keypair.fromRawEd25519Seed(seededBytes(`account/${label}`, 32)).publicKey();
}

function seededContract(label: string): string {
  return StrKey.encodeContract(seededBytes(`contract/${label}`, 32));
}

function seededTxHash(label: string): string {
  return seededBytes(`tx/${label}`, 32).toString("hex");
}

// ------------------------------------------------------------- ScVal helpers

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();
const bytes = (label: string, n: number): xdr.ScVal =>
  xdr.ScVal.scvBytes(seededBytes(label, n));
const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);

/** `i128` as the SEP-41-typed amount fields carry it. */
function i128(value: bigint): xdr.ScVal {
  const hi = BigInt.asIntN(64, value >> 64n);
  const lo = BigInt.asUintN(64, value);
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({ hi: xdr.Int64.fromString(hi.toString()), lo: xdr.Uint64.fromString(lo.toString()) }),
  );
}

/**
 * Event data payload. soroban-sdk publishes the non-`#[topic]` fields as a map
 * keyed by field name; Soroban requires `ScMap` keys in ascending order, so
 * they are sorted here rather than left in declaration order.
 */
function dataMap(fields: [string, xdr.ScVal][]): xdr.ScVal {
  const entries = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v }));
  return xdr.ScVal.scvMap(entries);
}

// ------------------------------------------------------------- event builder

interface MockEventSpec {
  ledgerOffset: number;
  name: string;
  topics: xdr.ScVal[];
  data: xdr.ScVal;
  /** Emitted by a sub-call that was rolled back; stored but not final state. */
  reverted?: boolean;
}

function buildEvent(contractId: string, spec: MockEventSpec, index: number): ArchivedEvent {
  const topics = [sym(spec.name), ...spec.topics];
  const ledgerSeq = START_LEDGER + spec.ledgerOffset;
  const label = `${contractId}/${spec.name}/${spec.ledgerOffset}/${index}`;
  // A single transaction per ledger in the mock; the ordering machinery is
  // still exercised, since positions are compared as a whole tuple.
  const coords = { ledgerSeq, txApplicationOrder: 1, opIndex: 0, eventIndex: 0 };
  return {
    contractId,
    ...coords,
    ledgerCloseTime: BASE_CLOSE_TIME + spec.ledgerOffset * LEDGER_CLOSE_INTERVAL,
    txHash: seededTxHash(label),
    topicsXdr: topicsToXdr(topics),
    dataXdr: spec.data.toXDR("base64"),
    eventType: eventTypeOf(topics),
    inSuccessfulContractCall: spec.reverted !== true,
    rpcEventId: formatSourceEventId(coords),
    topics: attributeTopics(topics),
  };
}

// ----------------------------------------------------------------- timelines

/** Field bundles the checkpoint-bearing events carry (DESIGN_cont §11.2). */
function checkpointFields(label: string): [string, xdr.ScVal][] {
  return [
    ["r_e_point", bytes(`${label}/r_e`, 64)],
    ["sigma", bytes(`${label}/sigma`, 32)],
    ["b_tilde", bytes(`${label}/b_tilde`, 32)],
    ["v_tilde_aud_s", bytes(`${label}/v_aud_s`, 32)],
    ["b_tilde_aud_s", bytes(`${label}/b_aud_s`, 32)],
  ];
}

function confidentialTokenHistory(alice: string, bob: string, spender: string): MockEventSpec[] {
  return [
    { ledgerOffset: 0, name: "register", topics: [addr(alice)], data: dataMap([["auditor_id", u32(1)]]) },
    { ledgerOffset: 1, name: "register", topics: [addr(bob)], data: dataMap([["auditor_id", u32(1)]]) },
    { ledgerOffset: 2, name: "register", topics: [addr(spender)], data: dataMap([["auditor_id", u32(1)]]) },

    // Receiving side accumulates.
    { ledgerOffset: 10, name: "deposit", topics: [addr(alice), addr(alice)], data: dataMap([["amount", i128(1_000_0000000n)]]) },
    { ledgerOffset: 25, name: "deposit", topics: [addr(bob), addr(alice)], data: dataMap([["amount", i128(250_0000000n)]]) },

    // Folds the receiving opening into the spendable one.
    { ledgerOffset: 40, name: "merge", topics: [addr(alice)], data: dataMap([]) },

    // Sender-side checkpoint for alice; receiving-side replay for bob.
    {
      ledgerOffset: 55,
      name: "transfer",
      topics: [addr(alice), addr(bob)],
      data: dataMap([
        ["r_e_point", bytes("t55/r_e", 64)],
        ["v_tilde", bytes("t55/v_tilde", 32)],
        ["sigma", bytes("t55/sigma", 32)],
        ["b_tilde", bytes("t55/b_tilde", 32)],
        ["v_tilde_aud_r", bytes("t55/v_aud_r", 32)],
        ["r_tilde_aud_r", bytes("t55/r_aud_r", 32)],
        ["v_tilde_aud_s", bytes("t55/v_aud_s", 32)],
        ["b_tilde_aud_s", bytes("t55/b_aud_s", 32)],
      ]),
    },

    { ledgerOffset: 70, name: "deposit", topics: [addr(alice), addr(alice)], data: dataMap([["amount", i128(500_0000000n)]]) },

    // Incoming transfer: alice's receiving-side replay, bob's checkpoint.
    {
      ledgerOffset: 90,
      name: "transfer",
      topics: [addr(bob), addr(alice)],
      data: dataMap([
        ["r_e_point", bytes("t90/r_e", 64)],
        ["v_tilde", bytes("t90/v_tilde", 32)],
        ["sigma", bytes("t90/sigma", 32)],
        ["b_tilde", bytes("t90/b_tilde", 32)],
        ["v_tilde_aud_r", bytes("t90/v_aud_r", 32)],
        ["r_tilde_aud_r", bytes("t90/r_aud_r", 32)],
        ["v_tilde_aud_s", bytes("t90/v_aud_s", 32)],
        ["b_tilde_aud_s", bytes("t90/b_aud_s", 32)],
      ]),
    },

    // Owner checkpoint. The spender recovers allowance state from the on-chain
    // delegation entry, not from this event (§3.2).
    {
      ledgerOffset: 120,
      name: "set_spender",
      topics: [addr(alice), addr(spender)],
      data: dataMap([["live_until_ledger", u32(START_LEDGER + 5000)], ...checkpointFields("set120")]),
    },

    // Attributed to owner, recipient AND spender (§3.3).
    {
      ledgerOffset: 140,
      name: "spender_transfer",
      topics: [addr(spender), addr(alice), addr(bob)],
      data: dataMap([
        ["r_e_point", bytes("st140/r_e", 64)],
        ["v_tilde", bytes("st140/v_tilde", 32)],
        ["sigma_a", bytes("st140/sigma_a", 32)],
        ["v_tilde_aud_r", bytes("st140/v_aud_r", 32)],
        ["r_tilde_aud_r", bytes("st140/r_aud_r", 32)],
        ["v_tilde_aud_s", bytes("st140/v_aud_s", 32)],
        ["a_tilde_aud_s", bytes("st140/a_aud_s", 32)],
      ]),
    },

    // T_0 for the replay window: alice's last Merge at or before her latest
    // checkpoint (§2).
    { ledgerOffset: 160, name: "merge", topics: [addr(alice)], data: dataMap([]) },

    {
      ledgerOffset: 185,
      name: "withdraw",
      topics: [addr(alice), addr(bob)],
      data: dataMap([
        ["amount", i128(300_0000000n)],
        ["r_e_point", bytes("w185/r_e", 64)],
        ["sigma", bytes("w185/sigma", 32)],
        ["b_tilde", bytes("w185/b_tilde", 32)],
        ["b_tilde_aud_s", bytes("w185/b_aud_s", 32)],
      ]),
    },

    { ledgerOffset: 200, name: "deposit", topics: [addr(alice), addr(alice)], data: dataMap([["amount", i128(75_0000000n)]]) },

    // Self-transfer: sender-side checkpoint and recipient-side replay at once
    // (§3.2), so alice is attributed twice under different roles.
    {
      ledgerOffset: 220,
      name: "transfer",
      topics: [addr(alice), addr(alice)],
      data: dataMap([
        ["r_e_point", bytes("t220/r_e", 64)],
        ["v_tilde", bytes("t220/v_tilde", 32)],
        ["sigma", bytes("t220/sigma", 32)],
        ["b_tilde", bytes("t220/b_tilde", 32)],
        ["v_tilde_aud_r", bytes("t220/v_aud_r", 32)],
        ["r_tilde_aud_r", bytes("t220/r_aud_r", 32)],
        ["v_tilde_aud_s", bytes("t220/v_aud_s", 32)],
        ["b_tilde_aud_s", bytes("t220/b_aud_s", 32)],
      ]),
    },

    // Alice's LATEST checkpoint — and it lands after her last Merge (offset
    // 160), the §2 case that makes "anchor at the last merge overall" wrong.
    {
      ledgerOffset: 240,
      name: "revoke_spender",
      topics: [addr(alice), addr(spender)],
      data: dataMap(checkpointFields("rev240")),
    },
  ];
}

/**
 * An SPP pool's stream. Its topics are field elements, not addresses, so no
 * event attributes to an account — the case §3.3 covers by letting an indexer
 * serve the per-contract stream and leave selection to the client.
 */
function poolHistory(): MockEventSpec[] {
  const specs: MockEventSpec[] = [];
  for (let i = 0; i < 6; i++) {
    specs.push({
      ledgerOffset: 30 + i * 35,
      name: "new_commitment",
      topics: [bytes(`pool/commitment/${i}`, 32)],
      data: dataMap([["index", u32(i)]]),
    });
    if (i % 2 === 1) {
      specs.push({
        ledgerOffset: 32 + i * 35,
        name: "new_nullifier",
        topics: [bytes(`pool/nullifier/${i}`, 32)],
        data: dataMap([]),
      });
    }
  }
  return specs;
}

// ---------------------------------------------------------------------- main

function main(): void {
  const withGap = process.argv.includes("--gap");
  const cfg = loadConfig();
  const db = new ArchiveDb(cfg.dbPath);

  const alice = seededAccount("alice");
  const bob = seededAccount("bob");
  const spender = seededAccount("spender");

  // If CONTRACT_IDS names contracts, seed the first one so the mock history and
  // the configured deployment agree; otherwise mint a deterministic id.
  const tokenContract = cfg.contractIds[0] ?? seededContract("confidential-token");
  const poolContract = cfg.contractIds[1] ?? seededContract("spp-pool");

  const plans: [string, MockEventSpec[]][] = [
    [tokenContract, confidentialTokenHistory(alice, bob, spender)],
    [poolContract, poolHistory()],
  ];

  for (const [contractId, specs] of plans) {
    const events = specs.map((s, i) => buildEvent(contractId, s, i));
    const inserted = db.insertEvents(events);

    const offsets = specs.map((s) => s.ledgerOffset);
    const lo = START_LEDGER + Math.min(...offsets);
    const hi = START_LEDGER + Math.max(...offsets) + 10;

    if (withGap) {
      /*
       * Record coverage in two pieces, leaving [gapFrom, gapTo] unproven. The
       * events inside it stay in the DB — the point is that coverage, not row
       * count, is what C3 answers from, so a query spanning the hole reports
       * `complete: false` even though rows come back.
       */
      const gapFrom = START_LEDGER + 100;
      const gapTo = START_LEDGER + 150;
      db.recordIngestedRange(contractId, lo, gapFrom - 1);
      db.recordIngestedRange(contractId, gapTo + 1, hi);
      process.stdout.write(
        `[seed] ${contractId}: ${inserted} new events, coverage ${lo}-${gapFrom - 1} and ${gapTo + 1}-${hi} (gap ${gapFrom}-${gapTo})\n`,
      );
    } else {
      db.recordIngestedRange(contractId, lo, hi);
      process.stdout.write(`[seed] ${contractId}: ${inserted} new events, coverage ${lo}-${hi}\n`);
    }

    // The fixture history starts at the contract's first event by
    // construction, so the fixture archive genuinely holds it all.
    db.setRetentionIntent(contractId, lo, true);
    db.setIngestState(contractId, null, hi + 1);
  }

  // Indelible provenance stamp: this DB holds authored data, not chain data.
  db.setSource("seeded-fixture");

  // A plausible chain head so /v1/health can report a lag without a live RPC.
  const head = START_LEDGER + 400;
  db.setMeta("latest_ledger", String(head));
  db.setMeta("latest_ledger_close_time", String(BASE_CLOSE_TIME + 400 * LEDGER_CLOSE_INTERVAL));

  process.stdout.write(
    `\n[seed] done -> ${cfg.dbPath}\n` +
      `  token contract : ${tokenContract}\n` +
      `  pool contract  : ${poolContract}\n` +
      `  alice          : ${alice}\n` +
      `  bob            : ${bob}\n` +
      `  spender        : ${spender}\n` +
      `  ledgers        : ${START_LEDGER}..${head}\n`,
  );
  db.close();
}

main();
