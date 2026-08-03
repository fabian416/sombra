# Sombra — Integration Map

Precise integration surface for the three upstream stacks Sombra consumes. Written for builders wiring
`wallet/`, `archive/`, and `kit/`. Every claim is cited to a file and line in the sibling clones; nothing
here is vendored.

Reference clones (never modified, never copied into this repo):

| Alias | Path | License |
|:--|:--|:--|
| **CT-DEMO** | `../stellar-confidential-token-demo` — OpenZeppelin's Confidential Token demo monorepo | MIT |
| **CT-CONTRACTS** | `../stellar-contracts/packages/tokens/src/confidential` — canonical Soroban contract + specs | Apache-2.0 |
| **SPP** | `../stellar-private-payments` — Nethermind's Stellar Private Payments shielded pool | Apache-2.0 |

> **The two privacy stacks share almost nothing.** CT is an *account* model: Pedersen commitments over
> Grumpkin, Poseidon2, UltraHonk/Noir proofs, per-account spendable+receiving balances, recovery by event
> replay. SPP is a *UTXO* model: a Poseidon2 merkle tree of note commitments, nullifiers, Groth16/Circom
> proofs, recovery by trial-decrypting every commitment event. Different curves usage, different proving
> systems, different toolchains, different recovery algorithms. `kit/` is a façade over two genuinely
> disjoint implementations — do not plan for shared crypto internals.

**Version pins that matter**

| Stack | Pin | Source |
|:--|:--|:--|
| CT contracts | `soroban-sdk 27.0.2` | `../stellar-contracts/Cargo.toml:55` |
| CT circuits | `nargo 1.0.0-beta.11` + `bb 0.87.0` | `CT-CONTRACTS/circuits/vks/README.md` |
| CT SDK | `@aztec/bb.js 0.87.0`, `@noir-lang/noir_js 1.0.0-beta.9`, `@stellar/stellar-sdk ^14.2.0` | `CT-DEMO/packages/sdk/package.json` |
| CT app | `@stellar/freighter-api ^4.1.0`, Next 16.2.9, React 19.2.7 | `CT-DEMO/packages/app/package.json` |
| SPP | Rust `1.97.1`, `wasm-bindgen-cli` **exactly** `0.2.126`, Binaryen `version_131`, Circom ≥ `2.2.2` | `SPP/rust-toolchain.toml:2-4`, `SPP/sdk/web/scripts/build.sh:22`, `:34-97`, `SPP/CONTRIBUTING.md:90` |
| SPP app | `@stellar/freighter-api ^6.0.1` (peer, optional) | `SPP/sdk/web/package.json` |

Note the CT demo's own comment claims soroban-sdk 26 (`CT-DEMO/packages/sdk/src/chain/events.ts:13`); the
contract repo is on 27. Pin to 27. Note also the two Freighter API majors — **CT is on v4, SPP on v6**.
One wallet consuming both needs a single version that satisfies both, or two adapters.

---

## A. CT SDK surface — `@ctd/sdk`

Package `CT-DEMO/packages/sdk`, name `@ctd/sdk`, version `0.1.0`, **`"private": true`**. ~3,770 lines
across 40 files. Barrel `src/index.ts:15-21` re-exports seven layers: `crypto/`, `witness/`, `proving/`,
`chain/`, `state/`, `disclosure/`, `auditor/`.

**Browser-safety is designed-in and explicit.** Exactly two modules are Node-only and are deliberately
kept *out* of the barrels — they must be imported by path:

- `state/json-store.ts:1-6` — `JsonFileStore` (`node:fs`, `node:path`). Excluded per `state/index.ts:1-2`.
- `proving/artifacts.ts:10-12` — `loadCircuit` (`node:fs`, `node:url`, `node:path`). Excluded per
  `proving/index.ts:1-3`.

Everything else in the barrel is isomorphic. `crypto/field.ts:98-107` uses Web Crypto
(`crypto.getRandomValues`). The one implicit Node-ism in otherwise browser-safe code is
`Buffer.from` at `chain/payload.ts:27` — fine under Node and under any bundler that polyfills `Buffer`,
but Vite does **not** by default.

### A.1 crypto/ — keys, curve, hashing

| Export | Signature | Browser | file:line |
|:--|:--|:--:|:--|
| `deriveKeys` | `(sk: bigint, addrF: bigint) => KeyPair` | ✅ | `crypto/keys.ts:35-40` |
| `generateKeys` | `(addrF: bigint) => KeyPair` | ✅ | `crypto/keys.ts:43-45` |
| `serializeKeys` / `deserializeKeys` | `KeyPair ⇄ {sk, addrF}` | ✅ | `crypto/keys.ts:48-54` |
| `addressToField` | `(strkey: string) => bigint` | ✅ | `crypto/address.ts:25-35` |
| `commit` | `(v: bigint, r: bigint) => Point` | ✅ | `crypto/grumpkin.ts:79-81` |
| `scalarMul`, `ecdh`, `pointToBytes`, `pointFromBytes`, `isIdentity`, `pointCoords` | — | ✅ | `crypto/grumpkin.ts:61-119` |
| `G`, `H`, `IDENTITY`, `Grumpkin`, `Fr`, `Fp` | constants | ✅ | `crypto/grumpkin.ts:25-58` |
| `sponge`, `poseidonWithDomain`, `spongeSqueeze2` | — | ✅ | `crypto/poseidon2.ts:24-62` |
| `vkFromSk`, `dvkFromVkOp`, `deriveSpendR`, `deriveAllowR`, `deriveTxBlind`, `deriveEphemeralRE` | — | ✅ | `crypto/poseidon2.ts:69-103` |
| `encryptAmount`, `encryptBalance`, `encryptAllowance`, `encryptEscDvk`, `encryptAuditorSenderBalance`, `encryptDisclosure`, `decryptWithDomain` | — | ✅ | `crypto/poseidon2.ts:110-146` |
| `frMod`, `frAdd`, `frSub`, **`fpAdd`**, `toBytes32BE`, `fromBytesBE`, `fromBytesLE`, `toHex32`, `fromHex`, `randomScalar` | — | ✅ | `crypto/field.ts` |
| `DOMAIN`, `CIRCUIT_TYPE`, `FR_MODULUS`, `FP_MODULUS`, generators | constants | ✅ | `crypto/constants.ts:69-124` |

Key derivation is `sk` → `vk = Poseidon2(VIEWING_KEY, sk, addrF)`, `Y = sk·H`, `PVK = vk·H`
(`crypto/keys.ts:1-10`). Every key is **contract-bound** through `addrF`, so a key set for one deployment
is meaningless against another. `addressToField` compresses the 56-char strkey into two **little-endian**
28-byte limbs and hashes `Poseidon2(ADDRESS, lo, hi)` (`crypto/address.ts:25-35`).

**`fpAdd` is a correctness landmine, not a convenience.** Blinding factors accumulate under *point*
addition, so they sum **mod p (the Grumpkin group order), never mod r**. `crypto/field.ts:25-36` spells
out the consequence: reducing mod `r` silently opens the wrong commitment roughly half the time, off by
`p − r`. Every blinding accumulation in Sombra's own recovery path must use `fpAdd`.

**Key derivation from seed — the demo and the spec disagree.** The demo derives
`sk = SHA-512(ed25519_signature) mod r` over a fixed message
(`CT-DEMO/packages/app/lib/derive-key.ts:14-31`). The normative spec requires
`sk = RS(HKDF-SHA-512(IKM=root, salt="openzeppelin/confidential-token/v1/sk", info=be32(addr_f)‖be32(acct_f)‖le4(j)))`
with rejection counter `j` (`CT-CONTRACTS/docs/SDK.md:183`), where `root` is a SEP-0053 signature over a
151-byte message (`SDK.md:210-238`). **These produce different keys.** Sombra must choose: the spec form
means demo-created accounts aren't recoverable, and vice-versa. Both bind the key to the contract address.
The spec also warns (`SDK.md:230`) that MPC/threshold ed25519 randomizes the nonce and won't reproduce —
implementations MUST sign twice from independent invocations and abort on mismatch.

### A.2 witness/ — per-circuit input builders

All browser-safe, all pure. A "witness" is the full `main()` argument set keyed by the exact Noir
parameter names.

| Export | Signature | file:line |
|:--|:--|:--|
| `buildRegisterWitness` | `(keys: KeyPair) => RegisterWitness` | `witness/register.ts:18-26` |
| `buildWithdrawWitness` | `(p: WithdrawParams) => WithdrawWitness` | `witness/withdraw.ts:51-90` |
| `buildTransferWitness` | `(p: TransferParams) => TransferWitness` | `witness/transfer.ts:76-145` |
| `fieldIn`, `pointIn` | encoders (`Point` → `${prefix}_x`/`_y`) | `witness/common.ts:15-27` |
| `buildDiscloseRecipientWitness`, `buildDiscloseSenderWitness` | selective disclosure | `witness/disclose-recipient.ts`, `witness/disclose-sender.ts` |

Each returns `{ inputs, payload, next }` — `payload` is the on-chain struct, `next` is the post-op
spendable opening to cache optimistically (`withdraw.ts:47-48`, `transfer.ts:58-59`).
`buildTransferWitness` adds `recipientView` and `rEScalar` (`transfer.ts:60-73`).

By default `r_e` is **deterministic**: `r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma)` (`transfer.ts:87`,
derivation `crypto/poseidon2.ts:99-103`). The circuit only constrains `R_e = r_e·H` and `r_e ≠ 0`, so this
is a client convention — but it lets a sender re-derive any past transfer's ephemeral scalar from `vk` +
the event's public `sigma`, retaining nothing.

### A.3 proving/ — UltraHonk via bb.js

| Export | Signature | Browser | file:line |
|:--|:--|:--:|:--|
| `CircuitProver` | `new (circuit: CompiledCircuit)` | ✅ * | `proving/prover.ts:61-107` |
| `.prove` | `(inputs: NoirInputs) => Promise<ProofResult>` | ✅ | `prover.ts:80-85` |
| `.verify` | `(r: ProofResult) => Promise<boolean>` | ✅ | `prover.ts:88-91` |
| `.verificationKey` | `() => Promise<Uint8Array>` | ✅ | `prover.ts:99-102` |
| `.destroy` | `() => Promise<void>` | ✅ | `prover.ts:104-106` |
| `proverFromArtifact` | `(artifact: {bytecode}) => CircuitProver` | ✅ | `prover.ts:114-118` |
| `setUltraHonkBackendLoader` | `(loader) => void` | ✅ | **Mandatory in browser.** `prover.ts:45-47` |
| `loadCircuit` | `("register"\|"withdraw"\|"transfer") => CompiledCircuit` | ❌ `node:fs` | `proving/artifacts.ts:20-23` |

\* only after `setUltraHonkBackendLoader` — see below.

**Two hard requirements.**

1. **Keccak transcript is mandatory.** Proofs are generated with `{ keccak: true }` (`prover.ts:29`,
   applied `:83`, `:90`, `:101`). The on-chain verifier (NethermindEth/rs-soroban-ultrahonk) rebuilds
   Fiat-Shamir with keccak256 while bb.js **defaults to Poseidon**. A default-transcript proof verifies
   locally and is **silently rejected on-chain** (`prover.ts:5-8`). The contract side adds: do **not**
   pass `--zk`, the verifier implements only the non-zk `ultra_flavor`
   (`CT-CONTRACTS/circuits/vks/README.md`).
