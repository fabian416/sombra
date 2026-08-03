# Sombra scripts — the demo's on-chain substrate

Three Node scripts. `deploy.ts` puts a fresh Confidential Token on Stellar
testnet; `derive.ts` implements the normative key derivation both this side and
the browser depend on; `history.ts` gives one account a real confidential
history on it. Everything the browser wallet and the Archive demonstrate is read
back from what these produce — the wallet never proves anything itself.

Splitting the work this way is deliberate. Reconstructing a balance needs no
zero-knowledge proof at all (`DESIGN.md` §5.2 is two Poseidon2 hashes, an ECDH
per incoming transfer, and two Pedersen re-commitments). Proving is needed only
to *create* history, and in Node it runs with no bundler involved — which keeps
the two riskiest integrations in the stack, bb.js worker resolution and the
mandatory keccak transcript, off the demo's critical path entirely.

## Prerequisites

- Node ≥ 20.
- The `stellar` CLI **≥ 25.2**. The contracts are built against soroban-sdk 27
  and older CLIs reject their spec XDR with `cannot parse WASM file: xdr
  processing error`. If the CLI on `PATH` is older, point at a newer binary:
  `STELLAR_CLI=/path/to/stellar npm run deploy`.
- The sibling clone `../../stellar-confidential-token-demo`, with its SDK
  installed and built:

  ```sh
  cd ../../stellar-confidential-token-demo
  pnpm install --filter @ctd/sdk
  pnpm --filter @ctd/sdk build
  ```

  That clone ships the prebuilt contract WASM and the compiled circuits, so
  neither Rust nor `nargo` is needed here.

Then, in this directory:

```sh
npm install
npm run deploy            # ~1 min
npm run derive -- --parity  # seconds — key derivation vs. the browser kit
npm run history           # several minutes — real UltraHonk proofs
```

## How the CT SDK is consumed

`package.json` declares

```json
"@ctd/sdk": "file:../../stellar-confidential-token-demo/packages/sdk"
```

A path dependency, resolved through the package's own `exports` map — including
the contract WASM and the compiled circuit artifacts, which `common.ts` locates
via `import.meta.resolve` rather than by reaching into the sibling clone by
hand. **No upstream source is copied into this repo.** `@ctd/sdk` is
`"private": true` and unpublished, so it cannot be `npm install`ed from a
registry; consuming it by path is the rules-clean way to depend on it, and it is
why a reviewer needs the sibling clone checked out.

## `deploy.ts`

Deploys the verifier, the auditor registry, and the token (whose constructor
wires the other two), registers all six circuit verification keys and one
auditor key, and asserts that the contract's stored `address_as_field` equals
the SDK's `addressToField(token)`. That last check is the one that matters: if
the two Poseidon2 implementations had diverged, every `register` proof would be
rejected on-chain, and this is the cheapest place to find out.

A **fresh** deployment, not the demo's existing one, because the Archive claims
to hold an account's *full* history and can only do so by construction if it
starts ingesting at the contract's own deploy ledger. RPC retains roughly seven
days, so a token deployed months ago has history that is simply unobtainable.

## `history.ts`

Two accounts, primary and secondary, and this sequence:

| Step | Event | Why it is in the history |
|:--|:--|:--|
| register (both) | `register` | Start of history; bounds the worst-case replay window |
| deposit (both) | `deposit` | Receiving-side replay — deposits commit with zero blinding |
| merge (secondary) | `merge` | Received value is not spendable until merged |
| 3 × transfer secondary → primary | `transfer` | Receiving-side replay via ECDH from the event ciphertexts |
| merge (primary) | `merge` | Folds deposit + transfers into spendable — the `T_0` anchor |
| transfer primary → secondary | `transfer` | Checkpoint: publishes `(b_tilde, sigma)` |
| withdraw (primary) | `withdraw` | Checkpoint, the latest one |
| transfer secondary → primary | `transfer` | Arrives *after* that checkpoint |
| merge (primary) | `merge` | Folds it in after the checkpoint too |

That tail is the point. With a merge landing after the latest checkpoint,
recovery has to resolve `T_0` as "the last merge at or **before** the
checkpoint" (`INDEXER.md:21`). A wallet that takes the last merge overall starts
its replay too late and reconstructs a spendable balance short by exactly the
amount that merge folded in — and its re-commitment against the on-chain point
fails. This is the single easiest way to build a silently wrong wallet, so the
history is built to make it loud rather than latent.

After every step the script re-syncs the account's state from events alone and
re-commits the reconstructed openings against the on-chain Pedersen points
(`StateEngine.verifyAgainstChain`). A green run is itself evidence that the
history it just wrote is replayable.

Proving takes single-digit seconds per operation; the run is dominated by
waiting for ledgers to close. That is fine — it runs once, offline, before the
demo.

