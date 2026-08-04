import { useEffect } from "react";
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
import { useOperationFlow } from "../lib/useOperationFlow";
import type { TxReceipt } from "../lib/client";
import { formatAmount, formatCount, formatLedger, splitAmount } from "../lib/format";

export function Home() {
  const { balances, loadingBalances, refresh, client, hasLocalState } =
    useSombra();
  const merge_ = useOperationFlow<TxReceipt>();
  const merging = merge_.busy;
  const error = merge_.error;

  useEffect(() => {
    if (!balances.confidential) void refresh();
  }, [balances.confidential, refresh]);

  const { public: pub, confidential: conf, shielded } = balances;

  const merge = async () => {
    const result = await merge_.run(() => client.merge(), {
      success: "Saldo a receber incorporado",
      failure: "Falha ao incorporar",
      describe: (r) => `${formatAmount(r.amount)} XLM agora é gastável`,
    });
    if (result) await refresh();
  };

  return (
    <>
      <ScreenHeader
        title="Saldos"
        lede="Uma conta, três camadas. O que você lê aqui não é o que o ledger guarda."
        action={
          <Button onClick={() => void refresh()} busy={loadingBalances}>
            Atualizar
          </Button>
        }
      />

      {!hasLocalState && (
        <div className="mb-6">
          <Notice tone="warn">
            <strong className="font-semibold">
              Seu saldo confidencial está ilegível neste dispositivo.
            </strong>{" "}
            Os compromissos continuam na chain, mas sem as aberturas locais
            nada aqui pode ser gasto.{" "}
            <Link
              to="/recover"
              className="underline underline-offset-4 hover:text-corona"
            >
              Recuperar com a assinatura da carteira
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
          title="Saldo público"
          layer="PUBLIC"
          note="Qualquer pessoa lê isto, em claro, para sempre."
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
                  ? `Aberturas conferem com a chain no ledger ${formatLedger(conf.syncedLedger)}`
                  : "Aberturas não conferem com a chain"}
              </span>

              {conf.receiving > 0n && (
                <Button busy={merging} onClick={() => void merge()}>
                  Incorporar {formatAmount(conf.receiving, { decimals: 2 })} ao
                  gastável
                </Button>
              )}
            </>
          ) : null
        }
      />

      <Panel className="mt-5 min-w-0">
        <PanelHeader
          title="Pool blindado"
          layer="SPP"
          note="Suas notas no pool de pagamentos privados."
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
                label="Notas"
                value={formatCount(shielded.noteCount)}
                tone="ash"
                sub="Cada nota é um UTXO gastável."
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
            Depositar ou sacar
          </Link>
        </div>
      </Panel>

      <p className="mt-6 text-[12.5px] text-ash">
        Saldos vêm do cliente simulado. O Freighter é real.
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
