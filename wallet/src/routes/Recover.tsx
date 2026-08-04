import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ScreenHeader } from "../components/Shell";
import { Eclipse } from "../components/Eclipse";
import { DecryptText } from "../components/DecryptText";
import { Button, Eyebrow, Notice, Panel, PanelHeader, cx } from "../components/ui";
import { ARCHIVE_URL, CLIENT_MODE, useSombra } from "../state/SombraProvider";
import type {
  LedgerRange,
  RecoveryPhase,
  RecoveryProgress,
  RecoveryResult,
} from "../lib/client";
import { formatAmount, formatCount, formatLedger } from "../lib/format";
import { toast } from "../lib/toast";

/** A real sequence, so it is numbered. Order is the information. */
const STEPS: Array<{ phase: RecoveryPhase; title: string; note: string }> = [
  {
    phase: "derive",
    title: "Derivar chaves",
    note: "De uma assinatura do signatário registrado, vinculada a este contrato e conta",
  },
  {
    phase: "checkpoint",
    title: "Buscar checkpoint",
    note: "No Sombra Archive, que retém eventos abaixo do piso da RPC",
  },
  {
    phase: "replay",
    title: "Reproduzir eventos",
    note: "Cada depósito, transferência e incorporação desde o checkpoint",
  },
  {
    phase: "verify",
    title: "Verificar na chain",
    note: "Recompor as aberturas e comparar com os pontos na chain",
  },
  {
    phase: "restored",
    title: "Fundos restaurados",
    note: "O saldo volta a ser gastável",
  },
];

interface LogLine {
  id: number;
  phase: RecoveryPhase;
  text: string;
}