## Outputs

- **`deployment.json`** (committed) — network, contract ids, deploy ledger,
  account addresses, every transaction hash with the event it produced, the
  ledger range the history spans, the full key-derivation parameters with the
  shared parity vector, and any `supersededAccounts`.
- **`.demo-keys.json`** (gitignored) — Stellar seeds for the deployer, primary
  and secondary accounts, each account's derived confidential spending secret,
  the derivation tag it was enrolled under, and the auditor's Grumpkin secret.
  Testnet only.

`deploy.ts` writes both; `history.ts` fills in the account and transaction
fields. Re-running `history.ts` reuses the recorded accounts — rather than
orphaning a half-built history under an account nothing points at — but only
when they were enrolled under the derivation the script currently implements.
When they were not, it mints fresh ones and records the old pair under
`supersededAccounts`; see *Key derivation* below for why that case cannot be
repaired any other way.

## `derive.ts` — key derivation

`SDK.md` §5.1 + §5.2, normative, no shortcuts:

```
msg  = "openzeppelin/confidential-token/v1/sk" ‖ 0x0a ‖ enc(contract) ‖ 0x0a ‖ enc(account)
root = Ed25519-Sign( sk_ed, SHA-256("Stellar Signed Message:\n" ‖ msg) )      §5.2, 64 bytes
sk   = RS( HKDF-SHA-512( IKM  = root,
                         salt = "openzeppelin/confidential-token/v1/sk",
                         info = be32(addr_f) ‖ be32(acct_f) ‖ le4(j) ) )      §5.1
```

`RS` is `§4.7`'s rejection procedure — clear the top two bits, accept iff the
result is in `[1, r)`, else increment `j` — with an extra re-roll if `vk == 0`,
which registration constraint R5 forbids. Everything below `sk` (`vk`, `Y`,
`PVK`) is `@ctd/sdk`'s `deriveKeys`, so the Poseidon2 and Grumpkin used to
derive keys are the same ones used to prove.

The root is a SEP-0053 signature, which is what a wallet's `signMessage`
produces, so a browser holding the same Stellar account derives the same
confidential keys without ever seeing a seed — the seed half of the recovery
story. The message binds both the contract and the account, so a signature
harvested for one account on one deployment derives nothing else.

**Why this is not the demo app's `sk = SHA-512(signature) mod r`.** Both fold
the same signature and they produce different keys; only one is the
specification. `register` is single-use, so an account enrolled under the wrong
one cannot be migrated — the address is burned, and remediation means
registering a fresh address and transferring the balance out. The shortcut also
omits `acct_f`, so one signer registering two addresses publishes an identical
`PVK` under both, publicly linking two addresses that are otherwise unlinkable
(`SDK.md` §5.1, *Bound to acct_f*).

Because that mistake is unrepairable rather than merely wrong, three checks run
around it:

- **`--parity`** executes `kit/src/keys.ts` — the browser implementation, built
  on an independent crypto core (`@noble/hashes` HKDF, `@zkpassport/poseidon2`,
  `@noble/curves`) — over a shared vector and compares `sk`, `vk`, `Y` and
  `PVK`. Agreement covers both the §5 layer and the DESIGN.md §4 layer beneath
  it. The vector is in `deployment.json` under `keyDerivation.testVector`; its
  seed is the published constant `32 × 0x01`, not a funded account.
- **`keyDerivation.accountVectors`** pins the same thing against the accounts
  that are *actually registered*, which is the stronger claim: an
  implementation that reproduces these `Y` values from a SEP-0053 signature has
  shown it can enrol this history's accounts, not merely that it agrees on a
  synthetic input. Only public values are recorded — `Y` and `PVK` are what
  `register` published on-chain. `sk` and `vk` are secret (`vk` decrypts both
  channels) and stay in the gitignored `.demo-keys.json`, where a client can
  read them for a full byte-parity test locally. Note `secondary` has
  `rejectionCounter: 1`.
- **`history.ts` reads `Y` and `PVK` back from chain** immediately after each
  `register` and asserts they match the derivation. `SDK.md` §5.2 makes a `Y`
  mismatch mean "this account uses a root I do not hold", so proving here that
  the published points *are* the spec's keys is what gives the wallet's identical
  check something true to find.
- **`.demo-keys.json` records a `derivation` tag per account.** An account whose
  tag does not match the current derivation is not reused — `history.ts` mints a
  fresh one and records the old one under `supersededAccounts`, rather than
  failing at `register` several minutes into a proving run.

```sh
npm run derive -- --parity
```

`SOMBRA_PRIMARY_SK` / `SOMBRA_SECONDARY_SK` still override `sk` directly; that
is `§5.3`'s direct-import form, conformant but reproducible only from the stored
value, and it is recorded as `rootForm: "import"`.

