# Sombra — Integration Map

Precise integration surface for the three upstream stacks Sombra consumes. Written for builders wiring
`wallet/`, `archive/`, and `kit/`. Every claim below is cited to a file and line in the sibling clones;
nothing here is vendored.

Reference clones (never modified, never copied into this repo):

| Alias | Path |
|:--|:--|
| **CT-DEMO** | `../stellar-confidential-token-demo` — OpenZeppelin's Confidential Token demo monorepo (MIT) |
| **CT-CONTRACTS** | `../stellar-contracts/packages/tokens/src/confidential` — the canonical Soroban contract + specs |
| **SPP** | `../stellar-private-payments` — Nethermind's Stellar Private Payments shielded pool |

> **Version pins that matter.** `soroban-sdk 27.0.2` (`../stellar-contracts/Cargo.toml:55`), `nargo
> 1.0.0-beta.11` + `bb 0.87.0` for the CT circuits (`CT-CONTRACTS/circuits/vks/README.md`), `@aztec/bb.js
> 0.87.0` and `@noir-lang/noir_js 1.0.0-beta.9` in the demo SDK (`CT-DEMO/packages/sdk/package.json`).
> The demo SDK's own doc comment claims soroban-sdk 26 (`CT-DEMO/packages/sdk/src/chain/events.ts:13`);
> the contract repo is on 27. Pin bindings to 27.

---

## A. CT SDK surface — `@ctd/sdk`

Package: `CT-DEMO/packages/sdk`, `package.json` name `@ctd/sdk`, version `0.1.0`, **`"private": true`**.
Total source is ~3,770 lines across 40 files. Barrel at `src/index.ts:15-21` re-exports seven layers:
`crypto/`, `witness/`, `proving/`, `chain/`, `state/`, `disclosure/`, `auditor/`.

**Browser-safety is designed-in and explicit.** Two Node-only modules are deliberately kept *out* of the
barrels and must be imported by path:

- `state/json-store.ts:1-6` — `JsonFileStore`, uses `node:fs` / `node:path`. Excluded from
  `state/index.ts` (see the comment at `state/index.ts:1-2`).
- `proving/artifacts.ts:10-12` — `loadCircuit`, uses `node:fs` / `node:url` / `node:path`. Excluded from
  `proving/index.ts` (comment at `proving/index.ts:1-3`).

Everything else in the barrel is isomorphic. `crypto/field.ts:98-107` uses `crypto.getRandomValues`
(Web Crypto, available in both). `chain/payload.ts:27` uses `Buffer.from` — fine under Node and under
any bundler that polyfills `Buffer`, but it is the one implicit Node-ism in otherwise browser-safe code.

### A.1 crypto/ — keys, curve, hashing

| Export | Signature | Browser-safe | Notes / file:line |
|:--|:--|:--:|:--|
| `deriveKeys` | `(sk: bigint, addrF: bigint) => KeyPair` | ✅ | The whole key set is a pure function of `(sk, addrF)`. `crypto/keys.ts:35-40` |
| `generateKeys` | `(addrF: bigint) => KeyPair` | ✅ | Random `sk`. `crypto/keys.ts:43-45` |
| `serializeKeys` / `deserializeKeys` | `KeyPair -> {sk,addrF}` and back | ✅ | Only `(sk, addrF)` need persisting. `crypto/keys.ts:48-54` |
| `addressToField` | `(strkey: string) => bigint` | ✅ | `Poseidon2(ADDRESS, lo, hi)` over the 56-char strkey split into two **little-endian** 28-byte limbs. `crypto/address.ts:25-35` |
| `commit` | `(value: bigint, randomness: bigint) => Point` | ✅ | `v·G + r·H`. `crypto/grumpkin.ts:79-81` |
| `scalarMul`, `ecdh`, `pointToBytes`, `pointFromBytes`, `isIdentity`, `pointCoords` | — | ✅ | `crypto/grumpkin.ts:61-119`. On-chain point = flat 64 bytes `be(x)‖be(y)`, identity = 64 zero bytes (`:96-119`) |
| `G`, `H`, `IDENTITY`, `Grumpkin`, `Fr`, `Fp` | constants | ✅ | `crypto/grumpkin.ts:25-58` |
| `sponge`, `poseidonWithDomain`, `spongeSqueeze2` | — | ✅ | Width 4, rate 3, capacity 1, `iv = len·2^64`. `crypto/poseidon2.ts:24-62` |
| `vkFromSk`, `dvkFromVkOp`, `deriveSpendR`, `deriveAllowR`, `deriveTxBlind`, `deriveEphemeralRE` | — | ✅ | `crypto/poseidon2.ts:69-103` |
| `encryptAmount`, `encryptBalance`, `encryptAllowance`, `encryptEscDvk`, `encryptAuditorSenderBalance`, `encryptDisclosure`, `decryptWithDomain` | — | ✅ | `crypto/poseidon2.ts:110-146` |
| `frMod`, `frAdd`, `frSub`, **`fpAdd`**, `toBytes32BE`, `fromBytesBE`, `fromBytesLE`, `toHex32`, `fromHex`, `randomScalar` | — | ✅ | `crypto/field.ts` |
| `DOMAIN`, `CIRCUIT_TYPE`, `FR_MODULUS`, `FP_MODULUS`, generators | constants | ✅ | `crypto/constants.ts:69-124` |

