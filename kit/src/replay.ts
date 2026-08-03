/**
 * The replay engine — DESIGN.md §5.2 *Recovery*, steps 1–7.
 *
 * This is the whole of what makes recovery real, and it is worth stating how
 * little it is: **no zero-knowledge proof is involved.** Reconstructing an
 * opening is a checkpoint lookup, two Poseidon2 hashes, one ECDH per incoming
 * transfer, field addition, and two Pedersen re-commitments compared against
 * chain state. Proving is needed only to *create* history. That asymmetry is
 * why a browser wallet can recover an account without bb.js, a WASM worker, or
 * a single circuit artifact.
 *
 * The two anchors are different, and conflating them is the classic bug:
 *
 *   - **W_spend** is anchored at the latest *checkpoint*, which carries a
 *     self-contained `(b̃, σ)` — one event lookup, no history.
 *   - **W_receive** is anchored at **T_0**, and T_0 is the account's most
 *     recent `Merge` **at or before that checkpoint** — not its most recent
 *     merge overall. INDEXER.md §2 goes out of its way to warn about this:
 *
 *       "Anchoring the receiving side at the account's last `Merge` overall is
 *        not sufficient — a `Merge` after the checkpoint reconstructs the
 *        current receiving opening correctly but leaves the spendable opening
 *        short by the amount that merge folded in, the checkpoint predating it."
 *
 *     The reason is visible in the fold below: a merge inside the replay window
 *     folds the receiving accumulator into the spendable one. Take T_0 to be
 *     the later merge and the credits it folded in are never replayed, so the
 *     spendable side is short by exactly that amount — while the receiving side
 *     still verifies, which is what makes the bug quiet. It fails closed only
 *     at step 7. `test/replay.test.ts` pins this case directly.
 */
import { FR, FQ, fqAdd, fqMod } from "./crypto/field.js";
import { type EcdhRule, type Point, commit, ecdh, pointsEqual } from "./crypto/grumpkin.js";
import { decryptAmount, decryptBalance, deriveSpendR, deriveTransferBlinding } from "./crypto/poseidon2.js";
import {
  type ConfidentialEvent,
  checkpointPayload,
  compareEvents,
  creditsAccount,
  depositAmount,
  incomingTransferPayload,
  isCheckpointFor,
  isSelfTransfer,
  participant,
  sortEvents,
} from "./events.js";

/** A Pedersen commitment opening. `r` is the canonical representative in [0, q). */
export interface Opening {
  v: bigint;
  r: bigint;
}

export const ZERO_OPENING: Opening = { v: 0n, r: 0n };

/** What T_0 turned out to be. `stream-start` means the history was short. */
export type ReplayAnchor = "merge" | "register" | "stream-start";

export interface ReplayInput {
  /** The account being recovered — the strkey, matched against topic roles. */
  account: string;
  /** The viewing key. Both decrypt rules need it; nothing here needs `sk`. */
  vk: bigint;
  /**
   * The account's events. Sorted and deduplicated internally, so a caller that
   * merged two sources does not have to get the boundary exactly right.
   */
  events: readonly ConfidentialEvent[];
  /**
   * Which ECDH rule the *deployment* implements. Defaults to the specified
   * `poseidon2`; a deployment on the demo's contract revision needs `x-only`.
   * Getting it wrong cannot produce a wrong balance — only a step 7 mismatch —
   * which is what lets `recoverFromSigner` resolve it by trying both.
   */
  ecdhRule?: EcdhRule;
}

export interface ReplayResult {
  spendable: Opening;
  receiving: Opening;
  /** The checkpoint that pinned W_spend, or null if the account never spent. */
  checkpoint: ConfidentialEvent | null;
  /** T_0 — the event the receiving side restarts at. */
  t0: ConfidentialEvent | null;
  t0Anchor: ReplayAnchor;
  /** Ledger range of the replay window `(T_0, now]`. */
  window: { fromLedger: number; toLedger: number };
  /** Events in the window that changed an accumulator. */
  eventsApplied: number;
  /** Every event considered, applied or not. */
  eventsConsidered: number;
  counts: {
    deposits: number;
    incomingTransfers: number;
    merges: number;
    checkpointsSkipped: number;
  };
  /**
   * SDK.md §10.7 — the post-merge spendable blinding landed in `[r, q)`, so it
   * has no single-`Field` encoding and **no spend proof can be constructed**
   * against this commitment, even though chain state is well-formed and the §7
   * check below still passes.
   *
   * §10.7 makes surfacing this as its own named state a MUST, precisely because
   * it otherwise presents as an unexplained proving failure. It resolves at the
   * next merge that folds in an inbound *confidential transfer*; an account
   * whose only inflows are deposits stays affected, deposits carrying zero
   * blinding (DESIGN.md §7.3).
   */
  spendableBlindingUnencodable: boolean;
  /** The ECDH rule this replay ran under. */
  ecdhRule: EcdhRule;
}

