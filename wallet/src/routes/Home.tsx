import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ScreenHeader } from "../components/Shell";
import { ConfidentialSplitCard } from "../components/ConfidentialSplitCard";
import { DecryptText } from "../components/DecryptText";
import {
  Button,
  Notice,
  Panel,
  PanelHeader,
  Stat,
  cx,
} from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { formatAmount, formatCount, formatLedger, splitAmount } from "../lib/format";

export function Home() {
  const { balances, loadingBalances, refresh, client, hasLocalState } =
    useSombra();
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!balances.confidential) void refresh();
  }, [balances.confidential, refresh]);

  const { public: pub, confidential: conf, shielded } = balances;

  const merge = async () => {
    setMerging(true);
    setError(null);
    try {
      await client.merge();
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The merge didn't go through.",
      );
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
      <ScreenHeader
        title="Balances"
        lede="One account, three layers. What you can read here is not what an observer reads off the ledger."
        action={
          <Button onClick={() => void refresh()} busy={loadingBalances}>
            Refresh
          </Button>
        }
      />

      {!hasLocalState && (
        <div className="mb-6">
          <Notice tone="warn">
            <strong className="font-semibold">
              Your confidential balance is unreadable on this device.
            </strong>{" "}
            The commitments are still on chain, but without the local openings
            nothing here can be spent.{" "}
            <Link
              to="/recover"
              className="underline underline-offset-4 hover:text-corona"
            >
              Restore with your wallet signature
            </Link>
            .
          </Notice>
        </div>
      )}

      {error && (
        <div className="mb-6">
          <Notice tone="warn">{error}</Notice>
        </div>
      )}

      {/* Public. The only balance that reads the same from both sides — and the
          only one rendered without the brand colour, because cyan in this app
          means "only you can read this". */}
      <Panel className="mb-5">
        <PanelHeader
          title="Public balance"
          layer="PUBLIC"
          note="Anyone can read this, in the clear, forever."
        />
        <div className="px-5 py-6">
          {pub ? (
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="numeral text-[clamp(2rem,5vw,2.85rem)] leading-none text-corona">
                {splitAmount(pub.amount).whole}
                <span className="text-ash/60">
                  .{splitAmount(pub.amount).frac}
                </span>
              </span>
              <span className="eyebrow text-ash">{pub.asset}</span>
            </div>
          ) : (
            <Skeleton className="h-10 w-56" />
          )}
        </div>
      </Panel>

      <ConfidentialSplitCard
        balance={conf}
        loading={loadingBalances}
        footer={
          conf ? (
            <>
              <span
                className={cx(
                  "eyebrow flex items-center gap-2",
                  conf.matchesChain ? "text-cyan" : "text-chroma",
                )}
              >
                <span
                  className={cx(
                    "size-1.5 rounded-full",
                    conf.matchesChain ? "bg-cyan" : "bg-chroma",
                  )}
                  aria-hidden
                />
                {conf.matchesChain
                  ? `Openings match the chain at ledger ${formatLedger(conf.syncedLedger)}`
                  : "Openings do not match the chain"}
              </span>

              {conf.receiving > 0n && (
                <Button busy={merging} onClick={() => void merge()}>
                  Fold {formatAmount(conf.receiving, { decimals: 2 })} into
                  spendable
                </Button>
              )}
            </>
          ) : null
        }
      />

      <Panel className="mt-5 min-w-0">
        <PanelHeader
          title="Shielded pool"
          layer="SPP"
          note="Your notes in the private payment pool."
        />
        <div className="flex flex-wrap items-end justify-between gap-6 px-5 py-6">
          {shielded ? (
            <>
              <div className="flex flex-wrap items-baseline gap-2.5">
                <DecryptText
                  key={shielded.amount.toString()}
                  text={formatAmount(shielded.amount)}
                  delayMs={200}
                  perCharMs={24}
                  className="numeral text-[26px] leading-none text-cyan"
                />
                <span className="eyebrow text-ash">{shielded.tokenLabel}</span>
              </div>
              <Stat
                label="Notes"
                value={formatCount(shielded.noteCount)}
                tone="ash"
                sub="Each note is a spendable UTXO."
              />
            </>
          ) : (
            <Skeleton className="h-10 w-40" />
          )}
        </div>
        <div className="border-t border-white/10 px-5 py-3.5">
          <Link
            to="/shield"
            className="eyebrow text-ash underline decoration-limb-bright underline-offset-4 transition-colors hover:text-corona"
          >
            Deposit or withdraw
          </Link>
        </div>
      </Panel>

      <p className="mt-6 text-[12.5px] text-ash">
        Balances come from the mock client. Freighter is live.
      </p>
    </>
  );
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx("rounded bg-white/8", className)}
      style={{ animation: "corona-breathe 1.8s ease-in-out infinite" }}
      aria-hidden
    />
  );
}
