# Sombra

**The first confidential wallet on Stellar that never loses your funds.**

Built for the Stellar Builder Summit SP 26 — Privacy lane (OpenZeppelin + Nethermind), sub-lane *Confidential-Token & Private-Payment Wallets*.

## The problem

Confidential Token balances on Stellar are Pedersen commitments. To spend, a wallet must reconstruct the commitment "opening" by replaying the account's full event history from seed. Stellar RPC retains events for **7 days only** — a wallet that loses local state after that window can see its funds on-chain but can never spend them again. OpenZeppelin's own spec (`INDEXER.md`) states: without a durable event archive, *"recovery from seed is not guaranteed"*. The official CT demo describes itself as *"RPC-only (no indexer)"*.

Sombra closes that gap.

## The stack

| Component | Path | What it is |
|:--|:--|:--|
| **Sombra Wallet** | `wallet/` | Web wallet (React + Vite). Freighter for Stellar signing; Sombra manages the privacy layer. Confidential balance display, private send/receive (CT), shielded deposits/withdrawals (SPP), recovery-from-seed, shielded swap. |
| **Sombra Archive** | `archive/` | Durable event indexer implementing OpenZeppelin's `INDEXER.md` spec (RFC-2119). Ingests confidential-token + SPP pool events from Stellar RPC, retains them indefinitely, serves `/v1/health`, `/v1/.../checkpoint`, `/v1/.../events`. Trustless: clients verify reconstructed openings against on-chain commitments. |
| **sombra-kit** | `kit/` | TypeScript SDK unifying both privacy primitives behind one API: `getConfidentialBalance()`, `privateSend()`, `shield()`, `unshield()`, `recoverFromSeed()`, `privateSwap()`. Wraps the official OZ CT SDK and Nethermind SPP SDK; adds the Archive-backed recovery neither has. |

## Demo moments

1. **Recovery**: wipe the wallet's local storage live → restore from seed via Sombra Archive → funds spendable again. No other wallet can do this past the 7-day RPC window.
2. **Shielded swap** (stretch): SPP pool → fresh address → Soroswap → back into the pool. First shielded DeFi flow on Stellar.

## Rules compliance

- 100% original code. We consume the official SDKs as dependencies (MIT / Apache-2.0) — the intended integration path — and implement the published `INDEXER.md` spec. No demo-app code is copied.
- Reference material lives in sibling clones (`../stellar-contracts`, `../stellar-private-payments`, `../stellar-confidential-token-demo`) and is never vendored here.

## Spec scorecard

Sombra Archive implements OpenZeppelin's normative `INDEXER.md` specification. Every claim below is backed by a test **titled with the clause it verifies** — run `cd archive && npx vitest run`.

| Clause | Requirement | Where |
|:--|:--|:--|
| §2 | `T_0` = last `Merge` **at or before** the checkpoint (not the last overall); falls back to `Register` | `archive/test/conformance.test.ts`, kit replay engine |
| §3.1 | Every record field persisted, topics/data as verbatim XDR | `archive/src/db.ts` + test |
| §3.3 | Attribution from event **topics** — sender AND recipient; never the tx source account | `archive/src/events.ts` + 3 tests |
| §3.4 | Total order `(ledger_seq, tx_application_order, event_index)` | `archive/src/db.ts` + test |
| §4 | Idempotent ingestion, gap tracking, request-bounded coverage, fidelity, final-stream only (rolled-back sub-call events excluded from reads) | `archive/src/ingest.ts` + 5 tests |
| §5 | Indefinite retention; `holds_full_history` honest for cold starts | `archive/src/ingest.ts` + 3 tests |
| §6 C1 | Latest checkpoint — sender-side `Transfer` only, self-transfer counts, spender excluded | `archive/src/api.ts` + 3 tests |
| §6 C2 | Ordered per-account history, paginated without loss or repeat | `archive/src/api.ts` + test |
| §6 C3 | `complete:false` across gaps and past `ingested_through` | `archive/src/api.ts` + 2 tests |
| §6 C4 | Ingestion status with contiguous floor | `/v1/health` + test |
| §7 | Trust model: recovery verifies reconstructed openings against **on-chain commitments** — a tampered archive cannot fake a balance | `kit/src/recover.ts`, proven by `scripts/e2e-recover.ts` |

The kit's cryptography is pinned **byte-for-byte** against the official conformance fixtures (`circuits/lib/testdata/*.json`, read at test time, never transcribed) — including the mod-p blinding accumulation trap. `SDK.md` §5.1/§5.2 key derivation implemented normatively (HKDF-SHA-512 with rejection sampling over the SEP-0053 signature root).

**End-to-end proof** (`cd scripts && npm run e2e`): recovers the demo account from its signer against the live Archive, replays real on-chain events, re-commits, and matches the on-chain points → `VERIFIED=true`. The run ends with the retention contrast: the RPC refuses pre-floor ledgers (`-32600`) while the Archive serves them — with an honest `complete` flag.
