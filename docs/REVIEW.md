# Sombra — Adversarial Technical Review

**Reviewed:** 2026-08-03 · **Deadline:** 2026-08-06 · **Scope:** `README.md`, `archive/src/*`, `wallet/src/*`, `docs/INTEGRATION.md`
**Posture:** reviewed as the bounty judges would — OpenZeppelin and Nethermind engineers who wrote `INDEXER.md`, `DESIGN.md`, and `SDK.md`. Every claim below is checked against the normative text, not against the README.

## Verdict up front

The Archive is the real thing. Read against `INDEXER.md` clause by clause, `archive/src/` satisfies every §3–§5 MUST and all four §6 capabilities, and it does so with an understanding of the spec that goes past the checklist — `latestCheckpoint`'s `is_checkpoint_owner` join (`db.ts:439-459`), the self-transfer dual-role handling (`events.ts:198-217`), and the "prove only what the source promises it scanned" coverage discipline (`ingest.ts:180-198`) are all things a careless implementation gets wrong. `docs/INTEGRATION.md` is the single strongest artifact in the repo and would survive scrutiny on its own.

The wallet is not the real thing. It is a mock with a `sleep()`-driven recovery animation that never opens a socket to the Archive, never touches a key, and never reads the chain. `kit/` — one of the three components the README sells — does not exist.

So the submission's problem is not competence. It is that the demo currently proves nothing the Archive can back up, and the gap between README voice and shipped state is exactly the gap a judge probes first. Three days is enough to close it, but only by cutting hard (§ *3-day plan*).

---

# BLOCKER

## B1 — The recovery demo is an animation, not a recovery

**What.** `MockSombraClient.recoverFromSeed` (`wallet/src/lib/mockClient.ts:324-420`) is a scripted timeline: `sleep(900)`, `sleep(1_100)`, a `requestAnimationFrame` ease-out over a hardcoded `REPLAY_MS = 4_200`, then `setLocal()` with values it already held. There is no `fetch` to the Archive anywhere in `wallet/src`. No ECDH, no Poseidon2, no Pedersen re-commitment, no chain read. `SombraProvider.tsx:52` hardcodes `new MockSombraClient()`; the `CLIENT_MODE` flag declared two lines above at `:24` is read and never used. The wallet's `package.json` has no `@stellar/stellar-sdk`, no `@ctd/sdk`, no bb.js — the live path is not stubbed, it is absent.

Two details make it worse than a generic mock, because they are printed on screen during the demo:

- `mockClient.ts:359` renders `GET {archiveUrl}/v1/accounts/{addr}/checkpoint`. The Archive's actual C1 route is `/v1/tokens/:contract_id/accounts/:account/checkpoint` (`api.ts:243`). The fake URL does not match the real service in the same repo.
- `mockClient.ts:343` renders `sk = SHA-512(seed) mod r`. That is the *demo app's* derivation (`CT-DEMO/packages/app/lib/derive-key.ts`), not the normative one — and `INTEGRATION.md:63-70` already flags that the two produce different keys. A judge who wrote `SDK.md` §5.1 reads that line and knows immediately that nothing behind it is real.

**Why a judge cares.** The bounty sub-lane is *Confidential-Token & Private-Payment Wallets*. The single differentiating claim is "recovery that no other wallet can do." A recovery that is a CSS transition is the definition of a shallow demo, and the two strings above are the tell that converts "work in progress" into "misrepresented."

**Fix.** Recovery must run against real on-chain events for a real registered account. See § *The one strategic call* — the good news is that a genuine recovery needs **no proof generation at all**, so this is far more achievable than it looks.

## B2 — `kit/` does not exist, and the dependency path the README asserts is not available

**What.** `README.md:19` lists `sombra-kit` as a shipped component with a six-function API. There is no `kit/` directory. Separately, `README.md:28` states "We consume the official SDKs as dependencies (MIT / Apache-2.0) — the intended integration path." For the CT SDK that is not currently possible: `@ctd/sdk` is `"private": true` and unpublished (`INTEGRATION.md:559-561` documents this). It cannot be `npm install`ed.