**`fpAdd` is a correctness landmine, not a helper.** Blinding factors accumulate under *point* addition,
so they must be summed **mod p (the Grumpkin group order), never mod r**. `crypto/field.ts:25-36` spells
out the consequence: reducing mod `r` silently opens the wrong commitment roughly half the time, off by
`p − r`. Sombra's own recovery code must use `fpAdd` for every blinding accumulation.

**Key derivation from seed — the demo and the spec disagree.** The demo derives
`sk = SHA-512(ed25519_signature) mod r` over a fixed message
(`CT-DEMO/packages/app/lib/derive-key.ts:14-31`). The normative spec requires
`sk = RS(HKDF-SHA-512(IKM=root, salt="openzeppelin/confidential-token/v1/sk", info=be32(addr_f)‖be32(acct_f)‖le4(j)))`
with a rejection counter `j` (`CT-CONTRACTS/docs/SDK.md:183`), where `root` is a SEP-0053 signature over a
151-byte message (`SDK.md:210-238`). **These produce different keys.** Sombra must pick one; using the
spec's HKDF form means demo-created accounts are not recoverable, and vice-versa. Both bind the key to the
contract address, so keys never cross deployments.

### A.2 witness/ — per-circuit input builders

All browser-safe, all pure. A "witness" is the full `main()` argument set keyed by the exact Noir
parameter names.

| Export | Signature | file:line |
|:--|:--|:--|
| `buildRegisterWitness` | `(keys: KeyPair) => RegisterWitness` | `witness/register.ts:18-26` |
| `buildWithdrawWitness` | `(p: WithdrawParams) => WithdrawWitness` | `witness/withdraw.ts:51-90` |
| `buildTransferWitness` | `(p: TransferParams) => TransferWitness` | `witness/transfer.ts:76-145` |
| `fieldIn`, `pointIn` | input encoders (`Point` → `${prefix}_x`/`_y`) | `witness/common.ts:15-27` |
| `buildDiscloseRecipientWitness`, `buildDiscloseSenderWitness` | off-chain selective disclosure | `witness/disclose-recipient.ts`, `witness/disclose-sender.ts` |

Each builder returns `{ inputs, payload, next }` — `payload` is the on-chain struct, `next` is the
post-op spendable opening the state engine should cache optimistically
(`witness/withdraw.ts:47-48`, `witness/transfer.ts:58-59`). `buildTransferWitness` also returns
`recipientView` (what the recipient will decrypt) and `rEScalar` (`transfer.ts:60-73`).

By default `r_e` is **deterministic**: `r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma)`
(`witness/transfer.ts:87`, derivation at `crypto/poseidon2.ts:99-103`). The circuit only constrains
`R_e = r_e·H` and `r_e ≠ 0`, so this is a client convention — but it is what lets a sender re-derive any
past transfer's ephemeral scalar from `vk` + the event's public `sigma`, with nothing retained.

### A.3 proving/ — UltraHonk via bb.js

| Export | Signature | Browser-safe | Notes |
|:--|:--|:--:|:--|
| `CircuitProver` | `new (circuit: CompiledCircuit)` | ✅ (with loader override) | `proving/prover.ts:61-107` |
| `CircuitProver.prove` | `(inputs: NoirInputs) => Promise<ProofResult>` | ✅ | Solves witness via `noir_js`, proves via bb.js. `prover.ts:80-85` |
| `CircuitProver.verify` | `(r: ProofResult) => Promise<boolean>` | ✅ | Local sanity check. `prover.ts:88-91` |
| `CircuitProver.verificationKey` | `() => Promise<Uint8Array>` | ✅ | `prover.ts:99-102` |
| `CircuitProver.destroy` | `() => Promise<void>` | ✅ | Frees WASM. `prover.ts:104-106` |
| `proverFromArtifact` | `(artifact: {bytecode}) => CircuitProver` | ✅ | For bundler-imported JSON. `prover.ts:114-118` |
| `setUltraHonkBackendLoader` | `(loader) => void` | ✅ | **Mandatory in the browser** — see below. `prover.ts:45-47` |
| `loadCircuit` | `(name: "register"\|"withdraw"\|"transfer") => CompiledCircuit` | ❌ **node:fs** | Import from `proving/artifacts.js` directly. `proving/artifacts.ts:20-23` |

**Two hard requirements:**

1. **Keccak transcript is mandatory.** Every proof is generated with `{ keccak: true }`
   (`prover.ts:29`, applied at `:83`, `:90`, `:101`). The on-chain verifier
   (NethermindEth/rs-soroban-ultrahonk) rebuilds Fiat-Shamir with keccak256, while bb.js *defaults to
   Poseidon*. A default-transcript proof verifies locally and is **silently rejected on-chain**
   (`prover.ts:5-8`). The contract side says the same and adds: do **not** pass `--zk`, the verifier
   implements only the non-zk `ultra_flavor` (`CT-CONTRACTS/circuits/vks/README.md`).
