# sombra-kit

Recovery engine for Stellar Confidential Token accounts: spec-conformant key
derivation, event replay, and chain-verified opening reconstruction over a
durable event archive.

Browser-compatible, dependency-light, and **no proving**.

## The one thing to know

Reconstructing a spendable commitment opening requires **no zero-knowledge
proof**. Per `DESIGN.md` §5.2 steps 1–7, recovery is a checkpoint lookup, two
Poseidon2 hashes, one ECDH per incoming transfer, field addition, and two
Pedersen re-commitments compared against on-chain points. No circuit, no
witness, no `bb.js`, no WASM.

Proving is needed only to *create* history — `register`, `withdraw`,
`confidential_transfer` — which happens in Node, ahead of time. That split is
what lets this package run in a browser with no bundler archaeology, and it
takes the riskiest integration in the project off the critical path.

## Install and use

```ts
import { recoverFromSigner } from "sombra-kit";

const result = await recoverFromSigner({
  signer,                     // anything that signs a SEP-0053 message
  contractId: "CC2Z…4ZAC",    // the confidential token
  rpc: "https://soroban-testnet.stellar.org",
  archive: "https://archive.example",
  onProgress: (p) => console.log(p.phase, p.label),
});

result.restored.spendable;      // { v, r } — the opening, spendable again
result.verifiedAgainstChain;    // re-commits to the on-chain points
result.complete;                // the archive's C3 signal, propagated
result.beyondRpcWindow;         // events no RPC could have served
```

Runtime dependencies are `@noble/curves`, `@noble/hashes` and
`@zkpassport/poseidon2`. Nothing else — no `Buffer`, no `node:` imports, no
`@stellar/stellar-sdk`. The XDR codec and the JSON-RPC client are written
against `Uint8Array` and `fetch` for exactly that reason;
`@stellar/stellar-base` is a **devDependency** used only to pin the codec in
tests.

## Layers

| Module | What it is |
|:--|:--|
| `crypto/field` | The two moduli and the arithmetic that must not confuse them (`fqAdd` vs `frAdd`) |
| `crypto/grumpkin` | Grumpkin over `@noble/curves`, Pedersen generators, ECDH, the 64-byte point encoding |
| `crypto/poseidon2` | The §2.5 sponge, the domain-tag funnel, two-mask mode, and the two decrypt rules |
| `crypto/address` | `address_to_field`, strkey encode/decode with CRC validation |
| `keys` | `SDK.md` §5.1 + §5.2 — signer root, HKDF, rejection sampling, the four client MUSTs |
| `xdr/` | `ScVal`, `LedgerKey`, `LedgerEntryData` — enough XDR to read events and account state |
| `events` | The event catalogue, topic attribution, and the four questions replay asks of an event |
| `archive` | Typed client for `INDEXER.md` §6 (C1–C4), completeness carried on every result |
| `chain` | Stellar RPC: `getHealth`, `getEvents`, and the account entry via `getLedgerEntries` |
| `seam` | The hybrid read path and its two `SDK.md` §12.4 MUSTs |
| `replay` | `DESIGN.md` §5.2 steps 1–7, including T_0 |
| `recover` | The assembly, with the wallet's progress phases |

## The parts worth reviewing

**`T_0` is the last `Merge` at or before the checkpoint.** Not the last merge
overall. `INDEXER.md` §2 warns about this specifically: taking the later merge
reconstructs the receiving side correctly while leaving the spendable side short
by whatever that merge folded in — so it fails only at step 7, and only against
the spendable commitment. `replay.ts` cites the clause; `test/replay.test.ts`
reproduces the wrong algorithm alongside the right one and asserts the exact
shortfall.

**Blindings accumulate mod q, never mod r.** `r < q`, so a wrong-modulus sum is
a perfectly well-formed scalar that opens a different commitment — about half
the time, per `SDK.md` §4.6. The two functions are deliberately named so they
cannot be typo'd into each other, and a fixture-backed test pins the difference
at exactly `q − r`.

**The archive is trusted for availability only.** Recovery ends by re-committing
both openings against the on-chain points, so a tampered or incomplete history
produces a detectable mismatch rather than a plausible wrong balance
(`INDEXER.md` §7). Attribution is re-derived from the verbatim topic XDR rather
than taken from the archive's decoded columns, for the same reason.

