/**
 * End-to-end recovery of a real account, from a signer alone.
 *
 * This is the proof behind the whole submission, run outside the browser so it
 * is checkable in CI and reproducible from a terminal: take the primary demo
 * account's Stellar secret, derive its confidential keys through SDK.md §5,
 * fetch its history from the running Sombra Archive across the seam, replay
 * DESIGN.md §5.2 steps 1–6, and re-commit both openings against the Pedersen
 * points the contract actually holds (step 7).
 *
 * Nothing here authors state. Every event replayed was emitted by
 * `history.ts` in real ledgers under real UltraHonk proofs; this script only
 * reads. And it reads through exactly the code path the browser wallet uses —
 * `sombra-kit`'s `recoverFromSigner`, with `ed25519Signer` standing in for the
 * Freighter prompt. Same derivation, same archive routes, same replay, same
 * verification. If this passes and the wallet does not, the difference is the
 * signer, not the recovery.
 *
 * ## The seam
 *
 * SDK.md §12.4 puts the seam at the RPC's retention floor plus a margin. On
 * testnet today that floor is ~120 960 ledgers back, so the natural seam sits
 * far *below* this history and the RPC would serve all of it — the archive
 * would be asked for a range it correctly reports as outside its coverage, and
 * nothing about the archive's role would be exercised.
 *
 * So the seam is compressed by default: pinned just above the scripted
 * history, which puts every one of the account's events below it and makes the
 * Archive the only source for all of them. The code path is identical — the
 * same `syncAccountHistory`, the same two legs — only the number moves, and
 * the run prints both numbers so the compression is stated rather than hidden.
 * `INDEXER.md`'s point is that the archive must be able to serve history no RPC
 * can; the honest version of that claim on a contract deployed hours ago is
 * "the archive served all of it, and here is the seam that made it do so".
 *
 * Usage:
 *   npm run e2e                     compressed seam (default), primary account
 *   npm run e2e -- --natural        seam from the live RPC floor
 *   npm run e2e -- --account secondary
 *   SOMBRA_SEAM_LEDGER=3954009 npm run e2e
 *   SOMBRA_ARCHIVE_URL=… SOMBRA_RPC_URL=… npm run e2e
 */

import { Keypair } from "@stellar/stellar-sdk";

import {
  ArchiveClient,
  RpcClient,
  RpcError,
  ed25519Signer,
  recoverFromSigner,
  type RecoveryProgress,
} from "../kit/src/index.js";
import { RPC_URL, loadDeployment, loadKeys, type AccountRecord } from "./common.js";

const DEFAULT_ARCHIVE = "http://localhost:8787";

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const archiveUrl = process.env.SOMBRA_ARCHIVE_URL ?? DEFAULT_ARCHIVE;
const rpcUrl = process.env.SOMBRA_RPC_URL ?? RPC_URL;
const which = (option("account") ?? "primary") as "primary" | "secondary";

const pad = (s: string, n = 22): string => s.padEnd(n);
const hex = (v: bigint): string => `0x${v.toString(16)}`;

