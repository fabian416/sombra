import { useEffect, useState } from "react";
import { ScreenHeader } from "../components/Shell";
import {
  Button,
  Eyebrow,
  Field,
  Notice,
  Panel,
  PanelHeader,
  cx,
} from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import type { SwapQuote, SwapResult } from "../lib/client";
import {
  formatAmount,
  formatLedger,
  parseAmount,
  truncateAddress,
} from "../lib/format";

const ASSETS = ["XLM", "EURC"] as const;
type Asset = (typeof ASSETS)[number];

/** The four hops, and what each one gives away. */
const ROUTE = [
  {
    title: "Shielded pool",
    note: "Withdraw notes to a single-use address",
    exposed: "Amount",
  },
  {
    title: "Fresh address",
    note: "Never used before, never used again",
    exposed: "Nothing linkable",
  },
  {
    title: "Soroswap",
    note: "A public swap by an address with no history",
    exposed: "Amount and pair",
  },
  {
    title: "Shielded pool",
    note: "Deposit the proceeds back as new notes",
    exposed: "Amount",
  },
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

  // Quote as the amount settles, so the route panel is never stale.
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
      setError(err instanceof Error ? err.message : "Check the amount.");
      return;
    }
    if (parsed === 0n) {
      setError("Enter an amount above zero.");
      return;
    }
    if (parsed > shielded) {
      setError("Amount is larger than your shielded balance.");
      return;
    }

    setRunning(true);
    try {
      setResult(await client.privateSwap(fromAsset, toAsset, parsed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The swap didn't complete.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <ScreenHeader
        title="Swap"
        lede="Trade from inside the pool without tying the trade to your history. Funds leave to an address with no past, swap in public, and come straight back."
      />

      <div className="mb-6">
        <Notice>
          <strong className="font-semibold text-corona-dim">Flow preview.</strong>{" "}
          The route below is the design Sombra implements; execution here runs
          against the mock client. Soroswap routing is not yet wired.
        </Notice>
      </div>

      <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
        <Panel className="h-fit">
          <PanelHeader title="Shielded swap" layer="SPP" />
          <form onSubmit={submit} className="space-y-5 px-5 py-5">
            <div className="flex items-end gap-3">
              <AssetPicker
                label="From"
                value={fromAsset}
                onChange={(a) => {
                  setFromAsset(a);
                  if (a === toAsset) setToAsset(a === "XLM" ? "EURC" : "XLM");
                }}
              />
              <button
                type="button"
                onClick={flip}
                aria-label="Swap the pair around"
                className="mb-px border border-limb px-3 py-3 text-ash transition-colors hover:border-ash/60 hover:text-corona"
              >
                ⇄
              </button>
              <AssetPicker
                label="To"
                value={toAsset}
                onChange={(a) => {
                  setToAsset(a);
                  if (a === fromAsset) setFromAsset(a === "XLM" ? "EURC" : "XLM");
                }}
              />
            </div>

            <Field
              label="Amount"
              placeholder="0.0000000"
              inputMode="decimal"
              value={amount}
              suffix={fromAsset}
              onChange={(e) => setAmount(e.target.value)}
              hint={`${formatAmount(shielded)} in the pool`}
            />

            {quote && (
              <div className="border border-limb bg-umbra-lift px-4 py-3.5">
                <Eyebrow>You receive, back in the pool</Eyebrow>
                <div className="numeral mt-1.5 text-[19px] text-pool">
                  {formatAmount(quote.amountOut)}{" "}
                  <span className="eyebrow text-ash">{quote.toAsset}</span>
                </div>
                <div className="numeral mt-1 text-[12px] text-ash">
                  price impact {(quote.priceImpactBps / 100).toFixed(2)}%
                </div>
              </div>
            )}

            {error && <Notice tone="warn">{error}</Notice>}

            <Button type="submit" variant="primary" busy={running}>
              {running ? "Running the route" : "Run the flow"}
            </Button>
          </form>
        </Panel>

        <Panel>
          <PanelHeader
            title="Route"
            layer="SPP"
            note="Four hops. Only the middle one is public, and it belongs to nobody."
          />
          <ol className="divide-y divide-limb">
            {ROUTE.map((hop, i) => {
              const receipt = result?.receipts[i > 2 ? 2 : i];
              return (
                <li key={hop.title} className="px-5 py-4">
                  <div className="flex items-start gap-3.5">
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
                        <span className="text-[14px] text-corona">
                          {hop.title}
                        </span>
                        <span
                          className={cx(
                            "eyebrow",
                            hop.exposed === "Nothing linkable"
                              ? "text-pool"
                              : "text-cyan",
                          )}
                        >
                          {hop.exposed}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12.5px] leading-snug text-ash">
                        {hop.note}
                      </p>
                      {i === 1 && result && (
                        <p className="numeral mt-1.5 text-[12px] text-corona-dim">
                          {truncateAddress(result.ephemeralAddress, 8)}
                        </p>
                      )}
                      {receipt && i !== 1 && result && (
                        <p className="numeral mt-1.5 text-[12px] text-ash">
                          {truncateAddress(receipt.hash, 8)} · ledger{" "}
                          {formatLedger(receipt.ledger)}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>

          {result && (
            <div className="border-t border-limb px-5 py-4">
              <Notice tone="good">
                Swapped {formatAmount(result.amountIn)} {result.fromAsset} for{" "}
                {formatAmount(result.amountOut)} {result.toAsset}. The pool
                balance moved; nothing on chain ties the trade to your account.
              </Notice>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function AssetPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Asset;
  onChange: (a: Asset) => void;
}) {
  return (
    <label className="flex-1">
      <Eyebrow>{label}</Eyebrow>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Asset)}
        className="numeral mt-2 w-full appearance-none border border-limb bg-umbra-lift px-3.5 py-3 text-[15px] focus:border-ash focus:outline-none"
      >
        {ASSETS.map((asset) => (
          <option key={asset} value={asset} className="bg-penumbra">
            {asset}
          </option>
        ))}
      </select>
    </label>
  );
}
