/**
 * LiveSombraClient — the real data layer, over `sombra-kit`.
 *
 * What is live here is exactly what recovery needs and nothing more, because
 * that is the line the whole project is built along: **reconstructing an
 * opening requires no zero-knowledge proof.** Reading the confidential balance
 * is a ledger-entry read plus two Pedersen re-commitments; recovering it is a
 * SEP-0053 signature, an archive query, one ECDH per incoming transfer, and the
 * same two re-commitments. Neither needs a circuit, a witness, or WASM.
 *
 * *Creating* history does need proofs — `register`, `confidential_transfer`,
 * `withdraw` — and that runs in Node, in `scripts/history.ts`, where the prover
 * works with no bundler involved. So the operations below split cleanly:
 *
 * | Method | Live? |
 * |:--|:--|
 * | `connectFreighter` | live — Freighter |
 * | `getPublicBalance` | live — Horizon |
 * | `getConfidentialBalance` | live — RPC ledger entry + local openings, re-committed |
 * | `receiveInfo` | live — the account's on-chain viewing key |
 * | `recoverFromSigner` | live — Freighter → sombra-kit → Archive → chain |
 * | `hasLocalState` / `wipeLocalState` | live — the openings this wallet holds |
 * | `privateSend`, `merge`, `shield`, `unshield`, swaps | **simulated**, see below |
 *
 * The simulated group is delegated to {@link MockSombraClient} so the app stays
 * clickable, and every receipt it returns carries `simulated: true`. That flag
 * is not decoration: a wallet that renders a fabricated transaction hash
 * indistinguishably from a real one is the exact failure this client exists to
 * remove, so the marking travels with the data rather than living in a comment.
 * `getShieldedBalance` reports zero rather than delegating — SPP is out of scope
 * for this build, and this account genuinely holds no shielded position, so
 * zero is the true answer where the mock's number would be an invented one.
 */
import {
  ArchiveClient,
  IncompleteHistoryError,
  RecoveryError,
  RpcClient,
  SeamNotCoveredError,
  base64Decode,
  pointToBytes,
  recoverFromSigner as kitRecover,
  toHex,
  verifyAgainstChain,
  type MessageSigner,
  type OnChainAccount,
  type RecoveryProgress as KitProgress,
} from "sombra-kit";
import { signMessage } from "@stellar/freighter-api";

import type {
  ConfidentialBalance,
  LedgerRange,
  PublicBalance,
  ReceiveInfo,
  RecoveryProgress,
  RecoveryResult,
  ShieldedBalance,
  SombraClient,
  Stroops,
  SwapQuote,
  SwapResult,
  TxReceipt,
  WalletIdentity,
} from "./client";
import { connect as freighterConnect } from "./freighter";
import { MockSombraClient } from "./mockClient";

/** The confidential token this build recovers against. */
const CONTRACT_ID: string =
  import.meta.env.VITE_CT_CONTRACT_ID ??
  "CC2Z2B4X4IIFPEHTAAXSZMXVOFUFLDFQ2HVOOQUY3UTFNNKKZPEK4ZAC";

const RPC_URL: string =
  import.meta.env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org";

const HORIZON_URL: string =
  import.meta.env.VITE_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

/**
 * The demo seam, per REVIEW.md's *demo-timescale* note.
 *
 * An archive started today cannot hold >7-day-old events for a contract
 * deployed today — the RPC it ingests from does not retain them either — so the
 * seam is pinned above this history to make the Archive the source for it. The
 * code path is identical to the natural seam; only the number moves, and
 * `Seam.compressed` carries that fact to anything that renders it.
 */
const DEMO_SEAM_LEDGER: number | undefined =
  import.meta.env.VITE_DEMO_SEAM_LEDGER === undefined
    ? undefined
    : Number(import.meta.env.VITE_DEMO_SEAM_LEDGER);

/** Openings are per (contract, account): a different account is a different key. */
const openingsKey = (account: string): string =>
  `sombra:live:openings:v1:${CONTRACT_ID}:${account}`;