export function Recover() {
  const { client, refresh, hasLocalState, wipeLocalState } = useSombra();

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RecoveryProgress | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [result, setResult] = useState<RecoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const logSeq = useRef(0);
  const lastDetail = useRef("");
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: "end" });
  }, [log]);

  const stepIndex = progress
    ? STEPS.findIndex((s) => s.phase === progress.phase)
    : -1;
  const succeeded = result?.complete === true && result.verifiedAgainstChain;
  const complete = succeeded ? STEPS.length : Math.max(0, stepIndex);
  const fraction = succeeded ? 1 : (progress?.fraction ?? 0);

  const onProgress = useCallback((p: RecoveryProgress) => {
    setProgress(p);
    // The replay phase fires every frame; only text changes are worth a line.
    if (p.detail && p.detail !== lastDetail.current) {
      lastDetail.current = p.detail;
      setLog((prev) => {
        const next = [
          ...prev,
          { id: logSeq.current++, phase: p.phase, text: p.detail },
        ];
        return next.length > 60 ? next.slice(-60) : next;
      });
    }
  }, []);

  const start = async () => {
    setError(null);
    setResult(null);
    setLog([]);
    lastDetail.current = "";
    setRunning(true);
    try {
      const outcome = await client.recoverFromSigner(ARCHIVE_URL, onProgress);
      setResult(outcome);
      await refresh();
    } catch (err) {
      const detail =
        err instanceof Error ? err.message : "A recuperação parou antes de terminar.";
      setError(detail);
      toast.error("Falha na recuperação", detail);
      setProgress(null);
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setResult(null);
    setProgress(null);
    setLog([]);
    setError(null);
    lastDetail.current = "";
  };

  const showStage = running || result !== null;

  return (
    <>
      {running && (
        <PhaseOverlay
          progress={progress}
          fraction={fraction}
          complete={complete}
        />
      )}

      <ScreenHeader
        title="Recuperar"
        lede="A RPC da Stellar retém sete dias de histórico. O Sombra Archive retém tudo, então a assinatura da carteira basta para tornar um saldo confidencial gastável de novo, em qualquer dispositivo."
      />

      {!hasLocalState && !showStage && (
        <div className="mb-6">
          <Notice tone="warn">
            Este dispositivo não tem as aberturas do seu saldo confidencial. Os
            fundos estão na chain e ilegíveis até você recuperar.
          </Notice>
        </div>
      )}

      <div
        className={cx(
          "grid gap-5",
          showStage ? "grid-cols-1" : "lg:grid-cols-[0.95fr_1.05fr]",
        )}
      >
        {!showStage && (
          <Panel className="min-w-0">
            <PanelHeader
              title="Recuperar com a assinatura da carteira"
              layer="ARCHIVE"
              note="Não há nada para digitar. Suas chaves vêm de uma assinatura, não de uma frase."
            />
            <div className="space-y-5 px-5 py-5">
              <p className="text-[13.5px] leading-relaxed text-ash">
                O Sombra pede à sua carteira uma assinatura sobre uma mensagem
                fixa que nomeia este contrato e a sua conta. Essa assinatura
                deriva as mesmas chaves em qualquer dispositivo, então nada
                precisa ser guardado.
              </p>

              <Button variant="primary" onClick={() => void start()}>
                Assinar e recuperar
              </Button>

              {error && <Notice tone="warn">{error}</Notice>}

              <div className="space-y-3 border-t border-white/10 pt-4">
                <div>
                  <Eyebrow>Endpoint do Archive</Eyebrow>
                  <p className="numeral-wrap mt-1.5 text-[12.5px] text-ash">
                    {ARCHIVE_URL}
                  </p>
                </div>
                {CLIENT_MODE === "mock" && (
                  <Notice>
                    Simulado nesta versão. Nenhuma requisição ao Archive é feita
                    e nenhuma chave é derivada — o fluxo, os tempos e os estados
                    de falha são reais; a criptografia ainda não está ligada.
                  </Notice>
                )}
              </div>
            </div>
          </Panel>
        )}

        <Stage
          fraction={fraction}
          complete={complete}
          progress={progress}
          result={result}
          running={running}
        />
      </div>

      {(showStage || log.length > 0) && (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <Panel className="min-w-0">
            <PanelHeader title="Registro da reprodução" layer="ARCHIVE" />
            <div className="h-[188px] overflow-y-auto px-5 py-4">
              {log.length === 0 ? (
                <p className="text-[13px] text-ash">
                  Aguardando o primeiro evento.
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {log.map((line) => (
                    <li
                      key={line.id}
                      className="numeral-wrap animate-log-in text-[12.5px] leading-relaxed text-ash"
                    >
                      <span className="mr-2 text-cyan/50">
                        {String(
                          STEPS.findIndex((s) => s.phase === line.phase) + 1,
                        ).padStart(2, "0")}
                      </span>
                      {line.text}
                    </li>
                  ))}
                </ol>
              )}
              <div ref={logEnd} />
            </div>
          </Panel>

          <Panel className="min-w-0">
            <PanelHeader title="Etapas" />
            <ol className="divide-y divide-white/10">
              {STEPS.map((step, i) => {
                const done = i < complete;
                const active = i === complete && running;
                return (
                  <li
                    key={step.phase}
                    className="flex items-start gap-3 px-5 py-2.5"
                  >
                    <span
                      className={cx(
                        "numeral mt-px w-5 shrink-0 text-[11px]",
                        done
                          ? "text-cyan"
                          : active
                            ? "text-corona"
                            : "text-ash/40",
                      )}
                    >
                      {done ? "✓" : String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cx(
                          "block text-[13.5px]",
                          done || active ? "text-corona" : "text-ash",
                        )}
                      >
                        {step.title}
                      </span>
                      <span className="block text-[12px] leading-snug text-ash">
                        {step.note}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </div>
      )}

      {result && <Outcome result={result} onReset={reset} />}

      <DemoControls onWipe={wipeLocalState} disabled={running} />
    </>
  );
}

/**
 * The two ways a recovery can fail are not the same failure, and the spec is
 * explicit that a wallet must not let them read alike: a gapped archive is a
 * coverage problem someone can fix by pointing at another archive; a
 * verification mismatch means the data served was wrong. They get different
 * words, different colour and different advice.
 */
function Outcome({
  result,
  onReset,
}: {
  result: RecoveryResult;
  onReset: () => void;
}) {
  if (result.failure === "incomplete") {
    return (
      <div className="mt-5">
        <Panel className="min-w-0">
          <PanelHeader
            title="Recuperação interrompida — histórico incompleto"
            layer="ARCHIVE"
            action={<Button onClick={onReset}>Tentar de novo</Button>}
          />
          <div className="space-y-4 px-5 py-5">
            <Notice>
              O Archive respondeu e o que veio está bem formado. Só que ele não
              guarda todos os ledgers do seu histórico: a reprodução ficaria sem
              eventos e o saldo resultante estaria errado.
            </Notice>

            <div>
              <Eyebrow>Ledgers que faltam no Archive</Eyebrow>
              <ul className="mt-2 space-y-1">
                {(result.missingRanges ?? []).map((range) => (
                  <li
                    key={`${range.from}-${range.to}`}
                    className="numeral text-[15px] text-corona"
                  >
                    {formatLedger(range.from)} – {formatLedger(range.to)}
                  </li>
                ))}
              </ul>
            </div>

            <Coverage ranges={result.archiveCoverage} />

            <p className="text-[13px] leading-relaxed text-ash">
              Aponte o Sombra para um archive que cubra a lacuna e rode de novo.
              Seus fundos estão intactos: nada foi escrito e nenhum estado
              parcial foi salvo.
            </p>
          </div>
        </Panel>
      </div>
    );
  }

  if (!result.verifiedAgainstChain) {
    return (
      <div className="mt-5">
        <Panel className="min-w-0 border-chroma/45">
          <PanelHeader
            title="Recuperação recusada — verificação falhou"
            layer="ARCHIVE"
            action={<Button onClick={onReset}>Tentar de novo</Button>}
          />
          <div className="space-y-4 px-5 py-5">
            <Notice tone="warn">
              O Archive serviu todo o histórico sem lacunas, mas as aberturas
              reconstruídas não correspondem aos pontos na chain. Os eventos que
              este archive devolveu não são os que a sua conta emitiu.
            </Notice>
            <p className="text-[13px] leading-relaxed text-ash">
              Nada foi salvo. Não gaste com base neste archive — use um
              independente e compare.
            </p>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="mt-5">
      <Panel className="glow-hero min-w-0">
        <PanelHeader
          title="Restaurado"
          layer="ARCHIVE"
          action={<Button onClick={onReset}>Rodar de novo</Button>}
        />
        <div className="grid gap-x-8 gap-y-5 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Gastável"
            value={`${formatAmount(result.restored.spendable)} XLM`}
            tone="cyan"
          />
          <Figure
            label="A receber"
            value={`${formatAmount(result.restored.receiving)} XLM`}
            tone="cyan"
          />
          <Figure
            label="Eventos reproduzidos"
            value={formatCount(result.eventsReplayed)}
            sub={`ledgers ${formatLedger(result.fromLedger)} – ${formatLedger(result.throughLedger)}`}
          />
          <Figure
            label="Abaixo do piso da RPC"
            value={formatCount(result.beyondRpcWindow)}
            tone="cyan"
            sub="indisponíveis sem o Archive"
          />
        </div>
        <div className="space-y-4 border-t border-white/10 px-5 py-4">
          <Coverage ranges={result.archiveCoverage} />
          <Notice tone="good">
            Servido inteiro e verificado contra os compromissos na chain. Seu
            saldo voltou a ser gastável —{" "}
            <Link to="/send" className="underline underline-offset-4">
              faça uma transferência confidencial
            </Link>{" "}
            para comprovar.
          </Notice>
        </div>
      </Panel>
    </div>
  );
}

function Coverage({ ranges }: { ranges: LedgerRange[] }) {
  if (!ranges.length) return null;
  return (
    <div>
      <Eyebrow>Cobertura do Archive</Eyebrow>
      <ul className="mt-1.5 space-y-0.5">
        {ranges.map((range) => (
          <li
            key={`${range.from}-${range.to}`}
            className="numeral text-[12.5px] text-ash"
          >
            {formatLedger(range.from)} – {formatLedger(range.to)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The demo moment: everything else goes away and the corona comes back. */
function PhaseOverlay({
  progress,
  fraction,
  complete,
}: {
  progress: RecoveryProgress | null;
  fraction: number;
  complete: number;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-umbra/95 px-6 backdrop-blur-xl"
      role="status"
      aria-live="polite"
    >
      <Eclipse
        size={320}
        intensity={fraction}
        segments={{ total: STEPS.length, complete }}
        className="max-w-[78vw]"
      />

      <DecryptText
        key={progress?.label ?? "start"}
        text={progress?.label ?? "Starting"}
        perCharMs={30}
        tickMs={42}
        className="display glow-text mt-10 text-center text-[clamp(1.35rem,3.4vw,2rem)] text-cyan"
      />

      <p className="numeral mt-3 text-[13px] text-ash">
        {progress?.eventsTotal
          ? `${formatCount(progress.eventsReplayed ?? 0)} / ${formatCount(progress.eventsTotal)} eventos`
          : `${Math.round(fraction * 100)}%`}
      </p>

      <p className="numeral-wrap mt-6 max-w-[34rem] text-center text-[12.5px] leading-relaxed text-ash/70">
        {progress?.detail}
      </p>
    </div>
  );
}

function Stage({
  fraction,
  complete,
  progress,
  result,
  running,
}: {
  fraction: number;
  complete: number;
  progress: RecoveryProgress | null;
  result: RecoveryResult | null;
  running: boolean;
}) {
  const succeeded = result?.complete === true && result.verifiedAgainstChain;
  const headline = result
    ? succeeded
      ? "Fundos restaurados"
      : "Recuperação interrompida"
    : (progress?.label ?? "Nada aqui ainda");

  return (
    <Panel className="relative min-w-0 overflow-hidden">
      <div className="flex flex-col items-center px-5 py-10 sm:py-14">
        <Eclipse
          size={300}
          intensity={fraction}
          segments={{ total: STEPS.length, complete }}
          className="max-w-full"
        />

        <p
          className={cx(
            "display mt-8 text-center text-[clamp(1.25rem,3vw,1.7rem)] transition-colors duration-500",
            succeeded
              ? "glow-text text-cyan"
              : result || running
                ? "text-corona"
                : "text-ash",
          )}
        >
          {headline}
        </p>

        {progress?.eventsTotal ? (
          <p className="numeral mt-2.5 text-[13px] text-ash">
            {formatCount(progress.eventsReplayed ?? 0)} /{" "}
            {formatCount(progress.eventsTotal)} eventos
          </p>
        ) : (
          <p className="mt-2.5 max-w-[26rem] text-center text-[13px] leading-relaxed text-ash">
            {running
              ? "Reconstruindo as aberturas que tornam os compromissos gastáveis."
              : "O disco é o que a chain guarda. A coroa é o que só as suas chaves enxergam — e o que um dispositivo apagado perde."}
          </p>
        )}
      </div>
    </Panel>
  );
}

function Figure({
  label,
  value,
  sub,
  tone = "ash",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "corona" | "cyan" | "ash";
}) {
  const tones = {
    corona: "text-corona",
    cyan: "text-cyan",
    ash: "text-corona-dim",
  } as const;
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className={cx("numeral mt-1.5 text-[17px]", tones[tone])}>
        {value}
      </div>
      {sub && (
        <div className="numeral mt-1 text-[11.5px] leading-snug text-ash">
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * Cordoned off on purpose. Wiping local state is the setup for the demo, and it
 * must be one click — but it must never look like part of the wallet.
 */
function DemoControls({
  onWipe,
  disabled,
}: {
  onWipe: () => void;
  disabled: boolean;
}) {
  const { client } = useSombra();
  const [confirming, setConfirming] = useState(false);
  const [gap, setGap] = useState(
    () => client.demo?.isSimulatingArchiveGap() ?? false,
  );

  return (
    <div className="mt-8 rounded-2xl border border-dashed border-white/15 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Eyebrow className="text-chroma">Controles de demonstração</Eyebrow>
          <p className="mt-1 max-w-[34rem] text-[12.5px] leading-relaxed text-ash">
            Apague as aberturas locais para simular um dispositivo perdido. Os
            compromissos ficam na chain; só este navegador esquece como abri-los.
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2">
            <Button
              variant="danger"
              disabled={disabled}
              onClick={() => {
                onWipe();
                setConfirming(false);
              }}
            >
              Apagar
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancelar</Button>
          </div>
        ) : (
          <Button
            variant="danger"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            Apagar estado local
          </Button>
        )}
      </div>

      {client.demo && (
        <label className="mt-4 flex items-start gap-3 border-t border-white/10 pt-4 text-[12.5px] leading-relaxed text-ash">
          <input
            type="checkbox"
            checked={gap}
            disabled={disabled}
            onChange={(e) => {
              setGap(e.target.checked);
              client.demo?.simulateArchiveGap(e.target.checked);
            }}
            className="mt-0.5 size-3.5 accent-cyan"
          />
          Simular um archive sem parte do histórico, para mostrar como uma
          lacuna de cobertura difere de uma falha de verificação.
        </label>
      )}
    </div>
  );
}
