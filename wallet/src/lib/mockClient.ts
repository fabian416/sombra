/**
 * MockSombraClient — a full-fidelity stand-in for sombra-kit.
 *
 * It models the thing that actually matters for the demo: on-chain state and
 * local state are stored separately. Wiping local state leaves the commitments
 * on-chain untouched and the funds unspendable — exactly the failure Sombra
 * exists to fix. Recovery rebuilds the openings from the Archive.
 *
 * Latencies are deliberate. Soroban ledgers close in ~5s and proof generation
 * is slow; a demo that resolves instantly teaches the wrong expectations.
 */
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

const CHAIN_KEY = "sombra:mock:chain:v1";
const LOCAL_KEY = "sombra:mock:local:v1";
/** Set by a wipe, cleared by a recovery. Without it, local state self-seeds. */
const WIPED_KEY = "sombra:mock:wiped:v1";

export const DEMO_ADDRESS =
  "GC7XM4YQPFVDMQNL2GQ5KZWJHSPY2DK6TXRB4NWTCMBOJDFVJQ2AL3RE";
const POOL_CONTRACT =
  "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

/** Where the wallet's history begins — the ledger the token was deployed at. */
const DEPLOY_LEDGER = 3_013_364;

interface ChainState {
  address: string;
  publicXlm: string;
  spendable: string;
  receiving: string;
  shielded: string;
  noteCount: number;
  syncedLedger: number;
  /** Total CT events for this account since deployment. */
  eventCount: number;
  /** How many of those have aged out of the 7-day Soroban RPC window. */
  eventsBeyondRpcWindow: number;
}

interface LocalState {
  spendable: string;
  receiving: string;
  syncedLedger: number;
}

const INITIAL_CHAIN: ChainState = {
  address: DEMO_ADDRESS,
  publicXlm: (1_240n * 10_000_000n).toString(),
  spendable: (8_402_500_000n).toString(),
  receiving: (1_200_000_000n).toString(),
  shielded: (4_025_000_000n).toString(),
  noteCount: 7,
  syncedLedger: 3_411_902,
  eventCount: 3_910,
  eventsBeyondRpcWindow: 1_284,
};

function sleep(ms: number): Promise<void> {
  const jitter = ms * (0.85 + Math.random() * 0.3);
  return new Promise((resolve) => setTimeout(resolve, jitter));
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing — the demo still runs, it just won't persist */
  }
}

/**
 * A stable-looking Grumpkin point for a given value. Not cryptography — it only
 * has to look like what an observer reads off the chain, and stay put between
 * renders so the "Chain's view" toggle doesn't shimmer.
 */
function commitmentFor(label: string, value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const input = `${label}:${value}`;
  for (let i = 0; i < input.length; i++) {
    h1 = Math.imul(h1 ^ input.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + input.charCodeAt(i) * (i + 7), 0x85ebca6b) >>> 0;
  }
  let out = "";
  let s1 = h1;
  let s2 = h2;
  for (let i = 0; i < 8; i++) {
    s1 = Math.imul(s1 ^ (s1 >>> 15), 0x2545f491) >>> 0;
    s2 = Math.imul(s2 ^ (s2 >>> 13), 0x9e3779b1) >>> 0;
    out += s1.toString(16).padStart(8, "0") + s2.toString(16).padStart(8, "0");
  }
  return `0x04${out.slice(0, 62)}`;
}

function txHash(seed: string): string {
  return commitmentFor("tx", seed + Math.random()).slice(2, 66);
}

export class MockSombraClient implements SombraClient {
  private simulateGap = false;

  readonly demo = {
    simulateArchiveGap: (on: boolean) => {
      this.simulateGap = on;
    },
    isSimulatingArchiveGap: () => this.simulateGap,
  };

  private chain(): ChainState {
    const stored = read<ChainState>(CHAIN_KEY);
    if (stored) return stored;
    write(CHAIN_KEY, INITIAL_CHAIN);
    return INITIAL_CHAIN;
  }

  private setChain(next: Partial<ChainState>): ChainState {
    const merged = { ...this.chain(), ...next };
    write(CHAIN_KEY, merged);
    return merged;
  }