interface StoredOpenings {
  spendable: { v: string; r: string };
  receiving: { v: string; r: string };
  syncedLedger: number;
}

export class LiveSombraClient implements SombraClient {
  private readonly rpc = new RpcClient(RPC_URL);
  private readonly archive: ArchiveClient;
  /** Only for the operations this build does not perform for real. */
  private readonly simulated = new MockSombraClient();
  private identity: WalletIdentity | null = null;

  constructor(readonly archiveUrl: string) {
    this.archive = new ArchiveClient(archiveUrl);
  }

  /** The connected address, or a legible refusal. Every live read needs one. */
  private account(): string {
    if (this.identity === null) {
      throw new Error("Connect Freighter first — every live read is for a specific account.");
    }
    return this.identity.address;
  }

  private readOpenings(account: string): StoredOpenings | null {
    try {
      const raw = localStorage.getItem(openingsKey(account));
      return raw === null ? null : (JSON.parse(raw) as StoredOpenings);
    } catch {
      return null;
    }
  }

  private writeOpenings(account: string, value: StoredOpenings): void {
    try {
      localStorage.setItem(openingsKey(account), JSON.stringify(value));
    } catch {
      /* private browsing: the recovery still succeeded, it just will not persist */
    }
  }

  async connectFreighter(): Promise<WalletIdentity> {
    this.identity = await freighterConnect();
    return this.identity;
  }

  /** A session the provider obtained without prompting (silent restore, preview). */
  adoptIdentity(identity: WalletIdentity): void {
    this.identity = identity;
  }

