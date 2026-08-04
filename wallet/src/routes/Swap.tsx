import { useEffect, useState } from "react";
import { ScreenHeader } from "../components/Shell";
import { Button, Eyebrow, Notice, cx } from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { OperationJourney } from "../components/OperationJourney";
import type { SwapQuote, SwapResult } from "../lib/client";
import {
  formatAmount,
  formatLedger,
  parseAmount,
  truncateAddress,
} from "../lib/format";

/**
 * The swap, composed the way the team's bridge composes it: one centered card,
 * origin and destination as two tiles with a flip control between them, a
 * borderless oversized amount, and a single full-width gradient action.
 *
 * The four-hop route stays on screen below the card — the honest part (which
 * hop is public) is the product, not a disclosure to hide in a tooltip.
 */
const ASSETS = ["XLM", "EURC"] as const;
type Asset = (typeof ASSETS)[number];

const ROUTE = [
  { title: "Pool blindado", note: "Saque para um endereço de uso único", exposed: "Valor" },
  { title: "Endereço novo", note: "Nunca usado antes, nunca reutilizado", exposed: "Nada vinculável" },
  { title: "Soroswap", note: "Troca pública por um endereço sem histórico", exposed: "Valor e par" },
  { title: "Pool blindado", note: "O resultado volta como novas notas", exposed: "Valor" },
];

