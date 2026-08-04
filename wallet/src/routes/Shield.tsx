import { useState } from "react";
import { ScreenHeader } from "../components/Shell";
import { Button, Eyebrow, Notice, Panel, PanelHeader, Stat, cx } from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { useOperationFlow } from "../lib/useOperationFlow";
import { OperationJourney, StellarMark } from "../components/OperationJourney";
import type { TxReceipt } from "../lib/client";
import {
  formatAmount,
  formatCount,
  formatLedger,
  parseAmount,
  truncateAddress,
} from "../lib/format";

/**
 * The pool boundary, composed like the team's bridge: one centered card, the
 * two sides of the crossing as tiles, the flip control between them switching
 * the direction, an oversized amount, one gradient action.
 *
 * The honest line stays inside the card: a deposit amount is public on chain,
 * and this screen says so instead of animating an encryption that isn't there.
 */
type Direction = "deposit" | "withdraw";

export function Shield() {
  const { client, balances, refresh } = useSombra();
  const [direction, setDirection] = useState<Direction>("deposit");
  const [amount, setAmount] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TxReceipt | null>(null);
  const flow = useOperationFlow<TxReceipt>();

  const busy = flow.busy;
  const error = invalid ?? flow.error;

  const shielded = balances.shielded;
  const publicAmount = balances.public?.amount ?? 0n;
  const depositing = direction === "deposit";
  const available = depositing ? publicAmount : (shielded?.amount ?? 0n);

  const flip = () => {
    setDirection(depositing ? "withdraw" : "deposit");
    setInvalid(null);
    setReceipt(null);
    flow.reset();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setInvalid(null);
    setReceipt(null);
    flow.reset();

    let parsed: bigint;
    try {
      parsed = parseAmount(amount);
    } catch (err) {
      setInvalid(err instanceof Error ? err.message : "Confira o valor.");
      return;
    }
    if (parsed === 0n) {
      setInvalid("Informe um valor acima de zero.");
      return;
    }

    const result = await flow.run(
      () => (depositing ? client.shield(parsed) : client.unshield(parsed)),
      {
        success: depositing ? "Depósito confirmado" : "Saque confirmado",
        failure: depositing ? "O depósito falhou" : "O saque falhou",
        describe: (r) =>
          `${formatAmount(r.amount)} XLM · ledger ${formatLedger(r.ledger)}`,
      },
    );

    if (result) {
      setReceipt(result);
      setAmount("");
      await refresh();
    }
  };

  const from = depositing
    ? { name: "Stellar Testnet", sub: "Saldo público", icon: <StellarMark size={28} /> }
    : { name: "Pool blindado", sub: "Notas privadas", icon: <PoolGlyph /> };
  const to = depositing
    ? { name: "Pool blindado", sub: "Notas privadas", icon: <PoolGlyph /> }
    : { name: "Stellar Testnet", sub: "Saldo público", icon: <StellarMark size={28} /> };

  return (
    <>
      <OperationJourney
        op={depositing ? "shield" : "unshield"}
        active={flow.busy}
        succeeded={!!flow.result}
      />
      <ScreenHeader
        title="Pool blindado"
        lede="Depósitos e saques são valores públicos. O que acontece entre eles — quem tem o quê, quem pagou quem — não é."
      />

      <div className="mx-auto w-full max-w-[520px]">
        <form onSubmit={submit} className="panel glow-soft overflow-hidden">
          <div className="relative grid grid-cols-2 gap-px bg-white/10">
            <SideTile label="De" side={from} />
            <SideTile label="Para" side={to} />
            <button
              type="button"
              onClick={flip}
              aria-label="Inverter a direção"
              className="absolute left-1/2 top-1/2 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-umbra text-cyan transition-all hover:border-cyan/50 hover:shadow-[0_0_18px_rgba(56,226,255,0.4)]"
            >
              ⇄
            </button>
          </div>

          <div className="border-t border-white/10 px-6 pb-5 pt-6">
            <div className="flex items-baseline justify-between gap-4">
              <Eyebrow>Valor</Eyebrow>
              <button
                type="button"
                onClick={() =>
                  setAmount(formatAmount(available, { group: false }))
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
              <span className="eyebrow shrink-0 text-ash">XLM</span>
            </div>
            <p className="numeral mt-2.5 text-[12px] text-ash">
              {formatAmount(available)} XLM disponível
            </p>
          </div>

          {/* The honest line. No clear-to-cipher sweep on this boundary: the
              crossing amount is public on chain and pretending otherwise in
              front of the spec's authors would cost more than it looks. */}
          <div className="border-t border-white/10 bg-white/[0.03] px-6 py-3.5">
            <p className="text-[12px] leading-relaxed text-ash">
              {depositing
                ? "Este depósito é público — o que acontece depois dele não é."
                : "Este saque é público — o que veio antes dele não é."}
            </p>
          </div>

          {error && (
            <div className="border-t border-white/10 px-6 py-4">
              <Notice tone="warn">{error}</Notice>
            </div>
          )}

          <div className="border-t border-white/10 px-6 py-5">
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              className="w-full py-3.5 text-[14.5px]"
            >
              {busy
                ? depositing
                  ? "Depositando"
                  : "Sacando"
                : depositing
                  ? "Depositar →"
                  : "Sacar →"}
            </Button>
          </div>
        </form>

        {receipt && (
          <div className="mt-4">
            <Notice tone="good">
              {depositing
                ? `Depositou ${formatAmount(receipt.amount)} XLM. Novas notas estão na árvore.`
                : `Sacou ${formatAmount(receipt.amount)} XLM para o saldo público.`}
              <span className="numeral mt-1.5 block text-[12px] text-cyan/75">
                {truncateAddress(receipt.hash, 10)} · ledger{" "}
                {formatLedger(receipt.ledger)}
              </span>
            </Notice>
          </div>
        )}

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <Panel>
            <PanelHeader title="Posição no pool" layer="SPP" />
            <div className="space-y-4 px-5 py-5">
              {shielded ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <span className="numeral text-[24px] leading-none text-pool">
                      {formatAmount(shielded.amount)}
                    </span>
                    <span className="eyebrow text-ash">
                      {shielded.tokenLabel}
                    </span>
                  </div>
                  <Stat
                    label="Notas"
                    value={formatCount(shielded.noteCount)}
                    tone="ash"
                    sub="Um gasto consome até duas notas e grava duas de volta."
                  />
                  <div>
                    <div className="eyebrow">Contrato do pool</div>
                    <p className="numeral mt-1.5 text-[12.5px] text-ash">
                      {truncateAddress(shielded.poolContractId, 8)}
                    </p>
                  </div>
                </>
              ) : (
                <div className="h-24 bg-limb/40" aria-hidden />
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="O que um observador aprende" />
            <ul className="divide-y divide-limb text-[13px]">
              {(
                [
                  ["Que houve um depósito", "Sim"],
                  ["O valor do depósito", "Sim"],
                  ["Qual nota é sua", "Não"],
                  ["Quem você pagou no pool", "Não"],
                  ["Seu saldo no pool", "Não"],
                ] as const
              ).map(([question, answer]) => (
                <li
                  key={question}
                  className="flex items-center justify-between gap-4 px-5 py-2.5"
                >
                  <span className="text-ash">{question}</span>
                  <span
                    className={cx(
                      "eyebrow",
                      answer === "Sim" ? "text-cyan" : "text-pool",
                    )}
                  >
                    {answer}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}

function SideTile({
  label,
  side,
}: {
  label: string;
  side: { name: string; sub: string; icon: React.ReactNode };
}) {
  return (
    <div className="bg-umbra px-6 py-5">
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-2.5 flex items-center gap-3">
        <span className="flex h-8 w-8 items-center justify-center">
          {side.icon}
        </span>
        <div className="min-w-0">
          <div className="numeral text-[15.5px] font-semibold text-corona">
            {side.name}
          </div>
          <span className="mt-0.5 block text-[11.5px] text-ash">{side.sub}</span>
        </div>
      </div>
    </div>
  );
}

function PoolGlyph() {
  return (
    <svg viewBox="0 0 24 24" width={28} height={28} aria-hidden>
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
