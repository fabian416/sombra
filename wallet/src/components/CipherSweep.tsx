import type { ReactNode } from "react";
import { useGlyphScramble } from "../lib/useGlyphScramble";
import { cx } from "./ui";

/**
 * An indeterminate scanline for an operation that is genuinely in flight.
 *
 * It is deliberately indeterminate: it loops for exactly as long as the real
 * busy flag is true and claims nothing about how far along the work is. The
 * client reports no progress for a send, so neither does this — no phase
 * captions, no percentage, no fake steps that would desync once the live client
 * lands. It says "something is happening and it is encrypted", which is the
 * only thing that is actually known.
 *
 * The glyph band reuses the app's one scramble engine in "hold" mode, so the
 * cipher characters here are the same characters that resolve elsewhere.
 */
export function CipherSweep({
  active,
  children,
  label = "Encrypting",
}: {
  active: boolean;
  children: ReactNode;
  label?: string;
}) {
  return (
    <div className={cx("relative", active && "select-none")}>
      <div
        className={cx(
          "transition-opacity duration-300",
          active && "opacity-35",
        )}
        // Nothing inside is reachable while the operation runs.
        inert={active}
      >
        {children}
      </div>

      {active && <SweepOverlay label={label} />}
    </div>
  );
}

function SweepOverlay({ label }: { label: string }) {
  // "hold" never resolves — this is the resting cipher state, not a reveal.
  const { chars } = useGlyphScramble({
    text: "0000000000000000000000000000000000000000",
    mode: "hold",
    tickMs: 70,
  });

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
      aria-hidden
    >
      <div
        className="absolute inset-x-0"
        style={{ animation: "cipher-sweep 2.1s ease-in-out infinite" }}
      >
        {/* The band: cipher glyphs riding a bright leading edge. */}
        <div className="relative">
          <p className="truncate px-3 font-mono text-[11px] leading-none tracking-[0.32em] text-cyan/70 [text-shadow:0_0_10px_rgba(56,226,255,0.6)]">
            {chars.map((c) => c.ch).join("")}
          </p>
          <div
            className="mt-1 h-px w-full"
            style={{
              background:
                "linear-gradient(to right, transparent, rgba(56,226,255,0.9), transparent)",
              boxShadow: "0 0 14px rgba(56,226,255,0.75)",
            }}
          />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex justify-center pb-1">
        <span className="eyebrow text-cyan/80">{label}</span>
      </div>
    </div>
  );
}