2. **bb.js must be native ESM in the browser.** bb.js spawns its WASM worker via
   `new Worker(new URL('./main.worker.js', import.meta.url))` marked `webpackIgnore`. Bundled into a
   hashed chunk, that sibling URL no longer resolves and **proving hangs with no error** — it simply never
   resolves. The demo copies bb.js's `dest/browser/` verbatim into `public/vendor/bb/` and loads it via
   `new Function("url", "return import(url)")` so the bundler never sees the import
   (`CT-DEMO/packages/app/lib/bb-loader.ts:1-44`, wired `:37-43`). Sombra's Vite build needs the
   equivalent (static copy + `/* @vite-ignore */`).

Compiled ACIR artifacts ship at `CT-DEMO/packages/sdk/circuits/`: `register.json` 57 KB, `withdraw.json`
66 KB, `transfer.json` 73 KB — **~196 KB total**. These are circuit bytecode, not proving keys: UltraHonk
needs no per-circuit trusted setup and the CRS is handled by bb.js at backend init. **This is a decisive
advantage over SPP** (see §D.2).

### A.4 chain/ — RPC client, submitters, event ingest

| Export | Signature | Browser | file:line |
|:--|:--|:--:|:--|
| `ChainClient` | `new (cfg: ChainConfig)` | ✅ | `chain/client.ts:80-88` |
| `.simulate` | `(contractId, method, args) => Promise<xdr.ScVal>` | ✅ | `client.ts:92-111` |
| `.confidentialBalance` | `(address) => Promise<OnChainAccount \| null>` | ✅ | `client.ts:114-123` |
| `.isRegistered` | `(address) => Promise<boolean>` | ✅ | `client.ts:125-127` |
| `.auditorKey` | `(auditorId: number) => Promise<Point>` | ✅ | `client.ts:130-135` |
| `.invoke` | `(contractId, method, args, signer) => Promise<InvokeResult>` | ✅ | `client.ts:148-187` |
| `keypairSigner` | `(secret, passphrase) => Signer` | ✅ | `client.ts:68-78` |
| `Signer` (interface) | `{ publicKey: string; sign(xdr): Promise<string> }` | — | **The Freighter seam.** `client.ts:33-38` |
| `submitRegister` | `(client, signer, account, auditorId, witness, proof)` | ✅ | `chain/contract.ts:22-36` |
| `submitDeposit` | `(client, signer, from, to, amount)` — **no proof** | ✅ | `contract.ts:39-52` |
| `submitMerge` | `(client, signer, account)` — **no proof** | ✅ | `contract.ts:55-61` |
| `submitWithdraw` | `(client, signer, from, to, amount, witness, proof)` | ✅ | `contract.ts:64-79` |
| `submitTransfer` | `(client, signer, from, to, witness, proof)` — method `confidential_transfer` | ✅ | `contract.ts:82-96` |
| `encodeRegisterData` / `encodeWithdrawData` / `encodeTransferData` | `(witness, proof) => xdr.ScVal` | ⚠️ `Buffer` | `chain/payload.ts:48-83` |
| `scvStruct` | `(fields) => xdr.ScVal` — ScMap, **symbol keys sorted ascending** | ⚠️ `Buffer` | `payload.ts:32-40` |
| `fetchEvents` | `(client, opts) => Promise<FetchEventsResult>` | ✅ | `chain/events.ts:261-304` |
| `buildConfidentialEvent` | **single source of truth for event decoding** | ✅ | `events.ts:154-205` |
| `parseIndexerEvent` | `(row: IndexerRow) => ConfidentialEvent \| null` | ✅ | `chain/indexer.ts:186-202` |
| `naturalEventId` | `` `${ledger}-${txHash}-${opIndex}-${eventIndex}` `` | ✅ | `events.ts:236-243` |
| `cursorLedger` | `(cursor) => number` (`toid >> 32`); **RPC resume cursors only** | ✅ | `events.ts:222-224` |
| `dedupeById` | stable sort by ledger only | ✅ | `chain/event-source.ts:59-65` |
| `hybridFetchEvents` | `(client, indexer?, opts)` — **the seam Sombra Archive plugs into** | ✅ | `event-source.ts:82-142` |
| `hybridResolveEventRef` | RPC first, archive fallback | ✅ | `event-source.ts:156-164` |
| `IndexerClient` | `new ({ baseUrl })` | ✅ | `chain/indexer.ts:61-148` |
| `eventRef`, `eventToJson`, `resolveEventRef` | — | ✅ | `events.ts:320-372`, `:334-353` |
| factory / admin helpers | — | ✅ | `chain/factory.ts`, `chain/admin.ts` |

`ChainClient.invoke` is the full write path: build → simulate → `rpc.assembleTransaction` → sign → send →
poll at 2 s × 60 attempts (`client.ts:148-187`). `confidentialBalance` returns
`{spendingKey, viewingPublicKey, spendableBalance, receivingBalance, auditorId}` or `null`
(`client.ts:59-66`, `:194-219`).

### A.5 state/ — balance reconstruction

| Export | Signature | Browser | file:line |
|:--|:--|:--:|:--|
| `StateEngine` | `new (cfg: StateEngineConfig)` | ✅ | `state/engine.ts:61-62` |
| `.sync` | `() => Promise<AccountState>` | ✅ | `engine.ts:124-140` |
| `.current` | `() => Promise<AccountState>` (no network) | ✅ | `engine.ts:143-145` |
| `.setSpendable` | `(next: Opening) => Promise<AccountState>` | ✅ | `engine.ts:152-157` |
| `.verifyAgainstChain` | `() => Promise<{ok, spendableOk, receivingOk}>` | ✅ | `engine.ts:164-171` |
| `.decryptIncoming` | `(rE, vTilde, sigma) => {vTx, rTx}` | ✅ | `engine.ts:65-70` |
| `.openSpendable` | `(bTilde, sigma) => Opening` | ✅ | `engine.ts:73-77` |
| `MemoryStore` | `StateStore` | ✅ | `state/store.ts:53-63` |
| `LocalStorageStore` | `new (prefix = "ctd:state:")` | ✅ | `state/browser-store.ts:12-29` |
| `JsonFileStore` | `new (path)` | ❌ `node:fs` | `state/json-store.ts:14-32` |
| `freshState`, `reviveState`, `cloneState`, `bigintReplacer` | — | ✅ | `state/types.ts:32-40`, `store.ts:21-50` |

`StateEngineConfig` (`engine.ts:40-59`) = `{ client, store, keys, address, fromLedger, indexer? }`.
`AccountState` (`state/types.ts:17-30`) = `{ address, spendable: Opening, receiving: Opening, registered,
cursor?, syncedLedger }`, where `Opening = { v: bigint; r: bigint }`.

`verifyAgainstChain` is what makes an **untrusted** archive safe: it re-commits the reconstructed `(v, r)`
and compares against the on-chain Pedersen points (`engine.ts:168-169`). Sombra should surface this as a
"verified against chain" badge — it is the entire trust argument for the Archive.

**The demo's reconstruction is incomplete relative to the spec.** `StateEngine.apply`
(`engine.ts:80-118`) handles only `register`, `deposit`, `merge`, `withdraw`, `transfer`. It ignores
`spender_transfer`, `set_spender`, and `revoke_spender` — all three of which the spec classifies as
recovery-relevant (§B.2). `LocalStorageStore` also stores spending secrets in plaintext and says a
production wallet should use IndexedDB with encryption at rest (`browser-store.ts:5-7`).

### A.6 disclosure/ and auditor/

`disclosure/` (`prove.ts`, `verify.ts`, `recipient.ts`, `types.ts`) implements off-chain selective
disclosure per `CT-CONTRACTS/docs/SELECTIVE_DISCLOSURE.md`; `auditor/decrypt.ts` implements auditor-side
event decryption per `DESIGN.md §8`. Both browser-safe. Out of scope for Sombra v1, but note
`disclosure/verify.ts` compares circuit VKs against pinned bytes shipped in the separate `@ctd/disclosure`
package (`CT-DEMO/packages/disclosure/package.json`) — that pinning is the trust anchor.

---

## B. CT event catalog — the Archive's ingestion contract

Canonical source is the Rust, not the demo SDK. Wire-format rules (soroban-sdk 27 `#[contractevent]`):

- `topics[0]` is a `Symbol` of the **snake_case struct name**, then the `#[topic]` fields in declaration
  order.
- Data is an **`ScMap` keyed by field-name symbols**, not a positional vec. Canonical XDR sorts map keys
  by symbol, so **wire order ≠ Rust declaration order — never decode positionally.** The demo decoder
  does it correctly, by name (`CT-DEMO/packages/sdk/src/chain/events.ts:395-408`).
- `Point` is `pub type Point = BytesN<64>`
  (`../stellar-contracts/packages/contract-utils/src/crypto/grumpkin.rs:49`) — flat `be(x)‖be(y)`,
  identity = 64 zero bytes. Scalars/ciphertexts are `BytesN<32>`, canonical BE in `[0, r)`. Public amounts
  are `i128`.
- Canonicality is enforced at the verifier boundary, panicking `NonCanonicalEncoding = 3514`
  (`storage.rs:1317-1337`). **A guarantee you can rely on:** every scalar in a successfully emitted event
  is the unique canonical representative, so byte-equality is a valid identity test.

### B.1 Token contract events

| # | Rust struct | On-chain name | Ordered topics | Data fields (Rust types) | Def / emit |
|:--|:--|:--|:--|:--|:--|
| 1 | `Register` | `register` | `("register", account: Address)` | `auditor_id: u32` | `mod.rs:609-615` / `storage.rs:460` |
| 2 | `Deposit` | `deposit` | `("deposit", from, to: Address)` | `amount: i128` | `mod.rs:624-632` / `storage.rs:514` |
| 3 | `Merge` | `merge` | `("merge", account: Address)` | **none** | `mod.rs:641-646` / `storage.rs:546` |
| 4 | `Withdraw` | `withdraw` | `("withdraw", from, to: Address)` | `amount: i128`, `r_e_point: BytesN<64>`, `sigma`, `b_tilde`, `b_tilde_aud_s` (`BytesN<32>`) | `mod.rs:654-666` / `storage.rs:633-642` |
| 5 | `Transfer` | `transfer` | `("transfer", from, to: Address)` | `r_e_point: BytesN<64>`, `v_tilde`, `sigma`, `b_tilde`, `v_tilde_aud_r`, `r_tilde_aud_r`, `v_tilde_aud_s`, `b_tilde_aud_s` | `mod.rs:693-708` / `storage.rs:717-729` |
| 6 | `SpenderTransfer` | `spender_transfer` | `("spender_transfer", spender, from, to)` | `r_e_point`, `v_tilde`, **`sigma_a`**, `v_tilde_aud_r`, `r_tilde_aud_r`, `v_tilde_aud_s`, **`a_tilde_aud_s`** | `mod.rs:741-757` / `storage.rs:829-841` |
| 7 | `SetSpender` | `set_spender` | `("set_spender", account, spender)` | `live_until_ledger: u32`, `r_e_point`, `sigma`, `b_tilde`, `v_tilde_aud_s`, `b_tilde_aud_s` | `mod.rs:790-803` / `storage.rs:935-945` |
| 8 | `RevokeSpender` | `revoke_spender` | `("revoke_spender", account, spender)` | `r_e_point`, `sigma`, `b_tilde`, `v_tilde_aud_s`, `b_tilde_aud_s` | `mod.rs:832-844` / `storage.rs:1019-1028` |
| 9 | `UnderlyingAssetSet` | `underlying_asset_set` | no topic fields | `underlying_asset: Address` | `mod.rs:872-876` / `storage.rs:1066` |
| 10 | `VerifierSet` | `verifier_set` | no topic fields | `verifier: Address` | `mod.rs:885-889` / `storage.rs:1100` |
| 11 | `AuditorSet` | `auditor_set` | no topic fields | `auditor: Address` | `mod.rs:898-902` / `storage.rs:1134` |
| 12 | `AddressAsFieldSet` | `address_as_field_set` | no topic fields | `address_as_field: BytesN<32>` | `mod.rs:911-915` / `storage.rs:1175` |

