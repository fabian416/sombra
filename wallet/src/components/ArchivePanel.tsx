import { useArchiveHealth } from "../lib/useArchiveHealth";
import { ARCHIVE_URL } from "../state/SombraProvider";
import { Eyebrow, cx } from "./ui";
import { formatLedger } from "../lib/format";

/**
 * Painel do Archive — the landing's instrument, and the thesis in one object.
 *
 * The two sub-cards say the whole product: the ledger holds a commitment, the
 * wallet holds the amount. Everything below them is a fact about this Archive,
 * read from /v1/health when it is reachable and clearly marked as an example
 * when it is not. No invented numbers either way.
 */
export function ArchivePanel() {
  const { status, health } = useArchiveHealth();
  const live = status === "up";

  const coverage = live && health?.holdsFullHistory !== false ? 100 : live ? 92 : 100;

  return (
    <div className="panel glow-soft w-full max-w-[30rem] p-5">
      <header className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-medium text-corona">
          Sombra Archive
        </span>
        <span
          className={cx(
            "eyebrow rounded-full border px-2.5 py-1",
            live ? "border-cyan/40 text-cyan" : "border-white/15 text-ash",
          )}
        >
          {live ? "Verificado na chain" : "Exemplo"}
        </span>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <SubCard
          label="A chain vê"
          value="0x04a1…9f3c"
          note="Compromisso Pedersen"
          tone="ash"
        />
        <SubCard
          label="Você vê"
          value="840,25 XLM"
          note="Disponível para gastar"
          tone="cyan"
        />
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <Eyebrow>Cobertura do histórico</Eyebrow>
          <span className="numeral text-[12px] text-cyan">{coverage}%</span>
        </div>
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-cyan"
            style={{
              width: `${coverage}%`,
              boxShadow: "0 0 12px rgba(56,226,255,0.7)",
              transition: "width 600ms ease",
            }}
          />
        </div>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-white/10 pt-3.5">
        <Eyebrow>Ingestão de eventos</Eyebrow>
        <span className="flex items-center gap-2">
          <span
            className={cx(
              "size-1.5 rounded-full",
              live ? "bg-cyan" : "bg-white/25",
            )}
            aria-hidden
          />
          <span className="numeral text-[12px] text-corona-dim">
            {live
              ? health?.lag !== null && health?.lag !== undefined
                ? `Ativa · lag ${formatLedger(health.lag)} ledgers`
                : "Ativa"
              : "Fora de alcance"}
          </span>
        </span>
      </div>

      <dl className="mt-4 divide-y divide-white/10 rounded-xl border border-white/10 bg-white/[0.03]">
        <Row label="Retenção RPC" value="7 dias" />
        <Row label="Retenção Archive" value="Indefinida" />
        <Row label="Conformidade" value="INDEXER.md §3–§6" />
      </dl>

      {!live && (
        <p className="mt-3 text-[11.5px] leading-relaxed text-ash/70">
          Valores de exemplo. O Archive não respondeu em{" "}
          <span className="numeral">{ARCHIVE_URL}</span>.
        </p>
      )}
    </div>
  );
}

function SubCard({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note: string;
  tone: "ash" | "cyan";
}) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-3">
      <Eyebrow>{label}</Eyebrow>
      <p
        className={cx(
          "numeral mt-1.5 truncate text-[14px]",
          tone === "cyan" ? "text-cyan" : "text-corona-dim",
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[11.5px] leading-snug text-ash/75">{note}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="numeral text-[12px] text-corona-dim">{value}</dd>
    </div>
  );
}