async function main(): Promise<void> {
  const deployment = loadDeployment();
  const keys = loadKeys();
  const record: AccountRecord | undefined = keys[which];
  if (record === undefined) {
    throw new Error(`.demo-keys.json has no "${which}" account — run \`npm run history\` first`);
  }

  const contractId = deployment.contractId;
  const account = record.public;
  const archive = new ArchiveClient(archiveUrl);
  const rpc = new RpcClient(rpcUrl);

  console.log("Sombra — end-to-end recovery from a signer\n");
  console.log(`  ${pad("contract")}${contractId}`);
  console.log(`  ${pad("account")}${account}  (${which})`);
  console.log(`  ${pad("archive")}${archiveUrl}`);
  console.log(`  ${pad("rpc")}${rpcUrl}`);

  // ---------------------------------------------------------------- sources
  const [archiveHealth, rpcHealth] = await Promise.all([archive.health(), rpc.health()]);
  const contract = archiveHealth.contracts.find((c) => c.contractId === contractId);
  if (contract === undefined) {
    throw new Error(`the archive at ${archiveUrl} does not index ${contractId}`);
  }
  console.log(
    `\n  archive   status=${archiveHealth.status} ingested_through=${archiveHealth.ingestedThrough} ` +
      `lag=${archiveHealth.lagLedgers} ledgers  events=${contract.events} gaps=${contract.gaps.length}`,
  );
  console.log(
    `  rpc       latest=${rpcHealth.latestLedger} oldest=${rpcHealth.oldestLedger} ` +
      `(retention ${rpcHealth.ledgerRetentionWindow} ledgers)`,
  );

  // ------------------------------------------------------------------ seam
  const historyTo = deployment.historyLedgers?.to ?? contract.ingestedThrough ?? 0;
  const envSeam = process.env.SOMBRA_SEAM_LEDGER;
  const overrideSeamLedger = flag("natural")
    ? undefined
    : envSeam !== undefined
      ? Number(envSeam)
      : historyTo + 1;

  const naturalSeam = rpcHealth.oldestLedger + 60;
  console.log(
    `\n  seam      natural=${naturalSeam} (rpc floor ${rpcHealth.oldestLedger} + 60 margin)` +
      (overrideSeamLedger === undefined
        ? "  — using the live floor"
        : `\n            using=${overrideSeamLedger}  COMPRESSED so the archive serves the ` +
          `history below it;\n            the code path is identical, only the number moves`),
  );

  // ------------------------------------------------- C1, asked for directly
  const checkpoint = await archive.checkpoint(contractId, account);
  if (checkpoint.event === null) {
    console.log("\n  C1        no checkpoint — this account has never spent");
  } else {
    const e = checkpoint.event;
    console.log(
      `\n  C1        checkpoint found: ledger ${e.ledgerSeq}, tx ${e.txHash.slice(0, 16)}…, ` +
        `event_index ${e.eventIndex}\n            complete=${checkpoint.complete} ` +
        `coverage=${checkpoint.coverage.map((r) => `${r.fromLedger}–${r.toLedger}`).join(", ")}`,
    );
  }

  // ------------------------------------------------------------- the signer
  // §5.2 requires the SEP-0053 envelope even where the secret is extractable,
  // which is what makes this run and a Freighter prompt reach the same `sk`.
  const kp = Keypair.fromSecret(record.secret);
  const signer = ed25519Signer(new Uint8Array(kp.rawSecretKey()), kp.publicKey());

  console.log("\n  recovery");
  const seen: RecoveryProgress[] = [];
  const result = await recoverFromSigner({
    signer,
    contractId,
    account,
    rpc,
    archive,
    overrideSeamLedger,
    onProgress: (p) => {
      seen.push(p);
      console.log(`    [${String(Math.round(p.fraction * 100)).padStart(3)}%] ${pad(p.phase, 11)}${p.label}`);
      console.log(`            ${p.detail}`);
    },
  });

  // ----------------------------------------------------------------- report
  const r = result.replay;
  console.log("\n  replay");
  console.log(`    ${pad("events served")}${result.sync.events.length}`);
  console.log(
    `    ${pad("  from the archive")}${result.sync.archiveLeg.events} ` +
      `(ledgers ≤ ${result.sync.seam.ledger - 1})`,
  );
  console.log(
    `    ${pad("  from RPC")}${result.sync.rpcLeg.events} (ledgers ≥ ${result.sync.seam.ledger})`,
  );
  console.log(`    ${pad("events replayed")}${result.eventsReplayed}`);
  console.log(
    `    ${pad("  breakdown")}${r.counts.deposits} deposits, ${r.counts.incomingTransfers} ` +
      `incoming transfers, ${r.counts.merges} merges, ${r.counts.checkpointsSkipped} checkpoints skipped`,
  );
  console.log(
    `    ${pad("T_0")}${r.t0Anchor}${r.t0 === null ? "" : ` at ledger ${r.t0.ledgerSeq}`}`,
  );
  console.log(
    `    ${pad("ECDH rule")}${r.ecdhRule}` +
      (r.ecdhRule === "poseidon2"
        ? " (DESIGN.md §2.4)"
        : " (this contract revision's; resolved against the on-chain commitments)"),
  );
  console.log(`    ${pad("window")}${r.window.fromLedger}–${r.window.toLedger}`);
  console.log(`    ${pad("archive complete (C3)")}${result.complete}`);
  console.log(`    ${pad("beyond RPC window")}${result.beyondRpcWindow} events`);

  console.log("\n  restored openings");
  console.log(`    ${pad("spendable v")}${result.restored.spendable.v}`);
  console.log(`    ${pad("spendable r")}${hex(result.restored.spendable.r)}`);
  console.log(`    ${pad("receiving v")}${result.restored.receiving.v}`);
  console.log(`    ${pad("receiving r")}${hex(result.restored.receiving.r)}`);
  console.log(`    ${pad("on-chain spendable")}${result.restored.commitments.spendable}`);
  console.log(`    ${pad("on-chain receiving")}${result.restored.commitments.receiving}`);
  console.log(`    ${pad("spendable proof-able")}${!result.spendableBlindingUnencodable}`);

  // -------------------------------------------- the thesis, in two responses
  await showRetentionContrast(rpc, archive, contractId, account, rpcHealth.oldestLedger);

  console.log(
    `\n  verification  ${result.verification.detail}` +
      `\n                spendable=${result.verification.spendableOk} ` +
      `receiving=${result.verification.receivingOk}`,
  );
  console.log(`\nVERIFIED=${result.verifiedAgainstChain}`);

  if (!result.verifiedAgainstChain) {
    throw new Error("recovery did not verify against chain state");
  }
}