**Compliance module** (`CT-CONTRACTS/compliance/mod.rs`): `frozen` `("frozen", account)` no data
(`:333-343`); `unfrozen` (`:346-356`); `compliance_config_changed`, no topic fields, data
`policy: Option<Address>`, `sac_passthrough: bool` (`:359-369`). **No clawback event exists** — spec'd as
a follow-up (`docs/COMPLIANCE.md:261`).

**Separate contract IDs** — a token-scoped filter will not see these:

- Auditor registry (`CT-CONTRACTS/auditor/mod.rs`): `auditor_registered`
  `("auditor_registered", auditor_id: u32)`, data `point: BytesN<64>` (`:166-183`); `auditor_rotated`,
  data `old_point`, `new_point` (`:186-210`). `auditor_id` is a **non-Address topic**.
- Verifier (`CT-CONTRACTS/verifier/mod.rs`): `verification_key_registered`
  `(name, circuit_type: CircuitType)`, data `verification_key: Bytes` (`:269-291`);
  `verification_key_updated`, data `old_`/`new_verification_key` (`:294-322`). `CircuitType` is
  `#[repr(u32)]`: Register=0, Withdraw=1, Transfer=2, SpenderTransfer=3, SetSpender=4, RevokeSpender=5
  (`:96-106`, values are on-chain interface and MUST NOT change).

Full name list for a `types=` filter (19): `register`, `deposit`, `merge`, `withdraw`, `transfer`,
`spender_transfer`, `set_spender`, `revoke_spender`, `underlying_asset_set`, `verifier_set`,
`auditor_set`, `address_as_field_set`, `frozen`, `unfrozen`, `compliance_config_changed`,
`auditor_registered`, `auditor_rotated`, `verification_key_registered`, `verification_key_updated`.

> The demo SDK's `KNOWN` set (`CT-DEMO/packages/sdk/src/chain/events.ts:119-131`) is a **subset**: it omits
> `spender_transfer`, `set_spender`, `revoke_spender`, `compliance_config_changed` and all four config
> events, while adding four `user_*` events from a separate pluggable policy contract. **Trust the Rust.**

### B.2 Role in recovery — `INDEXER.md §3.2` (lines 43-58)

| Event | Role |
|:--|:--|
| `Register` | Start of history; bounds the worst-case replay window |
| `Deposit` | Receiving-side replay: `+= (amount, 0)` — deposits commit with **zero blinding**, `c_dep = amount·G` (`storage.rs:512`) |
| `Transfer` (recipient side) | Receiving-side replay: carries recipient-channel ciphertexts for `(v_transfer, r_transfer)` |
| `SpenderTransfer` (recipient side) | Receiving-side replay, as above |
| `Merge` | Folds receiving into spendable, resets receiving. **The `T_0` anchor.** |
| `Withdraw`, `Transfer` (sender side), `SetSpender`, `RevokeSpender` | **Checkpoints** — publish `(b_tilde, sigma)` for the owner's spendable balance |

A **self-transfer** (`from == to`) carries both roles and recovery must apply both (`INDEXER.md:56`,
`SDK.md:388`). `SpenderTransfer` is **never a checkpoint**: it carries no `b_tilde` and no `sigma`, and its
sender-channel field `a_tilde_aud_s` is an *allowance* ciphertext. Config events aren't needed for
recovery but indexers SHOULD archive them anyway (`INDEXER.md:58`).

### B.3 The recovery algorithm (normative, `CT-CONTRACTS/docs/DESIGN.md §5.2`)

1. Fetch `(b̃, σ)` from the most recent **checkpoint**. If none: `W_spend ← (0,0)`, `T_0 = Register`.
2. `v_s = b̃ − Poseidon(δ_enc_bal, vk, σ)`
3. `r_s = Poseidon(δ_spend_r, vk, σ)`
4. `W_spend ← (v_s, r_s)`
5. `T_0` = most recent `Merge` **at or before that checkpoint**, else `Register`. `W_receive ← (0,0)`.
6. Replay every event after `T_0` in canonical order: incoming transfer → ECDH-decrypt and accumulate;
   deposit → `+= (a, 0)`; merge → fold and reset; checkpoint → skip the spendable side.
7. **Verify:** `C_spend =? W_spend.v·G + W_spend.r·H`, likewise `C_receive`.

Steps 2-4 map to `StateEngine.openSpendable` (`engine.ts:73-77`); step 6's transfer rule to
`decryptIncoming` (`:65-70`); step 7 to `verifyAgainstChain` (`:164-171`).

> **`T_0` is the last `Merge` at or before the checkpoint — not the last merge overall.** `INDEXER.md:21`
> is explicit: a merge *after* the checkpoint reconstructs the receiving opening correctly but leaves the
> spendable opening **short by the amount that merge folded in**. This is the single easiest way to build a
> silently-wrong Archive, and it fails closed only because of step 7.

### B.4 Normative obligations on Sombra Archive (`INDEXER.md`, RFC-2119)

| Line | Requirement |
|:--|:--|
| `:7` | Indexer operators **MUST** satisfy §3–§5 for the deployment to support recovery from seed |
| `:14` | "Without a conforming indexer, **recovery from seed is not guaranteed**, and deployments MUST treat wallet-local state as unrecoverable after the RPC window" |
| `:22` | The same event **MUST** carry the same id whether served from archive or RPC |
| `:29` | For every in-scope event the indexer **MUST** persist the 7-field record (`:31-39`) |
| `:41` | A decoded representation **MAY** be served, but **MUST** reproduce the on-chain event exactly under that decoder |
| `:62` | Attribution **MUST** come from event topics, **never** from the transaction source account |
| `:68` | **MUST** preserve and expose the total order `(ledger_seq, tx_application_order, event_index)` |
| `:73` | Ingested-through ledger **MUST** stay within the source's retention window; unfillable gaps **MUST** be reported incomplete |
| `:74` | Ingestion **MUST** be at-least-once, deduplicated by event id |
| `:75` | **MUST** track contiguous ingested ranges; **MUST NOT** silently serve affected histories as complete |
| `:76` | Events **MUST** be stored faithfully — verbatim XDR or a decoded form pinned to the canonical decoder |
| `:80` | **MUST** retain full per-account history of every in-scope event **indefinitely**. "No pruning horizon is safe in general." |
| `:91` | **C3** — every response **MUST** state whether the served range is complete |
| `:109` | `types` filter **MUST** be applied after attribution, never by dropping events from storage |
| `:117` | Wallets **SHOULD** support multiple independent archive endpoints; deployments **SHOULD** run ≥2 |

**No reorg handling** (`INDEXER.md:72`): "Stellar ledgers are final at close; there is no reorg handling."
What replaces it is contiguous-gap bookkeeping. **Persist `tx_application_order` as its own column** — it
is not derivable from `tx_hash` and it is the middle component of the only correct sort key. Getting it
wrong silently corrupts every replayed opening whenever a merge and a deposit share a ledger.

### B.5 The two incompatible indexer HTTP shapes

The single most actionable finding for `archive/`.

**Shape 1 — the normative spec** (`INDEXER.md:96-107`), versioned under `/v1/`:

```text
GET /v1/health
  -> { latest_ledger, ingested_through, lag_seconds }
GET /v1/tokens/{contract_id}/accounts/{account}/checkpoint?at_ledger={n}
  -> { event: { ledger_seq, tx_hash, event_index, topics_xdr, data_xdr }, complete }
GET /v1/tokens/{contract_id}/accounts/{account}/events
      ?from_ledger&to_ledger&types&cursor&limit
  -> { events: [ …§3.1 records… ], cursor, complete }
```

Plus the optional per-contract stream `GET /v1/tokens/{contract_id}/events` (`:109`). C2 and C4 are
normative; C1 (`/checkpoint`) is RECOMMENDED and MAY be omitted.

**Shape 2 — what `@ctd/sdk`'s `IndexerClient` actually calls** (Goldsky-backed Cloudflare Worker):

```text
GET {baseUrl}/health
  -> { latest_synced_ledger }                                    indexer.ts:74-78
GET {baseUrl}/contracts/{contractId}/events?startLedger&endLedger&cursor&limit
  -> { latestLedger, cursor, events: [{id, ledger, txHash, topic, value}] }
                                                                 indexer.ts:87-122
```

Reference implementation: `CT-DEMO/packages/indexer/handler/src/routes/health.ts:12-18` and
`routes/events.ts:23-65`; response types `handler/src/types.ts:29-46`.

**They share no path, no param name, and no response field name.** Sombra Archive should serve **both**:
`/v1/*` to be conformant with the published spec (the differentiator we claim), and the demo's flat
`/health` + `/contracts/:id/events` so an unmodified `@ctd/sdk` `IndexerClient` works against it as a
drop-in. The demo shape is a strict pass-through of raw `topic`/`value` JSON with all decoding in the SDK,
which conveniently satisfies `INDEXER.md:41`.

The spec is **internally inconsistent**: §3.1 names the fields `topics`/`data` (`:39`) while the §6 sketch
uses `topics_xdr`/`data_xdr` (`:101`). Status codes, error bodies, auth, rate limits, and cursor format are
**entirely unspecified** — Sombra chooses. One behavioral constraint: a range the archive cannot cover must
be answerable with `complete: false`, not an error, because the client's seam logic reads that flag.

### B.6 The hybrid seam (what the Archive must not break)

`hybridFetchEvents` (`CT-DEMO/packages/sdk/src/chain/event-source.ts:82-142`) splits by ledger range:
archive owns `[next, seam-1]`, RPC owns `[seam, head]`, where `seam = rpcOldestLedger + RPC_SEAM_MARGIN`
and `RPC_SEAM_MARGIN = 60` (`event-source.ts:48`). The margin exists because the RPC's retention floor
advances *while the backfill runs* (`:41-47`); `CT-CONTRACTS/docs/SDK.md:508` makes it a MUST.