**Why a judge cares.** Two of the three rows in the README's own architecture table are unbacked — one component missing, one integration story that does not work as described. And the resolution has a rules dimension: if `kit/` ends up populated by copying files out of `CT-DEMO/packages/sdk`, that breaks the 100%-original-work rule outright.

**Fix.** Pick one and write it down in the README:
1. **Path/git dependency** on the demo SDK (`"@ctd/sdk": "file:../stellar-confidential-token-demo/packages/sdk"` or a git ref). Consumption, not copying — rules-clean, and it is what "consume as a dependency" should mean here. Requires the reviewer to have the sibling clone, so document it and pin a commit.
2. **Reimplement only what recovery needs** in `kit/` — Poseidon2, Grumpkin, ECDH, the §5.1 derivation, the two decrypt rules. That is a few hundred lines, not 3,770, it is unambiguously original, and it lets you claim conformance against `circuits/lib/testdata/*.json` (see H7).

Option 2 is stronger for this bounty. Either way, delete or scope down the README's six-function API claim to what exists.

## B3 — Zero tests, in a submission whose thesis is spec conformance

**What.** No `*.test.ts` anywhere in the repo. `archive/package.json` has no test script.

**Why a judge cares.** This is the highest-leverage gap in the entire submission. The judges wrote `INDEXER.md`; §8 defines conformance precisely ("satisfies §3–§5 and exposes C2, C3, C4"). Right now the claim of conformance lives in code comments. A test file whose cases are *named after the clauses* converts an assertion into a demonstration, and it is the cheapest credibility per hour available anywhere in this repo — the Archive already passes; nothing needs fixing to write them.

**Fix.** `archive/test/conformance.test.ts` against an in-memory DB and a fake `RpcSource`, one case per MUST, each titled with its clause:

- `§3.1 persists all seven record fields verbatim`
- `§3.3 attributes a Transfer to both sender and recipient` / `… a SpenderTransfer to all three` / `… never to the tx source account` (feed a source-account address that appears in no topic; assert it is not attributed)
- `§3.4 returns events in (ledger_seq, tx_application_order, event_index) order` — seed out-of-order, with two events in one ledger and two txs in one ledger
- `§4 idempotency: re-ingesting an overlapping window inserts nothing new`
- `§4 gap tracking: a hole between ranges is reported and never merged away`
- `§6 C3: a range spanning a gap returns complete:false`
- `§6 C3: a range past ingested_through returns complete:false`
- `§6 C1: a Transfer is the sender's checkpoint and not the recipient's` — the sharpest one, assert the recipient gets `null`
- `§6 C1: a self-transfer is its own checkpoint`
- `§6 types filter applies after attribution` — assert a type-filtered query never widens or narrows *which accounts* an event is attributed to

Vitest, in-memory SQLite, no network. Half a day, and it is the artifact a spec author will actually open.

## B4 — `START_LEDGER=auto` makes the Archive a 7-day cache that reports itself complete

**What.** Two behaviours combine badly.

`coldStartLedger` (`ingest.ts:210-214`) resolves `auto` to `oldestLedger + retentionMargin` — the RPC's *retention floor*. `.env.example` ships `START_LEDGER=auto` as the default. An archive started that way has never held anything older than 7 days, which is a direct §5 violation ("MUST retain the full per-account history … indefinitely"). The doc comment at `:201-209` is honest that `auto` "yields a conforming archive going forward but one that never held the pre-floor history" — but the API does not say so.

`resolveRange` (`api.ts:143-152`) defaults `from_ledger` to `coverage[0].fromLedger` — the bottom of what the archive happens to hold. So an unqualified C2 query against an `auto`-started archive returns `complete: true` over a window that begins *after* the account's `Register`. The wallet replays from there, misses everything before, and its §7 commitment check fails with no indication that incompleteness — rather than tampering — was the cause. `INDEXER.md` §7 draws exactly that distinction, and `SDK.md` §12.3 makes propagating it a client MUST.

**Why a judge cares.** This is the failure mode `INDEXER.md` §4 and C3 were written to prevent, reached through the default configuration. It also hollows out the product claim: "the archive that outlives the 7-day window" describing a service that holds seven days.

