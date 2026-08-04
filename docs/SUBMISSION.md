# Sombra — GrantFox submission draft

> Copy-paste material for the GrantFox submission form (sub-lane: Confidential-Token & Private-Payment Wallets). Edit freely.

## Title

**Sombra — the confidential wallet on Stellar that never loses your funds**

## Summary (short)

Sombra is a confidential-token wallet backed by the missing piece of Stellar's privacy stack: a durable event archive. Confidential balances are Pedersen commitments — spending them requires replaying the account's full event history, but Stellar RPC retains events for only 7 days. Lose your device on day eight and your funds are visible on-chain yet permanently unspendable. Sombra closes that gap.

## What we built (maps to all three bounty examples)

1. **Sombra Wallet** — private balance display done right: confidential CT balance decrypted in-wallet (hidden on-chain), private send/receive, Freighter signing, recovery-from-signature. UI in pt-BR, fully self-contained (works offline except RPC/Archive).
2. **Sombra Archive** — the first implementation of OpenZeppelin's `INDEXER.md` specification (RFC-2119): durable event archive with §3.1 record fidelity, topic-based attribution (§3.3), total ordering (§3.4), gap tracking (§4), indefinite retention (§5) and the C1–C4 API surface (§6), with a conformance test suite titled clause-by-clause.
3. **sombra-kit** — TypeScript recovery engine: normative SDK.md §5.1/§5.2 key derivation, event replay with correct T₀ anchoring, §7 re-commitment verification against chain state, hybrid RPC+Archive seam with fail-closed semantics. Crypto primitives pinned byte-for-byte against the official conformance fixtures (102 tests).

## The proof (not a promise)

A fresh Confidential Token deployed on testnet (`CC2Z…4ZAC`) with real on-chain history — 13 transactions with real UltraHonk proofs. End-to-end verified:

```
replay: 10 events served by the archive, T₀ resolved, openings restored
verification: re-committed openings match on-chain points → VERIFIED=true
retention contrast: RPC refuses ledgers below its floor (-32600);
                    the Archive answers them — with an honest complete flag
```

These events fall out of the RPC window on ~Aug 10. After that date, this history is recoverable **only** through Sombra Archive — which is the product thesis, live.

## Links

- Repository: https://github.com/fabian416/sombra
- Archive (live): _[public URL — pending deploy]_
- Wallet (live): _[public URL — pending deploy]_
- Demo video: _[pending]_

## Team

_[complete on GrantFox]_
