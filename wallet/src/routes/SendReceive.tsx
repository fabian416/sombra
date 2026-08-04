import { useEffect, useState } from "react";
import { ScreenHeader } from "../components/Shell";
import {
  Button,
  CopyLine,
  Eyebrow,

  Notice,
  Panel,
  PanelHeader,
  Stat,
  cx,
} from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { useOperationFlow } from "../lib/useOperationFlow";
import { Eclipse } from "../components/Eclipse";
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
        title="Enviar e receber"
        lede="Transferências de Confidential Token. O destinatário e a posição no ledger são públicos; o valor não."
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
    { id: "send", label: "Enviar" },
    { id: "receive", label: "Receber" },
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
        "Isso não é uma chave pública Stellar. Ela começa com G e tem 56 caracteres.",
      );
      return;
    }

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

    const result = await flow.run(() => client.privateSend(to.trim(), parsed), {
      success: "Transferência enviada",
      failure: "Falha na transferência",
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
    <div className="mx-auto w-full max-w-[520px]">
      <OperationJourney op="send" active={sending} succeeded={!!receipt} />

      <form onSubmit={submit} className="panel glow-soft overflow-hidden">
        {/* The two ends of the transfer, like the bridge composes them. */}
        <div className="grid grid-cols-[0.85fr_1.15fr] gap-px bg-white/10">
          <div className="bg-umbra px-6 py-5">
            <Eyebrow>De</Eyebrow>
            <div className="mt-2.5 flex items-center gap-3">
              <Eclipse size={30} intensity={0.9} spinSeconds={40} />
              <div className="min-w-0">
                <div className="numeral text-[15.5px] font-semibold text-corona">
                  Sua carteira
                </div>
                <span className="mt-0.5 block text-[11.5px] text-ash">
                  Saldo confidencial
                </span>
              </div>
            </div>
          </div>
          <div className="bg-umbra px-6 py-5">
            <Eyebrow>Para</Eyebrow>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="G…"
              spellCheck={false}
              autoComplete="off"
              className="numeral mt-2.5 w-full border-0 bg-transparent p-0 text-[15.5px] font-semibold text-corona outline-none placeholder:text-ash/40"
            />
            <span className="mt-0.5 block text-[11.5px] text-ash">
              Conta CT registrada
            </span>
          </div>
        </div>

        <div className="border-t border-white/10 px-6 pb-5 pt-6">
          <div className="flex items-baseline justify-between gap-4">
            <Eyebrow>Valor</Eyebrow>
            <button
              type="button"
              onClick={() =>
                setAmount(formatAmount(spendable, { group: false }))
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
            {formatAmount(spendable)} XLM disponível para gastar
          </p>
        </div>

        <div className="border-t border-white/10 bg-white/[0.03] px-6 py-3.5">
          <p className="text-[12px] leading-relaxed text-ash">
            Endereços visíveis, valor oculto — apenas um compromisso viaja.
          </p>
        </div>

        {error && (
          <div className="border-t border-white/10 px-6 py-4">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        {!hasLocalState && (
          <div className="border-t border-white/10 px-6 py-4">
            <Notice tone="warn">
              Recupere a sua conta antes de enviar — as aberturas necessárias
              para gerar a prova não estão neste dispositivo.
            </Notice>
          </div>
        )}

        <div className="border-t border-white/10 px-6 py-5">
          <Button
            type="submit"
            variant="primary"
            busy={sending}
            disabled={!hasLocalState}
            className="w-full py-3.5 text-[14.5px]"
          >
            {sending ? "Enviando em sigilo" : "Enviar em sigilo →"}
          </Button>
        </div>
      </form>

      {receipt && (
        <div className="mt-4">
          <Notice tone="good">
            Enviou {formatAmount(receipt.amount)} XLM. O ledger registrou uma
            transferência sem valor anexado.
            <span className="numeral mt-1.5 block text-[12px] text-cyan/75">
              {truncateAddress(receipt.hash, 10)} · ledger{" "}
              {formatLedger(receipt.ledger)}
            </span>
          </Notice>
        </div>
      )}

      <div className="mt-6">
        <Panel>
          <PanelHeader title="O que fica na chain" />
          <ul className="divide-y divide-limb text-[13px]">
            {[
              ["Remetente", "Público"],
              ["Destinatário", "Público"],
              ["Valor", "Cifrado"],
              ["Seu novo saldo", "Um compromisso"],
              ["Cópia do auditor", "Cifrada para a chave do auditor"],
            ].map(([field, disclosure]) => (
              <li
                key={field}
                className="flex items-center justify-between gap-4 px-5 py-3"
              >
                <span className="text-ash">{field}</span>
                <span
                  className={cx(
                    "eyebrow",
                    disclosure === "Público" ? "text-cyan" : "text-corona-dim",
                  )}
                >
                  {disclosure}
                </span>
              </li>
            ))}
          </ul>
          <p className="border-t border-limb px-5 py-4 text-[12.5px] leading-relaxed text-ash">
            A transferência carrega a abertura cifrada para a chave de
            visualização do destinatário — só ele consegue gastar o que chega.
          </p>
        </Panel>
      </div>
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
          title="Seus dados de recebimento"
          layer="CT"
          note="Compartilhe para receber pagamentos em sigilo."
        />
        <div className="space-y-5 px-5 py-5">
          <div>
            <Eyebrow>Endereço Stellar</Eyebrow>
            <div className="mt-2">
              {info ? (
                <CopyLine value={info.address} label="endereço" />
              ) : (
                <div className="h-11 bg-limb/50" aria-hidden />
              )}
            </div>
          </div>

          <div>
            <Eyebrow>Chave pública de visualização</Eyebrow>
            <div className="mt-2">
              {info ? (
                <CopyLine
                  value={info.viewingPublicKey}
                  display={truncateAddress(info.viewingPublicKey, 16)}
                  label="chave de visualização"
                />
              ) : (
                <div className="h-11 bg-limb/50" aria-hidden />
              )}
            </div>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ash">
              Quem envia cifra o valor para esta chave. Ela revela os valores
              recebidos a quem a possuir — compartilhe apenas com um auditor a
              quem você queira dar esse acesso.
            </p>
          </div>

          {info && (
            <div className="flex flex-wrap gap-x-8 gap-y-4 border-t border-limb pt-4">
              <Stat
                label="Registro"
                value={info.registered ? "Registrada" : "Não registrada"}
                tone={info.registered ? "cyan" : "ash"}
              />
              <Stat label="Auditor" value={`#${info.auditorId}`} tone="ash" />
            </div>
          )}
        </div>
      </Panel>

      <Panel className="h-fit">
        <PanelHeader title="Onde os fundos chegam" />
        <div className="space-y-4 px-5 py-5 text-[13px] leading-relaxed text-ash">
          <p>
            Transferências recebidas vão para o seu saldo{" "}
            <strong className="text-corona-dim">de recebimento</strong>, não
            direto para o gastável. Isso impede que um remetente interfira numa
            transferência que você esteja montando no mesmo momento.
          </p>
          <p>
            Incorpore o recebido ao gastável na tela de Saldos quando quiser
            usar o que chegou.
          </p>
        </div>
      </Panel>
    </div>
  );
}