  /**
   * A fresh visitor gets a working wallet — losing the openings is the demo's
   * deliberate act, not its starting point. Once wiped, it stays wiped until a
   * recovery runs.
   */
  private local(): LocalState | null {
    const stored = read<LocalState>(LOCAL_KEY);
    if (stored) return stored;
    if (localStorage.getItem(WIPED_KEY)) return null;
    return this.ensureLocal();
  }

  private setLocal(next: LocalState): void {
    write(LOCAL_KEY, next);
  }

  /** Seed local state so a first-run demo starts with a working wallet. */
  private ensureLocal(): LocalState {
    const existing = read<LocalState>(LOCAL_KEY);
    if (existing) return existing;
    const chain = this.chain();
    const seeded: LocalState = {
      spendable: chain.spendable,
      receiving: chain.receiving,
      syncedLedger: chain.syncedLedger,
    };
    this.setLocal(seeded);
    return seeded;
  }

  async connectFreighter(): Promise<WalletIdentity> {
    // The wallet connection is real even in mock mode — it is the one wire we
    // want judges to see working against their own extension.
    const identity = await freighterConnect();
    this.setChain({ address: identity.address });
    return identity;
  }

  async getPublicBalance(): Promise<PublicBalance> {
    await sleep(320);
    return { asset: "XLM", amount: BigInt(this.chain().publicXlm) };
  }

