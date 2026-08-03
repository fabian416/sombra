/**
 * The confidential-token event model — INDEXER.md §3.2, DESIGN_cont.md §11.2.
 *
 * Recovery is a fold over this stream, so everything the fold needs to decide
 * about an event is stated once, in {@link EVENT_SPEC}, rather than scattered
 * across the replay engine as `if (type === "transfer")` branches. Each entry
 * answers four questions:
 *
 *   - which topic positions name accounts, and under what role;
 *   - whether the event is a **checkpoint**, and for which role's spendable
 *     balance — a `Transfer` checkpoints its *sender* only, and serving it as
 *     the recipient's would hand a wallet somebody else's `(b̃, σ)`;
 *   - which field carries the operation salt — `sigma` for owner-initiated
 *     operations, **`sigma_a`** for `SpenderTransfer`, whose recipient channel
 *     is keyed by the allowance salt (DESIGN.md §7.8 O7/O9);
 *   - which role, if any, the event credits on the receiving side.
 *
 * The table is derived from the Rust `#[contractevent]` declarations, which are
 * the canonical source — the reference SDK's own event list is a subset that
 * omits the three spender events (INTEGRATION.md §B.1).
 *
 * **Nothing here decodes positionally.** soroban-sdk 27 publishes event data as
 * an `ScMap` keyed by field-name symbols and canonical XDR sorts those keys, so
 * wire order is alphabetical rather than declaration order. Fields are read by
 * name, always.
 */
import { assertCanonicalFr, fromBytesBE } from "./crypto/field.js";
import { type Point, assertOnCurve, pointFromBytes } from "./crypto/grumpkin.js";
import {
  type ScVal,
  decodeScVal,
  scAddress,
  scBytes,
  scInt,
  scMapFields,
  scSymbol,
} from "./xdr/scval.js";

export type ConfidentialEventType =
  | "register"
  | "deposit"
  | "merge"
  | "withdraw"
  | "transfer"
  | "spender_transfer"
  | "set_spender"
  | "revoke_spender";

interface EventSpec {
  /** `#[topic]` fields in declaration order, following the event-name symbol. */
  readonly topics: readonly string[];
  /** Role whose spendable balance this event's `(b̃, σ)` belongs to. */
  readonly checkpointOwner?: string;
  /** Data field holding the operation salt. */
  readonly saltField?: string;
  /** Role whose receiving balance this event credits. */
  readonly creditsRole?: string;
}

export const EVENT_SPEC: Readonly<Record<ConfidentialEventType, EventSpec>> = {
  register: { topics: ["account"] },
  deposit: { topics: ["from", "to"], creditsRole: "to" },
  // Merge carries no data at all and no proof, so no (b̃, σ) can be bound to
  // the post-merge commitment (DESIGN.md §7.4). It is not a checkpoint — but
  // it is the T_0 anchor, being the only event that resets C_receive.
  merge: { topics: ["account"] },
  withdraw: { topics: ["from", "to"], checkpointOwner: "from", saltField: "sigma" },
  transfer: {
    topics: ["from", "to"],
    checkpointOwner: "from",
    saltField: "sigma",
    creditsRole: "to",
  },
  // Never a checkpoint: it carries no b_tilde, and its sender-channel field
  // `a_tilde_aud_s` is an *allowance* ciphertext, not a balance one.
  spender_transfer: {
    topics: ["spender", "from", "to"],
    saltField: "sigma_a",
    creditsRole: "to",
  },
  set_spender: { topics: ["account", "spender"], checkpointOwner: "account", saltField: "sigma" },
  revoke_spender: { topics: ["account", "spender"], checkpointOwner: "account", saltField: "sigma" },
};

export const CHECKPOINT_TYPES: readonly ConfidentialEventType[] = (
  Object.keys(EVENT_SPEC) as ConfidentialEventType[]
).filter((t) => EVENT_SPEC[t].checkpointOwner !== undefined);

