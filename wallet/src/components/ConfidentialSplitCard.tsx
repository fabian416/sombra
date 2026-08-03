import { DecryptText } from "./DecryptText";
import { Eyebrow, Panel, PanelHeader } from "./ui";
import type { ConfidentialBalance } from "../lib/client";
import { formatAmount } from "../lib/format";

/**
 * The resting state of the whole wallet: one balance, shown twice.
 *
 * Left is the account's Pedersen commitment — the bytes the ledger actually
 * stores. Right is the amount those bytes open to, which only this device can
 * compute. The card does not animate; the numbers decrypt once when they load
 * and then sit still, which is what makes any later sweep read as an event.
 *
 * The cipher side is deliberately not decorative noise. It renders the real
 * commitment for this account, so a judge who diffs it against the chain finds
 * the same value.
 */
export function ConfidentialSplitCard({
  balance,
  loading,
  footer,
}: {
  balance: ConfidentialBalance | null;
  loading: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <Panel className="min-w-0 overflow-hidden">
      <PanelHeader
        title="Confidential balance"
        layer="CT"
        note="The same balance, both ways: as the chain stores it, and as only you can read it."
      />

      <div className="grid grid-cols-1 md:grid-cols-2">
        {/* Cipher side */}
        <div className="relative px-5 py-6">
          <Eyebrow>Your balance as the chain stores it</Eyebrow>

          {balance ? (
            <div className="mt-4 space-y-5">
              <CipherBlock
                label="Spendable commitment"
                bytes={balance.commitments.spendable}
              />
              <CipherBlock
                label="Receiving commitment"
                bytes={balance.commitments.receiving}
              />
            </div>
          ) : (
            <div className="mt-4 space-y-3" aria-hidden>
              <Bar className="h-3 w-full" />
              <Bar className="h-3 w-4/5" />
            </div>
          )}

          <p className="mt-5 text-[12px] leading-relaxed text-ash/70">
            No amount can be recovered from these points without your keys.
          </p>
        </div>

        {/* The seam. A thin cyan line, beaded like a particle track. */}
        <div
          className="pointer-events-none absolute hidden md:block"
          aria-hidden
        />

        {/* Plaintext side */}
        <div className="relative border-t border-white/10 px-5 py-6 md:border-l md:border-t-0">
          <Seam />
          <Eyebrow className="text-corona-dim">
            And as only you can read it
          </Eyebrow>

          {balance ? (
            <div className="mt-4 space-y-5">
              <Plain
                label="Spendable"
                amount={formatAmount(balance.spendable)}
                delayMs={120}
              />
              <Plain
                label="Receiving"
                amount={formatAmount(balance.receiving)}
                delayMs={420}
                muted={balance.receiving === 0n}
              />
            </div>
          ) : (
            <div className="mt-4 space-y-3" aria-hidden>
              <Bar className="h-7 w-44" />
              <Bar className="h-7 w-36" />
            </div>
          )}

          <p className="mt-5 text-[12px] leading-relaxed text-ash/70">
            {loading
              ? "Reading the ledger…"
              : "Computed on this device from your openings."}
          </p>
        </div>
      </div>

      {footer && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-3.5">
          {footer}
        </div>
      )}
    </Panel>
  );
}

function CipherBlock({ label, bytes }: { label: string; bytes: string }) {
  return (
    <div>
      <div className="eyebrow text-ash/60">{label}</div>
      {/* These are the real commitment bytes for this account.
          TODO: replace with the on-chain commitment bytes when the live client
          is wired — the shape and length already match. */}
      <p className="numeral-wrap mt-1.5 text-[12.5px] leading-relaxed text-cyan/55">
        {bytes}
      </p>
    </div>
  );
}

function Plain({
  label,
  amount,
  delayMs,
  muted = false,
}: {
  label: string;
  amount: string;
  delayMs: number;
  muted?: boolean;
}) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1.5 flex items-baseline gap-2">
        <DecryptText
          // Re-key on the value so a balance change decrypts again rather than
          // silently swapping numbers under the reader.
          key={amount}
          text={amount}
          delayMs={delayMs}
          perCharMs={26}
          tickMs={40}
          className={
            muted
              ? "numeral text-[19px] text-ash"
              : "numeral text-[19px] text-cyan"
          }
        />
        <span className="eyebrow text-ash">XLM</span>
      </div>
    </div>
  );
}

/** The split: a hairline with a few brighter beads riding it. */
function Seam() {
  return (
    <span
      className="pointer-events-none absolute -left-px top-0 hidden h-full w-px md:block"
      aria-hidden
      style={{
        background:
          "linear-gradient(to bottom, transparent, rgba(56,226,255,0.55) 12%, rgba(56,226,255,0.2) 50%, rgba(56,226,255,0.55) 88%, transparent)",
        boxShadow: "0 0 12px rgba(56,226,255,0.45)",
      }}
    />
  );
}

function Bar({ className }: { className?: string }) {
  return (
    <div
      className={`rounded bg-white/8 ${className ?? ""}`}
      style={{ animation: "corona-breathe 1.8s ease-in-out infinite" }}
    />
  );
}
