import { useEffect, useState } from "react";
import { ARCHIVE_URL } from "../state/SombraProvider";
import { formatLedger } from "../lib/format";
import { cx } from "./ui";

interface Health {
  ingestedThrough: number | null;
  latestLedger: number | null;
  lag: number | null;
  /** Oldest ledger the Archive retains — the floor recovery can reach back to. */
  retainsFrom: number | null;
  /** The Archive's own claim that it has no gaps below its tip. */
  holdsFullHistory: boolean | null;
}

type Status = "checking" | "up" | "down";

/**
 * Reads GET {ARCHIVE_URL}/v1/health. The Archive is the only thing standing
 * between a wiped wallet and unspendable funds, so its state is always on
 * screen — but a dead Archive must never break the wallet, so this degrades to
 * a quiet line rather than an alarm.
 */
export function ArchiveStatus() {
  const [status, setStatus] = useState<Status>("checking");
  const [health, setHealth] = useState<Health | null>(null);

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
    const id = setInterval(() => void poll(), 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const lagging = health?.lag !== null && (health?.lag ?? 0) > 12;

  return (
    <footer className="border-t border-limb bg-umbra/85 px-6 py-2.5 backdrop-blur-sm sm:px-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-2">
          <span
            className={cx(
              "size-1.5 rounded-full",
              status === "up" && !lagging && "bg-cyan",
              status === "up" && lagging && "bg-chroma",
              status === "down" && "bg-limb-bright",
              status === "checking" && "bg-ash/50",
            )}
            style={
              // Motion only while genuinely busy. A healthy archive is steady
              // state — the solid dot says everything a pulse would.
              status === "checking"
                ? { animation: "corona-breathe 1.6s ease-in-out infinite" }
                : undefined
            }
            aria-hidden
          />
          <span className="eyebrow text-corona-dim">Sombra Archive</span>
        </span>

        {status === "checking" && (
          <span className="eyebrow text-ash">Consultando</span>
        )}

        {status === "up" && (
          <>
            {health?.ingestedThrough !== null &&
              health?.ingestedThrough !== undefined && (
                <span className="numeral text-[12px] text-ash">
                  ingerido até o ledger{" "}
                  <span className="text-corona-dim">
                    {formatLedger(health.ingestedThrough)}
                  </span>
                </span>
              )}
            {health?.lag !== null && health?.lag !== undefined && (
              <span className="numeral text-[12px] text-ash">
                atraso{" "}
                <span className={lagging ? "text-chroma" : "text-corona-dim"}>
                  {formatLedger(health.lag)}
                </span>{" "}
                {Math.abs(health.lag) === 1 ? "ledger" : "ledgers"}
              </span>
            )}
            {health?.retainsFrom !== null &&
              health?.retainsFrom !== undefined && (
                <span className="numeral text-[12px] text-ash">
                  retém desde{" "}
                  <span className="text-corona-dim">
                    {formatLedger(health.retainsFrom)}
                  </span>
                </span>
              )}
            {health?.holdsFullHistory === false && (
              <span className="text-[12px] text-chroma">
                Lacunas abaixo do topo — a recuperação pode ser recusada.
              </span>
            )}
            {health?.holdsFullHistory === true && (
              <span className="eyebrow text-cyan">Histórico completo</span>
            )}
          </>
        )}

        {status === "down" && (
          <span className="text-[12px] text-ash">
            Fora de alcance em{" "}
            <span className="numeral text-ash/80">{ARCHIVE_URL}</span>. A recuperação
            depende dele — inicie o serviço do Archive.
          </span>
        )}
      </div>
    </footer>
  );
}