/**
 * The two responses that are the product thesis: ask each source for a range
 * that starts below the RPC's retention floor.
 *
 * What this does and does not show is worth being exact about, because the
 * dishonest version of this demo is one line away. The RPC refuses the range
 * outright with `-32600` — it cannot serve it at any price. The Archive answers
 * the same query, and answers it *honestly*: `complete: false`, because it
 * holds from the contract's deploy ledger and not from the beginning of time,
 * with the events it does hold returned. That contrast is real. What it is not
 * is a claim that these particular events are older than seven days — they are
 * hours old, `beyondRpcWindow` says 0, and the seam that made the Archive serve
 * them was compressed on purpose.
 *
 * Non-fatal: it is evidence, not a precondition.
 */
async function showRetentionContrast(
  rpc: RpcClient,
  archive: ArchiveClient,
  contractId: string,
  account: string,
  rpcOldest: number,
): Promise<void> {
  const belowFloor = Math.max(1, rpcOldest - 1_000);
  console.log(`\n  retention contrast  (from ledger ${belowFloor}, below the RPC floor ${rpcOldest})`);
  try {
    const page = await rpc.getEvents({ startLedger: belowFloor, endLedger: belowFloor + 1, contractIds: [contractId] });
    console.log(`    rpc       answered with ${page.events.length} events`);
  } catch (err) {
    const code = err instanceof RpcError ? err.code : undefined;
    console.log(`    rpc       refused: ${code ?? "?"} ${(err as Error).message}`);
  }
  const held = await archive.accountHistory(contractId, account, { fromLedger: belowFloor });
  console.log(
    `    archive   answered ledgers ${held.fromLedger}–${held.toLedger} with ${held.events.length} ` +
      `events for this account, and reports complete=${held.complete}\n` +
      `              (false is the honest answer: the archive holds from the contract's deploy ` +
      "ledger, not from ledger 1)",
  );
}

main().catch((e) => {
  console.error("\n❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