/**
 * Every type recovery needs to see. Used as the `types` filter on archive
 * queries — narrowing the transfer, not the attribution (INDEXER.md §6).
 */
export const RECOVERY_EVENT_TYPES: readonly ConfidentialEventType[] = Object.keys(
  EVENT_SPEC,
) as ConfidentialEventType[];

export function isConfidentialEventType(name: string): name is ConfidentialEventType {
  return Object.hasOwn(EVENT_SPEC, name);
}

/**
 * Position in the canonical total order of INDEXER.md §3.4.
 *
 * `tx_application_order` is the middle component and is not derivable from the
 * transaction hash, which is why it is carried explicitly. Ordering by ledger
 * alone silently corrupts every opening whenever a merge and a deposit land in
 * the same ledger.
 */
export interface EventPosition {
  ledgerSeq: number;
  txApplicationOrder: number;
  opIndex: number;
  eventIndex: number;
}

/** An event as served, before decoding. Both sources normalize into this. */
export interface RawEvent extends EventPosition {
  /** The §2 id `(ledger_seq, tx_hash, event_index)`. Stable across sources. */
  id: string;
  /**
   * The RPC's own event id. INDEXER.md §2 requires the §2 triple to match
   * across sources, but the RPC id is finer-grained (it separates a
   * transaction's fee-phase and application-phase events), so it is the better
   * dedup key at the seam when both sources supply it.
   */
  sourceEventId?: string | null;
  contractId: string;
  txHash: string;
  ledgerCloseTime?: number | null;
  topicsXdr: string[];
  dataXdr: string | null;
}

export interface ConfidentialEvent extends EventPosition {
  id: string;
  sourceEventId?: string | null;
  contractId: string;
  txHash: string;
  ledgerCloseTime?: number | null;
  type: ConfidentialEventType;
  /** Role → address, from topics only (INDEXER.md §3.3). */
  participants: Readonly<Record<string, string>>;
  /** Data fields by name. Empty for `merge`. */
  data: ReadonlyMap<string, ScVal>;
}

/** Thrown for an event outside the recovery scope, so callers can skip it. */
export class UnknownEventType extends Error {
  constructor(readonly eventType: string) {
    super(`event type "${eventType}" is not in the recovery scope of INDEXER.md §3.2`);
  }
}

/**
 * Decode one served record.
 *
 * Attribution comes from the topics and nothing else — never from the
 * transaction source account (INDEXER.md §3.3, a MUST). The archive already
 * serves decoded `accounts`, but they are re-derived here from the verbatim XDR:
 * the archive is trusted for availability only (§7), and re-deriving means a
 * mislabelled role cannot silently redirect a credit.
 */
export function decodeEvent(raw: RawEvent): ConfidentialEvent {
  if (raw.topicsXdr.length === 0) throw new Error(`event ${raw.id} has no topics`);
  const topics = raw.topicsXdr.map(decodeScVal);
  const name = scSymbol(topics[0], `event ${raw.id} topic 0`);
  if (!isConfidentialEventType(name)) throw new UnknownEventType(name);

  const spec = EVENT_SPEC[name];
  const participants: Record<string, string> = {};
  for (let i = 0; i < spec.topics.length; i++) {
    const role = spec.topics[i]!;
    const topic = topics[i + 1];
    if (topic === undefined) {
      throw new Error(`event ${raw.id} (${name}) is missing its "${role}" topic`);
    }
    participants[role] = scAddress(topic, `event ${raw.id} topic "${role}"`);
  }

  // `merge` has no data payload; soroban encodes that as ScVoid.
  const data =
    raw.dataXdr === null || raw.dataXdr === ""
      ? new Map<string, ScVal>()
      : decodeEventData(raw.dataXdr, `event ${raw.id} (${name}) data`);

  return {
    id: raw.id,
    sourceEventId: raw.sourceEventId,
    contractId: raw.contractId,
    txHash: raw.txHash,
    ledgerCloseTime: raw.ledgerCloseTime,
    ledgerSeq: raw.ledgerSeq,
    txApplicationOrder: raw.txApplicationOrder,
    opIndex: raw.opIndex,
    eventIndex: raw.eventIndex,
    type: name,
    participants,
    data,
  };
}

