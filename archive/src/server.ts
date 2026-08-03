/**
 * Entrypoint: opens the archive, starts the §4 ingestion loop (unless
 * `API_ONLY=1`), and serves the §6 API.
 *
 * Ingestion and the API share one SQLite handle on purpose. better-sqlite3 is
 * synchronous, so a write transaction cannot interleave with a read on the same
 * connection — reads never observe a half-inserted event and its topic rows.
 */
import { loadConfig } from "./config.js";
import { ArchiveDb } from "./db.js";
import { buildApi } from "./api.js";
import { Ingester } from "./ingest.js";
import { RpcSource } from "./source.js";

function log(msg: string, extra?: Record<string, unknown>): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  process.stdout.write(`[archive] ${msg}${suffix}\n`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new ArchiveDb(cfg.dbPath);
  const source = new RpcSource(cfg.rpcUrl);

  /*
   * Refuse to serve a fixture-seeded database by default. An archive's whole
   * claim is that it holds real chain history; serving authored data over the
   * same API, indistinguishably, would make every conformance property it
   * demonstrates worthless. Opt in explicitly to demo the API without a chain.
   */
  if (db.getSource() === "seeded-fixture" && !cfg.allowFixtureDb) {
    db.close();
    throw new Error(
      `refusing to serve ${cfg.dbPath}: it is stamped source="seeded-fixture" (written by ` +
        `test/fixtures/seed-mock.ts), not ingested from a chain. Set ALLOW_FIXTURE_DB=1 to ` +
        `serve it anyway for a UI demo, or point DB_PATH at an ingested archive.`,
    );
  }

  log("starting", {
    db: cfg.dbPath,
    source: db.getSource(),
    rpc: cfg.rpcUrl,
    contracts: cfg.contractIds.length,
    apiOnly: cfg.apiOnly,
  });

  if (cfg.apiOnly && cfg.contractIds.length > 0) {
    // API_ONLY skips the loop that would otherwise stamp §5 intent.
    try {
      await new Ingester(db, source, cfg, log).recordRetentionIntent();
    } catch (err) {
      log("could not record retention intent", { error: String(err) });
    }
  }

  let ingester: Ingester | null = null;
  if (!cfg.apiOnly && cfg.contractIds.length > 0) {
    ingester = new Ingester(db, source, cfg, log);
    ingester.start();
    log("ingestion loop started", { contracts: cfg.contractIds });
  } else if (cfg.contractIds.length === 0) {
    // The confidential-token contracts are not deployed yet; the API still
    // serves whatever `seed:mock` or an earlier run left in the archive.
    log("no CONTRACT_IDS configured — serving the API without ingestion");
  }

  const app = buildApi(db, cfg, source);
  await app.listen({ port: cfg.port, host: cfg.host });
  log("listening", { url: `http://${cfg.host}:${cfg.port}` });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down", { signal });
    await ingester?.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`[archive] fatal: ${String(err)}\n`);
  process.exit(1);
});
