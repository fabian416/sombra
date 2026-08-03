# Notice — upstream dependencies and provenance

Sombra is 100% original work. It consumes the following upstream projects **as
dependencies or normative references only** — no source code was copied from
any of them. Commits are pinned for reproducibility.

| Project | License | Pinned commit | How Sombra uses it |
|:--|:--|:--|:--|
| [OpenZeppelin/stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) | Apache-2.0 | `9b5ed96f67aa28a8be73c538f7bfdef65925c6bc` | Normative specs (`INDEXER.md`, `SDK.md`, `DESIGN.md`) that Sombra Archive and sombra-kit implement; conformance fixtures (`circuits/lib/testdata/*.json`) consumed read-only by the kit test suite; the deployed demo token is built from these contracts. |
| [brozorec/stellar-confidential-token-demo](https://github.com/brozorec/stellar-confidential-token-demo) | MIT | `ac67499a617c084b80c0e0298180b2c4faf9e2fb` | `@ctd/sdk` consumed as a path dependency by the Node-side history scripts (deploy + real proof generation). No demo-app code copied. |
| [NethermindEth/stellar-private-payments](https://github.com/NethermindEth/stellar-private-payments) | Apache-2.0 / LGPLv3 (circuits build) | `a1bf177200b4e9622ca1605dead382c92e49e516` | Studied as reference for the SPP integration surface documented in `docs/INTEGRATION.md`. Not currently a runtime dependency. |

Design tokens (colors, spacing) derive from the team's own prior brand system.
All UI components, the indexer, the recovery engine, and all animations are
original implementations.
