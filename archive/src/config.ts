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
  dbPath: string;
  port: number;
  host: string;
  corsOrigin: string[] | true;
  apiOnly: boolean;
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
    dbPath: dbPathRaw === ":memory:" ? dbPathRaw : path.resolve(process.cwd(), dbPathRaw),
    port: int("PORT", 8787),
    host: str("HOST", "0.0.0.0"),
    corsOrigin,
    apiOnly: str("API_ONLY", "0") === "1",
  };
}
