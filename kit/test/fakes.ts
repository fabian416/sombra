/**
 * In-memory stand-ins for the Sombra Archive and Stellar RPC, driven by a
 * {@link ChainSim}.
 *
 * They are deliberately faithful about the two things the seam logic depends
 * on: the archive answers only below the seam and stamps every response with a
 * `complete` flag, and the RPC refuses ranges below its retention floor with
 * the real `-32600`. That makes the fail-closed tests meaningful rather than
 * assertions about a mock's return value.
 */
import { Address, xdr } from "@stellar/stellar-base";

import { pointToBytes } from "../src/crypto/grumpkin.js";
import type { RawEvent } from "../src/events.js";
import type { OnChainAccount } from "../src/replay.js";
import type { ChainSim } from "./chainsim.js";

export interface FakeOptions {
  sim: ChainSim;
  rpcUrl?: string;
  archiveUrl?: string;
  /** RPC retention floor. Ledgers below this are refused with -32600. */
  rpcOldestLedger?: number;
  rpcLatestLedger?: number;
  /** What the archive claims under C4. Defaults to the head. */
  ingestedThrough?: number;
  /** C3. When false, every archive page reports `complete: false`. */
  complete?: boolean;
  coverage?: { from_ledger: number; to_ledger: number }[];
  gaps?: { from_ledger: number; to_ledger: number }[];
  /** Make every archive request fail with this HTTP status. */
  archiveFailsWith?: number;
  /** Page size the archive serves, to exercise cursor draining. */
  pageSize?: number;
  /** How the account entry names its fields. Defaults to the deployed naming. */
  accountFieldNaming?: AccountFieldNaming;
}

export const RPC_URL = "https://rpc.test/soroban";
export const ARCHIVE_URL = "https://archive.test";

function serializeEvent(e: RawEvent): Record<string, unknown> {
  return {
    id: e.id,
    source_event_id: e.sourceEventId,
    contract_id: e.contractId,
    ledger_seq: e.ledgerSeq,
    ledger_close_time: e.ledgerCloseTime,
    tx_hash: e.txHash,
    tx_application_order: e.txApplicationOrder,
    op_index: e.opIndex,
    event_index: e.eventIndex,
    topics_xdr: e.topicsXdr,
    data_xdr: e.dataXdr,
  };
}

/**
 * How a `ConfidentialAccount` entry names its fields on the wire.
 *
 * `deployed` is what the contract at `CC2Z…4ZAC` really stores — a struct is an
 * `ScMap` keyed by Rust field names, so the wire form follows the source.
 * `spec` is DESIGN.md's prose naming, which three of the four points do not use.
 * Both are encoded here because `chain.ts` accepts both and the difference is a
 * decode failure, not a wrong number: worth pinning in a test rather than
 * discovering against a live RPC.
 */
export type AccountFieldNaming = "deployed" | "spec";

const ACCOUNT_FIELD_NAMES: Record<AccountFieldNaming, Record<keyof OnChainAccount, string>> = {
  deployed: {
    spendingPublicKey: "spending_key",
    viewingPublicKey: "viewing_public_key",
    spendableCommitment: "spendable_balance",
    receivingCommitment: "receiving_balance",
    auditorId: "auditor_id",
  },
  spec: {
    spendingPublicKey: "spending_public_key",
    viewingPublicKey: "viewing_public_key",
    spendableCommitment: "spendable_commitment",
    receivingCommitment: "receiving_commitment",
    auditorId: "auditor_id",
  },
};

/** Encode chain state the way `getLedgerEntries` serves it. */
export function encodeAccountEntry(
  contractId: string,
  account: string,
  a: OnChainAccount,
  naming: AccountFieldNaming = "deployed",
): string {
  const names = ACCOUNT_FIELD_NAMES[naming];
  const bytes = (b: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(b));
  const entry = (key: string, val: xdr.ScVal): xdr.ScMapEntry =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

  // Canonical XDR sorts map keys, and the two namings sort differently — so the
  // entries are sorted here rather than written in a fixed order.
  const fields = [
    entry(names.auditorId, xdr.ScVal.scvU32(a.auditorId)),
    entry(names.receivingCommitment, bytes(pointToBytes(a.receivingCommitment))),
    entry(names.spendableCommitment, bytes(pointToBytes(a.spendableCommitment))),
    entry(names.spendingPublicKey, bytes(pointToBytes(a.spendingPublicKey))),
    entry(names.viewingPublicKey, bytes(pointToBytes(a.viewingPublicKey))),
  ].sort((x, y) => (x.key().sym().toString() < y.key().sym().toString() ? -1 : 1));

  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: xdr.ExtensionPoint.fromXDR(Buffer.from([0, 0, 0, 0])),
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), new Address(account).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvMap(fields),
    }),
  ).toXDR("base64");
}

export interface FakeBackends {
  fetch: typeof globalThis.fetch;
  /** Every URL requested, in order. Lets tests assert on the two legs. */
  calls: string[];
}