**A configured archive's failure MUST fail the whole sync** (`SDK.md:510`, implemented deliberately
without a try/catch at `event-source.ts:105-123`, rationale `:19-26`). Degrading silently to RPC-only
would persist a cursor derived from the RPC leg alone, permanently committing every future sync to a warm
path that never consults the archive — turning one transient 500 into unrecoverable data loss.
**Sombra Archive's availability is load-bearing for correctness, not just UX.**

### B.7 On-chain state a wallet tracks

`confidential_balance(account) -> ConfidentialAccount` (`mod.rs:511-513` → `storage.rs:310-316`), panics
`AccountNotRegistered = 3501` if absent, and **extends the entry TTL on read** (`storage.rs:1260-1276`):

```rust
pub struct ConfidentialAccount {          // storage.rs:51-64
    pub spending_public_key: Point,       // BytesN<64>  Y   = sk·H
    pub viewing_public_key:  Point,       // BytesN<64>  PVK = vk·H
    pub spendable_commitment: Point,      // BytesN<64>  C_spend
    pub receiving_commitment: Point,      // BytesN<64>  C_receive
    pub auditor_id: u32,
}
```

Spendable is **overwritten** (`storage.rs:1192-1196`); receiving is **homomorphically added to**
(`:1211-1215`) and reset to identity only by `merge` (`:539-547`). Both start as identity at registration
(`storage.rs:455-456`).

**There is no bounded pending list and no merge-forcing cap.** The receiving side is a single aggregated
Grumpkin point that grows without bound. Merging is pure client policy under two pressures: received funds
aren't spendable until merged, and merging bounds the replay window (`SDK.md:436-440`). There is **no
nonce, counter, or rollover** — freshness comes from the per-operation salt `σ` (fresh per *attempt*,
including retries — `SDK.md:396-402`) and from binding the proof to the current `C_spend`.

Two consequences for the Archive:

- **Inbound-transfer spam is an unbounded storage attack.** `SDK.md:538`: per-account event volume is
  linear in inbound transfers and "unbounded by design, since incoming-transfer spam is rate-limited only
  by transaction fees." An adversary grows any account's replay window arbitrarily for the cost of fees.
  Sombra Archive is the component that absorbs it.
