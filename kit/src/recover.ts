/**
 * `recoverFromSigner` — the one flow this package exists for.
 *
 * It is the assembly of the four layers below it, in the order DESIGN.md §5.2
 * and SDK.md §5.2/§10.9/§12.4 require, with the fail-fast checks placed where
 * they cost least and explain most:
 *
 *   1. **derive** — SDK.md §5.1 + §5.2. Sign, *verify the signature against the
 *      expected signer*, sign again and compare, derive `sk`/`vk`/`Y`/`PVK`.
 *   2. **derive**, still — read the account's on-chain entry and compare the
 *      derived `Y` against `spending_public_key`. One scalar multiplication,
 *      before a single event is fetched. Without it, a wrong signer or wrong
 *      deployment presents as a full recovery that mysteriously fails to
 *      verify several seconds later; with it, it is an immediate, legible
 *      refusal naming the cause.
 *   3. **checkpoint** — sync history across the seam (SDK.md §12.4), fail
 *      closed on archive error or on `complete: false`.
 *   4. **replay** — DESIGN.md §5.2 steps 1–7, T_0 resolved per INDEXER.md §2.
 *   5. **verify** — re-commit both openings against the on-chain points. This
 *      is what makes an untrusted archive safe (INDEXER.md §7).
 *
 * The phase names and the progress shape match `wallet/src/lib/client.ts`
 * exactly, so the wallet renders real phases from real work rather than a
 * scripted timeline.
 */
import { ArchiveClient, type LedgerRange } from "./archive.js";
import { RpcClient } from "./chain.js";
import type { Point } from "./crypto/grumpkin.js";
import { pointToBytes } from "./crypto/grumpkin.js";
import { toHex } from "./crypto/field.js";
import type { ConfidentialEvent } from "./events.js";
import {
  type ConfidentialKeys,
  type DerivationContext,
  type MessageSigner,
  deriveKeysFromSigner,
} from "./keys.js";
import {
  type OnChainAccount,
  type Opening,
  type ReplayResult,
  type VerificationResult,
  replay,
  verifyAgainstChain,
  verifySpendingKey,
} from "./replay.js";
import { type SeamOptions, type SyncResult, syncAccountHistory } from "./seam.js";

/** Matches `wallet/src/lib/client.ts`'s `RecoveryPhase`. */
export type RecoveryPhase = "derive" | "checkpoint" | "replay" | "verify" | "restored";

export interface RecoveryProgress {
  phase: RecoveryPhase;
  /** Sentence shown on the stage. Written for the person, not the log. */
  label: string;
  /** Technical line appended to the replay log. */
  detail: string;
  /** 0–1 across the whole recovery. */
  fraction: number;
  eventsReplayed?: number;
  eventsTotal?: number;
}

export interface RestoredBalance {
  registered: boolean;
  spendable: Opening;
  receiving: Opening;
  /** The on-chain points, hex, as an observer sees them. */
  commitments: { spendable: string; receiving: string };
  /** Local openings re-commit to the on-chain points. */
  matchesChain: boolean;
  syncedLedger: number;
}

export interface RecoveryResult {
  address: string;
  contractId: string;
  keys: ConfidentialKeys;
  restored: RestoredBalance;
  verification: VerificationResult;
  verifiedAgainstChain: boolean;

  eventsReplayed: number;
  fromLedger: number;
  throughLedger: number;

  /**
   * Events genuinely older than the RPC's live retention floor — history that
   * **no RPC could serve**, and therefore the exact measure of what the Archive
   * adds. Distinct from {@link archiveOnly}, which counts everything below the
   * seam: with a compressed demo seam those two differ, and reporting the
   * larger one as "beyond the 7-day window" would be a false claim.
   */
  beyondRpcWindow: number;
  /** Events served by the Archive because they fell below the seam. */
  archiveOnly: number;

  /** SDK.md §12.3 — the completeness signal, propagated rather than swallowed. */
  complete: boolean;
  archiveCoverage: LedgerRange[];
  archiveGaps: LedgerRange[];

  /** SDK.md §10.7 — no spend proof is constructible against this commitment. */
  spendableBlindingUnencodable: boolean;

  /**
   * The served history reached far enough back to anchor T_0 at a merge or at
   * the account's `Register`. False means the archive's range begins after the
   * account was created, so a verification failure is an incompleteness
   * symptom rather than evidence of tampering.
   */
  historyReachesRegistration: boolean;