/**
 * Locate the latest checkpoint for the account: the last event in §3.4 order
 * for which the account holds the *owning* role.
 *
 * A `Transfer` is a checkpoint for its `from` only. Treating it as the
 * recipient's would apply a `(b̃, σ)` bound to somebody else's spendable
 * balance — decrypting to a plausible number that fails step 7.
 */
export function findLatestCheckpoint(
  events: readonly ConfidentialEvent[],
  account: string,
): ConfidentialEvent | null {
  let latest: ConfidentialEvent | null = null;
  for (const e of events) {
    if (!isCheckpointFor(e, account)) continue;
    if (latest === null || compareEvents(e, latest) > 0) latest = e;
  }
  return latest;
}

/**
 * Resolve T_0 — INDEXER.md §2, DESIGN.md §5.2 step 5.
 *
 * The account's most recent `Merge` **at or before** `checkpoint`, or its
 * `Register` if no such merge exists. The `at or before` comparison is against
 * the full §3.4 order key rather than the ledger sequence alone, because a
 * merge and a checkpoint can share a ledger and the ordering within it decides
 * the answer.
 *
 * When `checkpoint` is null the account has never spent, so no merge can
 * precede a checkpoint that does not exist — T_0 is `Register` (step 1's
 * no-checkpoint case).
 */
export function resolveT0(
  events: readonly ConfidentialEvent[],
  account: string,
  checkpoint: ConfidentialEvent | null,
): { t0: ConfidentialEvent | null; anchor: ReplayAnchor } {
  if (checkpoint !== null) {
    let latestMerge: ConfidentialEvent | null = null;
    for (const e of events) {
      if (e.type !== "merge" || participant(e, "account") !== account) continue;
      // "at or before": a merge in the same position as the checkpoint cannot
      // happen (one event per position), so this is effectively strict — but
      // the spec's wording is `<=` and the code says `<=`.
      if (compareEvents(e, checkpoint) > 0) continue;
      if (latestMerge === null || compareEvents(e, latestMerge) > 0) latestMerge = e;
    }
    if (latestMerge !== null) return { t0: latestMerge, anchor: "merge" };
  }

  const register = events.find((e) => e.type === "register" && participant(e, "account") === account);
  if (register !== undefined) return { t0: register, anchor: "register" };

  // No Register in the served history. The archive did not reach back to
  // registration, so the window may be short — the caller surfaces this
  // alongside the completeness signal rather than silently replaying from
  // wherever the stream happens to begin.
  return { t0: null, anchor: "stream-start" };
}

/**
 * Steps 1–6. Returns the reconstructed openings; step 7 is
 * {@link verifyAgainstChain}, kept separate because it needs chain state and
 * this function needs nothing but events and `vk`.
 */