2. **bb.js must be loaded as native ESM in the browser.** bb.js spawns its WASM worker via
   `new Worker(new URL('./main.worker.js', import.meta.url))` with a `webpackIgnore`. Once bundled into a
   hashed chunk that sibling URL no longer resolves and **proving hangs silently** — no error, just never
   resolves. The demo copies bb.js's `dest/browser/` verbatim to `public/vendor/bb/` and loads it with a
   `new Function("url", "return import(url)")` escape hatch so the bundler never sees the import
   (`CT-DEMO/packages/app/lib/bb-loader.ts:1-44`, wired at `:37-43`). Sombra's Vite build needs the same
   trick or an equivalent (`vite-plugin-static-copy` + `/* @vite-ignore */`).

Compiled circuit artifacts ship in `CT-DEMO/packages/sdk/circuits/`: `register.json` 57 KB,
`withdraw.json` 66 KB, `transfer.json` 73 KB (~196 KB total). These are ACIR bytecode, not proving keys —
UltraHonk needs no per-circuit trusted setup, and the CRS is fetched/derived by bb.js at backend init.

### A.4 chain/ — RPC client, submitters, event ingest

| Export | Signature | Browser-safe | file:line |
|:--|:--|:--:|:--|
| `ChainClient` | `new (cfg: ChainConfig)` | ✅ | `chain/client.ts:80-88` |
| `.simulate` | `(contractId, method, args) => Promise<xdr.ScVal>` | ✅ | `client.ts:92-111` |
| `.confidentialBalance` | `(address) => Promise<OnChainAccount \| null>` | ✅ | Returns the 4 Points + `auditorId`; `null` if unregistered. `client.ts:114-123` |
| `.isRegistered` | `(address) => Promise<boolean>` | ✅ | `client.ts:125-127` |
| `.auditorKey` | `(auditorId: number) => Promise<Point>` | ✅ | Reads `K_aud` from the auditor registry. `client.ts:130-135` |
| `.invoke` | `(contractId, method, args, signer) => Promise<InvokeResult>` | ✅ | build → simulate → assemble → sign → send → poll (2 s × 60). `client.ts:148-187` |
| `keypairSigner` | `(secret, passphrase) => Signer` | ✅ | Node/scripts. `client.ts:68-78` |
| `Signer` (interface) | `{ publicKey: string; sign(xdr): Promise<string> }` | — | **The Freighter seam.** `client.ts:33-38` |
| `submitRegister` | `(client, signer, account, auditorId, witness, proof)` | ✅ | `chain/contract.ts:22-36` |
| `submitDeposit` | `(client, signer, from, to, amount)` — **no proof** | ✅ | `contract.ts:39-52` |
| `submitMerge` | `(client, signer, account)` — **no proof** | ✅ | `contract.ts:55-61` |
| `submitWithdraw` | `(client, signer, from, to, amount, witness, proof)` | ✅ | `contract.ts:64-79` |
| `submitTransfer` | `(client, signer, from, to, witness, proof)` | ✅ | method is `confidential_transfer`. `contract.ts:82-96` |
| `encodeRegisterData` / `encodeWithdrawData` / `encodeTransferData` | `(witness, proof) => xdr.ScVal` | ⚠️ `Buffer` | `chain/payload.ts:48-83` |
| `scvStruct` | `(fields) => xdr.ScVal` | ⚠️ `Buffer` | contracttype = ScMap, **symbol keys sorted ascending**. `payload.ts:32-40` |
| `fetchEvents` | `(client, opts) => Promise<FetchEventsResult>` | ✅ | RPC `getEvents`, pages to head. `chain/events.ts:261-304` |
| `parseIndexerEvent` | `(row: IndexerRow) => ConfidentialEvent \| null` | ✅ | `chain/indexer.ts:186-202` |
| `buildConfidentialEvent` | shared shape definition | ✅ | **Single source of truth for event decoding.** `events.ts:154-205` |
| `naturalEventId` | `({ledger,txHash,opIndex,eventIndex}) => string` | ✅ | `` `${ledger}-${txHash}-${opIndex}-${eventIndex}` ``. `events.ts:236-243` |
| `cursorLedger` | `(cursor) => number` | ✅ | `toid >> 32`. **Only valid on an RPC resume cursor.** `events.ts:222-224` |
| `dedupeById` | `(events) => ConfidentialEvent[]` | ✅ | Stable sort by ledger only. `chain/event-source.ts:59-65` |
| `hybridFetchEvents` | `(client, indexer\|undefined, opts)` | ✅ | **The seam Sombra Archive plugs into.** `event-source.ts:82-142` |
| `hybridResolveEventRef` | `(client, indexer, ref)` | ✅ | RPC first, archive fallback. `event-source.ts:156-164` |
| `IndexerClient` | `new ({ baseUrl })` | ✅ | `chain/indexer.ts:61-148` |
| `eventRef`, `eventToJson`, `resolveEventRef` | — | ✅ | `events.ts:320-372`, `:334-353` |
| `deployFromFactory`, admin helpers | — | ✅ | `chain/factory.ts`, `chain/admin.ts` |

### A.5 state/ — balance reconstruction