  sync: SyncResult;
  replay: ReplayResult;
  chain: OnChainAccount;
}

export interface RecoverOptions extends SeamOptions {
  signer: MessageSigner;
  /** The confidential token contract, `C…`. */
  contractId: string;
  /** Defaults to the signer's own address. */
  account?: string;
  rpc: RpcClient | string;
  archive: ArchiveClient | string;
  onProgress?: (p: RecoveryProgress) => void;
  failOnIncomplete?: boolean;
  types?: readonly string[];
}

export class RecoveryError extends Error {
  override readonly name = "RecoveryError";
  constructor(
    message: string,
    readonly phase: RecoveryPhase,
  ) {
    super(message);
  }
}

function pointHex(p: Point): string {
  return `0x${toHex(pointToBytes(p))}`;
}

export async function recoverFromSigner(options: RecoverOptions): Promise<RecoveryResult> {
  const { signer, contractId, account = signer.publicKey, onProgress } = options;

  const rpc = typeof options.rpc === "string" ? new RpcClient(options.rpc) : options.rpc;
  const archive =
    typeof options.archive === "string" ? new ArchiveClient(options.archive) : options.archive;

  const report = (p: RecoveryProgress): void => onProgress?.(p);
  const ctx: DerivationContext = { contractId, account };

  // ------------------------------------------------------------- 1. derive
  report({
    phase: "derive",
    label: "Asking your wallet to sign",
    detail: "SDK.md §5.2 signer root — signing twice to prove the signature is deterministic",
    fraction: 0.04,
  });

  let keys: ConfidentialKeys;
  try {
    keys = await deriveKeysFromSigner(signer, ctx);
  } catch (err) {
    throw new RecoveryError(err instanceof Error ? err.message : String(err), "derive");
  }

  report({
    phase: "derive",
    label: "Rebuilding your keys",
    detail: `sk derived (${keys.rootForm}, j=${keys.rejectionCounter}); vk and Y follow from it`,
    fraction: 0.12,
  });

  // ---- fail fast against chain state before fetching any history.
  const chain = await rpc.confidentialAccount(contractId, account);
  if (chain === null) {
    throw new RecoveryError(
      `${account} has no confidential account on ${contractId} — it was never registered, ` +
        "or it is registered on a different deployment",
      "derive",
    );
  }
  if (!verifySpendingKey(keys.Y, chain)) {
    throw new RecoveryError(
      "the derived spending public key does not match the one this account registered. " +
        "Either the signer holds a different key than the one this account was enrolled with, " +
        "or the account was enrolled under a different derivation — registration is single-use, " +
        "so the key cannot be rotated in place.",
      "derive",
    );
  }

  report({
    phase: "derive",
    label: "Keys match the chain",
    detail: `Y = sk·H matches the registered spending_public_key ${pointHex(chain.spendingPublicKey).slice(0, 18)}…`,
    fraction: 0.18,
  });

  // --------------------------------------------------------- 2. checkpoint
  report({
    phase: "checkpoint",
    label: "Finding your last checkpoint",
    detail: "reading the archive across the RPC seam",
    fraction: 0.24,
  });

  const sync = await syncAccountHistory({
    rpc,
    archive,
    contractId,
    account,
    marginLedgers: options.marginLedgers,
    overrideSeamLedger: options.overrideSeamLedger,
    failOnIncomplete: options.failOnIncomplete,
    types: options.types,
  });

  const belowSeam = sync.events.filter((e) => e.ledgerSeq < sync.seam.ledger).length;
  const beyondRpcWindow = sync.events.filter(
    (e) => e.ledgerSeq < sync.seam.rpcOldestLedger,
  ).length;

  report({
    phase: "checkpoint",
    label: "History retrieved",
    detail:
      `${sync.events.length} events — ${sync.archiveLeg.events} from the archive below ledger ` +
      `${sync.seam.ledger}, ${sync.rpcLeg.events} from RPC above it`,
    fraction: 0.35,
    eventsTotal: sync.events.length,
  });

  // ------------------------------------------------------------- 3. replay
  const result = replay({ account, vk: keys.vk, events: sync.events });

  report({
    phase: "replay",
    label: "Replaying your history",
    detail: describeReplay(result),
    fraction: 0.8,
    eventsReplayed: result.eventsApplied,
    eventsTotal: sync.events.length,
  });

  // ------------------------------------------------------------- 4. verify
  report({
    phase: "verify",
    label: "Checking against the chain",
    detail: "re-committing both openings and comparing with the on-chain points",
    fraction: 0.9,
    eventsReplayed: result.eventsApplied,
    eventsTotal: sync.events.length,
  });

  /**
   * Did the served history reach far enough back to anchor T_0?
   *
   * `stream-start` means neither a merge before the checkpoint nor the account's
   * `Register` was in the range, so the receiving side was replayed from
   * wherever the stream happened to begin. An archive that cold-started above
   * the account's registration produces exactly this, and it is the failure
   * REVIEW.md B4 describes — reached by configuration or, on a fixed demo
   * history, simply by waiting for the RPC retention floor to pass the
   * contract's deploy ledger.
   *
   * Step 7 still catches it: a short receiving side cannot re-commit to the
   * on-chain point. But it catches it as a *mismatch*, which reads identically
   * to tampering — the conflation SDK.md §12.3 exists to prevent. So the cause
   * is named in the detail rather than left for the reader to guess.
   */
  const historyReachesRegistration = result.t0Anchor !== "stream-start";

  const checked = verifyAgainstChain(result.spendable, result.receiving, chain);
  const verification: VerificationResult =
    checked.ok || historyReachesRegistration
      ? checked
      : {
          ...checked,
          detail:
            `${checked.detail}. The served history does not reach this account's Register, ` +
            "so the likeliest cause is an archive range that begins after the account was " +
            "created — not a tampered history.",
        };

  const restored: RestoredBalance = {
    registered: true,
    spendable: result.spendable,
    receiving: result.receiving,
    commitments: {
      spendable: pointHex(chain.spendableCommitment),
      receiving: pointHex(chain.receivingCommitment),
    },
    matchesChain: verification.ok,
    syncedLedger: sync.seam.headLedger,
  };

  report({
    phase: verification.ok ? "restored" : "verify",
    label: verification.ok ? "Your funds are spendable again" : "Recovery could not be verified",
    detail: verification.detail,
    fraction: 1,
    eventsReplayed: result.eventsApplied,
    eventsTotal: sync.events.length,
  });

  return {
    address: account,
    contractId,
    keys,
    restored,
    verification,
    verifiedAgainstChain: verification.ok,
    eventsReplayed: result.eventsApplied,
    fromLedger: result.window.fromLedger,
    throughLedger: sync.seam.headLedger,
    beyondRpcWindow,
    archiveOnly: belowSeam,
    complete: sync.complete,
    archiveCoverage: sync.coverage,
    archiveGaps: sync.gaps,
    spendableBlindingUnencodable: result.spendableBlindingUnencodable,
    historyReachesRegistration,
    sync,
    replay: result,
    chain,
  };
}

