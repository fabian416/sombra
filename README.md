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

## Build order (priority is strict)

1. Archive (nothing works without it)
2. Wallet CT flows + recovery
3. SPP shield/unshield
4. Shielded swap
5. (cherry) MCP server exposing sombra-kit to AI agents
