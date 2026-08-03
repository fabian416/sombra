# Sombra Archive

A durable event indexer for Stellar confidential-token and SPP pool contracts,
implementing OpenZeppelin's [`INDEXER.md`](../../stellar-contracts/packages/tokens/src/confidential/docs/INDEXER.md)
(RFC-2119 normative).

**Why it exists.** Confidential balances are Pedersen commitments; spending one
requires reconstructing its opening `(v, r)` by replaying the account's event
history. Stellar RPC keeps events for **7 days**. Past that window a wallet that
lost local state can see its funds on-chain and never spend them again. The
spec's own words: without a conforming archive, *"recovery from seed is not
guaranteed"*. This is that archive.

The archive is trusted for **availability only** (§7). It holds nothing secret —
commitments and masked ciphertexts are public chain data — and it cannot lie
undetected: recovery ends with the wallet checking reconstructed openings
against the on-chain commitment, so a tampered history fails closed.

---

## Quick start

```bash
cd sombra/archive
npm install
cp .env.example .env      # ships pointing at the live testnet contract
npm start                 # http://localhost:8787
npm test                  # conformance suite, no network
```

Out of the box this ingests Sombra's demo Confidential Token on testnet,
`CC2Z2B4X…4ZAC`, from its **deploy ledger** 3949779 — so the archive holds that
contract's complete history by construction, and `/v1/health` reports
`holds_full_history: true`. Deployment details, including the transaction behind
every event, are in [`../scripts/deployment.json`](../scripts/deployment.json).

```bash
curl -s localhost:8787/v1/health
```
```json
{
  "status": "ok",
  "source": "ingested",
  "latest_ledger": 3954105,
  "ingested_through": 3954105,
  "lag_seconds": 0,
  "lag_ledgers": 0,
  "contracts": [{
    "contract_id": "CC2Z2B4X4IIFPEHTAAXSZMXVOFUFLDFQ2HVOOQUY3UTFNNKKZPEK4ZAC",
    "ingested_through": 3954105, "contiguous_from": 3949779,
    "retains_from": 3949779, "holds_full_history": true,
    "gaps": [], "events": 41
  }]
}
```

| Script | What it does |
|:--|:--|
| `npm start` | Ingest and serve |
| `npm run dev` | Same under `tsx watch` |
| `npm test` | Conformance suite (Vitest, in-memory DB, no network) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm run seed:mock` | Write an **authored** fixture history — see [Fixtures](#fixtures) |

## Configuration

All via `.env` (see [`.env.example`](./.env.example) for the annotated list).

| Variable | Default | Notes |
|:--|:--|:--|
| `RPC_URL` | `https://soroban-testnet.stellar.org` | Any source yielding the complete final event stream (§4) |
| `CONTRACT_IDS` | the demo CT contract | Comma-separated contract ids |
| `START_LEDGER` | `3949779` | The contract's **deploy ledger**. `auto` starts at the RPC retention floor instead — convenient in dev, but such an archive has never held anything older than the window it exists to outlive, so it warns at startup and reports `holds_full_history: false` |
| `POLL_WINDOW_LEDGERS` | `1000` | Ledgers per request. Every scan is bounded by an explicit `endLedger` |
| `POLL_INTERVAL_MS` | `5000` | Delay between polls once caught up |
| `PAGE_LIMIT` | `200` | Events per `getEvents` page |
| `DB_PATH` | `./data/archive.db` | SQLite file |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | The wallet's `VITE_ARCHIVE_URL` must match |
| `CORS_ORIGIN` | `*` | The wallet is a browser app |
| `API_ONLY` | `0` | `1` serves without ingesting |
| `ALLOW_FIXTURE_DB` | `0` | Required to serve a fixture-seeded database at all |

## API

Every endpoint is CORS-enabled and every response carries `complete` (§6 C3).

### `GET /v1/health` — C4

`ingested_through` is the **minimum** across configured contracts — the archive
is only as fresh as its least-advanced one. `lag_ledgers` is exact;
`lag_seconds` is it scaled by Stellar's ~5s close interval. `retains_from` and
`holds_full_history` report the §5 retention intent; `source` is `ingested` or
`seeded-fixture`.