  async getConfidentialBalance(): Promise<ConfidentialBalance> {
    await sleep(420);
    const chain = this.chain();
    const local = this.local();
    const commitments = {
      spendable: commitmentFor("spendable", chain.spendable),
      receiving: commitmentFor("receiving", chain.receiving),
    };

    if (!local) {
      // The funds are on-chain and visible as commitments. Without the openings
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

    return {
      registered: true,
      spendable: BigInt(local.spendable),
      receiving: BigInt(local.receiving),
      commitments,
      matchesChain:
        local.spendable === chain.spendable &&
        local.receiving === chain.receiving,
      syncedLedger: local.syncedLedger,
    };
  }

  async getShieldedBalance(): Promise<ShieldedBalance> {
    await sleep(380);
    const chain = this.chain();
    return {
      amount: BigInt(chain.shielded),
      noteCount: chain.noteCount,
      poolContractId: POOL_CONTRACT,
      tokenLabel: "XLM",
    };
  }

  async privateSend(to: string, amount: Stroops): Promise<TxReceipt> {
    const local = this.ensureLocal();
    if (BigInt(local.spendable) < amount) {
      throw new Error("Amount is larger than your spendable balance.");
    }
    // Proof generation, then a ledger close.
    await sleep(1_900);
    const chain = this.chain();
    const nextSpendable = (BigInt(local.spendable) - amount).toString();
    const ledger = chain.syncedLedger + 1;
    this.setChain({
      spendable: nextSpendable,
      syncedLedger: ledger,
      eventCount: chain.eventCount + 1,
    });
    this.setLocal({ ...local, spendable: nextSpendable, syncedLedger: ledger });
    return {
      hash: txHash(to),
      ledger,
      kind: "transfer",
      amount,
      confidential: true,
    };
  }

  async receiveInfo(): Promise<ReceiveInfo> {
    await sleep(220);
    const chain = this.chain();
    return {
      address: chain.address,
      viewingPublicKey: commitmentFor("viewing", chain.address),
      registered: true,
      auditorId: 0,
    };
  }

  async merge(): Promise<TxReceipt> {
    const local = this.ensureLocal();
    const moved = BigInt(local.receiving);
    if (moved === 0n) throw new Error("Your receiving balance is empty.");
    await sleep(1_400);
    const chain = this.chain();
    const nextSpendable = (BigInt(local.spendable) + moved).toString();
    const ledger = chain.syncedLedger + 1;
    this.setChain({
      spendable: nextSpendable,
      receiving: "0",
      syncedLedger: ledger,
      eventCount: chain.eventCount + 1,
    });
    this.setLocal({
      spendable: nextSpendable,
      receiving: "0",
      syncedLedger: ledger,
    });
    return {
      hash: txHash("merge"),
      ledger,
      kind: "merge",
      amount: moved,
      confidential: true,
    };
  }

  async shield(amount: Stroops): Promise<TxReceipt> {
    const chain = this.chain();
    if (BigInt(chain.publicXlm) < amount) {
      throw new Error("Amount is larger than your public balance.");
    }
    // Two output notes and a Merkle insertion — the slowest operation here.
    await sleep(2_600);
    const ledger = chain.syncedLedger + 1;
    this.setChain({
      publicXlm: (BigInt(chain.publicXlm) - amount).toString(),
      shielded: (BigInt(chain.shielded) + amount).toString(),
      noteCount: chain.noteCount + 1,
      syncedLedger: ledger,
    });
    return {
      hash: txHash("shield"),
      ledger,
      kind: "deposit",
      amount,
      confidential: true,
    };
  }

  async unshield(amount: Stroops): Promise<TxReceipt> {
    const chain = this.chain();
    if (BigInt(chain.shielded) < amount) {
      throw new Error("Amount is larger than your shielded balance.");
    }
    await sleep(2_400);
    const ledger = chain.syncedLedger + 1;
    const spentNotes = Math.min(chain.noteCount, 2);
    this.setChain({
      publicXlm: (BigInt(chain.publicXlm) + amount).toString(),
      shielded: (BigInt(chain.shielded) - amount).toString(),
      noteCount: Math.max(0, chain.noteCount - spentNotes + 1),
      syncedLedger: ledger,
    });
    return {
      hash: txHash("unshield"),
      ledger,
      kind: "withdraw",
      amount,
      confidential: true,
    };
  }

  async recoverFromSigner(
    _archiveUrl: string,
    onProgress: (p: RecoveryProgress) => void,
  ): Promise<RecoveryResult> {
    const chain = this.chain();
    const total = chain.eventCount;
    const beyond = chain.eventsBeyondRpcWindow;
    const checkpointLedger = chain.syncedLedger - 41_820;
    const gapped = this.simulateGap;

    // Phase text stays deliberately generic. This implementation makes no
    // Archive request and performs no key derivation, so it must not print
    // route templates or derivation formulas that would read as evidence of
    // work it did not do.

    // 1 — derive keys from the enrolled signer
    onProgress({
      phase: "derive",
      label: "Deriving keys from your signer",
      detail: "requesting the enrolled signature",
      fraction: 0.04,
    });
    await sleep(900);
    onProgress({
      phase: "derive",
      label: "Deriving keys from your signer",
      detail: `viewing key ready · account ${chain.address.slice(0, 8)}…`,
      fraction: 0.16,
    });
    await sleep(500);

    // 2 — checkpoint from the Archive
    onProgress({
      phase: "checkpoint",
      label: "Fetching checkpoint from the Archive",
      detail: "requesting the latest checkpoint for this account",
      fraction: 0.22,
    });
    await sleep(1_100);

    const coverage: LedgerRange[] = gapped
      ? [
          { from: checkpointLedger, to: chain.syncedLedger - 9_000 },
          { from: chain.syncedLedger - 6_500, to: chain.syncedLedger },
        ]
      : [{ from: checkpointLedger, to: chain.syncedLedger }];
    const missing: LedgerRange[] = gapped
      ? [{ from: chain.syncedLedger - 8_999, to: chain.syncedLedger - 6_501 }]
      : [];

    onProgress({
      phase: "checkpoint",
      label: "Fetching checkpoint from the Archive",
      detail: `checkpoint at ledger ${checkpointLedger.toLocaleString("en-US")} · ${beyond.toLocaleString("en-US")} events sit below the RPC retention floor`,
      fraction: 0.32,
      complete: !gapped,
      archiveCoverage: coverage,
    });
    await sleep(600);

    // An Archive that cannot serve the whole range stops the recovery here.
    // Degrading to a partial replay would produce openings that fail
    // verification for a reason the person could not distinguish from tampering.
    if (gapped) {
      const hole = missing[0];
      onProgress({
        phase: "checkpoint",
        label: "The Archive is missing part of your history",
        detail: `no events held for ledgers ${hole.from.toLocaleString("en-US")}–${hole.to.toLocaleString("en-US")}`,
        fraction: 0.32,
        complete: false,
        archiveCoverage: coverage,
      });
      return {
        address: chain.address,
        eventsReplayed: 0,
        fromLedger: DEPLOY_LEDGER,
        throughLedger: chain.syncedLedger,
        restored: await this.getConfidentialBalance(),
        beyondRpcWindow: beyond,
        verifiedAgainstChain: false,
        complete: false,
        archiveCoverage: coverage,
        failure: "incomplete",
        missingRanges: missing,
      };
    }

    // 3 — replay, the part that takes real time
    const startedAt = performance.now();
    const REPLAY_MS = 4_200;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const elapsed = performance.now() - startedAt;
        const ratio = Math.min(1, elapsed / REPLAY_MS);
        // Ease out: the tail of a replay is always slower than the head.
        const eased = 1 - Math.pow(1 - ratio, 1.8);
        const replayed = Math.floor(eased * total);
        onProgress({
          phase: "replay",
          label: "Replaying events since the checkpoint",
          detail: `deposit · transfer · merge · ${replayed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} applied`,
          fraction: 0.32 + eased * 0.42,
          eventsReplayed: replayed,
          eventsTotal: total,
          complete: true,
          archiveCoverage: coverage,
        });
        if (ratio >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // 4 — verify openings against the on-chain commitments
    onProgress({
      phase: "verify",
      label: "Verifying against on-chain commitments",
      detail: "re-committing the rebuilt openings and comparing to the chain",
      fraction: 0.8,
      complete: true,
      archiveCoverage: coverage,
    });
    await sleep(1_200);
    onProgress({
      phase: "verify",
      label: "Verifying against on-chain commitments",
      detail: "spendable and receiving both match",
      fraction: 0.9,
      complete: true,
      archiveCoverage: coverage,
    });
    await sleep(700);

    // 5 — restore
    localStorage.removeItem(WIPED_KEY);
    this.setLocal({
      spendable: chain.spendable,
      receiving: chain.receiving,
      syncedLedger: chain.syncedLedger,
    });
    onProgress({
      phase: "restored",
      label: "Funds restored",
      detail: "openings rebuilt · balance spendable again",
      fraction: 1,
      eventsReplayed: total,
      eventsTotal: total,
      complete: true,
      archiveCoverage: coverage,
    });

    const restored = await this.getConfidentialBalance();
    return {
      address: chain.address,
      eventsReplayed: total,
      fromLedger: DEPLOY_LEDGER,
      throughLedger: chain.syncedLedger,
      restored,
      beyondRpcWindow: beyond,
      verifiedAgainstChain: true,
      complete: true,
      archiveCoverage: coverage,
    };
  }

  async quoteSwap(
    fromAsset: string,
    toAsset: string,
    amount: Stroops,
  ): Promise<SwapQuote> {
    await sleep(500);
    // Indicative rates for the preview; the live build quotes Soroswap.
    const rate = fromAsset === "XLM" ? 0.115 : 8.7;
    const amountOut =
      (amount * BigInt(Math.round(rate * 1_000_000))) / 1_000_000n;
    const afterFee = (amountOut * 9_970n) / 10_000n;
    return {
      fromAsset,
      toAsset,
      amountIn: amount,
      amountOut: afterFee,
      priceImpactBps: 18,
      route: ["SPP pool", "fresh address", "Soroswap", "SPP pool"],
    };
  }

  async privateSwap(
    fromAsset: string,
    toAsset: string,
    amount: Stroops,
  ): Promise<SwapResult> {
    const quote = await this.quoteSwap(fromAsset, toAsset, amount);
    await sleep(3_400);
    const ledger = this.chain().syncedLedger;
    return {
      ...quote,
      ephemeralAddress:
        "GDXQ7T4KJVN2WPHM6ZLRB3SUEYAWJH5FQ2CTMNVPZK4DLWROIYB6XEFA",
      receipts: [
        {
          hash: txHash("swap-out"),
          ledger,
          kind: "withdraw",
          amount,
          confidential: true,
        },
        {
          hash: txHash("swap-exec"),
          ledger: ledger + 1,
          kind: "swap",
          amount: quote.amountOut,
          confidential: false,
        },
        {
          hash: txHash("swap-in"),
          ledger: ledger + 2,
          kind: "deposit",
          amount: quote.amountOut,
          confidential: true,
        },
      ],
    };
  }

  hasLocalState(): boolean {
    return this.local() !== null;
  }

  wipeLocalState(): void {
    localStorage.removeItem(LOCAL_KEY);
    localStorage.setItem(WIPED_KEY, "1");
  }
}
