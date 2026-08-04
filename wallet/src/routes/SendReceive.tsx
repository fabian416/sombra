import { useEffect, useState } from "react";
import { ScreenHeader } from "../components/Shell";
import {
  Button,
  CopyLine,
  Eyebrow,
  Field,
  Notice,
  Panel,
  PanelHeader,
  Stat,
  cx,
} from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { useOperationFlow } from "../lib/useOperationFlow";
import { CipherSweep } from "../components/CipherSweep";
import { OperationJourney } from "../components/OperationJourney";
import type { ReceiveInfo, TxReceipt } from "../lib/client";
import {
  formatAmount,
  formatLedger,
  isStellarAddress,
  parseAmount,
  truncateAddress,
} from "../lib/format";

type Tab = "send" | "receive";

export function SendReceive() {
  const [tab, setTab] = useState<Tab>("send");

  return (
    <>
      <ScreenHeader
        title="Send & receive"
        lede="Confidential Token transfers. The recipient and the ledger position are public; the amount is not."
        action={<Tabs value={tab} onChange={setTab} />}
      />
      {tab === "send" ? <SendForm /> : <ReceivePanel />}
    </>
  );
}

function Tabs({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
}) {
  const options: Array<{ id: Tab; label: string }> = [
    { id: "send", label: "Send" },
    { id: "receive", label: "Receive" },
  ];
  return (
    <div className="flex rounded-full border border-white/15 bg-white/5 p-0.5 backdrop-blur" role="tablist">
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className={cx(
            "eyebrow rounded-full px-4 py-2 transition-colors",
            value === option.id
              ? "bg-cyan font-semibold text-black"
              : "text-ash hover:text-corona-dim",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function SendForm() {
  const { client, balances, refresh, hasLocalState } = useSombra();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<TxReceipt | null>(null);
  const flow = useOperationFlow<TxReceipt>();

  const spendable = balances.confidential?.spendable ?? 0n;
  const sending = flow.busy;
  // Validation errors are the form's; failures belong to the flow.
  const error = invalid ?? flow.error;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setInvalid(null);
    setReceipt(null);
    flow.reset();

    if (!isStellarAddress(to)) {
      setInvalid(
        "That isn't a Stellar public key. It starts with G and is 56 characters.",
      );
      return;
    }

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

    const result = await flow.run(() => client.privateSend(to.trim(), parsed), {
      success: "Transfer sent",
      failure: "Transfer failed",
      describe: (r) =>
        `${formatAmount(r.amount)} XLM · ledger ${formatLedger(r.ledger)}`,
    });

    if (result) {
      setReceipt(result);
      setAmount("");
      await refresh();
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
      <OperationJourney op="send" active={sending} succeeded={!!receipt} />
      <Panel>
        <PanelHeader title="Private transfer" layer="CT" />
        <CipherSweep active={sending} label="Encrypting">
        <form onSubmit={submit} className="space-y-5 px-5 py-5">
          <Field
            label="Recipient"
            placeholder="G…"
            value={to}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setTo(e.target.value)}
            hint="Must be a registered CT account"
          />
          <Field
            label="Amount"
            placeholder="0.0000000"
            inputMode="decimal"
            value={amount}
            suffix="XLM"
            onChange={(e) => setAmount(e.target.value)}
            hint={`${formatAmount(spendable)} spendable`}
          />

          {error && <Notice tone="warn">{error}</Notice>}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              busy={sending}
              disabled={!hasLocalState}
            >
              Send privately
            </Button>
            {amount && !error && (
              <button
                type="button"
                onClick={() => setAmount(formatAmount(spendable, { group: false }))}
                className="eyebrow text-ash underline decoration-limb-bright underline-offset-4 hover:text-corona"
              >
                Send everything
              </button>
            )}
          </div>

          {!hasLocalState && (
            <Notice tone="warn">
              Recover your account before sending — the openings needed to build
              a proof are missing on this device.
            </Notice>
          )}

          {receipt && (
            <Notice tone="good">
              Sent {formatAmount(receipt.amount)} XLM. The ledger recorded a
              transfer with no amount attached.
              <span className="numeral mt-1.5 block text-[12px] text-cyan/75">
                {truncateAddress(receipt.hash, 10)} · ledger{" "}
                {formatLedger(receipt.ledger)}
              </span>
            </Notice>
          )}
        </form>
        </CipherSweep>
      </Panel>

      <Panel className="h-fit">
        <PanelHeader title="What lands on chain" />
        <ul className="divide-y divide-limb text-[13px]">
          {[
            ["Sender", "Public"],
            ["Recipient", "Public"],
            ["Amount", "Encrypted"],
            ["Your new balance", "A commitment"],
            ["Auditor copy", "Encrypted to the auditor key"],
          ].map(([field, disclosure]) => (
            <li
              key={field}
              className="flex items-center justify-between gap-4 px-5 py-3"
            >
              <span className="text-ash">{field}</span>
              <span
                className={cx(
                  "eyebrow",
                  disclosure === "Public" ? "text-cyan" : "text-corona-dim",
                )}
              >
                {disclosure}
              </span>
            </li>
          ))}
        </ul>
        <p className="border-t border-limb px-5 py-4 text-[12.5px] leading-relaxed text-ash">
          The transfer carries the opening encrypted to the recipient's viewing
          key, so only they can spend what arrives.
        </p>
      </Panel>
    </div>
  );
}

function ReceivePanel() {
  const { client } = useSombra();
  const [info, setInfo] = useState<ReceiveInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.receiveInfo().then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
      <Panel>
        <PanelHeader
          title="Your receiving details"
          layer="CT"
          note="Share these to be paid confidentially."
        />
        <div className="space-y-5 px-5 py-5">
          <div>
            <Eyebrow>Stellar address</Eyebrow>
            <div className="mt-2">
              {info ? (
                <CopyLine value={info.address} label="address" />
              ) : (
                <div className="h-11 bg-limb/50" aria-hidden />
              )}
            </div>
          </div>

          <div>
            <Eyebrow>Viewing public key</Eyebrow>
            <div className="mt-2">
              {info ? (
                <CopyLine
                  value={info.viewingPublicKey}
                  display={truncateAddress(info.viewingPublicKey, 16)}
                  label="viewing key"
                />
              ) : (
                <div className="h-11 bg-limb/50" aria-hidden />
              )}
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ash">
              Senders encrypt the amount to this key. It reveals incoming
              amounts to whoever holds it — share it only with an auditor you
              intend to give that access.
            </p>
          </div>

          {info && (
            <div className="flex flex-wrap gap-x-8 gap-y-4 border-t border-limb pt-4">
              <Stat
                label="Registration"
                value={info.registered ? "Registered" : "Not registered"}
                tone={info.registered ? "cyan" : "ash"}
              />
              <Stat label="Auditor" value={`#${info.auditorId}`} tone="ash" />
            </div>
          )}
        </div>
      </Panel>

      <Panel className="h-fit">
        <PanelHeader title="Where funds land" />
        <div className="space-y-4 px-5 py-5 text-[13px] leading-relaxed text-ash">
          <p>
            Incoming transfers go to your <strong className="text-corona-dim">receiving</strong>{" "}
            balance, not straight to spendable. That keeps a sender from
            interfering with a transfer you are building at the same moment.
          </p>
          <p>
            Fold receiving into spendable from the Balances screen when you want
            to use what arrived.
          </p>
        </div>
      </Panel>
    </div>
  );
}