## Run notes

### 2026-08-03 — history re-run under the normative derivation

The history that existed before this run was real and on-chain, but its accounts
had been enrolled with `sk = SHA-512(SEP-0053 signature) mod r` — the CT demo
app's shortcut, not `SDK.md` §5. Because `register` is single-use, those two
accounts are permanently bound to keys the spec's derivation does not produce:
a browser wallet implementing §5 derives a different `vk`, so every incoming
transfer in that history is encrypted to a viewing key the wallet does not hold,
and its `Y` never matches the on-chain `spending_public_key`. The history was
replayable but **not recoverable**, which is the only property Sombra is about.

There is no migration for that — the fix is new addresses. So `history.ts` minted
two fresh accounts, enrolled them under §5.1 + §5.2, and rebuilt the full
sequence. The superseded pair is recorded in `deployment.json` under
`supersededAccounts`; their events are still on-chain and the Archive still
ingests them, which is realistic noise rather than a problem.

Accounts (both `rootForm: "signer"`):

| | |
|:--|:--|
| primary | `GA4Q5CFRBM26X7NQGYFT5PITCMNUOD7R63LSID2IEFLNMKQKY5EIOAW7` |
| secondary | `GB7J4RKIHOIMA6KRQ32WJPGS6AWCOYETZM4IAIREVT5BO6IZICNQ73XI` |

13 transactions, ledgers 3953983–3954008, all verified `SUCCESS` against the RPC
after the fact rather than only at submission:

| Ledger | Event | Tx | |
|--:|:--|:--|:--|
| 3953983 | `register` | `bb2577ae85e1…` | primary |
| 3953984 | `register` | `41906894b5c2…` | secondary |
| 3953985 | `deposit` | `9bdf939caff2…` | primary +1000 |
| 3953986 | `deposit` | `db1acc6dc836…` | secondary +3000 |
| 3953987 | `merge` | `858b34f14c38…` | secondary, so it can send |
| 3953990 | `transfer` | `64acd4bb9db4…` | 700 → primary |
| 3953995 | `transfer` | `ab32ddcc9efe…` | 500 → primary |
| 3953998 | `transfer` | `4ec8d1e786f5…` | 300 → primary |
| 3954000 | `merge` | `0a851361a888…` | **the `T_0` anchor** |
| 3954002 | `transfer` | `a338554ff3de…` | 250 → secondary; first checkpoint |
| 3954004 | `withdraw` | `e538cc0ae483…` | 400 → public; **latest checkpoint** |
| 3954007 | `transfer` | `584f208c450d…` | 600 → primary, *after* that checkpoint |
| 3954008 | `merge` | `de4e98a3a8e1…` | *after* it too — the `T_0` trap |

Primary ends at spendable 2450, receiving 0. A wallet that resolves `T_0` as
"the last merge" rather than "the last merge at or before the checkpoint" gets
1850 and fails its re-commitment — which is the point of the tail.

Three things worth recording from the run:

- **The secondary account derived at `j = 1`.** Its first HKDF candidate was
  rejected by §4.7, so the rejection counter is not a formality that only
  appears in the spec — one of the two accounts in this history exercises it,
  and any client that ignores `j` derives the wrong `sk` for that account.
- **On-chain `Y` and `PVK` matched the derivation for both accounts**, checked
  immediately after each `register`.
- **Proving was 3.5–4.6 s per operation** and the run was dominated by waiting
  for ledgers. bb.js needed no mitigation: the worker-resolution hang
  (`INTEGRATION.md`) is a bundler failure, and there is no bundler in Node —
  which is the reason proving lives here and not in the browser.

### Retention deadline on this history

The Archive's claim — full per-account history by construction, ingesting from
the contract's own deploy ledger — is only *achievable* while that ledger is
still inside the RPC's retention window. Measured 2026-08-03, testnet RPC
retained 120,959 ledgers (~7 days):

| Ledger | | Falls below the retention floor |
|--:|:--|:--|
| 3949779 | `deployLedger` — the Archive's `START_LEDGER` | ~2026-08-10 15:00 UTC |
| 3953983–3954008 | the scripted history | ~2026-08-10 21:00 UTC |

So the Archive must complete a cold start from 3949779 **before roughly
2026-08-10 15:00 UTC**. After that the pre-floor history is permanently
unobtainable from RPC, `START_LEDGER=auto` silently resolves to the floor
instead, and the only repair is `npm run deploy && npm run history` on a fresh
contract — which invalidates every hash recorded above and every account address
the wallet and the Archive have pinned.

This is the same failure `REVIEW.md` B4 describes, reached by waiting rather
than by misconfiguration. It is worth re-running the numbers before submission:

```sh
curl -s -X POST https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

`oldestLedger` above 3949779 means the window has closed.