### `GET /v1/tokens/{contract}/accounts/{account}/events` — C2 + C3

Ordered, paginated, attributed from topics (§3.3).

```bash
T=CC2Z2B4X4IIFPEHTAAXSZMXVOFUFLDFQ2HVOOQUY3UTFNNKKZPEK4ZAC
P=GCKBD5H2T6TJ7H3SYBSFWE4WTPETTTPOUVV7VZTDZ2YN2ZN6WAK5JECM

curl -s "localhost:8787/v1/tokens/$T/accounts/$P/events?limit=50"
curl -s "localhost:8787/v1/tokens/$T/accounts/$P/events?types=Deposit,Merge"
curl -s "localhost:8787/v1/tokens/$T/accounts/$P/events?from_ledger=3950473&to_ledger=3950492"
```

Params: `from_ledger`, `to_ledger`, `types` (csv), `cursor`, `limit` (max 1000),
`include_reverted`. `types` accepts either spelling — `set_spender` or
`SetSpender` — and is applied *after* attribution, per §6.

`from_ledger` defaults to the archive's declared `retains_from`, not to the
bottom of whatever it happens to hold. That matters: an archive that
cold-started above a contract's first event would otherwise answer
`complete: true` over a window beginning after the account's `Register`, and the
wallet's §7 commitment check would fail with no way to tell incompleteness from
tampering.

### `GET /v1/tokens/{contract}/accounts/{account}/checkpoint` — C1

The latest checkpoint at or before `at_ledger` (defaults to `ingested_through`).

Checkpoint types are `Withdraw`, `Transfer` (**sender side**), `SetSpender`,
`RevokeSpender` (§3.2). The sender-side restriction is enforced, not incidental:
a `Transfer` is returned only to its sender, because the `(b_tilde, sigma)` it
publishes is the *sender's* spendable balance. A spender likewise gets no
checkpoint from `SetSpender` — they recover allowance state from the on-chain
delegation entry.

`complete` here answers the sharper question "is this really the latest?" — it
is `false` if a gap sits anywhere between the returned event and `at_ledger`,
since such a gap could hide a newer checkpoint.

### `GET /v1/tokens/{contract}/accounts/{account}/replay-window` — extension

**Beyond the §6 recommended surface**, and not required for conformance: C1 + C2
already make this derivable. It exists because one step of that derivation is
easy to get wrong in a way nothing detects until funds look unspendable.

Returns the §2 replay window — the latest checkpoint and `T_0`, *the last
`Merge` **at or before that checkpoint***, falling back to `Register`.

```bash
curl -s "localhost:8787/v1/tokens/$T/accounts/$P/replay-window"
#  checkpoint = withdraw@3950489
#  T_0        = merge@3950485      <- NOT the merge at 3950492
#  window     = 3950485 -> 3954116   complete=true
```

The demo contract's history was built to make this loud: the primary account
merges at 3950485, checkpoints (withdraw) at 3950489, then merges **again** at
3950492. Anchoring at the last merge overall reconstructs spendable `1850`
instead of `2450`, and the re-commitment against the on-chain point fails.

### `GET /v1/tokens/{contract}/events` — C2, per-contract stream

The §3.3 alternative: serve the whole stream, let the client attribute. The only
useful shape for SPP pool contracts, whose topics are field elements
(commitments, nullifiers) and attribute to no account at all.

### `GET /v1/tokens/{contract}/status`

Not in §6. Coverage ranges, gaps, and retention intent — what a hybrid client
needs to pick its seam (§2).

### Event record

```json
{
  "id": "3950489-113a0544…-0",
  "source_event_id": "0016968588769337344-0000000000",
  "contract_id": "CC2Z…", "ledger_seq": 3950489, "ledger_close_time": 1785771234,
  "tx_hash": "113a0544…", "tx_application_order": 1, "op_index": 0, "event_index": 0,
  "topics_xdr": ["AAAADwAAAAh3aXRoZHJhdw==", "…"],
  "data_xdr": "AAAAEQAAAAEAAAAF…",
  "event_type": "withdraw",
  "accounts": [{ "role": "from", "address": "GCKB…", "checkpoint_owner": true },
               { "role": "to",   "address": "GCEZ…", "checkpoint_owner": false }]
}
```

