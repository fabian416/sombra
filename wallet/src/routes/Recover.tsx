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
    title: "Derive keys",
    note: "From a signature by the enrolled signer, bound to this contract and account",
  },
  {
    phase: "checkpoint",
    title: "Fetch checkpoint",
    note: "From the Sombra Archive, which retains events past the RPC floor",
  },
  {
    phase: "replay",
    title: "Replay events",
    note: "Every deposit, transfer and merge since the checkpoint",
  },
  {
    phase: "verify",
    title: "Verify against chain",
    note: "Re-commit the openings and compare to the on-chain points",
  },
  {
    phase: "restored",
    title: "Funds restored",
    note: "The balance is spendable again",
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
        err instanceof Error ? err.message : "Recovery stopped before finishing.";
      setError(detail);
      toast.error("Recovery failed", detail);
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
        title="Recover"
        lede="Stellar RPC retains seven days of history. The Sombra Archive retains all of it, so a wallet signature is enough to make a confidential balance spendable again on any device."
      />

      {!hasLocalState && !showStage && (
        <div className="mb-6">
          <Notice tone="warn">
            This device has no openings for your confidential balance. The funds
            are on chain and unreadable until you recover.
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
              title="Recover with your wallet signature"
              layer="ARCHIVE"
              note="There is nothing to type. Your keys come from a signature, not a phrase."
            />
            <div className="space-y-5 px-5 py-5">
              <p className="text-[13.5px] leading-relaxed text-ash">
                Sombra asks your wallet to sign one fixed message naming this
                token contract and your account. That signature derives the same
                keys on any device, so nothing has to be stored.
              </p>

              <Button variant="primary" onClick={() => void start()}>
                Sign and recover
              </Button>

              {error && <Notice tone="warn">{error}</Notice>}

              <div className="space-y-3 border-t border-white/10 pt-4">
                <div>
                  <Eyebrow>Archive endpoint</Eyebrow>
                  <p className="numeral-wrap mt-1.5 text-[12.5px] text-ash">
                    {ARCHIVE_URL}
                  </p>
                </div>
                {CLIENT_MODE === "mock" && (
                  <Notice>
                    Simulated in this build. No Archive request is made and no
                    keys are derived — the flow, the timings and the failure
                    states are real, the cryptography is not yet wired.
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
            <PanelHeader title="Replay log" layer="ARCHIVE" />
            <div className="h-[188px] overflow-y-auto px-5 py-4">
              {log.length === 0 ? (
                <p className="text-[13px] text-ash">
                  Waiting for the first event.
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
            <PanelHeader title="Steps" />
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
            title="Recovery stopped — incomplete history"
            layer="ARCHIVE"
            action={<Button onClick={onReset}>Try again</Button>}
          />
          <div className="space-y-4 px-5 py-5">
            <Notice>
              The Archive answered and what it returned was well formed. It just
              does not hold every ledger in your history, so a replay would be
              missing events and the balance it produced would be wrong.
            </Notice>

            <div>
              <Eyebrow>Ledgers the Archive is missing</Eyebrow>
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
              Point Sombra at an archive that covers the gap and run this again.
              Your funds are untouched — nothing was written, and no partial
              state was saved.
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
            title="Recovery refused — verification failed"
            layer="ARCHIVE"
            action={<Button onClick={onReset}>Try again</Button>}
          />
          <div className="space-y-4 px-5 py-5">
            <Notice tone="warn">
              The Archive served your whole history with no gaps, but the
              openings rebuilt from it do not commit to the points on chain. The
              events this archive returned are not the events your account
              emitted.
            </Notice>
            <p className="text-[13px] leading-relaxed text-ash">
              Nothing was saved. Do not spend against this archive — try an
              independent one and compare.
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
          title="Restored"
          layer="ARCHIVE"
          action={<Button onClick={onReset}>Run it again</Button>}
        />
        <div className="grid gap-x-8 gap-y-5 px-5 py-5 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Spendable"
            value={`${formatAmount(result.restored.spendable)} XLM`}
            tone="cyan"
          />
          <Figure
            label="Receiving"
            value={`${formatAmount(result.restored.receiving)} XLM`}
            tone="cyan"
          />
          <Figure
            label="Events replayed"
            value={formatCount(result.eventsReplayed)}
            sub={`ledgers ${formatLedger(result.fromLedger)} – ${formatLedger(result.throughLedger)}`}
          />
          <Figure
            label="Below the RPC floor"
            value={formatCount(result.beyondRpcWindow)}
            tone="cyan"
            sub="unavailable without the Archive"
          />
        </div>
        <div className="space-y-4 border-t border-white/10 px-5 py-4">
          <Coverage ranges={result.archiveCoverage} />
          <Notice tone="good">
            Served whole, and verified against the on-chain commitments. Your
            balance is spendable again —{" "}
            <Link to="/send" className="underline underline-offset-4">
              send a private transfer
            </Link>{" "}
            to prove it.
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
      <Eyebrow>Archive coverage</Eyebrow>
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
          ? `${formatCount(progress.eventsReplayed ?? 0)} / ${formatCount(progress.eventsTotal)} events`
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
      ? "Funds restored"
      : "Recovery stopped"
    : (progress?.label ?? "Nothing here yet");

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
            {formatCount(progress.eventsTotal)} events
          </p>
        ) : (
          <p className="mt-2.5 max-w-[26rem] text-center text-[13px] leading-relaxed text-ash">
            {running
              ? "Rebuilding the openings that make the commitments spendable."
              : "The disc is what the chain stores. The corona is what only your keys can see — and what a wiped device loses."}
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
          <Eyebrow className="text-chroma">Demo controls</Eyebrow>
          <p className="mt-1 max-w-[34rem] text-[12.5px] leading-relaxed text-ash">
            Wipe the local openings to simulate a lost device. The commitments
            stay on chain; only this browser forgets how to open them.
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
              Wipe it
            </Button>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        ) : (
          <Button
            variant="danger"
            disabled={disabled}
            onClick={() => setConfirming(true)}
          >
            Wipe local state
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
          Simulate an archive missing part of the history, to show how a coverage
          gap differs from a verification failure.
        </label>
      )}
    </div>
  );
}