| Export | Signature | Browser-safe | file:line |
|:--|:--|:--:|:--|
| `StateEngine` | `new (cfg: StateEngineConfig)` | ✅ | `state/engine.ts:61-62` |
| `.sync` | `() => Promise<AccountState>` | ✅ | Fetch → apply → persist. `engine.ts:124-140` |
| `.current` | `() => Promise<AccountState>` | ✅ | No network. `engine.ts:143-145` |
| `.setSpendable` | `(next: Opening) => Promise<AccountState>` | ✅ | Optimistic post-op write. `engine.ts:152-157` |
| `.verifyAgainstChain` | `() => Promise<{ok, spendableOk, receivingOk}>` | ✅ | **Re-commits cached openings and compares to on-chain points.** `engine.ts:164-171` |
| `.decryptIncoming` | `(rE, vTilde, sigma) => {vTx, rTx}` | ✅ | ECDH with `vk`. `engine.ts:65-70` |
| `.openSpendable` | `(bTilde, sigma) => Opening` | ✅ | Checkpoint → opening, no replay. `engine.ts:73-77` |
| `MemoryStore` | `StateStore` | ✅ | `state/store.ts:53-63` |
| `LocalStorageStore` | `new (prefix = "ctd:state:")` | ✅ | `state/browser-store.ts:12-29` |
| `JsonFileStore` | `new (path)` | ❌ **node:fs** | Import from `state/json-store.js`. `state/json-store.ts:14-32` |
| `freshState`, `reviveState`, `cloneState`, `bigintReplacer` | — | ✅ | `state/types.ts:32-40`, `store.ts:21-50` |

`StateEngineConfig` (`engine.ts:40-59`) takes `{ client, store, keys, address, fromLedger, indexer? }` —
`indexer` is the optional `IndexerClient`. `AccountState` (`state/types.ts:17-30`) is
`{ address, spendable: Opening, receiving: Opening, registered, cursor?, syncedLedger }`.

`verifyAgainstChain` is the trustless check that makes an untrusted archive safe: it re-commits the
reconstructed `(v, r)` and compares against the on-chain Pedersen points (`engine.ts:168-169`). Sombra
should surface this in the UI as the "verified against chain" badge.

**The demo's own reconstruction is incomplete relative to the spec.** `StateEngine.apply`
(`engine.ts:80-118`) handles only `register`, `deposit`, `merge`, `withdraw`, `transfer`. It ignores
`spender_transfer`, `set_spender`, and `revoke_spender` — all three of which the spec classifies as
recovery-relevant (see §B.3). The demo's `LocalStorageStore` also stores spending secrets in plaintext
`localStorage` and says so (`browser-store.ts:5-7`).

### A.6 disclosure/ and auditor/

`disclosure/` (`prove.ts`, `verify.ts`, `recipient.ts`, `types.ts`) implements off-chain selective
disclosure per `CT-CONTRACTS/docs/SELECTIVE_DISCLOSURE.md`; `auditor/decrypt.ts` implements auditor-side
event decryption per `DESIGN.md §8`. Both are browser-safe. Out of scope for Sombra v1 but note that
`disclosure/verify.ts` compares circuit VKs against pinned bytes shipped in the separate `@ctd/disclosure`
package (`CT-DEMO/packages/disclosure/package.json`) — that pinning is the trust anchor.

---

## B. CT event catalog — the Archive's ingestion contract

Canonical source is the Rust, not the demo SDK. Wire-format rules
(`CT-CONTRACTS/mod.rs`, soroban-sdk 27 `#[contractevent]`):

- `topics[0]` is a `Symbol` of the **snake_case struct name**, followed by the `#[topic]` fields in
  declaration order.
- Data is an **`ScMap` keyed by field-name symbols**, not a positional vec. Canonical XDR sorts map keys
  by symbol, so **wire order ≠ Rust declaration order — never index data positionally.** The demo decoder
  does it correctly, by name (`CT-DEMO/packages/sdk/src/chain/events.ts:395-408`).
- `Point` is `pub type Point = BytesN<64>` (`../stellar-contracts/packages/contract-utils/src/crypto/grumpkin.rs:49`)
  — flat `be(x)‖be(y)`, identity = 64 zero bytes. All scalars/ciphertexts are `BytesN<32>`, canonical BE
  in `[0, r)`. Public amounts are `i128`.
- Canonicality is enforced at the verifier boundary and panics `NonCanonicalEncoding = 3514`
  (`storage.rs:1317-1337`). **Guarantee you can rely on:** every scalar in a successfully emitted event is
  the unique canonical representative, so byte-equality is a valid identity test.

### B.1 Token contract events

