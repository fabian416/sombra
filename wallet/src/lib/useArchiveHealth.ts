import { useEffect, useState } from "react";
import { ARCHIVE_URL } from "../state/SombraProvider";

export interface ArchiveHealth {
  ingestedThrough: number | null;
  latestLedger: number | null;
  lag: number | null;
  /** Oldest ledger the Archive retains — how far back recovery can reach. */
  retainsFrom: number | null;
  /** The Archive's own claim that it has no gaps below its tip. */
  holdsFullHistory: boolean | null;
}

export type ArchiveStatusKind = "checking" | "up" | "down";

/**
 * Polls GET {ARCHIVE_URL}/v1/health.
 *
 * Shared by the footer widget and the landing panel so there is one poll and
 * one parser, not two that can disagree on screen. Field names are read
 * defensively in both snake_case and camelCase — the Archive is a sibling
 * workstream and this must not break when it renames a key.
 */
export function useArchiveHealth(intervalMs = 10_000) {
  const [status, setStatus] = useState<ArchiveStatusKind>("checking");
  const [health, setHealth] = useState<ArchiveHealth | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`${ARCHIVE_URL}/v1/health`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(String(res.status));
        const body: Record<string, unknown> = await res.json();
        if (cancelled) return;

        const num = (...keys: string[]): number | null => {
          for (const key of keys) {
            const v = body[key];
            if (typeof v === "number") return v;
            if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
              return Number(v);
            }
          }
          return null;
        };
        const flag = (...keys: string[]): boolean | null => {
          for (const key of keys) {
            const v = body[key];
            if (typeof v === "boolean") return v;
          }
          return null;
        };

        const ingestedThrough = num("ingested_through", "ingestedThrough");
        const latestLedger = num("latest_ledger", "latestLedger", "tip");
        const reported = num("lag", "lag_ledgers", "lagLedgers");

        setHealth({
          ingestedThrough,
          latestLedger,
          lag:
            reported ??
            (latestLedger !== null && ingestedThrough !== null
              ? latestLedger - ingestedThrough
              : null),
          retainsFrom: num("retains_from", "retainsFrom"),
          holdsFullHistory: flag("holds_full_history", "holdsFullHistory"),
        });
        setStatus("up");
      } catch {
        if (cancelled) return;
        setHealth(null);
        setStatus("down");
      }
    };

    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { status, health };
}