export function makeBackends(options: FakeOptions): FakeBackends {
  const { sim } = options;
  const ledgers = sim.events.map((e) => e.ledgerSeq);
  const head = options.rpcLatestLedger ?? Math.max(...ledgers, 0) + 1;
  const oldest = options.rpcOldestLedger ?? Math.min(...ledgers, head);
  const ingestedThrough = options.ingestedThrough ?? head;
  const complete = options.complete ?? true;
  const pageSize = options.pageSize ?? 1000;
  const calls: string[] = [];

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    // ---------------------------------------------------------------- RPC
    if (url.startsWith(RPC_URL)) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      const ok = (result: unknown): Response => json({ jsonrpc: "2.0", id: body.id, result });

      switch (body.method) {
        case "getHealth":
          return ok({
            status: "healthy",
            oldestLedger: oldest,
            latestLedger: head,
            ledgerRetentionWindow: head - oldest,
          });
        case "getLatestLedger":
          return ok({ sequence: head });
        case "getEvents": {
          const start = Number(body.params.startLedger ?? 0);
          if (start < oldest) {
            // The real refusal, and the whole reason the Archive exists.
            return json({
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: -32600,
                message: `startLedger must be within the ledger range: ${oldest} - ${head}`,
              },
            });
          }
          const end = Number(body.params.endLedger ?? head + 1);
          const events = sim.events.filter((e) => e.ledgerSeq >= start && e.ledgerSeq < end);
          return ok({
            latestLedger: head,
            cursor: null,
            events: events.map((e) => ({
              type: "contract",
              ledger: e.ledgerSeq,
              ledgerClosedAt: new Date((e.ledgerCloseTime ?? 0) * 1000).toISOString(),
              contractId: e.contractId,
              id: `${(BigInt(e.ledgerSeq) << 32n) | (BigInt(e.txApplicationOrder) << 12n)}-${e.eventIndex}`,
              txHash: e.txHash,
              transactionIndex: e.txApplicationOrder,
              operationIndex: e.opIndex,
              topic: e.topicsXdr,
              value: e.dataXdr,
              inSuccessfulContractCall: true,
            })),
          });
        }
        case "getLedgerEntries": {
          const account = [...sim.accounts.keys()].find((a) =>
            String(body.params.keys ?? "").includes("") && sim.accounts.has(a),
          );
          // Match the requested key against every registered account.
          const keys = body.params.keys as string[];
          const entries: unknown[] = [];
          for (const a of sim.accounts.keys()) {
            const expected = xdr.LedgerKey.contractData(
              new xdr.LedgerKeyContractData({
                contract: new Address(sim.contractId).toScAddress(),
                key: xdr.ScVal.scvVec([
                  xdr.ScVal.scvSymbol("Account"),
                  new Address(a).toScVal(),
                ]),
                durability: xdr.ContractDataDurability.persistent(),
              }),
            ).toXDR("base64");
            if (keys.includes(expected)) {
              entries.push({
                key: expected,
                xdr: encodeAccountEntry(
                  sim.contractId,
                  a,
                  sim.onChain(a),
                  options.accountFieldNaming,
                ),
                lastModifiedLedgerSeq: head,
              });
            }
          }
          void account;
          return ok({ latestLedger: head, entries });
        }
        default:
          return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no such method" } });
      }
    }

    // ------------------------------------------------------------ archive
    if (url.startsWith(ARCHIVE_URL)) {
      if (options.archiveFailsWith !== undefined) {
        return new Response("archive is down", { status: options.archiveFailsWith });
      }
      const parsed = new URL(url);
      const path = parsed.pathname;

      if (path === "/v1/health") {
        return json({
          status: "ok",
          latest_ledger: head,
          ingested_through: ingestedThrough,
          lag_seconds: 0,
          lag_ledgers: 0,
          oldest_source_ledger: oldest,
          contracts: [],
        });
      }

      const statusMatch = /^\/v1\/tokens\/([^/]+)\/status$/.exec(path);
      if (statusMatch !== null) {
        return json({
          contract_id: decodeURIComponent(statusMatch[1]!),
          ingested_through: ingestedThrough,
          contiguous_from: Math.min(...ledgers, ingestedThrough),
          events: sim.events.length,
          event_ledger_min: Math.min(...ledgers),
          event_ledger_max: Math.max(...ledgers),
          coverage: options.coverage ?? [
            { from_ledger: Math.min(...ledgers), to_ledger: ingestedThrough },
          ],
          gaps: options.gaps ?? [],
        });
      }

      const eventsMatch = /^\/v1\/tokens\/([^/]+)\/accounts\/([^/]+)\/events$/.exec(path);
      if (eventsMatch !== null) {
        const account = decodeURIComponent(eventsMatch[2]!);
        const to = Number(parsed.searchParams.get("to_ledger") ?? ingestedThrough);
        const from = Number(parsed.searchParams.get("from_ledger") ?? Math.min(...ledgers));
        const all = sim
          .eventsFor(account)
          .filter((e) => e.ledgerSeq >= from && e.ledgerSeq <= to);
        const cursorRaw = parsed.searchParams.get("cursor");
        const offset = cursorRaw === null ? 0 : Number(atob(cursorRaw));
        const page = all.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        return json({
          events: page.map(serializeEvent),
          cursor: nextOffset < all.length ? btoa(String(nextOffset)) : null,
          complete,
          from_ledger: from,
          to_ledger: to,
        });
      }

      return json({ error: `no route for ${path}` }, 404);
    }

    throw new Error(`unexpected fetch to ${url}`);
  };

  return { fetch: fetchImpl, calls };
}
