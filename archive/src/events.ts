/**
 * Event decoding: the read-side concern INDEXER.md §4 ("Fidelity") separates
 * from storage. Storage keeps verbatim XDR (§3.1); everything here derives
 * queryable columns from it and never replaces it.
 *
 * Two derivations are load-bearing:
 *   - `eventCoords` establishes the §3.4 total order position of an event.
 *   - `attributeTopics` implements §3.3 attribution — from topics only, never
 *     from the transaction source account.
 */
import { Address, xdr } from "@stellar/stellar-sdk";

import type { RawSourceEvent } from "./source.js";

/** Position of an event in the canonical total order of §3.4. */
export interface EventCoords {
  ledgerSeq: number;
  txApplicationOrder: number;
  opIndex: number;
  eventIndex: number;
}

const TOID_OP_MASK = 0xfffn;
const TOID_TX_MASK = 0xfffffn;

/**
 * Decode the ordering triple packed into a Soroban RPC event id.
 *
 * The id is `<toid>-<eventOrder>`, where `toid` is the standard Stellar
 * "total order id": a 64-bit packing of
 *   `ledger_seq << 32 | tx_application_order << 12 | op_index`.
 * `op_index` is always 0 in practice — a Soroban transaction carries a single
 * operation, which is also why `event_index` alone disambiguates within a
 * transaction (§2).
 *
 * This is the fallback path. Nodes that serve `transactionIndex` directly are
 * believed over it; see `eventCoords`.
 */
export function parseEventId(id: string): EventCoords {
  const [toidStr, orderStr] = id.split("-");
  if (toidStr === undefined) throw new Error(`unparseable event id: ${id}`);
  const toid = BigInt(toidStr);
  return {
    ledgerSeq: Number(toid >> 32n),
    txApplicationOrder: Number((toid >> 12n) & TOID_TX_MASK),
    opIndex: Number(toid & TOID_OP_MASK),
    eventIndex: Number(orderStr ?? "0"),
  };
}

/**
 * The §3.4 ordering triple for a source event, preferring the explicit
 * `transactionIndex` / `operationIndex` the RPC serves (protocol 23+) and
 * falling back to the id packing for older nodes.
 *
 * Both agreed on every one of 200 sampled live testnet events, so the fallback
 * is a compatibility path rather than a correction. `ledger` is always taken
 * from the response field, never the id, since it is authoritative there.
 *
 * One quirk the preference has to survive: fee events carry the sentinel
 * `transactionIndex = 0xFFFFF` (they are emitted during fee processing, before
 * any transaction applies). That is a real position — sorting them last within
 * their ledger — not a missing value, so it is passed through untouched.
 */
export function eventCoords(raw: RawSourceEvent): EventCoords {
  const fromId = parseEventId(raw.id);
  return {
    ledgerSeq: raw.ledger,
    txApplicationOrder: raw.transactionIndex ?? fromId.txApplicationOrder,
    opIndex: raw.operationIndex ?? fromId.opIndex,
    eventIndex: fromId.eventIndex,
  };
}

/**
 * The §2 event id: the triple `(ledger_seq, tx_hash, event_index)`. The same
 * event MUST carry the same id whether served from the archive or from RPC, so
 * a hybrid client can deduplicate across the seam — hence a formatting derived
 * only from the triple, not from the RPC's paging token.
 */
export function formatEventId(ledgerSeq: number, txHash: string, eventIndex: number): string {
  return `${ledgerSeq}-${txHash}-${eventIndex}`;
}

/**
 * Roles of the `#[topic]` fields of every event in ingestion scope (§3.2),
 * indexed by the event-name symbol at topic 0. soroban-sdk's
 * `#[contractevent]` publishes topics as `[snake_case(StructName), ...#[topic]
 * fields]`, so this table is the snake_case struct names of the confidential
 * token's events paired with their declared topic order.
 *
 * Events absent from this table are still archived and still attributed — see
 * `attributeTopics`, which falls back to positional role names. That fallback
 * is what lets the same ingestion path serve SPP pool contracts, whose
 * `new_commitment` / `new_nullifier` topics are field elements rather than
 * addresses and so attribute to no account at all (§3.3 permits serving those
 * as a per-contract stream).
 */
export const TOPIC_ROLES: Readonly<Record<string, readonly string[]>> = {
  register: ["account"],
  deposit: ["from", "to"],
  merge: ["account"],
  withdraw: ["from", "to"],
  transfer: ["from", "to"],
  spender_transfer: ["spender", "from", "to"],
  set_spender: ["account", "spender"],
  revoke_spender: ["account", "spender"],
};

/**
 * The checkpoint event types (§3.2) mapped to the topic role naming the
 * account whose spendable balance the published `(b_tilde, sigma)` belongs to.
 *
 * The role matters: a `Transfer` is a checkpoint for its *sender* only. Serving
 * it as the recipient's checkpoint would hand a wallet a `(b_tilde, sigma)`
 * for somebody else's spendable balance, and the recipient's recovery would
 * fail its on-chain commitment check (§7). `SetSpender`/`RevokeSpender` are
 * owner checkpoints only — a spender recovers allowance state from the
 * on-chain delegation entry, not from the archive.
 */