export function Swap() {
  const { client, balances } = useSombra();
  const [fromAsset, setFromAsset] = useState<Asset>("XLM");
  const [toAsset, setToAsset] = useState<Asset>("EURC");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const shielded = balances.shielded?.amount ?? 0n;

  useEffect(() => {
    let cancelled = false;
    let parsed: bigint;
    try {
      parsed = parseAmount(amount);
    } catch {
      setQuote(null);
      return;
    }
    if (parsed === 0n) {
      setQuote(null);
      return;
    }
    const id = setTimeout(() => {
      void client.quoteSwap(fromAsset, toAsset, parsed).then((next) => {
        if (!cancelled) setQuote(next);
      });
    }, 260);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [amount, fromAsset, toAsset, client]);

  const flip = () => {
    setFromAsset(toAsset);
    setToAsset(fromAsset);
    setResult(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    let parsed: bigint;
    try {
      parsed = parseAmount(amount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confira o valor.");
      return;
    }
    if (parsed === 0n) {
      setError("Informe um valor acima de zero.");
      return;
    }
    if (parsed > shielded) {
      setError("O valor é maior que o seu saldo no pool.");
      return;
    }

    setRunning(true);
    try {
      setResult(await client.privateSwap(fromAsset, toAsset, parsed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "A troca não foi concluída.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <OperationJourney op="swap" active={running} succeeded={!!result} />

      <ScreenHeader
        title="Swap"
        lede="Troque de dentro do pool sem amarrar a operação ao seu histórico. Os fundos saem para um endereço sem passado, trocam em público e voltam direto."
      />

      <div className="mb-6">
        <Notice>
          <strong className="font-semibold text-corona-dim">
            Prévia do fluxo.
          </strong>{" "}
          A rota abaixo é o design que o Sombra implementa; a execução aqui roda
          contra o cliente de demonstração.
        </Notice>
      </div>

      <div className="mx-auto w-full max-w-[520px]">
        <form onSubmit={submit} className="panel glow-soft overflow-hidden">
          {/* Origin / destination tiles with the flip between them. */}
          <div className="relative grid grid-cols-2 gap-px bg-white/10">
            <AssetTile
              label="De"
              asset={fromAsset}
              onChange={(a) => {
                setFromAsset(a);
                if (a === toAsset) setToAsset(a === "XLM" ? "EURC" : "XLM");
              }}
            />
            <AssetTile
              label="Para"
              asset={toAsset}
              onChange={(a) => {
                setToAsset(a);
                if (a === fromAsset) setFromAsset(a === "XLM" ? "EURC" : "XLM");
              }}
            />
            <button
              type="button"
              onClick={flip}
              aria-label="Inverter o par"
              className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-umbra text-cyan transition-all hover:border-cyan/50 hover:shadow-[0_0_18px_rgba(56,226,255,0.4)]"
            >
              ⇄
            </button>
          </div>

          {/* The amount: oversized, borderless, with MAX inside. */}
          <div className="border-t border-white/10 px-6 pb-5 pt-6">
            <div className="flex items-baseline justify-between gap-4">
              <Eyebrow>Valor</Eyebrow>
              <button
                type="button"
                onClick={() =>
                  setAmount(formatAmount(shielded, { group: false }))
                }
                className="eyebrow text-cyan/80 transition-colors hover:text-cyan"
              >
                MAX
              </button>
            </div>
            <div className="mt-2 flex items-baseline gap-3">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                inputMode="decimal"
                className="numeral w-full border-0 bg-transparent p-0 text-[38px] leading-none text-corona outline-none placeholder:text-ash/40"
              />
              <span className="eyebrow shrink-0 text-ash">{fromAsset}</span>
            </div>
            <p className="numeral mt-2.5 text-[12px] text-ash">
              {formatAmount(shielded)} {fromAsset === "XLM" ? "XLM" : "no pool"}{" "}
              disponível no pool
            </p>
          </div>

          {/* The quote, when there is one. */}
          {quote && (
            <div className="flex items-center justify-between gap-4 border-t border-white/10 bg-white/[0.03] px-6 py-4">
              <div>
                <Eyebrow>Você recebe, de volta no pool</Eyebrow>
                <div className="numeral mt-1 text-[20px] text-cyan">
                  {formatAmount(quote.amountOut)}{" "}
                  <span className="eyebrow text-ash">{quote.toAsset}</span>
                </div>
              </div>
              <span className="numeral text-[12px] text-ash">
                impacto {(quote.priceImpactBps / 100).toFixed(2)}%
              </span>
            </div>
          )}

          {error && (
            <div className="border-t border-white/10 px-6 py-4">
              <Notice tone="warn">{error}</Notice>
            </div>
          )}

          <div className="border-t border-white/10 px-6 py-5">
            <Button
              type="submit"
              variant="primary"
              busy={running}
              className="w-full py-3.5 text-[14.5px]"
            >
              {running ? "Executando a rota" : "Executar rota →"}
            </Button>
          </div>
        </form>

        {/* The four hops, and what each gives away. */}
        <ol className="mt-6 grid gap-2.5">
          {ROUTE.map((hop, i) => {
            const receipt = result?.receipts[i > 2 ? 2 : i];
            return (
              <li
                key={`${hop.title}-${i}`}
                className="panel flex items-start gap-3.5 px-4 py-3.5"
              >
                <span
                  className={cx(
                    "numeral mt-0.5 w-5 shrink-0 text-[11px]",
                    result ? "text-cyan" : "text-limb-bright",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-[13.5px] text-corona">{hop.title}</span>
                    <span
                      className={cx(
                        "eyebrow",
                        hop.exposed === "Nada vinculável"
                          ? "text-pool"
                          : "text-cyan",
                      )}
                    >
                      {hop.exposed}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] leading-snug text-ash">
                    {hop.note}
                  </p>
                  {i === 1 && result && (
                    <p className="numeral mt-1.5 text-[11.5px] text-corona-dim">
                      {truncateAddress(result.ephemeralAddress, 8)}
                    </p>
                  )}
                  {receipt && i !== 1 && result && (
                    <p className="numeral mt-1.5 text-[11.5px] text-ash">
                      {truncateAddress(receipt.hash, 8)} · ledger{" "}
                      {formatLedger(receipt.ledger)}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {result && (
          <div className="mt-4">
            <Notice tone="good">
              Trocou {formatAmount(result.amountIn)} {result.fromAsset} por{" "}
              {formatAmount(result.amountOut)} {result.toAsset}. O saldo do pool
              se moveu; nada na chain liga a troca à sua conta.
            </Notice>
          </div>
        )}
      </div>
    </>
  );
}

/** One side of the pair: pool glyph, asset, and the selector under it. */
function AssetTile({
  label,
  asset,
  onChange,
}: {
  label: string;
  asset: Asset;
  onChange: (a: Asset) => void;
}) {
  return (
    <label className="block cursor-pointer bg-umbra px-6 py-5 transition-colors hover:bg-white/[0.03]">
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2.5 flex items-center gap-3">
        <PoolGlyph />
        <div className="min-w-0 flex-1">
          <select
            value={asset}
            onChange={(e) => onChange(e.target.value as Asset)}
            className="numeral w-full appearance-none border-0 bg-transparent p-0 text-[17px] font-semibold text-corona outline-none"
          >
            {ASSETS.map((a) => (
              <option key={a} value={a} className="bg-penumbra text-corona">
                {a}
              </option>
            ))}
          </select>
          <span className="mt-0.5 block text-[11.5px] text-ash">
            Pool blindado
          </span>
        </div>
      </div>
    </label>
  );
}

function PoolGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={30} height={30} aria-hidden>
      <circle
        cx="12"
        cy="12"
        r="9.2"
        fill="none"
        stroke="#38E2FF"
        strokeOpacity="0.55"
        strokeWidth="1.4"
      />
      <path
        d="M6 11.2c2-1.5 4-1.5 6 0s4 1.5 6 0M6 14.6c2-1.5 4-1.5 6 0s4 1.5 6 0"
        fill="none"
        stroke="#38E2FF"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