`topics_xdr` / `data_xdr` are verbatim base64 XDR (§3.1) — decode them with
`@stellar/stellar-sdk` exactly as you would an RPC event. `event_type` and
`accounts` are the decoded query columns §3.1 permits, never a replacement for
the XDR.

---

## Conformance suite

`npm test` — 26 cases, each **titled with the clause it demonstrates**, run
against an in-memory database and a fake source. No network.

```
§3.1 persists every required record field, with topics and data as verbatim XDR
§3.3 attributes a Transfer to BOTH sender and recipient
§3.3 attributes a SpenderTransfer to owner, recipient AND spender
§3.3 never attributes an event to the transaction source account
§3.4 returns events in (ledger_seq, tx_application_order, event_index) order
§4   idempotency: re-ingesting an overlapping window inserts nothing new
§4   gap tracking: a hole between ingested ranges is reported and never merged away
§4   coverage is bounded by the request, never by the node's reported head
§4   fidelity: an event whose topics cannot be decoded is still archived in full
§4   source: rolled-back sub-call events are stored but excluded from reads
§5   an archive started at the retention floor reports holds_full_history=false
§5   an archive started at the deploy ledger reports holds_full_history=true
§5   nothing prunes: retention intent is recorded once and never revised
§6   C2 returns the account's history in order, paginated without loss or repeat
§6   C3 a range spanning a gap returns complete:false
§6   C3 a range extending past ingested_through returns complete:false
§6   C4 exposes the latest fully-ingested ledger and its contiguous floor
§6   C1 a Transfer is the SENDER's checkpoint and not the recipient's
§6   C1 a spender gets no checkpoint from SetSpender/RevokeSpender
§6   C1 a self-transfer is its own checkpoint
§6   the types filter narrows the response without changing attribution
§2   T_0 is the last Merge at or BEFORE the checkpoint, not the last Merge overall
§2   T_0 falls back to Register when the account never merged before its checkpoint
     + 3 storage-integrity cases
```

## Spec conformance

### Normative requirements met

| § | Requirement | How |
|:--|:--|:--|
| 3.1 | Persist all seven record fields | Present; topics/data as verbatim base64 XDR (the RECOMMENDED form) |
| 3.2 | All confidential-token events in scope | Every contract event ingested unfiltered, config events included. Checkpoint types per the table, sender-side only for `Transfer` |
| 3.3 | Attribution from **topics**, never tx source | `event_topics` built solely from decoded topics. Self-transfers attribute twice, under both roles |
| 3.4 | Preserve/expose the total order | Stored per-event, the sort key of every query, and the pagination cursor |
| 4 | At-least-once, deduplicated | `INSERT OR IGNORE` on the position key |
| 4 | Complete, **final** event stream | Rolled-back sub-call events (`inSuccessfulContractCall: false`) are stored for audit but excluded from C1/C2 — replaying one would credit value the chain never did |
| 4 | Track contiguous ranges; detect gaps | `ingested_ranges`, merged on write. Coverage is claimed only for ledgers the *request* bounded |
| 4 | Backfill gaps while retrievable | Gaps inside the retention window are re-scanned at startup; gaps below the floor are reported permanent, never silently filled |
| 5 | Retain indefinitely | Nothing deletes. `retains_from` / `holds_full_history` state what the archive actually undertakes to hold |
| 6 C1 | Latest checkpoint | `/checkpoint`, owner-role enforced |
| 6 C2 | Ordered, paginated per-account history | `/events`, keyset pagination on the total order |
| 6 C3 | Every response states completeness | `complete` on every endpoint, `true` only when one contiguous range covers the whole *requested* window |
| 6 C4 | Latest fully-ingested ledger | `/v1/health` + `/status`, with gaps listed |

### Verified against live testnet