| # | Rust struct | On-chain name | Ordered topics | Data fields (Rust types) | Def / emit |
|:--|:--|:--|:--|:--|:--|
| 1 | `Register` | `register` | `("register", account: Address)` | `auditor_id: u32` | `mod.rs:609-615` / `storage.rs:460` |
| 2 | `Deposit` | `deposit` | `("deposit", from, to: Address)` | `amount: i128` | `mod.rs:624-632` / `storage.rs:514` |
| 3 | `Merge` | `merge` | `("merge", account: Address)` | **none** | `mod.rs:641-646` / `storage.rs:546` |
| 4 | `Withdraw` | `withdraw` | `("withdraw", from, to: Address)` | `amount: i128`, `r_e_point: BytesN<64>`, `sigma: BytesN<32>`, `b_tilde: BytesN<32>`, `b_tilde_aud_s: BytesN<32>` | `mod.rs:654-666` / `storage.rs:633-642` |
| 5 | `Transfer` | `transfer` | `("transfer", from, to: Address)` | `r_e_point: BytesN<64>`, `v_tilde`, `sigma`, `b_tilde`, `v_tilde_aud_r`, `r_tilde_aud_r`, `v_tilde_aud_s`, `b_tilde_aud_s` (all `BytesN<32>`) | `mod.rs:693-708` / `storage.rs:717-729` |
| 6 | `SpenderTransfer` | `spender_transfer` | `("spender_transfer", spender, from, to: Address)` | `r_e_point: BytesN<64>`, `v_tilde`, **`sigma_a`**, `v_tilde_aud_r`, `r_tilde_aud_r`, `v_tilde_aud_s`, **`a_tilde_aud_s`** | `mod.rs:741-757` / `storage.rs:829-841` |
| 7 | `SetSpender` | `set_spender` | `("set_spender", account, spender: Address)` | `live_until_ledger: u32`, `r_e_point: BytesN<64>`, `sigma`, `b_tilde`, `v_tilde_aud_s`, `b_tilde_aud_s` | `mod.rs:790-803` / `storage.rs:935-945` |
| 8 | `RevokeSpender` | `revoke_spender` | `("revoke_spender", account, spender: Address)` | `r_e_point: BytesN<64>`, `sigma`, `b_tilde`, `v_tilde_aud_s`, `b_tilde_aud_s` | `mod.rs:832-844` / `storage.rs:1019-1028` |
| 9 | `UnderlyingAssetSet` | `underlying_asset_set` | `("underlying_asset_set")` — no topic fields | `underlying_asset: Address` | `mod.rs:872-876` / `storage.rs:1066` |
| 10 | `VerifierSet` | `verifier_set` | `("verifier_set")` | `verifier: Address` | `mod.rs:885-889` / `storage.rs:1100` |
| 11 | `AuditorSet` | `auditor_set` | `("auditor_set")` | `auditor: Address` | `mod.rs:898-902` / `storage.rs:1134` |
| 12 | `AddressAsFieldSet` | `address_as_field_set` | `("address_as_field_set")` | `address_as_field: BytesN<32>` | `mod.rs:911-915` / `storage.rs:1175` |

Compliance module (`CT-CONTRACTS/compliance/mod.rs`): `frozen` `("frozen", account)` no data (`:333-343`);
`unfrozen` (`:346-356`); `compliance_config_changed` no topic fields, data `policy: Option<Address>`,
`sac_passthrough: bool` (`:359-369`). **No clawback event exists** — spec'd as a follow-up
(`docs/COMPLIANCE.md:261`).

**Separate contract IDs** — a token-scoped filter will not see these:
- Auditor registry (`CT-CONTRACTS/auditor/mod.rs`): `auditor_registered` `("auditor_registered", auditor_id: u32)` data `point: BytesN<64>` (`:166-183`); `auditor_rotated` data `old_point`, `new_point` (`:186-210`). Note `auditor_id` is a **non-Address topic**.
- Verifier (`CT-CONTRACTS/verifier/mod.rs`): `verification_key_registered` `(name, circuit_type: CircuitType)` data `verification_key: Bytes` (`:269-291`); `verification_key_updated` data `old_`/`new_verification_key` (`:294-322`). `CircuitType` is `#[repr(u32)]`: Register=0, Withdraw=1, Transfer=2, SpenderTransfer=3, SetSpender=4, RevokeSpender=5 (`:96-106`, values are on-chain interface and MUST NOT change).

The demo SDK's `KNOWN` set (`CT-DEMO/packages/sdk/src/chain/events.ts:119-131`) is a **subset**: it omits
`spender_transfer`, `set_spender`, `revoke_spender`, `compliance_config_changed`, and all four config
events, while adding four `user_*` events from a separate pluggable policy contract. **Trust the Rust.**

### B.2 Role in recovery — `INDEXER.md §3.2` (lines 43-58)

| Event | Role |
|:--|:--|
| `Register` | Start of history; bounds the worst-case replay window |
| `Deposit` | Receiving-side replay: accumulates `(amount, 0)` — deposits commit with **zero blinding**, `c_dep = amount·G` (`storage.rs:512`) |
| `Transfer` (recipient side) | Receiving-side replay: carries recipient-channel ciphertexts for `(v_transfer, r_transfer)` |
| `SpenderTransfer` (recipient side) | Receiving-side replay, as above |
| `Merge` | Folds receiving into spendable; resets receiving. **The `T_0` anchor.** |
| `Withdraw`, `Transfer` (sender side), `SetSpender`, `RevokeSpender` | **Checkpoints** — publish `(b_tilde, sigma)` for the owner's spendable balance |

A **self-transfer** (`from == to`) carries both roles and recovery must apply both
(`INDEXER.md:56`, `SDK.md:388`).

`SpenderTransfer` is **never a checkpoint**: it carries no `b_tilde` and no `sigma`; its sender-channel
field `a_tilde_aud_s` is an *allowance* ciphertext. Config events are not needed for recovery but
indexers SHOULD archive them anyway (`INDEXER.md:58`).

### B.3 The recovery algorithm (normative, `CT-CONTRACTS/docs/DESIGN.md §5.2`)