export function replay(input: ReplayInput): ReplayResult {
  const { account, vk, ecdhRule = "poseidon2" } = input;
  const events = sortEvents(input.events);

  // ---- steps 1-4: the spendable side, from the latest checkpoint alone.
  const checkpoint = findLatestCheckpoint(events, account);
  let spendable: Opening = { ...ZERO_OPENING };
  if (checkpoint !== null) {
    const { bTilde, sigma } = checkpointPayload(checkpoint);
    spendable = {
      v: decryptBalance(bTilde, vk, sigma), // step 2
      r: deriveSpendR(vk, sigma), // step 3
    };
  }

  // ---- step 5: T_0, and the receiving side restarting at zero.
  const { t0, anchor } = resolveT0(events, account, checkpoint);
  let receiving: Opening = { ...ZERO_OPENING };

  // ---- step 6: replay the window (T_0, now] in canonical order.
  const counts = { deposits: 0, incomingTransfers: 0, merges: 0, checkpointsSkipped: 0 };
  let eventsApplied = 0;
  let eventsConsidered = 0;

  for (const e of events) {
    // Strictly after T_0: T_0 itself is the reset, not a replayed credit.
    if (t0 !== null && compareEvents(e, t0) <= 0) continue;
    eventsConsidered++;

    let applied = false;

    // A self-transfer is both a checkpoint and a credit, and DESIGN.md §5.2
    // step 6 requires both roles to be applied. So the credit test and the
    // checkpoint test are independent `if`s, never an `else`.
    if (creditsAccount(e, account)) {
      if (e.type === "deposit") {
        // Deposits commit with zero blinding — c_dep = amount·G (§7.3).
        receiving = { v: receiving.v + depositAmount(e), r: receiving.r };
        counts.deposits++;
      } else {
        const { rEPoint, vTilde, sigma } = incomingTransferPayload(e);
        const s = ecdh(vk, rEPoint, ecdhRule);
        receiving = {
          v: receiving.v + decryptAmount(vTilde, s, sigma),
          // Blindings accumulate mod q, never mod r (SDK.md §4.6). Reducing
          // mod r here opens a different commitment about half the time.
          r: fqAdd(receiving.r, deriveTransferBlinding(s, sigma)),
        };
        counts.incomingTransfers++;
      }
      applied = true;
    }

    if (e.type === "merge" && participant(e, "account") === account) {
      // Fold and reset. Values add as exact integers; blindings mod q.
      spendable = { v: spendable.v + receiving.v, r: fqAdd(spendable.r, receiving.r) };
      receiving = { ...ZERO_OPENING };
      counts.merges++;
      applied = true;
    }

    if (isCheckpointFor(e, account)) {
      // Skip the spendable side — step 1 already captured it, and a checkpoint
      // inside the window is superseded by the latest one by construction.
      counts.checkpointsSkipped++;
      if (isSelfTransfer(e, account)) applied = true;
    }

    if (applied) eventsApplied++;
  }

  const last = events[events.length - 1];
  return {
    spendable,
    receiving,
    checkpoint,
    t0,
    t0Anchor: anchor,
    window: {
      fromLedger: t0?.ledgerSeq ?? events[0]?.ledgerSeq ?? 0,
      toLedger: last?.ledgerSeq ?? 0,
    },
    eventsApplied,
    eventsConsidered,
    counts,
    ecdhRule,
    // `r` is already the canonical F_q representative; values in [r, q) are the
    // ones with no single-`Field` encoding.
    spendableBlindingUnencodable: fqMod(spendable.r) >= FR,
  };
}

// ------------------------------------------------------------------- step 7

/** On-chain state, as read from the account's `ContractData` entry. */
export interface OnChainAccount {
  spendingPublicKey: Point;
  viewingPublicKey: Point;
  spendableCommitment: Point;
  receivingCommitment: Point;
  auditorId: number;
}

export interface VerificationResult {
  ok: boolean;
  spendableOk: boolean;
  receivingOk: boolean;
  /**
   * SDK.md §10.6 makes reporting *which* accumulator diverged a MUST — the two
   * have different causes and different remedies. A spendable mismatch points
   * at the checkpoint (wrong `vk`, wrong account, stale checkpoint); a
   * receiving mismatch points at the replay window (a missing event, a
   * duplicate, or a T_0 taken after the checkpoint).
   */
  detail: string;
}

/**
 * Step 7 — re-commit and compare against the on-chain points.
 *
 * This is the entire trust argument for an untrusted archive (INDEXER.md §7,
 * *Integrity fails closed*): a tampered or incomplete history cannot produce a
 * wrong balance that verifies, only a detectable mismatch. It is also why the
 * archive never needs to be trusted for anything but availability.
 */
export function verifyAgainstChain(
  spendable: Opening,
  receiving: Opening,
  chain: Pick<OnChainAccount, "spendableCommitment" | "receivingCommitment">,
): VerificationResult {
  const spendableOk = pointsEqual(commit(spendable.v, spendable.r), chain.spendableCommitment);
  const receivingOk = pointsEqual(commit(receiving.v, receiving.r), chain.receivingCommitment);

  let detail: string;
  if (spendableOk && receivingOk) {
    detail = "both openings re-commit to the on-chain points";
  } else if (!spendableOk && !receivingOk) {
    detail =
      "neither opening matches — the viewing key is for a different account or deployment";
  } else if (!spendableOk) {
    detail =
      "the spendable opening does not match: the checkpoint used was not this account's " +
      "latest, or its (b_tilde, sigma) belongs to another account";
  } else {
    detail =
      "the receiving opening does not match: the replay window is missing events, " +
      "replayed one twice, or resolved T_0 to a merge after the checkpoint";
  }
  return { ok: spendableOk && receivingOk, spendableOk, receivingOk, detail };
}

/**
 * Confirm the derived spending public key is the one the account registered.
 *
 * One scalar multiplication, run before any history is fetched, and it converts
 * the most common failure — right person, wrong signer or wrong deployment —
 * from "recovery completed and then failed to verify" into an immediate,
 * legible refusal.
 */
export function verifySpendingKey(Y: Point, chain: Pick<OnChainAccount, "spendingPublicKey">): boolean {
  return pointsEqual(Y, chain.spendingPublicKey);
}

export { FQ, FR };