Three findings came out of running this against real chain data rather than
fixtures, and each changed the implementation:

**1. The §2 event id is not unique.** §2 states the triple
`(ledger_seq, tx_hash, event_index)` is "unique per emitted event […] because a
Soroban transaction carries a single operation". It is not: a transaction's
fee-phase and application-phase events share both `tx_hash` and `event_index`,
differing only in `tx_application_order`. Over a 6,117-event sample, **86 events
(1.4%) collided**, and keying storage on that triple silently discarded them —
a hole in the exact guarantee the archive exists to provide.

The storage key is therefore
`(ledger_seq, tx_application_order, op_index, event_index)` — the §3.4 total
order plus `op_index`, which is precisely the RPC's own event id decomposed, and
which was unique across every sample. Records still carry `tx_hash` and still
serve `id` in the §2 shape; they additionally serve `source_event_id` (the RPC
id), which is the field to deduplicate on across the §1 seam.

**2. Decoding must never be able to lose an event.** Testnet runs protocol 27,
and `@stellar/stellar-sdk` v13 threw `unknown ScAddressType member for value 3`
on a newer `ScAddress` variant, aborting whole pages. The SDK is now v16, but
the structural fix matters more: topic decoding is best-effort and non-fatal, so
an event this build cannot parse is still archived in full. §3.1 makes the XDR
the payload and the decoded columns optional — storage outlives the decoder.

**3. `getEvents` bounds.** `endLedger` is exclusive; `startLedger` must fall
inside `[oldestLedger, latestLedger]` or the node errors rather than returning
empty. Cursor mode admits no `endLedger`, so bounded scans re-impose their upper
bound client-side.

### Hackathon simplifications

| Simplification | Impact |
|:--|:--|
| **SQLite** (`better-sqlite3`), single file, single process | Fine for a demo and for §5 (nothing is deleted). Every query is ordinary SQL over three tables and the schema ports to Postgres as-is; a real deployment wants Postgres for concurrent writers and streaming replication. Swap `db.ts` — nothing above it knows the engine |
| **One source** (Stellar RPC) | §4 permits Horizon or captive core too. `source.ts` is the only RPC-aware module. Captive core would remove the retention-floor race entirely |
| **Backfill runs at startup**, not continuously | A gap opened *while running* is detected and recorded immediately, but only re-scanned on the next boot |
| **`lag_seconds` is derived**, not measured | Ledger delta × 5s. `lag_ledgers` beside it is exact |
| **No auth / rate limiting / metrics** | Read-only public chain data (§7), but a public deployment wants rate limiting |
| **Single archive endpoint** | §7 recommends wallets support *multiple* independent archives, since withholding is the residual risk. Client-side concern, but a real deployment should run at least two |

## Fixtures

`npm run seed:mock` (in `test/fixtures/`) writes an **authored** event history.
It is the substrate for the conformance tests and a way to exercise the API
without a chain — it is *not* a data source.

Every database it writes is stamped `source = "seeded-fixture"`, `/v1/health`
reports that, and the server **refuses to start** on such a database unless
`ALLOW_FIXTURE_DB=1`. An archive whose conformance properties were demonstrated
against data this repo authored would have demonstrated nothing; the real
deployment ingests the testnet contract.

`npm run seed:mock -- --gap` seeds the same history but records coverage with a
hole, leaving the events in place. Queries spanning the hole still return rows —
and report `complete: false`, because completeness is answered from coverage,
not row count. That is the §4 requirement that an indexer "MUST NOT silently
serve affected histories as complete".

---

## Notes for a production deployment

1. Set `START_LEDGER` to each contract's **deploy ledger**. `auto` starts at the
   retention floor, which conforms going forward but never held the earlier
   history — §5 wants all of it, and `/v1/health` will say
   `holds_full_history: false` until you do.
2. Watch `/v1/health` for `gaps` and for `ingested_through` falling toward
   `oldest_source_ledger`. Once the retention floor passes the archive's
   position, the missing ledgers are gone from that source permanently.
3. Back up `DB_PATH`. §5 says retain indefinitely; SQLite makes that one file.
