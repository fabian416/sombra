/**
 * A confidential-token chain simulator, for testing replay against something
 * that is not itself the replay engine.
 *
 * Testing a fold by asserting the fold produces what the fold produced is
 * worthless. So this module plays the **other** side of the protocol: it
 * maintains the two Pedersen commitments exactly as the contract does
 * (`storage.rs` — spendable overwritten, receiving homomorphically added to,
 * reset only by merge), performs every operation from the *sender's* point of
 * view per DESIGN.md §7, and emits the events §11.2 specifies.
 *
 * That makes the round trip real: the sender encrypts with `r_e` and the
 * recipient's `PVK`, the recipient decrypts with its own `vk` and the event's
 * `R_e`, and the ECDH commutativity that DESIGN.md §5.3 relies on has to
 * actually hold for a test to pass. `verifyAgainstChain` then compares the
 * replayed opening against points this module computed from the opposite
 * direction — which is exactly what step 7 does against a real chain.
 *
 * Events are encoded to XDR with `@stellar/stellar-base`, not with this
 * package's own writer, so the decode path is exercised against an independent
 * encoder. Data-map keys are inserted in deliberately non-alphabetical order to
 * keep proving that nothing decodes positionally.
 */
import { Address, xdr } from "@stellar/stellar-base";

import { addressToField, encodeStrkey } from "../src/crypto/address.js";
import { fqAdd, toBytes32BE } from "../src/crypto/field.js";
import {
  H,
  type Point,
  commit,
  ecdh,
  pointAdd,
  pointToBytes,
  publicViewingKey,
  scalarMul,
  spendingPublicKey,
} from "../src/crypto/grumpkin.js";
import {
  deriveEphemeralScalar,
  deriveSpendR,
  deriveTransferBlinding,
  encryptAmount,
  encryptBalance,
  vkFromSk,
} from "../src/crypto/poseidon2.js";
import type { RawEvent } from "../src/events.js";
import type { OnChainAccount, Opening } from "../src/replay.js";

export interface SimAccount {
  address: string;
  sk: bigint;
  vk: bigint;
  Y: Point;
  PVK: Point;
  /** The truth the wallet would have kept locally, for cross-checking replay. */
  spendable: Opening;
  receiving: Opening;
  /** What the chain holds. */
  spendableCommitment: Point;
  receivingCommitment: Point;
  auditorId: number;
}

const IDENTITY_POINT: Point = { x: 0n, y: 0n };

/** Deterministic stand-in for an address, so tests read as fixed strings. */
export function testAddress(seed: number): string {
  const payload = new Uint8Array(32);
  for (let i = 0; i < 32; i++) payload[i] = (seed * 31 + i * 7 + 13) & 0xff;
  return encodeStrkey("account", payload);
}

export function testContract(seed = 99): string {
  const payload = new Uint8Array(32);
  for (let i = 0; i < 32; i++) payload[i] = (seed * 17 + i * 5 + 3) & 0xff;
  return encodeStrkey("contract", payload);
}

function bytesVal(b: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(b));
}

function scalarVal(v: bigint): xdr.ScVal {
  return bytesVal(toBytes32BE(v));
}

function pointVal(p: Point): xdr.ScVal {
  return bytesVal(pointToBytes(p));
}

function i128Val(v: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      hi: xdr.Int64.fromString(String(BigInt.asIntN(64, v >> 64n))),
      lo: xdr.Uint64.fromString(String(BigInt.asUintN(64, v))),
    }),
  );
}

export class ChainSim {
  readonly contractId: string;
  readonly addrF: bigint;
  readonly accounts = new Map<string, SimAccount>();
  readonly events: RawEvent[] = [];

  private ledger: number;
  private txOrder = 0;
  /** Salts are per-attempt in the protocol; a counter keeps tests reproducible. */
  private saltCounter = 1n;

  constructor(contractId = testContract(), startLedger = 1000) {
    this.contractId = contractId;
    this.addrF = addressToField(contractId);
    this.ledger = startLedger;
  }

