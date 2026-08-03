import { useState } from "react";
import { ScreenHeader } from "../components/Shell";
import {
  Button,
  Field,
  Notice,
  Panel,
  PanelHeader,
  Stat,
  cx,
} from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { useOperationFlow } from "../lib/useOperationFlow";
import type { TxReceipt } from "../lib/client";
import {
  formatAmount,
  formatCount,
  formatLedger,
  parseAmount,
  truncateAddress,
} from "../lib/format";

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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setInvalid(null);
    setReceipt(null);
    flow.reset();

    let parsed: bigint;
    try {
      parsed = parseAmount(amount);
    } catch (err) {
      setInvalid(err instanceof Error ? err.message : "Check the amount.");
      return;
    }
    if (parsed === 0n) {
      setInvalid("Enter an amount above zero.");
      return;
    }

    const result = await flow.run(
      () => (depositing ? client.shield(parsed) : client.unshield(parsed)),
      {
        success: depositing ? "Deposit confirmed" : "Withdrawal confirmed",
        failure: depositing ? "Deposit failed" : "Withdrawal failed",
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

  return (
    <>
      <ScreenHeader
        title="Shielded pool"
        lede="Deposits and withdrawals are public amounts. What happens between them — who holds what, and who paid whom — is not."
        action={
          <div className="flex rounded-full border border-white/15 bg-white/5 p-0.5 backdrop-blur" role="tablist">
            {(
              [
                ["deposit", "Deposit"],
                ["withdraw", "Withdraw"],
              ] as Array<[Direction, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={direction === id}
                onClick={() => {
                  setDirection(id);
                  setInvalid(null);
                  setReceipt(null);
                  flow.reset();
                }}
                className={cx(
                  "eyebrow rounded-full px-4 py-2 transition-colors",
                  direction === id
                    ? "bg-cyan font-semibold text-black"
                    : "text-ash hover:text-corona-dim",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <Panel>
          <PanelHeader
            title={depositing ? "Deposit into the pool" : "Withdraw from the pool"}
            layer="SPP"
            note={
              depositing
                ? "Public XLM becomes notes only you can spend."
                : "Notes are burned and public XLM comes back out."
            }
          />
          <form onSubmit={submit} className="space-y-5 px-5 py-5">
            {/* No clear-to-cipher sweep here: the amount crossing the pool
                boundary is public on chain, and animating it as encryption
                would misrepresent what the ledger records. */}
            <Notice>
              {depositing
                ? "This deposit is public; what follows is not."
                : "This withdrawal is public; what preceded it is not."}
            </Notice>
            <Field
              label="Amount"
              placeholder="0.0000000"
              inputMode="decimal"
              value={amount}
              suffix="XLM"
              onChange={(e) => setAmount(e.target.value)}
              hint={`${formatAmount(available)} available`}
            />

            {error && <Notice tone="warn">{error}</Notice>}

            <Button type="submit" variant="primary" busy={busy}>
              {depositing ? "Deposit" : "Withdraw"}
            </Button>

            {receipt && (
              <Notice tone="good">
                {depositing
                  ? `Deposited ${formatAmount(receipt.amount)} XLM. New notes are in the tree.`
                  : `Withdrew ${formatAmount(receipt.amount)} XLM to your public balance.`}
                <span className="numeral mt-1.5 block text-[12px] text-cyan/75">
                  {truncateAddress(receipt.hash, 10)} · ledger{" "}
                  {formatLedger(receipt.ledger)}
                </span>
              </Notice>
            )}
          </form>
        </Panel>

        <div className="space-y-5">
          <Panel>
            <PanelHeader title="Pool position" layer="SPP" />
            <div className="space-y-4 px-5 py-5">
              {shielded ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <span className="numeral text-[26px] leading-none text-pool">
                      {formatAmount(shielded.amount)}
                    </span>
                    <span className="eyebrow text-ash">
                      {shielded.tokenLabel}
                    </span>
                  </div>
                  <Stat
                    label="Notes"
                    value={formatCount(shielded.noteCount)}
                    tone="ash"
                    sub="A spend consumes up to two notes and writes two back."
                  />
                  <div>
                    <div className="eyebrow">Pool contract</div>
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
            <PanelHeader title="What an observer learns" />
            <ul className="divide-y divide-limb text-[13px]">
              {[
                ["That a deposit happened", "Yes"],
                ["The deposit amount", "Yes"],
                ["Which note is yours", "No"],
                ["Who you paid inside the pool", "No"],
                ["Your pool balance", "No"],
              ].map(([question, answer]) => (
                <li
                  key={question}
                  className="flex items-center justify-between gap-4 px-5 py-2.5"
                >
                  <span className="text-ash">{question}</span>
                  <span
                    className={cx(
                      "eyebrow",
                      answer === "Yes" ? "text-cyan" : "text-pool",
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
