/**
 * SombraClient — the wallet's entire data layer, as an interface.
 *
 * Every screen talks to this and nothing else. The mock implementation in
 * `mockClient.ts` makes the app clickable end to end today; the real one wraps
 * sombra-kit (OZ Confidential Token SDK + Nethermind SPP SDK + Sombra Archive)
 * and drops in behind the same shape with no UI changes.
 *
 * Amounts are always stroops (bigint, 7 decimals) — the on-chain unit. The UI
 * formats at the edge; nothing upstream of a component sees a float.
 */

export type Stroops = bigint;

export interface WalletIdentity {
  address: string;
  network: string;
  networkPassphrase: string;
}

export interface PublicBalance {
  asset: string;
  amount: Stroops;
}

/**
 * The Confidential Token account. `spendable` and `receiving` are the local
 * openings (v, r) of two Pedersen commitments; `commitments` is what an
 * observer reads on-chain in their place. Both describe the same funds — that
 * gap is the product.
 */
export interface ConfidentialBalance {
  registered: boolean;
  spendable: Stroops;
  receiving: Stroops;
  commitments: { spendable: string; receiving: string };
  /** Local openings re-commit to the on-chain points. False means desync. */
  matchesChain: boolean;
  syncedLedger: number;
}

/** A shielded position in a Nethermind SPP pool, held as UTXO notes. */
export interface ShieldedBalance {
  amount: Stroops;
  noteCount: number;
  poolContractId: string;
  tokenLabel: string;
}

export interface ReceiveInfo {
  address: string;
  /** ECDH target senders encrypt transfer openings to. */
  viewingPublicKey: string;
  registered: boolean;
  auditorId: number;
}

export type OperationKind =
  | "transfer"
  | "deposit"
  | "withdraw"
  | "merge"
  | "swap";

export interface TxReceipt {
  hash: string;
  ledger: number;
  kind: OperationKind;
  amount: Stroops;
  /** Present when the amount was encrypted on-chain rather than in the clear. */
  confidential: boolean;
}

export type RecoveryPhase =
  | "derive"
  | "checkpoint"
  | "replay"
  | "verify"
  | "restored";

export interface RecoveryProgress {
  phase: RecoveryPhase;
  /** Sentence shown on the stage. Written for the person, not the log. */
  label: string;
  /** Technical line appended to the replay log. */
  detail: string;
  /** 0–1 across the whole recovery, for the corona. */
  fraction: number;
  eventsReplayed?: number;
  eventsTotal?: number;
}

export interface RecoveryResult {
  address: string;
  eventsReplayed: number;
  fromLedger: number;
  throughLedger: number;
  restored: ConfidentialBalance;
  /** Events that predate the 7-day Soroban RPC window — Archive-only. */
  beyondRpcWindow: number;
  verifiedAgainstChain: boolean;
}

export interface SwapQuote {
  fromAsset: string;
  toAsset: string;
  amountIn: Stroops;
  amountOut: Stroops;
  /** Basis points. */
  priceImpactBps: number;
  route: string[];
}

export interface SwapResult extends SwapQuote {
  /** The single-use address the pool withdraws to before hitting Soroswap. */
  ephemeralAddress: string;
  receipts: TxReceipt[];
}

export interface SombraClient {
  /** Detect Freighter, request access, return the active identity. */
  connectFreighter(): Promise<WalletIdentity>;

  getPublicBalance(): Promise<PublicBalance>;
  getConfidentialBalance(): Promise<ConfidentialBalance>;
  getShieldedBalance(): Promise<ShieldedBalance>;

  /** Confidential Token transfer. The amount never appears on-chain. */
  privateSend(to: string, amount: Stroops): Promise<TxReceipt>;
  receiveInfo(): Promise<ReceiveInfo>;
  /** Fold the receiving balance into spendable. */
  merge(): Promise<TxReceipt>;

  /** Public XLM into the SPP pool. */
  shield(amount: Stroops): Promise<TxReceipt>;
  /** SPP pool back out to a public address. */
  unshield(amount: Stroops, recipient?: string): Promise<TxReceipt>;

  recoverFromSeed(
    seed: string,
    archiveUrl: string,
    onProgress: (p: RecoveryProgress) => void,
  ): Promise<RecoveryResult>;

  quoteSwap(
    fromAsset: string,
    toAsset: string,
    amount: Stroops,
  ): Promise<SwapQuote>;
  privateSwap(
    fromAsset: string,
    toAsset: string,
    amount: Stroops,
  ): Promise<SwapResult>;

  /** True when local openings are missing and the account needs recovery. */
  hasLocalState(): boolean;
  /** Demo control: drop local openings to simulate a lost device. */
  wipeLocalState(): void;
}