function decodeEventData(dataXdr: string, what: string): Map<string, ScVal> {
  const val = decodeScVal(dataXdr);
  if (val.type === "void") return new Map();
  return scMapFields(val, what);
}

/** Decode every record, dropping out-of-scope types (config events, SPP rows). */
export function decodeEvents(raws: readonly RawEvent[]): ConfidentialEvent[] {
  const out: ConfidentialEvent[] = [];
  for (const raw of raws) {
    try {
      out.push(decodeEvent(raw));
    } catch (err) {
      if (err instanceof UnknownEventType) continue;
      throw err;
    }
  }
  return out;
}

// ------------------------------------------------------------------- ordering

/** The §3.4 total order. */
export function compareEvents(a: EventPosition, b: EventPosition): number {
  return (
    a.ledgerSeq - b.ledgerSeq ||
    a.txApplicationOrder - b.txApplicationOrder ||
    a.opIndex - b.opIndex ||
    a.eventIndex - b.eventIndex
  );
}

export function sortEvents<T extends EventPosition>(events: readonly T[]): T[] {
  return [...events].sort(compareEvents);
}

/**
 * Deduplicate by event id, keeping the first occurrence.
 *
 * SDK.md §10.2 makes this a MUST and says why: crediting rules accumulate, so
 * one duplicated incoming transfer inflates the receiving balance and the §7
 * check then fails against a perfectly honest chain. The hybrid seam puts the
 * two legs on disjoint ranges (§12.4), so this should never fire — it is the
 * guard §12.4 nonetheless requires at the boundary.
 */