function describeReplay(r: ReplayResult): string {
  const anchor =
    r.t0Anchor === "merge"
      ? `T_0 = merge at ledger ${r.t0?.ledgerSeq}`
      : r.t0Anchor === "register"
        ? `T_0 = register at ledger ${r.t0?.ledgerSeq} (no merge before the checkpoint)`
        : "T_0 unresolved — the history does not reach registration";
  return (
    `${anchor}; ${r.counts.deposits} deposits, ${r.counts.incomingTransfers} incoming transfers, ` +
    `${r.counts.merges} merges folded, ${r.counts.checkpointsSkipped} checkpoints skipped`
  );
}

/** Convenience for a caller that already holds keys — skips phase 1. */
export async function recoverWithKeys(options: {
  keys: ConfidentialKeys;
  contractId: string;
  account: string;
  rpc: RpcClient;
  archive: ArchiveClient;
  events?: readonly ConfidentialEvent[];
}): Promise<{ replay: ReplayResult; verification: VerificationResult; chain: OnChainAccount }> {
  const chain = await options.rpc.confidentialAccount(options.contractId, options.account);
  if (chain === null) throw new RecoveryError("account is not registered", "derive");
  const events =
    options.events ??
    (await syncAccountHistory({
      rpc: options.rpc,
      archive: options.archive,
      contractId: options.contractId,
      account: options.account,
    })).events;
  const result = replay({ account: options.account, vk: options.keys.vk, events });
  return {
    replay: result,
    verification: verifyAgainstChain(result.spendable, result.receiving, chain),
    chain,
  };
}