export const CHECKPOINT_OWNER_ROLE: Readonly<Record<string, string>> = {
  withdraw: "from",
  transfer: "from",
  set_spender: "account",
  revoke_spender: "account",
};

export const CHECKPOINT_TYPES: readonly string[] = Object.keys(CHECKPOINT_OWNER_ROLE);

/** One decoded topic, indexed for querying alongside the verbatim XDR. */
export interface TopicRef {
  topicIndex: number;
  /** Declared field name where known (`from`, `to`, …), else `topic1`, `topic2`, … */
  role: string;
  kind: "address" | "scalar" | "other";
  /** `G…`/`C…` strkey for addresses, `0x…` hex for scalars, else a type tag. */
  value: string;
  /**
   * True when this topic names the owner whose spendable balance a checkpoint
   * event publishes (§3.2). Drives the C1 `/checkpoint` query.
   */
  isCheckpointOwner: boolean;
}

function bytesToHex(buf: Buffer | Uint8Array): string {
  return `0x${Buffer.from(buf).toString("hex")}`;
}

/** Decode one topic ScVal into an indexable `(kind, value)` pair. */
function decodeTopic(v: xdr.ScVal): { kind: TopicRef["kind"]; value: string } {
  switch (v.switch()) {
    case xdr.ScValType.scvAddress():
      return { kind: "address", value: Address.fromScVal(v).toString() };
    case xdr.ScValType.scvSymbol():
      return { kind: "other", value: v.sym().toString() };
    case xdr.ScValType.scvString():
      return { kind: "other", value: v.str().toString() };
    case xdr.ScValType.scvBytes():
      return { kind: "scalar", value: bytesToHex(v.bytes()) };
    case xdr.ScValType.scvU32():
      return { kind: "scalar", value: String(v.u32()) };
    case xdr.ScValType.scvI32():
      return { kind: "scalar", value: String(v.i32()) };
    case xdr.ScValType.scvU64():
      return { kind: "scalar", value: v.u64().toString() };
    case xdr.ScValType.scvI64():
      return { kind: "scalar", value: v.i64().toString() };
    case xdr.ScValType.scvU256():
    case xdr.ScValType.scvI256():
    case xdr.ScValType.scvU128():
    case xdr.ScValType.scvI128():
      // Wide integers — SPP commitments and nullifiers land here. Index the
      // verbatim XDR bytes as hex so they stay exact-matchable.
      return { kind: "scalar", value: bytesToHex(v.toXDR()) };
    default:
      return { kind: "other", value: v.switch().name };
  }
}

/** The event-name symbol at topic 0, or `null` if topic 0 is not a symbol. */
export function eventTypeOf(topics: xdr.ScVal[]): string | null {
  const first = topics[0];
  if (first === undefined || first.switch() !== xdr.ScValType.scvSymbol()) return null;
  return first.sym().toString();
}

/**
 * §3.3 attribution. An event belongs to **each** account address appearing in
 * its topics, so a `Transfer` is indexed under both sender and recipient and a
 * `SpenderTransfer` under owner, recipient, and spender.
 *
 * Topic 0 (the event name) is skipped; every later topic is decoded and
 * indexed, addresses included. A self-transfer yields two rows for the same
 * address under different roles — deliberately, since only the `from` row is
 * the checkpoint (that event is simultaneously a sender-side checkpoint and a
 * recipient-side replay event, §3.2).
 */
export function attributeTopics(topics: xdr.ScVal[]): TopicRef[] {
  const eventType = eventTypeOf(topics);
  const roles = eventType === null ? undefined : TOPIC_ROLES[eventType];
  const ownerRole = eventType === null ? undefined : CHECKPOINT_OWNER_ROLE[eventType];

  const out: TopicRef[] = [];
  for (let i = 1; i < topics.length; i++) {
    const topic = topics[i]!;
    const role = roles?.[i - 1] ?? `topic${i}`;
    const { kind, value } = decodeTopic(topic);
    out.push({
      topicIndex: i,
      role,
      kind,
      value,
      isCheckpointOwner: kind === "address" && ownerRole !== undefined && role === ownerRole,
    });
  }
  return out;
}

/** Base64 XDR of each topic — the verbatim payload §3.1 recommends. */
export function topicsToXdr(topics: xdr.ScVal[]): string[] {
  return topics.map((t) => t.toXDR("base64"));
}

/**
 * Decode the base64 topic XDR the source serves. Storage keeps these strings
 * untouched; this is the read-side decode §4 ("Fidelity") allows.
 */
export function topicsFromXdr(topicsXdr: string[]): xdr.ScVal[] {
  return topicsXdr.map((t) => xdr.ScVal.fromXDR(t, "base64"));
}

/**
 * Fold an event-type name to the form stored in `events.event_type`: the
 * snake_case symbol the contract actually publishes at topic 0, confirmed
 * against `stellar-contracts`' `#[contractevent]` structs and the reference
 * SDK's decoder.
 *
 * Callers of the §6 `types` filter tend to have the Rust struct names in hand
 * (`SetSpender`, `SpenderTransfer`) because that is how DESIGN_cont §11.2
 * writes them, so both spellings are accepted and folded to one. The filter is
 * still applied strictly *after* attribution, per §6.
 */
export function normalizeEventType(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return trimmed;
  if (!/[A-Z]/.test(trimmed)) return trimmed;
  return trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}
