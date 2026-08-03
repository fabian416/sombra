/**
 * Configuration for Sombra Archive, read from the environment (`.env` is
 * loaded if present). See `.env.example` for the annotated list.
 */
import { config as loadDotenv } from "dotenv";
import path from "node:path";

loadDotenv();

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

export interface Config {
  rpcUrl: string;
  contractIds: string[];
  pollIntervalMs: number;
  pageLimit: number;
  /** `"auto"` resolves to the source's oldest retained ledger at cold start. */
  startLedger: "auto" | number;
  retentionMargin: number;
  /**
   * Ledgers per polling request. Every scan is bounded by an explicit
   * `endLedger` so coverage can be claimed from what the *request* asked the
   * source to scan, never from the node's reported head (INDEXER.md §4).
   */
  pollWindowLedgers: number;
  dbPath: string;
  port: number;
  host: string;
  corsOrigin: string[] | true;
  apiOnly: boolean;
  /** Permit serving a DB stamped as fixture-seeded. Off by default. */
  allowFixtureDb: boolean;
}

export function loadConfig(): Config {
  const contractIds = str("CONTRACT_IDS", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const rawStart = str("START_LEDGER", "auto");
  const startLedger: "auto" | number =
    rawStart === "auto" ? "auto" : Number.parseInt(rawStart, 10);
  if (startLedger !== "auto" && !Number.isFinite(startLedger)) {
    throw new Error(`START_LEDGER must be "auto" or an integer, got ${rawStart}`);
  }

  const rawCors = str("CORS_ORIGIN", "*");
  const corsOrigin: string[] | true =
    rawCors === "*" ? true : rawCors.split(",").map((s) => s.trim()).filter(Boolean);

  const dbPathRaw = str("DB_PATH", "./data/archive.db");

  return {
    rpcUrl: str("RPC_URL", "https://soroban-testnet.stellar.org"),
    contractIds,
    pollIntervalMs: int("POLL_INTERVAL_MS", 5000),
    pageLimit: int("PAGE_LIMIT", 200),
    startLedger,
    retentionMargin: int("RETENTION_MARGIN", 60),
    pollWindowLedgers: Math.max(1, int("POLL_WINDOW_LEDGERS", 1000)),
    dbPath: dbPathRaw === ":memory:" ? dbPathRaw : path.resolve(process.cwd(), dbPathRaw),
    port: int("PORT", 8787),
    host: str("HOST", "0.0.0.0"),
    corsOrigin,
    apiOnly: str("API_ONLY", "0") === "1",
    allowFixtureDb: str("ALLOW_FIXTURE_DB", "0") === "1",
  };
}