- **The unspendable-blinding case** (`SDK.md:428-434`): a post-merge blinding can land outside the range a
  Noir `Field` encodes — no constructible proof, while on-chain state stays well-formed and
  `verifyAgainstChain` still passes. Must be surfaced as its own named state; it resolves only at the next
  merge folding in an inbound *confidential transfer* (deposits alone don't fix it).

### B.8 CT circuits

Noir workspace at `CT-CONTRACTS/circuits/`, built by `nargo`, outside the Cargo workspace. Six operation
circuits get VKs (`register`, `withdraw`, `transfer`, `set_spender`, `spender_transfer`,
`revoke_spender`); the seven `gadgets/*` packages are measurement-only. VKs in `circuits/vks/` are
**7,729 bytes each** (112 hex `Fr` fields; `--output_format fields` for macOS↔Linux reproducibility).

ACIR opcode counts (`circuits/constraints.baseline`): register 33, withdraw 94, transfer 133,
spender_transfer 135, set_spender 131, revoke_spender 123. Public inputs: withdraw 15, transfer 24,
spender_transfer 24, set_spender 24, revoke_spender 19.

Documented proving cost: **single-digit seconds on contemporary hardware**, an explicit obligation to
treat as user-visible (`docs/OVERVIEW.md:166`, `docs/SDK.md:534`). Cost driver is EC scalar
multiplications — transfer 8, register 2 (`OVERVIEW.md:166`).

`circuits/lib/testdata/` holds **17 JSON conformance fixtures** pinning one primitive each. `SDK.md:268-270`:
an implementation MUST reproduce every output byte-for-byte and its test suite MUST **read** the files
rather than transcribe them. Wiring these into `kit/`'s CI is the cheapest possible guard against a
Poseidon2/Grumpkin drift that would otherwise surface as silently unspendable funds.

> ⚠️ **CT is explicitly not production-ready.** `mod.rs:12-19` and `verifier/mod.rs` carry load-bearing
> warnings that the UltraHonk backend is unfinished and unaudited; `circuits/vks/README.md` calls the
> proving recipe "provisional… including the zero-knowledge setting."

---

## C. SPP SDK surface — `stellar-private-payments` (Rust → WASM)

Crate `stellar-private-payments-sdk-web` (`SPP/sdk/web/Cargo.toml:2`), `crate-type = ["cdylib","rlib"]`.
Published to npm as **`stellar-private-payments@0.1.0-alpha.1`**, Apache-2.0, with
`publishConfig: { access: "public", tag: "alpha" }` (`SPP/sdk/web/package.json`) — unlike `@ctd/sdk`,
this one is *designed* to be installed.

Package exports (`package.json:18-33`): `.` → `js/index.js`, `./wasm` → the raw bindgen module,
`./freighter` → `js/freighter.js`, `./circuits/*` → `dist/circuits/*`, `./workers/*` → `dist/workers/*`.
Peer dep `@stellar/freighter-api ^6.0.1` (optional).

**Three separate WASM modules** are produced: the main library plus two Web Worker binaries,
`storage-worker` and `prover-worker` (`Cargo.toml:14-20`, built at `scripts/build.sh:199-201`).

> **The deployment config is compiled into the WASM.** `sdk/web/src/lib.rs:20`:
> `include_str!("../../../deployments/testnet/deployments.json")`, parsed once into a leaked
> `&'static ContractConfig` (`src/deployment.rs:4-18`). **There is no runtime config injection** — pointing
> the SDK at different pools or verifiers requires rebuilding the Rust WASM with the full toolchain
> (§F). This is the single biggest constraint on how Sombra consumes SPP, and it is why §D.1's verdict
> matters so much.

### C.1 Object model

`Storage.open()` → `Client.new()` → `client.account(options, signer)` → `account.pool({poolContract})`.

**Init / telemetry** (all `sdk/web/src/lib.rs`):

| JS name | Signature | Async | file:line |
|:--|:--|:--:|:--|
| `configureTelemetry(config)` | `(JsValue) -> Result<(), JsValue>` | no | `lib.rs:52-53` |
| `set_log_level(level)` | `(&str) -> Result<(), JsValue>` | no | `lib.rs:104-105` |
| `debugLogsEnabled()` | `() -> bool` | no | `lib.rs:116-117` |
| `dump_recent_logs()` | `() -> String` | **yes** | `lib.rs:123-124` |
| `bootnodeRequired(rpcUrl, storage)` | `(String, &WasmStorage) -> Result<bool, JsError>` | **yes** | `bootnode.rs:12-13` |

**Storage** (`sdk/web/src/storage.rs`) — default worker URL `./workers/storage-worker.js` (`:15`), call
timeout 5 s (`:16`), open-ping timeout 15 s because cold WASM compile + OPFS/SQLite init is slow (`:17-18`):

| JS name | Signature | Async | file:line |
|:--|:--|:--:|:--|
| `Storage.open(options)` | `(JsValue) -> Result<Storage, JsError>`, options `{workerUrl?}` | **yes** | `storage.rs:74-75` |
| `storage.fork()` | `() -> Storage` — extra handle to the same worker/`spp.db` | no | `storage.rs:90` |
| `storage.call(request, timeoutMs?)` | raw worker RPC, externally-tagged enums | **yes** | `storage.rs:99-104` |

The worker protocol is `StorageWorkerRequest` (`src/protocol.rs:62-119`, **25 variants**) /
`StorageWorkerResponse` (`:123-142`). Variants relevant to a wallet or indexer: `SyncState`,
`SaveEvents(ContractsEventData)`, `SaveSyncProgress{metadata, fully_indexed}`, `ClearIndexingCursors`,
`UserKeys(addr)`, `AspSecret(addr)`, `UserNotes(addr, u32)`, `PortfolioBalances(addr)`,
`UnspentUserNotes{...}`, `PoolUserNotes{...}`, `RecipientLookup{...}`, `OperationalFeed{...}`,
`RecordOperation{...}`, `ListOperations{...}`, `GetSetting`/`SetSetting`.

**Client** (`sdk/web/src/client/mod.rs:65-71`):

| JS name | Signature | Async | file:line |
|:--|:--|:--:|:--|
| `Client.new(rpcUrl, storage, proverWorkerUrl, bootnodeUrl?)` | → `Client` | **yes** | `client/mod.rs:89-95` |
| `Client.contractConfig()` *(static)* | `() -> JsValue` | no | `client/mod.rs:157-158` |
| `client.backgroundSync()` | `() -> Result<(), JsError>` | **yes** | `client/mod.rs:167-168` |
| `client.stopBackgroundSync()` | `()` | no | `client/mod.rs:189-190` |
| `client.account(options, signer)` | → `Account` | **yes** | `client/mod.rs:198` |
| `client.sync()` | `() -> Result<(), JsError>` | **yes** | `client/mod.rs:223-224` |
| `client.operationalFeed(limit)` | → `JsValue` | **yes** | `client/mod.rs:230-231` |
| `client.recipientLookup(address)` | → `JsValue` | **yes** | `client/mod.rs:237-238` |
| `client.aspState()` | → `JsValue` | **yes** | `client/mod.rs:248-249` |
| `client.allContractsData()` | → `JsValue` | **yes** | `client/mod.rs:259-260` |
| `client.verifySelectiveDisclosure(receiptJson, expectedVkHash)` | → `JsValue` | **yes** | `client/mod.rs:270-271` |
| `deriveAspUserLeaf(notePkHex, membershipBlinding)` | → `String` | no | `client/mod.rs:297-301` |
| `verifySelectiveDisclosure(rpcUrl, receiptJson, vkHash, options)` | walletless verify | **yes** | `client/mod.rs:314-320` |

`proverWorkerUrl` is **required and non-empty** (`client/mod.rs:112-116`). `AccountOptions` is
`{ networkPassphrase: String, userAddress: Option<String> }` (`client/mod.rs:73-78`); when `userAddress`
is absent the SDK calls `signer.getPublicKey()` (`:427-466`). If no keys exist in storage, `account()`
asks the signer to sign `KEY_DERIVATION_MESSAGE` and derives + saves keys (`:207-213`).

`backgroundSync` is **not recoverable in place**: after a fatal indexer exit the stop-slot stays set and
you must construct a new `Client` (`client/mod.rs:162-166`).

**Account** (`sdk/web/src/client/account.rs:39-42`): `userAddress` getter (`:52-53`), `portfolio()`
(`:58`), `userPublicKeys()` → `{notePublicKey, encryptionPublicKey}` (`:64-65`), `userNotes(limit)`
(`:74-75`), `aspSecret()` (`:81-82`), `deriveAspUserLeaf()` (`:91-92`), `isRegistered()` (`:98-99`),
`registerPublicKeys(options?)` → tx hash (`:104-105`, options both-or-neither `:121-125`),
`pool({poolContract})` → `PrivatePool` (`:137`).

**PrivatePool** (`sdk/web/src/client/pool.rs:18-22`). **All amounts are stroops as JS `bigint` (`u128`).**

| JS name | Signature | Async | file:line |
|:--|:--|:--:|:--|
| `pool.balance()` | `() -> u128` | **yes** | `pool.rs:43` |
| `pool.notes()` | `() -> JsValue` | **yes** | `pool.rs:49` |
| `pool.estimate(amount)` | `(u128) -> JsValue` | **yes** | `pool.rs:56` |
| `pool.deposit(amount)` | **shield** | **yes** | `pool.rs:66` |
| `pool.transferToKeys(notePkHex, encPkHex, amount)` | private send by keys | **yes** | `pool.rs:78-84` |
| `pool.transfer(recipient, amount)` | private send by `G…` address (registry lookup) | **yes** | `pool.rs:104` |
| `pool.withdraw(amount, recipient?)` | **unshield**, defaults to connected wallet | **yes** | `pool.rs:118-124` |
| `pool.transact(config)` | raw 2-in/2-out join-split | **yes** | `pool.rs:137` |
| `pool.disclose(config)` | returns `null` when ASP registration required | **yes** | `pool.rs:151-156` |
| `pool.verifyDisclosure(receipt, expectedVkHash)` | — | **yes** | `pool.rs:163-168` |

`TransactConfig` (`sdk/web/src/client/transact.rs:12-25`, validated `:30-47`):

```ts
{ extRecipient: string, extAmount: bigint,      // i128, SIGNED
  inputNoteIds: string[],                       // 0..=2 commitment hex
  outputAmounts: bigint[],                      // exactly 2
  outRecipientNoteKeysHex: (string|null)[],     // exactly 2
  outRecipientEncKeysHex:  (string|null)[] }    // exactly 2
```

### C.2 Execution result shape

Every `deposit`/`transfer`/`withdraw`/`transact` goes through `PrivatePool::execute_plan`
(`sdk/web/src/client/execute/mod.rs:108-115`) and resolves to a **tagged union on `status`**
(`execute/mod.rs:29-45`):

- `{ status: "ok", hashes: string[] }`
- `{ status: "failed", hashes: string[], message: string, code?: -4 }` — `code: -4` is SEP-0043 wallet
  user-rejection (`execute/mod.rs:96-105`)
- `{ status: "aspNotReady" }`

The per-tx loop is prove → simulate → sign → submit → confirm (`execute/mod.rs:126-210`) and it **retries
proving** while the ASP membership tree lags, up to `SYNC_MAX_RETRIES = 50` polls at
`POLL_INTERVAL_MS = 200` ms (`execute/mod.rs:17-18`, `:147-167`).

Progress is a DOM `CustomEvent` on `window`, name `"stellar-private-payments:tx-progress"`
(`client/execute/progress.rs:8`), detail `{flow, stage, message, current?, total?}` (`:10-20`).
Stages: `prove`, `sync_wait`, `simulate`, `sign`, `submit`. Flows: `deposit`, `transfer`, `withdraw`,
`transact`, `disclose`. **This is the only progress channel** — Sombra's UI must listen on `window`, and
it is silently dropped when `web_sys::window()` is absent (`progress.rs:29-31`).

### C.3 JS entry points

`sdk/web/js/index.js` (137 lines) wraps the raw bindgen classes into plain objects (`wrapClient` `:63-93`,
`wrapAccount` `:47-61`) and resolves worker URLs from `import.meta.url` (`:14-15`). Exports:
`Storage` (`:130`, only `.open`), `Client` (`:131-134`, `.new` + static `.contractConfig`), plus
`PrivatePool`, `bootnodeRequired`, `deriveAspUserLeaf`, `verifySelectiveDisclosure` (`:135`), the
telemetry four (`:136`), and the WASM `init()` as default (`:137`). `newClient(options)` takes
`{rpcUrl, storage?, storageWorkerUrl?, proverWorkerUrl?, bootnodeUrl?}` and auto-opens storage when
omitted (`:102-117`).

### C.4 Supporting Rust crates

- **`sdk/client`** — the native SDK the web crate wraps. `Client → Account → PrivatePool`
  (`sdk/client/src/lib.rs:3`). Beyond the high-level ops it exposes the **step-wise plan API the web layer
  drives**: `prepare_deposit/transfer/withdraw/transact` (`pool.rs:268-293`), `prove_next` (`:297`),
  `simulate` (`:244`), `sign` (`:317`), `submit` (`:304`), `confirm` (`:313`). Sync modes `Inline` (CLI)
  vs `Background` (web) at `sync.rs:29`.
- **`sdk/tx-planner`** — coin selection + multi-tx planning. Every on-chain tx is **2-in/2-out**, so
  spending *k* notes generally needs *k−1* transactions. `find_combination`
  (`src/plan/combination.rs`) tries six tiers; `TRANSACTION_LIMIT = 10` notes. Public API at
  `sdk/tx-planner/README.md:43-49`. **This is why a single user-facing "send" can produce several Freighter
  prompts.**
- **`sdk/state`** — local SQLite wallet state + event processing. Exports `Storage`, `process_events`,
  `process_notes`, `AccountKeys`, `DeriveNoteFn` (`src/lib.rs:1-10`). `events_parsers.rs` is the
  **canonical event decoder**; `storage.rs` owns `save_events_batch` (`:85`),
  `scan_commitments_for_user_notes` (`:1224`), `reconcile_nullifiers` (`:1427`).
- **`sdk/prover`** — `no_std` crypto + Groth16 proving. `crypto.rs` holds the domain-separated Poseidon2
  primitives: `compute_commitment` (dom `0x01`, `:100`), `compute_nullifier` (dom `0x02`, `:127`),
  `derive_public_key` (dom `0x03`, `:91`), `compute_signature` (dom `0x04`, `:111`),
  `asp_membership_leaf` (`:154`). `notes.rs:31` is the single note-discovery function.
- **`sdk/stellar`** — Soroban RPC + tx assembly. Exports `Client` (`rpc.rs`), **`Indexer` +
  `ContractDataStorage`** (`indexer.rs`), `StateFetcher`/`PreparedSorobanTx`/`OnchainProofPublicInputs`
  (`contract_state.rs`), `hash_ext_data_offchain`, `auth_sign_steps`/`unsigned_tx_for_signing`,
  `submit_tx`/`confirm_tx`, and `parse_event_metadata`/`ParsedContractEvent` (`conversions.rs:186-262`).
- **`sdk/types`** — shared serde types. `SMT_DEPTH = 10` (`lib.rs:22`); `ContractConfig`/`PoolConfigEntry`
  mirror `deployments.json` (`lib.rs:25-65`), and **`PoolConfigEntry.deployment_ledger` (`lib.rs:52`) is
  the indexer's cold-start anchor**.
- **`sdk/witness`** — Circom witness calculator over compiled `.wasm` + `.r1cs`
  (`WitnessCalculator::new` `lib.rs:44`, `compute_witness` `:98`).
- **`sdk/disclosure`** — selective-disclosure receipt format, the `SELECTIVE_DISCLOSURE_1..4` registry
  (`lib.rs:287-343`), prove/verify (`:408`, `:514`).

---

## D. SPP pool events + testnet deployments

### D.1 Testnet deployments — **live, enabled, reusable. Verdict: do not redeploy.**

`SPP/deployments/testnet/deployments.json`, complete:

| Key | Value |
|:--|:--|
| `network` | `testnet` |
| `deployer` / `admin` | `GCBU2YCJGVLRSPPFK3ADYNUEH2W6ZFNNJLX6IHCEZT54VOHZZNYNHXDG` |
| `asp_membership` | `CD3IV5JWN5Y2LDGDTY24PPZFCPD62QGJTCCSFEQNAHCOO3E7IAEQPXCF` |
| `asp_non_membership` | `CAUJSKPEK6EOEULYMBZ7FNLAPSJUKDLAMVKF2KHTDDA7XNUQZVXXSLZ4` |
| `verifiers.B` | `CASGLGABQHO6E5NOOGBFUBSO6YMKDCBIZEZOEJPPVWHBRHBYECRMBZNU` |
| `verifiers.AB` | `CDM776JJSW2PANFVDP3P2JL75L7MAHBTHGXPIQ3HWFRFYMCZFSTIEDUN` |
| `public_key_registry` | `CDMGLGZV2S4HW4WKW7ZAYICT73V57QNCVJ5K6A22DVPPJHIQPHFLSGRL` |

Two pools, both `enabled: true`:

| Pool contract | Token contract | Deploy ledger | Policy flags | Asset |
|:--|:--|--:|:--|:--|
| `CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | 3899359 | `blocklist` | native (XLM) |
| `CCBOHPJ2TM24EZ4BJGT5ZHQD4F5N47J6WMJHSBXUA25NZMKPZOXD7XL2` | `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ` | 3899361 | `allowlist`,`blocklist` | classic EURC, issuer `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` |

> **The native SPP pool's token contract `CDLZFC3S…CYSC` is byte-identical to the CT demo's `underlying`**
> (`CT-DEMO/packages/app/lib/deployment.ts:82`, `:90` where it is named `XLM_SAC`). Both stacks sit on the
> **same XLM Stellar Asset Contract** on testnet. That is the structural fact that makes a single Sombra
> balance view — and the shielded-swap demo — coherent rather than two unrelated wallets bolted together.

**Why "do not redeploy" is the right call.** The SPP verifier contracts have their **verification key
baked in at compile time** (`contracts/circom-groth16-verifier/src/lib.rs:3-9`), and the SDK's pool config
is compiled into the WASM (`sdk/web/src/lib.rs:20`). Redeploying means rebuilding both the contracts and
the WASM SDK with the exact pinned toolchain (§F) — days of work with no benefit, since the published
pools are enabled and the SDK already targets them. **Use the shipped npm package against these
addresses.** The corollary is that Sombra cannot point SPP at its own pools without a full Rust rebuild,
so plan around the published testnet deployment.

CT testnet, for reference (`CT-DEMO/packages/app/lib/deployment.ts:68-87`): token
`CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F`, verifier
`CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL`, auditor
`CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L`, factory
`CDX4DBNWDMD7BVZCOJPTXVTBRXU2RG7JUOZKOOUX5RVWWWWIGV2LWS6Z`, underlying = the same XLM SAC,
`deployedAtLedger: 3013364`, `auditorId: 0`. Note `deployment.ts:77` publishes the **auditor's Grumpkin
secret key** in plaintext — deliberate, so anyone can play the auditor persona, flagged demo-only at
`:15-18`. Sombra must not treat that key as a secret or reuse the pattern.

### D.2 SPP proving keys — 34 MB, and mostly compiled into the WASM

`SPP/deployments/testnet/circuit_keys/` totals **34 MB**. Unlike CT's UltraHonk (no per-circuit setup),
SPP is Groth16 and ships **per-circuit binary proving keys**:

| File | Size |
|:--|--:|
| `policy_tx_2_2_AB_proving_key.bin` | 8.13 MB |
| `policy_tx_2_2_B_proving_key.bin` | 5.55 MB |
| `selectiveDisclosure_4_proving_key.bin` | 5.35 MB |
| `policy_tx_2_2_A_proving_key.bin` | 5.01 MB |
| `selectiveDisclosure_3_proving_key.bin` | 4.27 MB |
| `policy_tx_2_2_proving_key.bin` | 2.96 MB |
| `selectiveDisclosure_2_proving_key.bin` | 2.67 MB |
| `selectiveDisclosure_1_proving_key.bin` | 1.34 MB |

VKs are small: `*_vk.json` 2.7–5.1 KB, `*_vk_soroban.bin` 836 B–1.6 KB, plus `*_vk_const.rs` (4.2–7.8 KB)
for compile-time embedding in the verifier contracts.

**Loading is split, and this is the subtle part:**

- **Transact (policy) proving keys are BUNDLED, not fetched.** `sdk/web/build.rs:164-167` `include_bytes!`s
  each `<stem>_proving_key.bin` into the binary, exposed as `bundled_policy_proving_key(stem)`. The prover
  worker reads them from memory and `sdk/web/src/workers/prover.rs:334-337` explicitly notes they are
  "never fetched over the network". With four stems (`policy_tx_2_2`, `_A`, `_B`, `_AB`) at 1.3–8.1 MB
  each, **the prover-worker WASM is multi-megabyte before compression**, mitigated only by `wasm-opt -Os`
  (`build.sh:203-216`).
- **Everything else is fetched over HTTP**: per-stem `<stem>.wasm` and `<stem>.r1cs`
  (`prover.rs:303-304`), and the `selectiveDisclosure_N` proving keys (`prover.rs:170`, `:237-239`).
- **URL resolution** (`sdk/web/src/circuits.rs:55-85`): if
  `globalThis.__STELLAR_PRIVATE_PAYMENTS_CIRCUITS_BASE__` is a non-empty string, `${base}${filename}` —
  and the generated prover-worker loader sets it to `new URL('../circuits/', import.meta.url).href`
  (`build.sh:225-227`), i.e. the npm package's `dist/circuits/`. Otherwise
  `${location.origin}/circuits/${filename}`. Fetches are `GET` with `mode: cors` (`circuits.rs:154-156`).
- **Two-layer Cache API caching**, cache name `"stellar-circuits-v1"` (`circuits.rs:12`): compressed
  artifacts (`:130-194`, SHA-256 + length verified against build-time constants, evict-and-refetch once on
  mismatch `:196-213`), and **uncompressed proving keys** keyed by the compressed hash
  (`get_or_derive_uncompressed`, `:252-330`) so warm loads skip BN254 point decompression. All cache
  failures degrade gracefully to the slow path.

**Practical consequence for Sombra:** first load of the SPP prover is a multi-MB download regardless of
which pool the user picks, and both testnet pools carry policy flags (`blocklist` and
`allowlist,blocklist`) that put the larger `_B` (5.55 MB) and `_AB` (8.13 MB) circuits in play. Budget for
a visible one-time "preparing the private payments engine" step, and lazy-load the SPP module so it never
blocks the CT flows.

### D.3 Pool contract entry points

`SPP/contracts/pool/src/pool.rs` (842 lines), `#[contractimpl] impl PoolContract` starts `:222`:

| # | Signature | Line |
|:--|:--|:--|
| 1 | `__constructor(env, admin: Address, token: Address, verifier: Address, asp_membership: Address, asp_non_membership: Address, maximum_deposit_amount: U256, levels: u32, policy_flags: u32) -> Result<(), Error>` | `:246-256` |
| 2 | **`transact(env: &Env, proof: Proof, ext_data: ExtData, sender: Address) -> Result<(), Error>`** | `:513-518` |
| 3 | `get_policy_flags(env) -> Result<u32, Error>` | `:690` |
| 4 | `get_root(env) -> Result<U256, Error>` | `:702` |
| 5 | `is_known_root(env, root: &U256) -> Result<bool, Error>` | `:712` |
| 6 | `is_spent(env, n: &U256) -> Result<bool, Error>` | `:728` |
| 7 | `update_admin(env, new_admin: Address) -> Result<(), Error>` | `:742` |
| 8 | `update_asp_membership(env, new: Address) -> Result<(), Error>` | `:777` |
| 9 | `update_asp_non_membership(env, new: Address) -> Result<(), Error>` | `:795-798` |
| 10 | `get_asp_membership_root(env) -> Result<U256, Error>` | `:819` |
| 11 | `get_asp_non_membership_root(env) -> Result<U256, Error>` | `:837` |

**`transact` is the only state-changing user-facing entry point** — shield, private transfer, and unshield
are all the same call with different `ext_amount` signs.

`Proof` (`#[contracttype]`, `pool.rs:82-102`): `proof: Groth16Proof` (`contracts/types/src/lib.rs:42-49`,
256 bytes), `root: U256`, `input_nullifiers: Vec<U256>`, `output_commitment0: U256`,
`output_commitment1: U256`, `public_amount: U256`, `ext_data_hash: BytesN<32>`,
`asp_membership_root: U256`, `asp_non_membership_root: U256`.

`ExtData` (`pool.rs:109-120`): `recipient: Address`, **`ext_amount: I256` — signed: `>0` deposit, `<0`
withdraw, `0` pure transfer**, `encrypted_output0: Bytes`, `encrypted_output1: Bytes`.

Errors (`pool.rs:29-61`, `#[repr(u32)]` 1..=14): `NotAuthorized=1`, `MerkleTreeFull=2`,
`AlreadyInitialized=3`, `WrongLevels=4`, `NextIndexNotEven=5`, `WrongExtAmount=6`, `InvalidProof=7`,
`UnknownRoot=8`, `AlreadySpentNullifier=9`, `WrongExtHash=10`, `NotInitialized=11`, `Overflow=12`,
`NonCanonicalPublicInput=13`, `InvalidPolicyFlags=14`.

**`transact` flow.** Phase A (`pool.rs:513-537`): `sender.require_auth()` (`:519`); if `ext_amount > 0`,
check against `MaximumDepositAmount` (`:525-530`) and `token_client.transfer(sender → pool)` — **funds move
in before verification** (`:533`); delegate to `internal_transact` (`:536`).

Phase B, `internal_transact` (`pool.rs:561-646`):

1. **Known root** — else `UnknownRoot` (`:563-565`). Ring buffer of `ROOT_HISTORY_SIZE = 90` roots
   (`merkle_with_history.rs:18`); root `0` never valid (`:210-213`).
2. **Nullifier freshness** — every `input_nullifiers` unspent, else `AlreadySpentNullifier` (`:566-571`).
3. **ExtData binding** — recompute `hash_ext_data` = `keccak256(XDR(ExtData)) mod bn254_modulus`
   (`pool.rs:135-143`), compare to `proof.ext_data_hash`, else `WrongExtHash` (`:572-576`).
4. **Public amount** — recompute `calculate_public_amount` (positive → value; negative →
   `FIELD_SIZE − |v|`; `|v| < 2^248`), else `WrongExtAmount` (`:578-583`, helper `:325-345`).
5. **ASP root freshness** — cross-contract call: `BLOCKLIST_BIT` → `get_asp_non_membership_root()` must
   match; `ALLOWLIST_BIT` → `get_asp_membership_root()` must match; else `InvalidProof` (`:585-598`).
6. **Groth16 verification** (`:600-603`, impl `:410-461`) — range-checks every `U256` public input against
   the BN254 modulus → `NonCanonicalPublicInput` (`:418`, `:377-398`), then builds the public-input vector
   **in exactly this order** (`:423-456`):
   `[root, public_amount, ext_data_hash, ...input_nullifiers, output_commitment0, output_commitment1,
   (asp_membership_root × n_nullifiers if ALLOWLIST), (asp_non_membership_root × n_nullifiers if BLOCKLIST)]`
   then calls `CircomGroth16VerifierClient::verify` (`:458`).
7. **Mark spent + emit** — per nullifier, write the presence key and publish `NewNullifierEvent`
   (`:606-609`).
8. **Withdrawal** — if `ext_amount < 0`, `token_client.transfer(pool → ext_data.recipient)` (`:617-621`).
9. **Insert leaves** — `insert_two_leaves(commitment0, commitment1)` → `(idx_0, idx_1)` (`:623-628`).
   Requires `next_index` even, enforces capacity `2^levels`, Poseidon2-hashes the pair and walks up
   (`merkle_with_history.rs:137-183`).
10. **Emit commitments** — two `NewCommitmentEvent`s, output0 then output1, each with its leaf index and
    the matching `encrypted_outputN` (`:630-643`).

**Ordering consequence for the Archive:** within one `transact`, **all nullifier events precede both
commitment events**, and commitment `index` values are always `(even, even+1)`.

Other contracts: `contracts/types/` (shared Groth16 primitives);
`contracts/circom-groth16-verifier/` (**VK baked in at compile time**, `src/lib.rs:3-9`, one deployed
instance per policy variant); `contracts/public-key-registry/` (Address → `{encryption_key X25519 32B,
note_key BN254 32B}`, not required to transact); `contracts/asp-membership/` (allowlist, append-only
Poseidon2 merkle tree); `contracts/asp-non-membership/` (blocklist, Poseidon2 sparse merkle tree,
insert/delete); `contracts/soroban-utils/` (`poseidon2_compress`, `get_zeroes`, `bn256_modulus`).

### D.4 SPP event catalog

Decoding rules (`sdk/stellar/src/conversions.rs:202-262`): `topics[0]` is an `ScVal::Symbol` = the event
name (`:195`, `:218-225`); remaining topics follow `#[topic]` declaration order (`:211-216`); data is a
single `ScVal::Map` of `Symbol → ScVal` keyed by **snake_case Rust field name** (`:232-245`), and
**`ScVal::Void` is accepted for events with no non-topic fields** (`:246`). Event `id` is TOID format:
19-char TOID + `-` + 10-char zero-padded event index (`:187-189`,
`sdk/types/src/chain_data.rs:160-163`) — **use it as the primary key**; the reference storage does
`INSERT … ON CONFLICT(id) DO NOTHING` (`sdk/state/src/storage.rs:89-92`). The parser dispatch table
accepts both snake_case and PascalCase (`sdk/state/src/events_parsers.rs:13-38`).

| # | Rust struct | On-chain name | Ordered topics | Data fields | Def / emit |
|:--|:--|:--|:--|:--|:--|
| 1 | `NewCommitmentEvent` | `new_commitment_event` | `(name, commitment: U256)` | `index: u32`, `encrypted_output: Bytes` | `pool.rs:191-201` / `:631-636`, `:638-643` |
| 2 | `NewNullifierEvent` | `new_nullifier_event` | `(name, nullifier: U256)` | **none — data is `ScVal::Void`** | `pool.rs:206-212` / `:608` |
| 3 | `PublicKeyEvent` | `public_key_event` | `(name, owner: Address)` | `encryption_key: Bytes` (32B X25519), `note_key: Bytes` (32B BN254) | `public-key-registry/src/lib.rs:27-37` / `:83-88` |
| 4 | `LeafAddedEvent` | **`LeafAdded`** (literal PascalCase) | `(name)` — no indexed fields | `leaf: U256`, `index: u64`, `root: U256` | `asp-membership/src/lib.rs:51-56` / `:239-244` |
| 5 | `LeafInsertedEvent` | **`LeafInserted`** | `(name)` | `key: U256`, `value: U256`, `root: U256` | `asp-non-membership/src/lib.rs:72-77` / `:484-489` |
| 6 | `LeafDeletedEvent` | **`LeafDeleted`** | `(name)` | `key: U256`, `root: U256` | `asp-non-membership/src/lib.rs:79-83` / `:610-614` |

Note events 4-6 use `#[contractevent(topics = ["LeafAdded"])]` etc. — **literal PascalCase names, not
snake_case**, unlike the pool's two events. `PublicKeyEvent` is **deduped**: re-registering identical keys
emits nothing (`public-key-registry/src/lib.rs:73-80`).

A `LeafUpdated` parser exists (`events_parsers.rs:211-238`, `chain_data.rs:287-296`) but **no contract
emits it** — forward-compat scaffolding.

**Gap Sombra Archive can fill:** `LeafInserted`/`LeafUpdated`/`LeafDeleted` are parsed but **discarded** —
`sdk/state/src/processor.rs:25-31` only persists `Nullifier`, `Commitment`, `PublicKey`, `LeafAdded`;
everything else hits `tracing::warn!("event won't be saved")` (`:30`). Blocklist state is unindexed
upstream.

### D.5 SPP note discovery — what the wallet must do

**Merkle tree.** Fixed-depth binary tree with a root ring buffer
(`contracts/pool/src/merkle_with_history.rs`). **Depth is a constructor parameter**, `levels: u32`, range
`[1..32]` (`pool.rs:255`, validated `merkle_with_history.rs:69-71`) — *not* a compile-time constant. Read
it at runtime from `PoolInfo.merkle_levels` (`sdk/types/src/chain_data.rs:50`) via
`client.allContractsData()`. Hash is **Poseidon2 compression over BN254**
(`merkle_with_history.rs:146`, `:161`, `:168`). Root history depth **90** (`:18`) — a proof built against a
root older than 90 insert-pairs is rejected `UnknownRoot`. Leaves insert **two at a time**, `NextIndex`
always even (`:122-191`). The ASP non-membership SMT is fixed at `SMT_DEPTH = 10`
(`sdk/types/src/lib.rs:22`).

**Commitments and nullifiers** (`sdk/prover/src/crypto.rs`):

```
commitment = Poseidon2Hash3(amount, notePublicKey, blinding,          dom 0x01)   :100-110
signature  = Poseidon2Hash3(notePrivateKey, commitment, pathIndices,  dom 0x04)   :111-126
nullifier  = Poseidon2Hash3(commitment, pathIndices, signature,       dom 0x02)   :127-141
```

`pathIndices` is the **leaf index packed as a u64 into the first 8 bytes of a 32-byte LE field**
(`sdk/prover/src/notes.rs:66-68`). **This is why `NewCommitmentEvent.index` is load-bearing: you cannot
compute a note's nullifier without its leaf index.** An archive that drops `index` makes the notes
unspendable.

**Encrypted payloads ride inside the events.** The ciphertext is `NewCommitmentEvent.encrypted_output` —
a `Bytes` field in the event **data map**, not a topic — copied verbatim from `ExtData.encrypted_outputN`
(`pool.rs:634`, `:641`). Scheme (`sdk/prover/src/encryption.rs:279-349`): **X25519-XSalsa20-Poly1305
(NaCl crypto_box)** with a fresh ephemeral keypair per note. Wire format is exactly 120 bytes:

```
[ephemeral_x25519_pubkey 32B] [nonce 24B] [ciphertext 48B + Poly1305 tag 16B]
```

Plaintext is exactly 48 bytes: `amount (u128 LE, 16B) ‖ blinding (Field LE, 32B)`
(`encryption.rs:241-244`, `:268-274`).

**Discovery is pure trial decryption — there is no view tag and no sender hint.** Per commitment event,
`try_decrypt_and_derive_user_note` (`sdk/prover/src/notes.rs:31-84`):

1. X25519-ECDH against the ephemeral pubkey and attempt AEAD decrypt with your encryption private key;
   failure → not yours (`:38-42`).
2. Reject dummy zero-amount outputs (`:44-46`).
3. **Recompute the commitment** from `(amount, yourNotePublicKey, blinding)` and require equality with the
   on-chain `commitment` — this rejects notes encrypted to you but committed to someone else's note key
   (`:48-62`).
4. Derive `expected_nullifier` from `(notePrivateKey, commitment, leafIndex)` (`:64-77`).

Spend detection is then a **join, not a decryption**: match `expected_nullifier` against observed
`NewNullifierEvent.nullifier` values. Reference: `scan_commitments_for_user_notes`
(`sdk/state/src/storage.rs:1224-1425`) and `reconcile_nullifiers` (`:1427+`), both keeping per-(pool,
account) high-water marks so scanning is resumable.

> **Cost model:** trial decryption is O(all commitments ever emitted) per account, not O(your notes). It is
> an X25519 ECDH plus an AEAD attempt per commitment. This is the SPP analogue of CT's replay window and it
> is the thing Sombra Archive should accelerate — serving the commitment stream with `index` intact,
> resumably, is exactly what the wallet needs.

**What derives from the seed** — everything, from **one Ed25519 wallet signature** over the constant
`"Privacy Pool Key Derivation [v1]"` (`sdk/prover/src/encryption.rs:50`; the signature must be exactly 64
bytes, `:121-123`). Three domain-separated SHA-256 derivations (`:52-54`, `:181-200`):

| Domain tag | Produces |
|:--|:--|
| `privacy-pool/note-key/v1` | BN254 note private key = `Fr::from_le_bytes_mod_order(SHA256(domain‖sig))`; public key = `Poseidon2(sk, 0, dom 0x03)` (`:159-179`, `crypto.rs:91-99`) |
| `privacy-pool/encryption-key/v1` | X25519 `StaticSecret` from `SHA256(domain‖sig)` (`:119-140`) |
| `privacy-pool/asp-secret/v1` | ASP membership blinding, additionally bound to a network context string: `SHA256(domain‖0x00‖context‖0x00‖sig)` (`:77-98`, `:188-200`) |

Per-note `blinding` factors are **random, not derived** (`:210-231`) — but they travel inside the encrypted
payload, so **a full historical rescan from the seed alone fully reconstructs the wallet.** Nothing else
needs backing up. This is the SPP half of Sombra's recovery story, and it is architecturally cleaner than
CT's: no checkpoint subtlety, just "scan everything and try to decrypt."

> ⚠️ **Doc/code mismatch:** `encryption.rs:16-26`'s diagram says `[v2]`; the actual constant at `:50` is
> `[v1]`. **Use the constant** — a wrong message silently derives a different, empty wallet.

### D.6 SPP already has a durable-archive story

`SPP/tools/bootnode/` is a durable, shared event-history service, excluded from the workspace
(`CONTRIBUTING.md:76`). It exposes **only `getEvents` and `getLatestLedger`** over HTTPS JSON-RPC
(`tools/bootnode/README.md:3-6`), caching historical pages into **Postgres** namespaced by deployment
(`README.md:8-10`). Empty pages are stored to keep upstream cursor chains intact; a daily compressor
collapses near-tip empty spans (`:11-13`). Once a request falls safely inside the main RPC's retention
window it returns JSON-RPC **`-32002` with `fromLedger`** as a handoff signal and the client resumes
against the user's own RPC (`:15-18`). The client-side counterpart is `bootnodeRequired()` (§C.1) and
`Indexer::init`'s `RpcSyncGap` detection (`sdk/stellar/src/indexer.rs:18-57`).

**Be honest in the pitch about this.** SPP has already solved retention for itself. Sombra's novel claim
is specifically about **the Confidential Token side**, where the official demo describes itself as
"RPC-only (no indexer)" (`CT-DEMO/package.json`) and `INDEXER.md:14` states recovery "is not guaranteed"
without a conforming archive. On the SPP side Sombra's contribution is unification and the unindexed
blocklist gap (§D.4), not the archive concept.

The reference client indexer worth mirroring is `sdk/stellar/src/indexer.rs` (206 lines):
`PAGE_SIZE = 1000`, `MAX_PAGES_PER_ROUND = 10` (`:7-8`); shared cursor across contracts with **full reset
and replay on divergence** (`:99-113`); `fully_indexed` when a page is empty or a non-full page's max
ledger ≥ `latestLedger`, while a **full** page always continues because more events may share that ledger
(`:139-186`); persistence behind the `ContractDataStorage` trait — `get_sync_state`, `save_events_batch`,
`save_sync_progress` (`:193-206`). The RPC query uses topic filter **`[["**"]]`** — a wildcard, no
event-name filtering (`sdk/stellar/src/rpc.rs:332-390`).

---

## E. Freighter integration patterns

Both stacks reduce Freighter to a **narrow signing seam**, which is what lets Sombra own the privacy layer
above it. But the two seams have **different shapes**, and reconciling them is real work.

| | CT | SPP |
|:--|:--|:--|
| API version | `@stellar/freighter-api ^4.1.0` | `^6.0.1` (peer, optional) |
| Methods the SDK requires | `sign(txXdrBase64)` + app-level `signMessage` | **`signMessage`, `signTransaction`, `signAuthEntry`** — all three, checked at runtime |
| Key-derivation message | `"Confidential Token Demo — key derivation v1\n…"` incl. network + token contract | `"Privacy Pool Key Derivation [v1]"` (constant, no binding) |
| Derivation | `SHA-512(sig) mod r` (demo) / HKDF (spec) | 3 × domain-separated `SHA-256(domain‖sig)` |
| Prompts per user action | 1 | 1 auth-entry + 1 tx **per plan step** |

### E.1 CT

The SDK never imports Freighter. It declares a two-method interface
(`CT-DEMO/packages/sdk/src/chain/client.ts:33-38`):

```ts
export interface Signer {
  publicKey: string;
  sign(txXdrBase64: string): Promise<string>;
}
```

The app adapts Freighter in ~40 lines (`CT-DEMO/packages/app/lib/freighter.ts:25-56`): `isConnected()` →
`requestAccess()` → return `{ publicKey: address, sign, signMessage }`, where `sign` calls
`signTransaction(xdr, { networkPassphrase, address })` and returns `res.signedTxXdr`. `ChainClient.invoke`
does everything else (`client.ts:148-187`).

It extends this with `MessageSigner` (`freighter.ts:20-23`) adding
`signMessage(message): Promise<Uint8Array>` for **key derivation** — the Ed25519 signature is
deterministic (RFC 8032), so it is stable across devices and survives localStorage loss
(`derive-key.ts:1-10`). Two gotchas handled at `freighter.ts:44-67`: v4 returns base64, v3 a Buffer
(`normalizeSignature`), and the returned `signerAddress` **must** be checked against the requested address
(`:50-52`) — Freighter can sign with a different account than requested if the user switches.

**The flow Sombra reproduces:** connect → `signMessage(keyDerivationMessage(passphrase, tokenId))` →
`skFromSignature()` → `deriveKeys(sk, addressToField(tokenId))`. The Stellar account never learns the
confidential keys, and one signature reconstitutes them on any device — the seed half of the recovery
demo. The Archive supplies the event half.

### E.2 SPP

`WalletSigner` (`sdk/web/src/signer.rs`) requires the JS object to expose exactly three methods:
`signMessage`, `signTransaction`, `signAuthEntry` (`signer.rs:16`, presence checked `:36-42`). Each is
called with `(...args, { address, networkPassphrase })` (`:85-94`, `:102-106`) and **must return a
Promise** (`:111-113`). Results may be a bare string or an object with
`signedMessage`/`signedTxXdr`/`signedAuthEntry` (`:173-194`).

The package ships a ready adapter: `FreighterSigner` from `stellar-private-payments/freighter`
(`sdk/web/js/freighter.js:20`) with `ensureReady()`, `getPublicKey()`, `signTransaction`, `signAuthEntry`,
`signMessage`.

**Signing order for one Soroban tx** (`signer.rs:54-83`):

1. `auth_sign_steps(prepared, passphrase, address)` (`:58`)
2. for each auth entry: `signAuthEntry(preimageBase64, {address, networkPassphrase})` (`:63-73`)
3. `unsigned_tx_for_signing(prepared, address, authSignatures)` (`:75-76`)
4. `signTransaction(txB64, {address, networkPassphrase})` (`:78-82`)

Plus, **once per account** at `client.account(...)`, if no keys exist in storage:
`signMessage("Privacy Pool Key Derivation [v1]")` (`client/mod.rs:208-212`). Freighter returns base64;
hex is accepted as fallback (`signer.rs:226-235`).

Rejection propagation: `code: -4` on the JS error becomes `Error::UserRejected` (`signer.rs:151`,
`:157-171`). **Both `signer.rs:133-139` and `js/freighter.js:74-80` warn that custom error wording must
avoid the substrings "rejected"/"denied"/"cancelled"**, because a substring classifier is the fallback
path. Sombra's error-wrapping layer must not re-word SPP errors carelessly.

**A multi-note spend produces multiple `transact` calls**, so the user sees one auth-entry prompt + one tx
prompt *per plan step* — the `current`/`total` fields on the progress event exist precisely for this
(`execute/mod.rs:86-92`). Sombra's UI must set expectations before the first prompt or users will read the
second prompt as a bug.

### E.3 The app's call sequences (SPP)

There is **no `app/js/app.js`** — `app/package.json:5` points at a stale path. The real modules are
`app/js/wasm-facade.js`, `app/js/wallet.js`, `app/js/ui/navigation.js`, `app/js/ui/pool.js`,
`app/js/ui/transactions.js`.

Boot / connect (`app/js/ui/navigation.js:396-439`):

```
1. connectWallet()                    // wallet.js:94 → Freighter requestAccess
2. getWalletNetwork()                 // wallet.js:167 → {network, networkPassphrase, sorobanRpcUrl}
                                      //   app hard-rejects non-testnet (navigation.js:406-408)
3. bootnodeRequired(rpcUrl, storage)  // wasm-facade.js:138
4. initializeRuntime(rpcUrl)          // wasm-facade.js:153 → Storage.open() → Client.new({...})
5. client().backgroundSync()          // navigation.js:419
6. runOnboardingWizard({...})         // disclaimer / retention / persistent-storage / keys / registration
7. client().openAccount({networkPassphrase, userAddress}, signer)   // navigation.js:428
8. client().account().userPublicKeys()                              // navigation.js:429
9. createAppPool()                    // ui/pool.js:38 → account().pool({poolContract})
```

Then each operation is a single call on the pool session, wrapped in a `window` listener on the progress
event (`transactions.js:63-83`):

- **Shield** (`transactions.js:267-292`): `ensureAppPool()` → `session.deposit(amountStroops)`
- **Private transfer** (`:294-354`): `client().recipientLookup(address)` (fired when the address field
  hits 56 chars, `:304-315`) → fill note/encryption keys from `lookup.entry` (`:125-126`) → `ensureAppPool()`
  → **`session.transferToKeys(noteKey, encKey, amount)`** (`:329-331`). The app deliberately uses
  `transferToKeys`, **never** `transfer(address, amount)`, so it can fall back to manual key entry when the
  recipient is unregistered (`:131-137`, `:325`). `lookup.registryFullySynced === false` surfaces a
  "registry still syncing" warning (`:133-136`).
- **Unshield** (`:356-380`): `ensureAppPool()` → `session.withdraw(amount, recipient)`, recipient
  defaulting to the connected wallet (`:362`).

Registration (prerequisite for receiving by address) is `client().openAccount(...)` then
`account().registerPublicKeys({notePublicKeyHex, encryptionPublicKeyHex})`
(`navigation.js:554-557`, `onboarding-wizard.js:258-265`).

Account switching: `startWalletWatcher` polls every 2 s and force-disconnects on address change
(`navigation.js:459-471`).

---

## F. Gotchas and risks

Ordered by how likely each is to cost a day.

### Build and packaging

1. **`@ctd/sdk` is `"private": true` and unpublished** (`CT-DEMO/packages/sdk/package.json`). It cannot be
   `npm install`ed. Sombra must consume it as a git/path/workspace dependency or reimplement ~3,770 lines.
   **This is a day-one decision.** By contrast SPP publishes `stellar-private-payments@0.1.0-alpha.1`
   (Apache-2.0, `publishConfig.access: public`) — verify it is actually on the registry before assuming it.
2. **SPP's deployment config is compiled into the WASM** (`SPP/sdk/web/src/lib.rs:20`). No runtime config
   injection. Pointing SPP at different pools means rebuilding the Rust WASM with Rust `1.97.1`,
   `wasm-bindgen-cli` **exactly** `0.2.126`, Binaryen `version_131`, and Circom ≥ `2.2.2`
   (`rust-toolchain.toml:2-4`, `build.sh:22`, `:34-97`, `CONTRIBUTING.md:90`). Use the published testnet
   deployment (§D.1).
3. **bb.js worker resolution breaks under bundlers → proving hangs with no error.** Serve bb.js as native
   ESM from a stable path. `CT-DEMO/packages/app/lib/bb-loader.ts:1-44`.
4. **Two Freighter API majors** — CT on `^4.1.0`, SPP on `^6.0.1`. Reconcile deliberately.
5. `chain/payload.ts:27` uses `Buffer` — Vite does not polyfill it by default.

### Crypto correctness (silent failures)

6. **Keccak transcript is mandatory** for CT proofs, and `--zk` must **not** be used. A Poseidon-transcript
   proof verifies locally and is rejected on-chain. `proving/prover.ts:5-8,29`.
7. **`fpAdd` vs `frAdd`.** CT blindings accumulate mod **p**, not mod r. Wrong choice silently opens the
   wrong commitment ~50% of the time. `crypto/field.ts:25-36`.
8. **`T_0` = last `Merge` at or before the checkpoint**, not the last merge overall. `INDEXER.md:21`.
9. **CT key-derivation mismatch** between the demo (`SHA-512` of signature) and the spec (HKDF + rejection
   sampling). Not interchangeable. §A.1.
10. **SPP key-derivation message doc/code mismatch**: diagram says `[v2]`, constant says `[v1]`
    (`encryption.rs:16-26` vs `:50`). Wrong string → a different, empty wallet.
11. **Wire the 17 CT conformance fixtures into CI** (`CT-CONTRACTS/circuits/lib/testdata/`). `SDK.md:268-270`
    requires reading them, not transcribing. Cheapest guard against a drift that manifests as unspendable
    funds.

### Archive / indexing

12. **Two incompatible indexer HTTP shapes** (spec `/v1/*` vs the demo's flat paths). Serve both. §B.5.
13. **A configured archive's failure MUST fail the whole sync**, never degrade to RPC-only.
    `SDK.md:510`, `event-source.ts:19-26`. Archive availability is a correctness property.
14. **Persist `tx_application_order` as its own column** — not derivable from `tx_hash`, and it is the
    middle component of the only correct sort key. `INDEXER.md:22`, `:68`.
15. **CT event data is a symbol-keyed, canonically-sorted map** — never decode positionally. §B.
16. **`Merge` has zero data fields**; **`NewNullifierEvent` data is `ScVal::Void`**. A decoder that assumes
    a non-empty data map drops CT's replay anchor and SPP's highest-volume event.
17. **`NewCommitmentEvent.index` is load-bearing** — without the leaf index you cannot compute the
    nullifier, so notes become unspendable. `sdk/prover/src/notes.rs:66-68`.
18. **`SpenderTransfer.sigma_a` is the pre-update salt** (`storage.rs:794` captured before `:822`
    overwrites). Indexing it as "current" is off by one operation.
19. **CT auditor and verifier events live on different contract IDs** — a token-scoped filter misses them.
20. **SPP `LeafAdded` / `LeafInserted` / `LeafDeleted` use literal PascalCase event names**, unlike the
    pool's two snake_case events. `events_parsers.rs:26`, `:180`, `:245`.
21. **Inbound-transfer spam is unbounded by design** on the CT side and the Archive absorbs it.
    `SDK.md:538`. SPP's equivalent is that trial decryption is O(all commitments ever).

### Runtime / UX

22. **SPP proving keys: 34 MB total, and the policy keys are `include_bytes!`d into the WASM**
    (`build.rs:164-167`). Multi-MB first load regardless of pool. Lazy-load the SPP module. §D.2.
23. **Good news: SPP needs no COOP/COEP or SharedArrayBuffer.** Deliberately single-threaded WASM —
    `ark-circom` is patched to strip `parallel` features precisely because multithreaded WASM "requires
    COOP/COEP headers and is much stricter to deploy" (`SPP/CONTRIBUTING.md:105-108`). Parallelism comes
    from two ordinary Web Workers. **Sombra can be served from any static host.**
24. **SPP is browser-only** — `wasm-bindgen --target web` for all three modules, OPFS SAH-Pool VFS for
    SQLite, `Cache` API for artifacts. No Node target is produced. `build.sh:199-201`,
    `sdk/web/src/workers/storage.rs:111-113`.
25. **Single-tab constraint.** OPFS lock contention is detected and surfaced as a "DB locked" modal
    (`workers/storage.rs:48`, `:125`; `app/js/db-locked.js`). Two Sombra tabs will fight over `spp.db`.
26. **`backgroundSync` is not recoverable in place** — after a fatal indexer exit you must build a new
    `Client` (`client/mod.rs:162-166`).
27. **Multiple Freighter prompts per SPP send** (one auth-entry + one tx per plan step, `k` notes → `k−1`
    txs). Set expectations in the UI before the first prompt.
28. **Do not re-word SPP errors** — a substring classifier on "rejected"/"denied"/"cancelled" is the
    fallback user-rejection path. `signer.rs:133-139`, `js/freighter.js:74-80`.
29. **CT's `LocalStorageStore` keeps spending secrets in plaintext** and says a production wallet should
    use IndexedDB + encryption at rest. `state/browser-store.ts:5-7`.
30. **The CT demo publishes the auditor's Grumpkin secret key in plaintext**
    (`CT-DEMO/packages/app/lib/deployment.ts:77`). Deliberate for the demo persona; never reuse the pattern.

### Maturity

31. **CT is explicitly unaudited and not production-ready** (`CT-CONTRACTS/mod.rs:12-19`,
    `circuits/vks/README.md`: the proving recipe is "provisional"). **SPP is `0.1.0-alpha.1`.** Both are
    moving targets. Pin exact commits of the sibling clones in Sombra's README so a rebase upstream cannot
    silently invalidate this document.