1. Fetch `(b̃, σ)` from the most recent **checkpoint**. If none: `W_spend ← (0,0)`, `T_0 = Register`.
2. `v_s = b̃ − Poseidon(δ_enc_bal, vk, σ)`
3. `r_s = Poseidon(δ_spend_r, vk, σ)`
4. `W_spend ← (v_s, r_s)`
5. `T_0` = most recent `Merge` **at or before that checkpoint**, else `Register`. `W_receive ← (0,0)`.
6. Replay every event after `T_0` in canonical order: incoming transfer → ECDH-decrypt and accumulate;
   deposit → `+= (a, 0)`; merge → fold and reset; checkpoint → skip the spendable side.
7. **Verify:** `C_spend =? W_spend.v·G + W_spend.r·H` and likewise for `C_receive`.

Steps 2-4 map exactly to `StateEngine.openSpendable` (`engine.ts:73-77`); step 6's transfer rule to
`decryptIncoming` (`:65-70`); step 7 to `verifyAgainstChain` (`:164-171`).

> **`T_0` is the last `Merge` at or before the checkpoint — not the last merge overall.** `INDEXER.md:21`
> is explicit: a merge *after* the checkpoint reconstructs the receiving opening correctly but leaves the
> spendable opening **short by the amount that merge folded in**. This is the single easiest way to build a
> silently-wrong Archive.

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
What replaces it is gap-range bookkeeping.

### B.5 The two incompatible indexer HTTP shapes

This is the single most actionable finding for `archive/`.

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
Plus the optional per-contract stream `GET /v1/tokens/{contract_id}/events` (`:109`).
C2 and C4 are normative; C1 (`/checkpoint`) is RECOMMENDED and MAY be omitted.

**Shape 2 — what `@ctd/sdk`'s `IndexerClient` actually calls** (Goldsky-backed Cloudflare Worker):

```text
GET  {baseUrl}/health
  -> { latest_synced_ledger }                          indexer.ts:74-78
GET  {baseUrl}/contracts/{contractId}/events?startLedger&endLedger&cursor&limit
  -> { latestLedger, cursor, events: [{id, ledger, txHash, topic, value}] }
                                                       indexer.ts:87-122
```
Reference implementation: `CT-DEMO/packages/indexer/handler/src/routes/health.ts:12-18` and
`routes/events.ts:23-65`; response types at `handler/src/types.ts:29-46`.

**They share no path, no param name, and no response field name.** Sombra Archive should serve **both**:
`/v1/*` to be conformant with the published spec (the differentiator we claim), and the demo's flat
`/health` + `/contracts/:id/events` so that an unmodified `@ctd/sdk` `IndexerClient` works against it as a
drop-in. The demo shape is a strict pass-through of raw `topic`/`value` JSON with all decoding in the SDK,
which conveniently satisfies `INDEXER.md:41`'s "decoded form pinned to the canonical decoder" clause.

Note the spec is **internally inconsistent**: §3.1 names the fields `topics`/`data` (`:39`) while the §6
sketch uses `topics_xdr`/`data_xdr` (`:101`). Status codes, error bodies, auth, rate limits, and cursor
format are **entirely unspecified** — Sombra chooses. The one behavioral constraint: a range the archive
cannot cover must be answerable with `complete: false`, not an error, because the client's seam logic
reads that flag.

### B.6 The hybrid seam (what the Archive must not break)

`hybridFetchEvents` (`CT-DEMO/packages/sdk/src/chain/event-source.ts:82-142`) splits by ledger range:
archive owns `[next, seam-1]`, RPC owns `[seam, head]`, where
`seam = rpcOldestLedger + RPC_SEAM_MARGIN` and `RPC_SEAM_MARGIN = 60` (`event-source.ts:48`). The margin
exists because the RPC's retention floor advances *while the backfill runs* (`:41-47`;
`CT-CONTRACTS/docs/SDK.md:508` makes the margin a MUST).

**A configured archive's failure MUST fail the whole sync** (`SDK.md:510`, implemented deliberately
without a try/catch at `event-source.ts:105-123`, rationale at `:19-26`). Degrading silently to RPC-only
would persist a cursor derived from the RPC leg alone, permanently committing every future sync to a warm
path that never consults the archive — turning one transient 500 into unrecoverable data loss. **Sombra
Archive's availability is therefore load-bearing for correctness, not just UX.**

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
(`:1211-1215`) and reset to identity only by `merge` (`:539-547`).

**There is no bounded pending list and no merge-forcing cap.** The receiving side is a single aggregated
Grumpkin point that grows without bound. Merging is pure client policy, driven by two pressures: received
funds aren't spendable until merged, and merging bounds the replay window (`SDK.md:436-440`).
There is **no nonce, counter, or rollover** — freshness comes from the per-operation salt `σ`
(fresh per *attempt*, including retries — `SDK.md:396-402`) and from state binding to the current
`C_spend`.

Two consequences for the Archive:

- **Inbound-transfer spam is an unbounded storage attack.** `SDK.md:538`: per-account event volume is
  linear in inbound transfers and "unbounded by design, since incoming-transfer spam is rate-limited only
  by transaction fees." An adversary can grow any account's replay window arbitrarily for the cost of
  fees. Sombra Archive is the component that has to absorb it.