  async getPublicBalance(): Promise<PublicBalance> {
    const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(this.account())}`);
    if (res.status === 404) return { asset: "XLM", amount: 0n };
    if (!res.ok) throw new Error(`Horizon returned ${res.status} reading the public balance.`);
    const body = (await res.json()) as { balances?: { asset_type: string; balance: string }[] };
    const native = body.balances?.find((b) => b.asset_type === "native");
    // Horizon reports 7-decimal amounts as a decimal string; stroops are integers.
    const stroops =
      native === undefined ? 0n : BigInt(Math.round(Number(native.balance) * 10_000_000));
    return { asset: "XLM", amount: stroops };
  }

  /**
   * The confidential balance: the chain's two Pedersen points, plus whatever
   * openings this wallet still holds for them.
   *
   * `matchesChain` is computed rather than remembered — the stored openings are
   * re-committed and compared against the points just read. That is the same
   * check recovery ends with (DESIGN.md §5.2 step 7), run on every refresh, so
   * a wallet whose local state has drifted says so instead of displaying a
   * number it can no longer spend.
   */
  async getConfidentialBalance(): Promise<ConfidentialBalance> {
    const account = this.account();
    const chain = await this.rpc.confidentialAccount(CONTRACT_ID, account);

    if (chain === null) {
      return {
        registered: false,
        spendable: 0n,
        receiving: 0n,
        commitments: { spendable: "0x", receiving: "0x" },
        matchesChain: false,
        syncedLedger: 0,
      };
    }

    const commitments = commitmentHexes(chain);
    const stored = this.readOpenings(account);
    if (stored === null) {
      // The funds are on-chain and visible as commitments; without the openings
      // they cannot be spent, and nothing local can prove otherwise.
      return {
        registered: true,
        spendable: 0n,
        receiving: 0n,
        commitments,
        matchesChain: false,
        syncedLedger: 0,
      };
    }

    const spendable = { v: BigInt(stored.spendable.v), r: BigInt(stored.spendable.r) };
    const receiving = { v: BigInt(stored.receiving.v), r: BigInt(stored.receiving.r) };
    return {
      registered: true,
      spendable: spendable.v,
      receiving: receiving.v,
      commitments,
      matchesChain: verifyAgainstChain(spendable, receiving, chain).ok,
      syncedLedger: stored.syncedLedger,
    };
  }

  /** SPP is out of scope in this build; zero is the truthful answer, not a stub. */
  async getShieldedBalance(): Promise<ShieldedBalance> {
    return { amount: 0n, noteCount: 0, poolContractId: "", tokenLabel: "XLM" };
  }

  async receiveInfo(): Promise<ReceiveInfo> {
    const account = this.account();
    const chain = await this.rpc.confidentialAccount(CONTRACT_ID, account);
    return {
      address: account,
      viewingPublicKey:
        chain === null ? "" : `0x${toHex(pointToBytes(chain.viewingPublicKey))}`,
      registered: chain !== null,
      auditorId: chain?.auditorId ?? 0,
    };
  }

  /**
   * Rebuild the openings from the enrolled signer — the one flow this client
   * exists for, and the only one that is live end to end.
   *
   * The phases the UI renders are the kit's own, reported as the work happens:
   * `derive` while Freighter signs and the derived `Y` is checked against the
   * registered spending key, `checkpoint` across the archive/RPC seam, `replay`
   * over the events actually served, `verify` re-committing against chain. No
   * timeline, no easing curve — if a phase is slow on screen it is slow in fact.
   */
  async recoverFromSigner(
    _archiveUrl: string,
    onProgress: (p: RecoveryProgress) => void,
  ): Promise<RecoveryResult> {
    const account = this.account();
    const signer = freighterSigner(account);

    const forward = (p: KitProgress): void =>
      onProgress({
        phase: p.phase,
        label: p.label,
        detail: p.detail,
        fraction: p.fraction,
        eventsReplayed: p.eventsReplayed,
        eventsTotal: p.eventsTotal,
      });

    try {
      const result = await kitRecover({
        signer,
        contractId: CONTRACT_ID,
        account,
        rpc: this.rpc,
        archive: this.archive,
        overrideSeamLedger: DEMO_SEAM_LEDGER,
        onProgress: forward,
      });

      const coverage = result.archiveCoverage.map(toUiRange);

      // Persist only what verified. An unverified opening is not a balance the
      // wallet may show as its own on the next refresh.
      if (result.verifiedAgainstChain) {
        this.writeOpenings(account, {
          spendable: {
            v: result.restored.spendable.v.toString(),
            r: result.restored.spendable.r.toString(),
          },
          receiving: {
            v: result.restored.receiving.v.toString(),
            r: result.restored.receiving.r.toString(),
          },
          syncedLedger: result.restored.syncedLedger,
        });
      }

      return {
        address: account,
        eventsReplayed: result.eventsReplayed,
        fromLedger: result.fromLedger,
        throughLedger: result.throughLedger,
        restored: {
          registered: result.restored.registered,
          spendable: result.restored.spendable.v,
          receiving: result.restored.receiving.v,
          commitments: result.restored.commitments,
          matchesChain: result.restored.matchesChain,
          syncedLedger: result.restored.syncedLedger,
        },
        // Events no RPC could have served — *not* everything below the seam,
        // which with a compressed demo seam is a larger and different number.
        beyondRpcWindow: result.beyondRpcWindow,
        verifiedAgainstChain: result.verifiedAgainstChain,
        complete: result.complete,
        archiveCoverage: coverage,
        ...(result.verifiedAgainstChain ? {} : { failure: "verification" as const }),
      };
    } catch (err) {
      // SDK.md §12.3: an archive that is honestly missing ledgers is a
      // different outcome from one that served the range and failed to verify.
      // They reach the UI as different failures, never as one refusal.
      if (err instanceof IncompleteHistoryError) {
        const coverage = err.coverage.map(toUiRange);
        onProgress({
          phase: "checkpoint",
          label: "The Archive is missing part of your history",
          detail: err.message,
          fraction: 0.35,
          complete: false,
          archiveCoverage: coverage,
        });
        return {
          address: account,
          eventsReplayed: 0,
          fromLedger: err.partial.archiveLeg.fromLedger,
          throughLedger: err.partial.seam.headLedger,
          restored: await this.getConfidentialBalance(),
          beyondRpcWindow: 0,
          verifiedAgainstChain: false,
          complete: false,
          archiveCoverage: coverage,
          failure: "incomplete",
          missingRanges: err.gaps.map(toUiRange),
        };
      }
      if (err instanceof SeamNotCoveredError || err instanceof RecoveryError) {
        throw new Error(err.message);
      }
      throw err;
    }
  }

  // ------------------------------------------------------- simulated, marked
  //
  // Every method below returns mock data. They are grouped here rather than
  // scattered so that "what in this client is not real" is one contiguous block
  // a reviewer can read in ten seconds, and each receipt is stamped
  // `simulated: true` so the marking survives into the UI's data.

  async privateSend(to: string, amount: Stroops): Promise<TxReceipt> {
    return simulate(await this.simulated.privateSend(to, amount));
  }

  async merge(): Promise<TxReceipt> {
    return simulate(await this.simulated.merge());
  }

  async shield(amount: Stroops): Promise<TxReceipt> {
    return simulate(await this.simulated.shield(amount));
  }

  async unshield(amount: Stroops, _recipient?: string): Promise<TxReceipt> {
    // The simulation has no recipient to pay, so the argument is dropped here
    // rather than passed to something that would ignore it silently.
    return simulate(await this.simulated.unshield(amount));
  }

  async quoteSwap(fromAsset: string, toAsset: string, amount: Stroops): Promise<SwapQuote> {
    return this.simulated.quoteSwap(fromAsset, toAsset, amount);
  }

  async privateSwap(fromAsset: string, toAsset: string, amount: Stroops): Promise<SwapResult> {
    const result = await this.simulated.privateSwap(fromAsset, toAsset, amount);
    return { ...result, receipts: result.receipts.map(simulate) };
  }

  hasLocalState(): boolean {
    return this.identity !== null && this.readOpenings(this.identity.address) !== null;
  }

  wipeLocalState(): void {
    if (this.identity === null) return;
    // The commitments stay on-chain and the balance stays visible; only the
    // openings go. That is the whole demonstration.
    localStorage.removeItem(openingsKey(this.identity.address));
  }
}

/** Marks a receipt as produced by the simulated path, not by a transaction. */
function simulate(receipt: TxReceipt): TxReceipt {
  return { ...receipt, simulated: true };
}

function toUiRange(r: { fromLedger: number; toLedger: number }): LedgerRange {
  return { from: r.fromLedger, to: r.toLedger };
}

function commitmentHexes(chain: OnChainAccount): { spendable: string; receiving: string } {
  return {
    spendable: `0x${toHex(pointToBytes(chain.spendableCommitment))}`,
    receiving: `0x${toHex(pointToBytes(chain.receivingCommitment))}`,
  };
}

/**
 * Freighter as a SEP-0053 signer.
 *
 * Two shapes have to be handled: Freighter v4 returns the signature as a base64
 * string, v3 as a `Buffer`. Neither is inspected further here — the kit
 * verifies the 64 bytes against the expected `G…` address before deriving
 * anything from them (SDK.md §5.2), so a wallet that signs a different digest,
 * or signs with a different account than the one selected, fails there with a
 * message that names the cause instead of producing a usable-but-wrong key.
 */
export function freighterSigner(publicKey: string): MessageSigner {
  return {
    publicKey,
    async signMessage(message: string): Promise<Uint8Array> {
      const res = await signMessage(message, { address: publicKey });
      if (res.error) {
        throw new Error(
          `Freighter did not sign the recovery message: ${res.error.message ?? String(res.error)}`,
        );
      }
      const signed = res.signedMessage;
      if (signed === null || signed === undefined) {
        throw new Error("Freighter returned no signature for the recovery message.");
      }
      return typeof signed === "string" ? base64Decode(signed) : new Uint8Array(signed);
    },
  };
}