**Fix.** Three small changes:
1. Track, per contract, the ledger from which the archive intends to hold history (`START_LEDGER`, or the contract's deploy ledger). Persist it in `meta`. Expose it as `retains_from` on `/v1/health` and `/v1/tokens/:id/status`, alongside a boolean `holds_full_history`.
2. Make `resolveRange`'s default `from_ledger` be `retains_from`, not `coverage[0].fromLedger`. If the archive cold-started above the contract's first event, the honest default answer is `complete: false`.
3. Make `START_LEDGER=auto` log a startup warning naming the §5 violation, and set `holds_full_history: false`. Keep `auto` — it is the right dev-mode default — but stop it from being silently indistinguishable from a conforming deployment.

---

# HIGH

## H1 — `inSuccessfulContractCall` is captured and never used

**Where.** `source.ts:65` declares it on `RawSourceEvent`. It appears nowhere else in the codebase (`toArchivedEvent`, `ingest.ts:35-52`, does not read it).

**What.** Soroban emits contract events from sub-calls that were subsequently rolled back (a `try_invoke_contract` whose inner call panicked while the outer transaction succeeded). Those events carry `inSuccessfulContractCall: false` and did not affect final state. `INDEXER.md` §4 *Source* requires a source yielding "the complete, **final** event stream."

**Why a judge cares.** Archiving a rolled-back `Deposit` or `Transfer` means the wallet's §5.2 step-6 replay accumulates value into `W_receive` that the chain never credited. The reconstructed opening then fails the §7 commitment check — funds appear unrecoverable, and the wallet cannot tell this apart from a tampered archive. It is also the kind of declared-but-unread field a reviewer greps for.

**Fix.** In `toArchivedEvent`, persist the flag as a column, and exclude `inSuccessfulContractCall === false` rows from C1/C2 responses. Persist rather than drop at ingest: `§4 Fidelity` favours storing faithfully and filtering on read, and keeping them makes the exclusion auditable. One line in the schema, one predicate in each read query, one test.

## H2 — Coverage through `page.latestLedger` extrapolates from an unverified RPC property

**Where.** `ingest.ts:189-198`.

**What.** On a short page the loop records `recordIngestedRange(contractId, windowStart, page.latestLedger)` — claiming every ledger up to the node's head was scanned. That holds only if `getEvents` with a `startLedger` and no `endLedger` always scans to the head whenever it returns fewer than `limit` events. That is *probably* true of stellar-rpc, but it is a property of the node, not of the JSON-RPC contract, and providers do impose their own scan bounds. If a provider ever returns a short page having scanned only part of the window, the Archive records coverage over ledgers it never looked at — and C3 then reports a genuinely incomplete history as complete.

The module docstring (`ingest.ts:1-18`) states the correct principle: *"Coverage is therefore never extrapolated from what arrived — it is derived from what the source promises it looked at."* This one call site is the exception to its own rule, because `latestLedger` is a report about the chain, not a promise about the scan.

**Why a judge cares.** Everything else in this file is disciplined about exactly this distinction, and §4/C3 exist to stop precisely this failure. A spec author reading `ingest.ts` will find this line.

**Fix.** Always send an explicit `endLedger` on the polling request (`windowStart + POLL_WINDOW`, capped at `latestLedger + 1`), and claim coverage through `min(endLedger - 1, latestLedger)` — a range the *request* bounded, so the claim rests on the request rather than on node behaviour. `scanRange` already does this correctly for backfill (`:256-257`); make the head path match it. Small diff, and it turns the file's stated principle into an invariant with no exceptions.

## H3 — The key-derivation story does not match the spec the judges wrote

**What.** `SDK.md` §5 is normative and specific: `sk = RS(HKDF-SHA-512(IKM = root, salt = "openzeppelin/confidential-token/v1/sk", info = be32(addr_f) ‖ be32(acct_f) ‖ le4(j)))`, where `root` is a **SEP-0053 ed25519 signature** over a 151-byte message binding contract and account (`SDK.md:212-218`), with rejection sampling on `j` and a re-roll if `vk == 0`.

Sombra's surface says something else. `client.ts:139` is `recoverFromSeed(seed: string, …)`; the UI copy is "Deriving keys from your phrase"; the on-screen derivation is the demo's `SHA-512(signature)`. `wallet/src/lib/freighter.ts` does not import `signMessage` at all — the root-derivation path is unimplemented, not merely mismatched. `INTEGRATION.md:63-70` already identified this fork and says "Sombra must pick one." It has not been picked.

Four §5.2 obligations are also unmet, each a MUST on the wallet:
- verify the returned signature against the ed25519 public key expected to have signed, and abort on mismatch (`:228`) — the demo app does this at `freighter.ts:50-52`; Sombra does not;
- obtain the signature twice from independent invocations and abort if they differ (`:230`);
- record the enrolled signer, and do not assume it is the master key (`:234`);
- disclose, at account creation, that confidentiality is bounded by the secrecy of the signing key (`:224`).

**Why a judge cares.** `SDK.md` §5 exists *because* two clients given the same backup material would otherwise derive different accounts — and `register` is single-use, so the divergence is unrepairable. This is the section its authors are most likely to check line by line, and "recover from your seed phrase" is not what it specifies.

**Fix.** Implement §5.1 + §5.2 in `kit/`: Freighter `signMessage` over the §5.2 message → 64-byte root → HKDF-SHA-512 → rejection sample → `sk` → `vk`/`PVK`/`Y`. Rename `recoverFromSeed` to `recoverFromSigner`. Verify `Y` against the on-chain `spending_public_key` (`INTEGRATION.md:368-374`) as the first recovery step — it is one scalar multiplication and it makes the whole flow fail-fast and legible. Add the double-signature determinism check; it is four lines and it is a MUST. If Freighter's `signMessage` proves unusable in the time available, fall back to §5.3's raw root and *say so in the UI* — §5.3 is conformant and §5.3's last paragraph requires recording which form produced `sk`.

## H4 — No hybrid seam, and no fail-closed on archive error

**What.** `SDK.md` §12.4 specifies two things it explicitly says are not derivable from `INDEXER.md`, both MUSTs:

- the seam MUST sit strictly above the RPC's reported retention floor by a margin, with the two legs on disjoint ledger ranges;
- **a configured archive's failure MUST fail the whole sync** — no silent degradation to RPC-only, and no persisting a sync position derived from the RPC leg alone.

Neither exists in `wallet/src`. `RecoveryResult.beyondRpcWindow` (`client.ts:100`) implies a seam that nothing computes.

**Why a judge cares.** §12.4's second rule is the one with teeth: the demo SDK implements it deliberately without a try/catch and documents why (`INTEGRATION.md:356-360`) — degrading to RPC-only turns one transient 500 into permanently unrecoverable openings. It is also the requirement that makes "RPC and archive compose" a real architecture rather than a diagram. Sombra's whole pitch is the archive half of that composition; not implementing the composition rule is conspicuous.

**Fix.** In `kit/`, one function: read `getHealth().oldestLedger`, set `seam = oldestLedger + 60`, require the Archive's `ingested_through >= seam` (this is what C4 is *for*), fetch `[retains_from, seam-1]` from the Archive and `[seam, head]` from RPC, dedupe by event id at the boundary as a guard, merge on the §3.4 order. If the Archive leg throws or reports `complete: false`, abort the sync and surface it — do not write a cursor. Roughly 60 lines, and it is the most spec-legible code you can ship.

## H5 — The completeness signal is not propagated to the caller

**What.** The Archive emits `complete` correctly on every response (`api.ts:233`, `:267`, `:298`). Nothing in the wallet consumes it: `RecoveryResult` (`client.ts:93-102`) carries `verifiedAgainstChain` but has no field for completeness.

**Why a judge cares.** `SDK.md` §12.3 makes this an explicit client MUST, with the reason spelled out: *"an incomplete range and a tampered range both end in the same refusal at §10.6, and only that signal distinguishes them."* Building a spec-conformant C3 on the server and then discarding it on the client is the exact anti-pattern that clause names.

**Fix.** Add `complete: boolean` and `archiveCoverage: {from, to}[]` to `RecoveryResult` and to `RecoveryProgress`. On `complete: false`, the UI must refuse to present the restored balance as verified and must say *why* — "the archive does not hold ledgers X–Y" reads very differently from "verification failed." That distinction, rendered on screen, is a demo moment in its own right, and it is free.

## H6 — `npm run seed:mock` is a credibility landmine

**What.** `archive/package.json` declares `"seed:mock": "tsx src/seed-mock.ts"`. That file does not exist yet. `.env.example` invites the mode: *"Leave empty to run API-only (useful with `npm run seed:mock`)."*

**Why a judge cares.** If the demo Archive is populated by a seeder rather than by ingesting real testnet events, then "durable event archive" describes a fixture file, and every conformance property the code implements is being demonstrated against data the repo authored. This is the fastest route to "the demo is fake." The risk is not that the file exists — it is that nothing distinguishes a seeded DB from an ingested one at the API.

**Fix.** Keep the seeder — it is the right substrate for the conformance tests in B3 — but make the mode impossible to mistake:
- put it under `archive/test/fixtures/`, not `src/`;
- stamp `meta.source = "seeded-fixture"` on any DB it writes, and surface `"source": "seeded-fixture"` on `/v1/health`;
- refuse to start the HTTP server on a seeded DB unless `ALLOW_FIXTURE_DB=1`.

The demo Archive must ingest the real testnet contract. Anything else, a judge is entitled to assume the worst about.

## H7 — Nothing pins the crypto against the conformance fixtures

**What.** `circuits/lib/testdata/*.json` holds 17 language-agnostic fixtures. `SDK.md:268-270` is unambiguous: an implementation MUST reproduce every output byte-for-byte, and its test suite MUST **read** the files rather than transcribe the values.

**Why a judge cares.** If `kit/` reimplements any primitive (B2 option 2), this is the only thing standing between a correct wallet and one that silently opens the wrong commitment. `INTEGRATION.md:413-416` already identifies it as "the cheapest possible guard against a Poseidon2/Grumpkin drift that would otherwise surface as silently unspendable funds" — take your own advice. It is also a MUST you can satisfy in an hour and point at.

**Fix.** If `kit/` reimplements primitives, wire the fixture directory into its tests by reading the JSON. If `kit/` takes a dependency on `@ctd/sdk` instead, wire the fixtures anyway as a pin on the dependency. Related: `INTEGRATION.md:58-61` flags `fpAdd` vs `frAdd` — blindings accumulate mod **p**, not mod r, and getting it wrong opens the wrong commitment roughly half the time. Every blinding accumulation in the replay must use the mod-p addition, and one fixture-backed test should cover it.

---

# MEDIUM

## M1 — `scanRange` stops after one page when invoked outside the loop

**Where.** `ingest.ts:253` — `while (this.running || cursor === null)`.

Called from `backfillGaps()` inside `loop()`, `running` is already true and behaviour is correct. Called directly — a one-shot backfill CLI, or a test — `running` is false: the first iteration passes on `cursor === null`, and if that page comes back full, the loop exits with the gap only partially filled and coverage recorded for the fragment. It under-claims rather than over-claims, so C3 stays honest, but the gap silently stops being backfilled.

**Fix.** Give `scanRange` its own bounded loop (`while (true)` with explicit `return`s, plus a cancellation check on `this.running` that *breaks* rather than gating entry). Worth doing because a standalone backfill command is a natural thing for a reviewer to run.

## M2 — Topic rows are not backfilled for events already present

**Where.** `db.ts:168` — `if (res.changes === 0) continue;` skips topic insertion whenever the event row already exists.

Correct today, since events and topics are written in one transaction. But it means any future change to `attributeTopics` (a new event type in `TOPIC_ROLES`, a fixed role name) cannot be applied to already-ingested data by re-ingesting — the attribution index silently stays stale while `INSERT OR IGNORE` reports success. Given §3.3 attribution is the thing per-account recovery depends on, that is a sharp edge.

**Fix.** Either re-run topic upserts unconditionally (they are `INSERT OR IGNORE` on a PK that includes `topic_index`, so it is idempotent and cheap), or add a schema-version column and a reindex path. The first is one line.

## M3 — Nothing computes `T_0`, the subtlety the spec flags hardest

**What.** `INDEXER.md` §2 goes out of its way to warn that anchoring the receiving side at the account's last `Merge` *overall* is wrong — it must be the last `Merge` **at or before the checkpoint**, or the spendable opening ends up short by the amount that later merge folded in. `INTEGRATION.md:278-281` calls this "the single easiest way to build a silently-wrong Archive."

The Archive stores everything needed and C1+C2 make `T_0` derivable, which is conformant — §6 C1 explicitly says `T_0` "is obtainable from C2's ordered history." But no code in this repo computes it, so the repo does not yet demonstrate that it understood the warning.

**Fix.** Two moves, both cheap. In `kit/`, implement `T_0` resolution correctly and comment it with the §2 citation. In the Archive, add a non-normative convenience route — `GET /v1/tokens/:id/accounts/:acct/replay-window` returning `{ checkpoint, t0, from_ledger, to_ledger, complete }`. It is a small handler over queries `db.ts` already has, it makes the client trivial, and it is the most direct way to show a judge you read §2 rather than §6. Label it clearly as an extension beyond the recommended surface.

## M4 — Wallet and Archive disagree on the port

`archive/.env.example` ships `PORT=8787`; `wallet/.env.example` ships `VITE_ARCHIVE_URL=http://localhost:3001`. Out of the box the wallet cannot reach the Archive. Trivial, but it is the first thing that happens if a judge clones and runs.

## M5 — No LICENSE file

`sombra/` has none. The bounty requires a GitHub repo as a deliverable, and the submission's central compliance claim is about licensing — consuming MIT (`stellar-confidential-token-demo`) and Apache-2.0 (`stellar-private-payments`) work. Ship a LICENSE (MIT or Apache-2.0) and add a short NOTICE naming both upstreams, their licenses, and the pinned commits. `archive/package.json` already declares `"license": "MIT"` with no file to back it.

## M6 — Single archive endpoint

`INDEXER.md` §7 closes on withholding as the residual trust risk, and recommends wallets support multiple independent archive endpoints with deployments running at least two. Sombra takes a single `archiveUrl` (`client.ts:141`). Not a MUST, but it is the mitigation the spec's own trust-model section ends on, so a judge will look for at least an acknowledgement. Accepting `string | string[]` and racing/falling back is ~15 lines; failing that, name it as a known limitation.

---

# LOW

- **L1** — `App.tsx:5-7`: `if (!identity) return <Connect />; return <Connect />;` — dead branch, and it advertises that only one route exists.
- **L2** — `README.md:24` claims the shielded swap would be "the first shielded DeFi flow on Stellar." Unverifiable superlative; if the flow is cut (it should be — see below), the line must go with it.
- **L3** — `api.ts:39` derives `lag_seconds` from a hardcoded 5-second close interval. `lag_ledgers` sits beside it and is exact; the code says so. Fine — but the spec's recommended shape names `lag_seconds`, so keep both and keep the comment.
- **L4** — `decodeCursor` (`api.ts:79-86`) does not bind a cursor to the query that produced it. Harmless under keyset pagination, but a cursor from a different account silently "works." Consider binding the account/contract into the cursor.
- **L5** — `parseEventId`'s TOID masks (`events.ts:23-24`, 20 bits tx / 12 bits op) are correct, and preferring the wire's `transactionIndex` with the id decode as fallback (`:65-73`) is the right call. No action — noting it because it is the sort of thing a judge will verify and it holds up.

---

# Bounty rules compliance

**Originality — holds for what exists.** I compared `archive/src/api.ts` against the demo's own indexer (`CT-DEMO/packages/indexer/handler/src/routes/events.ts`). Different framework (Fastify vs Hono), different store (SQLite vs Cloudflare D1), different route shapes, different response field names, different pagination. No shared structure, no lifted helpers. The event-decoding logic in `events.ts` is independently derived from the Rust `#[contractevent]` definitions — I verified `TOPIC_ROLES` (`events.ts:99-108`) field-by-field against `stellar-contracts/.../confidential/mod.rs:609-844` and all eight entries match declaration order exactly. `CHECKPOINT_OWNER_ROLE` correctly excludes `spender_transfer`, matching `INDEXER.md` §3.2 and `DESIGN.md` §5.2 step 1. This is original work by someone who read the source.

**The live risk is B2.** The moment `kit/` gets populated by copying from `CT-DEMO/packages/sdk` to work around `"private": true`, originality is gone. Decide now, in writing, in the README.

**Deliverables.** Git remote is set (`https://github.com/fabian416/sombra.git`), three commits, all scaffold. Before submitting, confirm: the repo is public, `main` is pushed, the README's architecture table matches shipped reality, and a LICENSE exists (M5). One submission per sub-lane — confirm nothing else has been entered under *Confidential-Token & Private-Payment Wallets*.

---

# Feasibility: what to cut, and the one strategic call

## The one strategic call: recovery needs no proving

This is the most important thing in this review. **Reconstructing an opening requires no zero-knowledge proof.** Per `DESIGN.md` §5.2 steps 1–7, recovery is: read a checkpoint event, two Poseidon2 hashes, an ECDH per incoming transfer, integer/field addition, and two Pedersen re-commitments compared against on-chain points. No circuit, no witness, no bb.js, no WASM.

Proving is needed only to *create* history — `register`, `withdraw`, `confidential_transfer`. And that can be done **in Node, offline, ahead of the demo**, where `loadCircuit` and `proverFromArtifact` work with no bundler involved.

So split the work along that line:

- **Node script, run once before the demo** — register a testnet account, deposit, receive a couple of transfers, merge, withdraw. Real proofs, real transactions, real events on real ledgers. Slow, and it does not matter.
- **Browser wallet** — connect, read balances, wipe, recover, verify. No proving in the browser at all.

This removes the riskiest integration in the project from the critical path entirely. `INTEGRATION.md:543-547` ranks bb.js worker resolution as the #1 day-costing risk ("proving hangs with no error") and keccak transcript as #2 ("verifies locally, silently rejected on-chain"). With this split, neither can touch the demo. It also makes the demo *more* honest, not less: the events being replayed are genuinely on-chain, produced by genuinely valid proofs.

Cost: private *send* becomes a Node-side action, not a browser button. Accept that. The bounty is about the wallet's recovery story, and a working recovery beats a broken send.

## Cut list

Cut outright: SPP shield/unshield (the 34 MB of proving keys in `SPP/deployments/testnet/circuit_keys/` have no browser story — `INTEGRATION.md:552`); the shielded swap; the MCP server; selective disclosure; the auditor client; spender flows in the wallet (the Archive should keep indexing `set_spender`/`revoke_spender`/`spender_transfer` — it already does, and that exceeds what the demo needs, which is a point in your favour).

Keep: Archive (finish, test, deploy, ingest real events); `kit/` scoped to recovery only; wallet scoped to connect / balances / wipe / recover / verify.

Removing SPP means the README's framing changes from "two privacy primitives unified" to "the durable-recovery layer the CT spec requires, built to spec." That is a **better** submission for this sub-lane, not a lesser one — it is one claim, fully delivered, judged by the people who wrote the requirement.

## The demo-timescale problem, and the honest way through it

You cannot demonstrate recovery past a 7-day RPC window inside three days, and you cannot backfill around it: the RPC only retains 7 days, so an Archive started today can never obtain the older history of the demo's existing CT token (deployed at ledger 3013364). There is no configuration that makes real >7-day-old events available.

Do not paper over this. Compress the seam and say so:

- Set the wallet's seam by config — `VITE_DEMO_SEAM_LEDGER` — to roughly one hour back instead of `oldestLedger + 60`.
- Below that seam the RPC leg is not consulted; the Archive is the only source. The events are real, on-chain, and genuinely served by the Archive.
- Show both numbers on screen: the RPC's true retention floor, and the compressed demo seam, labelled *"seam compressed from 7 days to 1 hour so the mechanism is visible in a live demo; the code path is identical."*
- Then land the proof: issue a real `getEvents` for a ledger below the RPC's *true* floor and show the `-32600` error next to the Archive serving that same range. That contrast is the entire product thesis, demonstrated with two real responses.

A judge who sees an explicitly labelled compressed timescale reads it as rigor. A judge who sees an unlabelled "beyond the 7-day window" badge over data that is two hours old reads it as fabrication — and one of them wrote the spec that says the window is 7 days.

---

# Three-day plan

Ordered so that each day ends with something demonstrable, and the demo becomes real as early as possible.

### Day 1 (Aug 3) — make the Archive provably conformant and really running

1. **B3 — conformance tests.** One case per MUST, titled by clause. Half a day, highest credibility-per-hour in the repo.
2. **H1** — filter `inSuccessfulContractCall`. **H2** — bound the poll with an explicit `endLedger`. **M1**, **M2**, **M4** — one-liners, take them.
3. **B4** — add `retains_from` / `holds_full_history`, change the `resolveRange` default, warn on `auto`.
4. **Deploy a fresh CT token on testnet** and record its deploy ledger. Start the Archive with `START_LEDGER=<deploy ledger>` so it holds full history by construction. Put it on a public URL (Fly/Railway) — a judge should be able to `curl /v1/health`.
5. **H6** — move the seeder to `test/fixtures/`, stamp seeded DBs, gate the server.

*End of day: `curl` against a public Archive ingesting a real contract, plus a green test suite naming the clauses it satisfies. That alone is a defensible submission.*

### Day 2 (Aug 4) — real keys, real events, real recovery

1. **B2** — decide the `kit/` question and write it in the README. Recommend: reimplement recovery-only primitives, pinned to `circuits/lib/testdata` (**H7**).
2. **H3** — implement `SDK.md` §5.1 + §5.2: Freighter `signMessage` → root → HKDF → `sk`/`vk`, with signature verification, the double-signature determinism check, and `Y` compared against the on-chain `spending_public_key`.
3. **Node history script** — register / deposit / transfer in / merge / transfer out, with real proofs, against the fresh contract. This is the demo's substrate; run it early so the Archive ingests it live.
4. **H4** — the hybrid seam and the fail-closed rule, in `kit/`.
5. **Replay engine** — `DESIGN.md` §5.2 steps 1–7, with `T_0` resolved per §2 (**M3**), mod-p blinding accumulation, and the §7 re-commitment check against chain state.

*End of day: `recoverFromSigner` works from a Node test harness against the live Archive and returns a chain-verified opening. The claim is now true, whatever the UI looks like.*

### Day 3 (Aug 5) — wire the UI, tell the story

1. **B1** — swap `MockSombraClient` for the live client; make `CLIENT_MODE` actually select. Delete the fake URL and fake derivation strings.
2. Recovery UI: real progress from real phases, live event counts, the compressed-seam labelling, and the RPC `-32600` vs Archive contrast.
3. **H5** — surface `complete` and the coverage ranges; make an incomplete range fail visibly and differently from a verification failure.
4. **M5** LICENSE + NOTICE; **M6** acknowledge or implement multi-endpoint; README rewritten to match shipped reality (drop `kit/`'s six-function API if it did not ship, drop SPP, drop L2's superlative).
5. Record the demo video. Do this with time to spare — it is a deliverable, not a nicety.

### Aug 6 — submit with buffer

Reserve the morning. Do not schedule work into it.

## If Day 2 slips

Fall back to submitting the Archive alone as a spec-conformant indexer with a Node-based recovery CLI proving it end to end, and be explicit in the README that the browser wallet is in progress. A rigorously conformant Archive with a clause-by-clause test suite, a public endpoint, and a CLI that recovers a real account is a *strong* entry for this sub-lane. A polished wallet running on `MockSombraClient` is not an entry at all — it is the thing the judges are trained to spot.