- **The unspendable-blinding case** (`SDK.md:428-434`): a post-merge blinding can land outside the range a
  Noir `Field` encodes — no constructible proof, while on-chain state stays well-formed and
  `verifyAgainstChain` still passes. Must be surfaced as its own named state; it resolves only at the next
  merge that folds in an inbound *confidential transfer* (deposits alone don't fix it).

### B.8 CT circuits

Noir workspace at `CT-CONTRACTS/circuits/`, built by `nargo`, outside the Cargo workspace. Six operation
circuits get VKs (`register`, `withdraw`, `transfer`, `set_spender`, `spender_transfer`,
`revoke_spender`); the seven `gadgets/*` packages are measurement-only. VKs in `circuits/vks/` are
**7,729 bytes each** (112 hex `Fr` fields, `--output_format fields` for macOS↔Linux reproducibility).

ACIR opcode counts (`circuits/constraints.baseline`): register 33, withdraw 94, transfer 133,
spender_transfer 135, set_spender 131, revoke_spender 123. Public inputs: withdraw 15, transfer 24,
spender_transfer 24, set_spender 24, revoke_spender 19.

Documented proving cost: **single-digit seconds on contemporary hardware** and an explicit obligation to
treat it as user-visible (`docs/OVERVIEW.md:166`, `docs/SDK.md:534`). Cost driver is EC scalar
multiplications — transfer needs 8, register 2 (`OVERVIEW.md:166`).

`circuits/lib/testdata/` holds **17 JSON conformance fixtures** pinning one primitive each. `SDK.md:268-270`:
an implementation MUST reproduce every output byte-for-byte and its test suite MUST **read** the files
rather than transcribe them. Sombra's kit should wire these into CI — it is the cheapest possible guard
against a Poseidon2/Grumpkin drift that would otherwise surface as silently unspendable funds.

> ⚠️ **CT is explicitly not production-ready.** `mod.rs:12-19` and `verifier/mod.rs` carry load-bearing
> warnings that the UltraHonk backend is unfinished and unaudited, and `circuits/vks/README.md` calls the
> proving recipe "provisional… including the zero-knowledge setting."

---

## C. SPP SDK surface

_(in progress — see §D for the deployment facts already confirmed)_

---

## D. SPP pool events + testnet deployments

### D.1 Testnet deployments — **live, reusable, no redeploy needed**

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

| Pool contract | Token contract | Deployed at ledger | Policy flags | Asset |
|:--|:--|--:|:--|:--|
| `CCG3ICXNCYWQIRUMUQEJZZIIF2DTXIY63UMVDJT2EJM7VZPE45W2XFLU` | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` | 3899359 | `blocklist` | native (XLM) |
| `CCBOHPJ2TM24EZ4BJGT5ZHQD4F5N47J6WMJHSBXUA25NZMKPZOXD7XL2` | `CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ` | 3899361 | `allowlist`,`blocklist` | classic EURC, issuer `GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO` |

> **The native SPP pool's token contract `CDLZFC3S…CYSC` is byte-identical to the CT demo's `underlying`**
> (`CT-DEMO/packages/app/lib/deployment.ts:82`). Both stacks sit on the **same XLM Stellar Asset Contract**
> on testnet. That is the structural fact that makes a single Sombra balance view — and the shielded-swap
> demo — coherent rather than two unrelated wallets bolted together.

CT testnet deployment for reference (`CT-DEMO/packages/app/lib/deployment.ts:68-87`): token
`CBF64DEOVQAXJFBSNGFEUT2AH4H7K5JBY3ZYJ5GVEINMNSDISWRG5N3F`, verifier
`CDCET36PIS44DWJM5UQSSI4ZHGRDSBIIQW4G4ALPYK3Y6FEQGY5ZWFXL`, auditor
`CA4II62E35TQKPGHCPBD6EBAS732GSGS6H37UUWKEDHR4YTBVMPHVY4L`, factory
`CDX4DBNWDMD7BVZCOJPTXVTBRXU2RG7JUOZKOOUX5RVWWWWIGV2LWS6Z`, `deployedAtLedger: 3013364`, `auditorId: 0`.
Note `deployment.ts:77` publishes the **auditor's Grumpkin secret key** in plaintext — deliberate, so
anyone can play the auditor persona, and flagged as demo-only at `:15-18`.

### D.2 SPP circuit keys — 34 MB of proving keys

`SPP/deployments/testnet/circuit_keys/` totals **34 MB**. Unlike CT's UltraHonk (no per-circuit setup),
SPP ships **per-circuit binary proving keys**:

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

Verification keys are small: `*_vk.json` 2.7–5.1 KB, `*_vk_soroban.bin` 836 B–1.6 KB, plus `*_vk_const.rs`
(4.2–7.8 KB) for compile-time embedding in the verifier contracts.

The naming (`policy_tx_2_2` = 2 inputs / 2 outputs; `A`/`B`/`AB` matching the `verifiers.B` and
`verifiers.AB` contract IDs above) indicates a UTXO-style join-split circuit family with policy variants.
**For a browser wallet, the shield/transact path alone needs the ~2.96 MB `policy_tx_2_2` key at minimum,
and 5–8 MB if the deployed pools' policy flags select the A/B/AB variants** — the two testnet pools carry
`blocklist` and `allowlist,blocklist`, so the AB (8.13 MB) key is in play for the EURC pool.

_(pool entry points, event catalog, and the app's call sequence: in progress)_

---

## E. Freighter integration pattern

Both stacks reduce Freighter to a **narrow signing seam**, which is what lets Sombra own the privacy layer
above it.

### E.1 CT demo

The SDK never imports Freighter. It declares a two-method interface
(`CT-DEMO/packages/sdk/src/chain/client.ts:33-38`):

```ts
export interface Signer {
  publicKey: string;
  sign(txXdrBase64: string): Promise<string>;
}
```

The app adapts Freighter to it in ~40 lines (`CT-DEMO/packages/app/lib/freighter.ts:25-56`):
`isConnected()` → `requestAccess()` → return `{ publicKey: address, sign, signMessage }`, where `sign`
calls `signTransaction(xdr, { networkPassphrase, address })` and returns `res.signedTxXdr`.
`ChainClient.invoke` handles everything else — build, simulate, `rpc.assembleTransaction`, sign, send,
poll (`client.ts:148-187`).

It extends this with `MessageSigner` (`freighter.ts:20-23`), adding
`signMessage(message): Promise<Uint8Array>` for **key derivation**: the Ed25519 signature over a fixed
message is deterministic (RFC 8032), so it is stable across devices and survives localStorage loss
(`derive-key.ts:1-10`). Two version gotchas handled at `freighter.ts:44-67`: v4 returns base64 string, v3
a Buffer (`normalizeSignature`), and the returned `signerAddress` **must** be checked against the
requested address (`:50-52`) — Freighter can sign with a different account than the one you asked for if
the user switches.

Package: `@stellar/freighter-api ^4.1.0` (`CT-DEMO/packages/app/package.json`).

**The flow Sombra reproduces:** connect Freighter → `signMessage(keyDerivationMessage(passphrase, tokenId))`
→ `skFromSignature()` → `deriveKeys(sk, addressToField(tokenId))` → the CT key set. The user's Stellar
account never learns the confidential keys, and one signature reconstitutes them on any device — which is
exactly the seed half of the recovery demo. The Archive supplies the event half.

### E.2 SPP

_(in progress)_

---

## F. Gotchas and risks

Ordered by how likely each is to cost a day.

1. **bb.js worker resolution breaks under bundlers → proving hangs with no error.** Must serve bb.js as
   native ESM from a stable path. `CT-DEMO/packages/app/lib/bb-loader.ts:1-44`.
2. **Keccak transcript is mandatory** (`{ keccak: true }`), and `--zk` must **not** be used. A
   Poseidon-transcript proof verifies locally and is rejected on-chain — the worst possible failure mode.
   `CT-DEMO/packages/sdk/src/proving/prover.ts:5-8,29`.
3. **`fpAdd` vs `frAdd`.** Blindings accumulate mod **p**, not mod r. Getting this wrong silently opens the
   wrong commitment ~50% of the time. `CT-DEMO/packages/sdk/src/crypto/field.ts:25-36`.
4. **`T_0` = last `Merge` at or before the checkpoint.** Using the last merge overall leaves the spendable
   opening short. `CT-CONTRACTS/docs/INDEXER.md:21`.
5. **SPP proving keys are 1.3–8.1 MB each, 34 MB total.** No CDN-free browser story yet.
   `SPP/deployments/testnet/circuit_keys/`.
6. **A configured archive's failure MUST fail the whole sync**, never degrade to RPC-only.
   `CT-CONTRACTS/docs/SDK.md:510`, `CT-DEMO/.../event-source.ts:19-26`.
7. **Two incompatible indexer HTTP shapes** (spec `/v1/*` vs demo flat). Serve both. §B.5.
8. **Node-only modules in `@ctd/sdk`:** `state/json-store.ts` and `proving/artifacts.ts` (both `node:fs`).
   Kept out of the barrels — do not re-export them from `kit/`.
9. **`@ctd/sdk` is `"private": true`** and unpublished (`CT-DEMO/packages/sdk/package.json`). It cannot be
   `npm install`ed. Sombra must vendor-by-reference (git dependency / pnpm workspace link / path
   dependency) or reimplement the ~3,770 lines. This is a build-wiring decision needed on day one.
10. **Event data is a symbol-keyed map, sorted canonically** — never decode positionally. §B.
11. **`Merge` has zero data fields.** A decoder that assumes non-empty data will drop the one event that
    anchors the entire receiving-side replay.
12. **`SpenderTransfer.sigma_a` is the pre-update salt** (`storage.rs:794` captured before `:822`
    overwrites). Indexing it as "current" is off by one operation.
13. **Auditor and verifier events live on different contract IDs** — a token-scoped filter misses them.
14. **Inbound-transfer spam is unbounded by design** and the Archive absorbs it. `SDK.md:538`.
15. **CT is explicitly unaudited / not production-ready.** `CT-CONTRACTS/mod.rs:12-19`.
16. **The demo's `LocalStorageStore` keeps spending secrets in plaintext** and says a production wallet
    should use IndexedDB + encryption at rest. `CT-DEMO/.../state/browser-store.ts:5-7`.
17. **Key-derivation mismatch between the demo (SHA-512 of signature) and the spec (HKDF + rejection
    sampling).** Pick one; they are not interchangeable. §A.1.