  /** Advance to a new ledger. Events since the last call shared the previous one. */
  nextLedger(): void {
    this.ledger++;
    this.txOrder = 0;
  }

  private salt(): bigint {
    // Not a real sampling procedure — tests need determinism, and §10.4's
    // freshness requirement is about the sender, which is simulated here.
    return (this.saltCounter++ * 0x9e3779b97f4a7c15n) % (1n << 250n);
  }

  private emit(
    type: string,
    topics: string[],
    data: [string, xdr.ScVal][] | null,
    opts: { sameLedger?: boolean } = {},
  ): RawEvent {
    if (opts.sameLedger !== true) this.nextLedger();
    const txOrder = this.txOrder++;
    const txHash = `${type}-${this.ledger}-${txOrder}`.padEnd(64, "0");

    const topicsXdr = [
      xdr.ScVal.scvSymbol(type).toXDR("base64"),
      ...topics.map((t) => new Address(t).toScVal().toXDR("base64")),
    ];
    const dataXdr =
      data === null
        ? xdr.ScVal.scvVoid().toXDR("base64")
        : xdr.ScVal
            .scvMap(
              data.map(
                ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }),
              ),
            )
            .toXDR("base64");

    const event: RawEvent = {
      id: `${this.ledger}-${txHash}-0`,
      sourceEventId: `${this.ledger}-${txOrder}-0`,
      contractId: this.contractId,
      txHash,
      ledgerSeq: this.ledger,
      ledgerCloseTime: 1_700_000_000 + this.ledger * 5,
      txApplicationOrder: txOrder,
      opIndex: 0,
      eventIndex: 0,
      topicsXdr,
      dataXdr,
    };
    this.events.push(event);
    return event;
  }

  account(address: string): SimAccount {
    const a = this.accounts.get(address);
    if (a === undefined) throw new Error(`${address} is not registered in the sim`);
    return a;
  }

  /** DESIGN.md §7.2 — both commitments start at the identity. */
  register(address: string, sk: bigint, auditorId = 0): SimAccount {
    const vk = vkFromSk(sk, this.addrF);
    const acct: SimAccount = {
      address,
      sk,
      vk,
      Y: spendingPublicKey(sk),
      PVK: publicViewingKey(vk),
      spendable: { v: 0n, r: 0n },
      receiving: { v: 0n, r: 0n },
      spendableCommitment: IDENTITY_POINT,
      receivingCommitment: IDENTITY_POINT,
      auditorId,
    };
    this.accounts.set(address, acct);
    this.emit("register", [address], [["auditor_id", xdr.ScVal.scvU32(auditorId)]]);
    return acct;
  }

  /** DESIGN.md §7.3 — deposits commit with zero blinding. */
  deposit(from: string, to: string, amount: bigint): RawEvent {
    const acct = this.account(to);
    acct.receiving = { v: acct.receiving.v + amount, r: acct.receiving.r };
    acct.receivingCommitment = pointAdd(acct.receivingCommitment, commit(amount, 0n));
    return this.emit("deposit", [from, to], [["amount", i128Val(amount)]]);
  }

  /** DESIGN.md §7.4 — fold receiving into spendable, reset receiving. */
  merge(address: string, opts: { sameLedger?: boolean } = {}): RawEvent {
    const acct = this.account(address);
    acct.spendable = {
      v: acct.spendable.v + acct.receiving.v,
      // Blindings accumulate mod q — the same rule the replay engine must use.
      r: fqAdd(acct.spendable.r, acct.receiving.r),
    };
    acct.receiving = { v: 0n, r: 0n };
    acct.spendableCommitment = commit(acct.spendable.v, acct.spendable.r);
    acct.receivingCommitment = IDENTITY_POINT;
    return this.emit("merge", [address], null, opts);
  }

  /**
   * DESIGN.md §7.6 — the sender side of a confidential transfer.
   *
   * The whole ECDH construction runs here from the sender's direction:
   * `r_e` from the sender's own `vk`, `S = r_e · PVK_recipient`, and the two
   * recipient-channel derivations off the shared scalar. A self-transfer
   * (`from === to`) is supported and is the case that has to be applied twice.
   */
  transfer(
    from: string,
    to: string,
    amount: bigint,
    opts: { sameLedger?: boolean } = {},
  ): RawEvent {
    const sender = this.account(from);
    const recipient = this.account(to);
    const sigma = this.salt();

    const rE = deriveEphemeralScalar(sender.vk, sigma);
    const rEPoint = scalarMul(rE, H);
    const s = ecdh(rE, recipient.PVK);
    const rTransfer = deriveTransferBlinding(s, sigma);
    const vTilde = encryptAmount(amount, s, sigma);

    // Sender: spendable is overwritten with deterministic randomness.
    const vNew = sender.spendable.v - amount;
    if (vNew < 0n) throw new Error(`${from} cannot send ${amount}: spendable is ${sender.spendable.v}`);
    const rNew = deriveSpendR(sender.vk, sigma);
    sender.spendable = { v: vNew, r: rNew };
    sender.spendableCommitment = commit(vNew, rNew);
    const bTilde = encryptBalance(vNew, sender.vk, sigma);

    // Recipient: C_transfer is added homomorphically to the receiving side.
    recipient.receiving = {
      v: recipient.receiving.v + amount,
      r: fqAdd(recipient.receiving.r, rTransfer),
    };
    recipient.receivingCommitment = pointAdd(
      recipient.receivingCommitment,
      commit(amount, rTransfer),
    );

    return this.emit(
      "transfer",
      [from, to],
      [
        // Deliberately not alphabetical: nothing may decode positionally.
        ["v_tilde", scalarVal(vTilde)],
        ["b_tilde", scalarVal(bTilde)],
        ["r_e_point", pointVal(rEPoint)],
        ["sigma", scalarVal(sigma)],
        ["v_tilde_aud_r", scalarVal(0n)],
        ["r_tilde_aud_r", scalarVal(0n)],
        ["v_tilde_aud_s", scalarVal(0n)],
        ["b_tilde_aud_s", scalarVal(0n)],
      ],
      opts,
    );
  }

  /** DESIGN.md §7.5 — a checkpoint with a public amount, no recipient channel. */
  withdraw(from: string, to: string, amount: bigint): RawEvent {
    const sender = this.account(from);
    const sigma = this.salt();
    const vNew = sender.spendable.v - amount;
    if (vNew < 0n) throw new Error(`${from} cannot withdraw ${amount}`);
    const rNew = deriveSpendR(sender.vk, sigma);
    sender.spendable = { v: vNew, r: rNew };
    sender.spendableCommitment = commit(vNew, rNew);

    return this.emit(
      "withdraw",
      [from, to],
      [
        ["amount", i128Val(amount)],
        ["b_tilde", scalarVal(encryptBalance(vNew, sender.vk, sigma))],
        ["sigma", scalarVal(sigma)],
        ["r_e_point", pointVal(scalarMul(deriveEphemeralScalar(sender.vk, sigma), H))],
        ["b_tilde_aud_s", scalarVal(0n)],
      ],
    );
  }

  /** Chain state as `getLedgerEntries` would report it. */
  onChain(address: string): OnChainAccount {
    const a = this.account(address);
    return {
      spendingPublicKey: a.Y,
      viewingPublicKey: a.PVK,
      spendableCommitment: a.spendableCommitment,
      receivingCommitment: a.receivingCommitment,
      auditorId: a.auditorId,
    };
  }

  /** Every event, as a per-account archive query would return it (§3.3). */
  eventsFor(address: string): RawEvent[] {
    return this.events.filter((e) => {
      const topics = e.topicsXdr.slice(1).map((t) => {
        const v = xdr.ScVal.fromXDR(t, "base64");
        return Address.fromScVal(v).toString();
      });
      return topics.includes(address);
    });
  }
}