**A configured archive's failure fails the whole sync.** `SDK.md` §12.4. There
is no `try`/`catch` degrading to RPC-only, deliberately: degrading persists a
sync position derived from the RPC leg alone, and every later sync then takes a
warm path that never consults the archive, turning one transient 500 into
permanently unrecoverable openings. An honest `complete: false` is a different
case and gets a different error type, carrying the coverage so a UI can say
*"the archive does not hold ledgers X–Y"* rather than *"verification failed"*.

## Tests

```
npm test          # 106 tests
npm run build     # tsup → dist/, ESM, platform-neutral
npm run typecheck
```

| Suite | Count | Pins |
|:--|--:|:--|
| `conformance.test.ts` | 21 | All 17 `circuits/lib/testdata/*.json` fixtures, plus the mod-q rule |
| `xdr.test.ts` | 22 | The hand-rolled XDR grammar against `@stellar/stellar-base` |
| `keys.test.ts` | 23 | `SDK.md` §5, and byte-parity with `scripts/derive.ts` |
| `replay.test.ts` | 22 | `DESIGN.md` §5.2 steps 1–7, `INDEXER.md` §2 and §3.4 |
| `seam.test.ts` | 18 | `SDK.md` §12.3 / §12.4, both contract revisions, end-to-end recovery |

Two properties make these worth more than their count.

*The conformance suite reads the fixture files rather than transcribing them*,
which `SDK.md` §6.1 makes a MUST, and it asserts that **every** file in the
directory is consumed by a test — so a fixture added upstream fails the suite
instead of being quietly ignored. The testdata directory lives in the sibling
`stellar-contracts` clone; set `CT_TESTDATA_DIR` to override.

*The replay suite runs against a chain simulator* (`test/chainsim.ts`) that
plays the **sender's** side of the protocol and maintains the two Pedersen
commitments exactly as `storage.rs` does. So a passing test means the replayed
opening re-commits to a point derived independently of the replay — which is
what step 7 checks against a real chain. ECDH commutativity has to actually
hold for the suite to be green.

**Two contract revisions are live, and they differ where recovery reads.**
Running this package against the real testnet deployment surfaced three
divergences between `stellar-contracts`'s confidential module and the revision
the CT demo ships and deploys, all of them in exactly the bytes recovery
touches:

| | `stellar-contracts` | CT demo's deployed WASM |
|:--|:--|:--|
| Account entry | `spending_public_key`, `spendable_commitment`, `receiving_commitment` | `spending_key`, `spendable_balance`, `receiving_balance` |
| Transfer field | `r_e_point` | `r_e` |
| ECDH secret | `Poseidon2(δ_ecdh, S.x, S.y)` | `S.x` |

The first two are names and are read by alias (`chain.ts`, `events.ts`); get
them wrong and nothing decodes at all, which is a loud failure. The third is
not a name — under the wrong rule every incoming transfer decrypts to a
different amount *and* a different blinding, so `recoverFromSigner` resolves it
by replaying under each and keeping whichever re-commits to the on-chain points.
That is safe for the same reason the archive can be untrusted: step 7 is the
arbiter, and no wrong rule opens the chain's commitment. Pin it with
`ecdhRule` when the deployment is known. `poseidon2` remains the default and is
what the fixtures pin; `seam.test.ts` recovers a history emitted under each.

**Key derivation is `SDK.md` §5 and nothing else.** There is no fallback path
and no second scheme — the CT demo app's `sk = SHA-512(signature) mod r` is not
implemented here, because a callable non-spec derivation in a shipped library is
a thing someone reaches for by accident, and the failure mode is an account that
`register` has permanently bound to the wrong key. `keys.test.ts` pins the whole
chain against the vector `scripts/derive.ts` publishes, including the case that
makes this concrete: the demo's secondary account derives at rejection counter
`j = 1`, and a client that hardcodes `j = 0` gets a perfectly well-formed
scalar that is the wrong key.

## Notes

All original work, written against the published specifications. No code is
copied from the reference SDK or the demo app.