export function dedupeEvents<T extends { id: string; sourceEventId?: string | null }>(
  events: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    const key = e.sourceEventId ?? e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// ------------------------------------------------------------- role questions

export function participant(e: ConfidentialEvent, role: string): string | undefined {
  return e.participants[role];
}

/**
 * Is this event a checkpoint for `account`? True only when the account holds
 * the *owning* role — the `from` of a transfer or withdrawal, the `account` of
 * a set/revoke. `SpenderTransfer` is never a checkpoint for anyone.
 */
export function isCheckpointFor(e: ConfidentialEvent, account: string): boolean {
  const role = EVENT_SPEC[e.type].checkpointOwner;
  return role !== undefined && e.participants[role] === account;
}

/** Does this event credit `account`'s receiving balance? */
export function creditsAccount(e: ConfidentialEvent, account: string): boolean {
  const role = EVENT_SPEC[e.type].creditsRole;
  return role !== undefined && e.participants[role] === account;
}

/**
 * A `Transfer` whose `from` and `to` are the same account.
 *
 * It is simultaneously a sender-side checkpoint and a recipient-side credit,
 * and DESIGN.md §5.2 step 6 requires **both** roles to be applied. The two act
 * on different accumulators, so their order does not matter; applying only one
 * loses the other's update.
 */
export function isSelfTransfer(e: ConfidentialEvent, account: string): boolean {
  return isCheckpointFor(e, account) && creditsAccount(e, account);
}

// ------------------------------------------------------------ field accessors

/**
 * Data fields whose name differs between confidential-token revisions.
 *
 * The module in `stellar-contracts` declares the recipient channel's ephemeral
 * point as `r_e_point`; the revision the CT demo ships — and therefore the WASM
 * this history was created against — declares it `r_e`. The value is identical,
 * the name is not, and reading only one of them turns a perfectly good event
 * into a decode failure. Every name a revision has used is tried, most recent
 * first; the salt and ciphertext fields (`sigma`, `b_tilde`, `v_tilde`) have
 * been stable across both.
 */
const FIELD_ALIASES: Readonly<Record<string, readonly string[]>> = {
  r_e_point: ["r_e_point", "r_e"],
};

function dataField(e: ConfidentialEvent, field: string): { value: ScVal | undefined; what: string } {
  const names = FIELD_ALIASES[field] ?? [field];
  for (const name of names) {
    const value = e.data.get(name);
    if (value !== undefined) return { value, what: `${e.type} event ${e.id} field "${name}"` };
  }
  return { value: undefined, what: `${e.type} event ${e.id} field "${names.join('" / "')}"` };
}

function scalarField(e: ConfidentialEvent, field: string): bigint {
  const { value, what } = dataField(e, field);
  const bytes = scBytes(value, what);
  if (bytes.length !== 32) {
    throw new Error(`${what} should be BytesN<32>, got ${bytes.length} bytes`);
  }
  // The verifier panics `NonCanonicalEncoding` on any non-canonical scalar, so
  // every scalar in a successfully emitted event is the unique canonical
  // representative (SDK.md §4.2). Asserting it turns "the archive served
  // something the chain never emitted" into an error at the boundary.
  return assertCanonicalFr(fromBytesBE(bytes), what);
}

function pointField(e: ConfidentialEvent, field: string): Point {
  const { value, what } = dataField(e, field);
  return assertOnCurve(pointFromBytes(scBytes(value, what)), what);
}

/** The operation salt σ, from whichever field this event type carries it in. */
export function eventSalt(e: ConfidentialEvent): bigint {
  const field = EVENT_SPEC[e.type].saltField;
  if (field === undefined) throw new Error(`${e.type} events carry no salt`);
  return scalarField(e, field);
}

/**
 * The checkpoint payload of DESIGN.md §5.2 step 1: the encrypted balance scalar
 * and the salt that masks it.
 */
export interface CheckpointPayload {
  bTilde: bigint;
  sigma: bigint;
}

export function checkpointPayload(e: ConfidentialEvent): CheckpointPayload {
  if (EVENT_SPEC[e.type].checkpointOwner === undefined) {
    throw new Error(`${e.type} is not a checkpoint event type (INDEXER.md §3.2)`);
  }
  return { bTilde: scalarField(e, "b_tilde"), sigma: eventSalt(e) };
}

/** The recipient-channel payload of DESIGN.md §5.2 step 6. */
export interface IncomingTransferPayload {
  rEPoint: Point;
  vTilde: bigint;
  sigma: bigint;
}

export function incomingTransferPayload(e: ConfidentialEvent): IncomingTransferPayload {
  if (e.type !== "transfer" && e.type !== "spender_transfer") {
    throw new Error(`${e.type} carries no recipient channel`);
  }
  return {
    rEPoint: pointField(e, "r_e_point"),
    vTilde: scalarField(e, "v_tilde"),
    // `spender_transfer` keys its recipient channel by the allowance salt
    // σ_a rather than by a σ of its own (DESIGN.md §7.8 O7/O9).
    sigma: eventSalt(e),
  };
}

/**
 * A deposit's public amount. Deposits commit with **zero blinding**
 * (`c_dep = amount·G`, DESIGN.md §7.3), which is why the replay credits
 * `(amount, 0)` and needs no decryption here.
 */
export function depositAmount(e: ConfidentialEvent): bigint {
  if (e.type !== "deposit") throw new Error(`${e.type} is not a deposit`);
  const amount = scInt(e.data.get("amount"), `deposit event ${e.id} field "amount"`);
  if (amount < 0n) throw new Error(`deposit event ${e.id} has a negative amount`);
  return amount;
}

/** A registration's auditor id. Not needed for replay; surfaced for display. */
export function registerAuditorId(e: ConfidentialEvent): number {
  if (e.type !== "register") throw new Error(`${e.type} is not a registration`);
  return Number(scInt(e.data.get("auditor_id"), `register event ${e.id} field "auditor_id"`));
}
