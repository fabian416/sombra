import { useEffect, useRef, useState } from "react";

/**
 * The one glyph engine in the app.
 *
 * It resolves a string left to right: every character not yet resolved renders
 * as a cycling cipher glyph, and characters lock into their real value one at a
 * time. Two consumers share it — the queued reveal (`DecryptText`) and, later,
 * the cipher glyphs inside a scanline sweep — so the scramble looks and times
 * the same everywhere rather than being reimplemented per screen.
 *
 * `mode: "hold"` never resolves; that is the resting cipher state.
 */
export type ScrambleMode = "resolve" | "hold";

export interface GlyphScrambleOptions {
  text: string;
  /** The alphabet unresolved characters cycle through. Binary by default. */
  glyphs?: string;
  /** How often unresolved glyphs re-roll. */
  tickMs?: number;
  /** How long each character waits behind the one before it. */
  perCharMs?: number;
  /** Delay before the first character resolves. */
  delayMs?: number;
  mode?: ScrambleMode;
  /** Set false to render the final text with no animation at all. */
  run?: boolean;
}

export interface ScrambledChar {
  /** What to render right now — a cipher glyph, or the real character. */
  ch: string;
  resolved: boolean;
}

const DEFAULT_GLYPHS = "01";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Whitespace never scrambles — it would only make the text jitter. */
function isStatic(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === " ";
}

export function useGlyphScramble({
  text,
  glyphs = DEFAULT_GLYPHS,
  tickMs = 45,
  perCharMs = 34,
  delayMs = 0,
  mode = "resolve",
  run = true,
}: GlyphScrambleOptions): { chars: ScrambledChar[]; done: boolean } {
  const reduced = prefersReducedMotion();
  const instant = !run || (reduced && mode === "resolve");

  const [chars, setChars] = useState<ScrambledChar[]>(() =>
    text.split("").map((ch) => ({ ch, resolved: true })),
  );
  const [done, setDone] = useState(true);
  const raf = useRef(0);

  useEffect(() => {
    if (instant) {
      setChars(text.split("").map((ch) => ({ ch, resolved: true })));
      setDone(true);
      return;
    }

    const source = text.split("");
    const started = performance.now();
    let lastTick = 0;
    // Cached so a re-roll only touches unresolved slots.
    let current: ScrambledChar[] = source.map((ch) => ({
      ch: isStatic(ch) ? ch : glyphs[0],
      resolved: isStatic(ch),
    }));
    setChars(current);
    setDone(false);

    const pick = () => glyphs[Math.floor(Math.random() * glyphs.length)];

    const frame = (now: number) => {
      const elapsed = now - started - delayMs;
      const resolvedCount =
        mode === "hold"
          ? 0
          : Math.max(0, Math.min(source.length, Math.floor(elapsed / perCharMs)));

      if (now - lastTick >= tickMs || resolvedCount > 0) {
        const rolling = now - lastTick >= tickMs;
        if (rolling) lastTick = now;

        current = source.map((ch, i) => {
          if (isStatic(ch)) return { ch, resolved: true };
          if (i < resolvedCount) return { ch, resolved: true };
          // Keep the previous glyph between ticks so it does not strobe.
          return {
            ch: rolling ? pick() : (current[i]?.ch ?? pick()),
            resolved: false,
          };
        });
        setChars(current);
      }

      if (mode === "resolve" && resolvedCount >= source.length) {
        setDone(true);
        return;
      }
      raf.current = requestAnimationFrame(frame);
    };

    raf.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf.current);
  }, [text, glyphs, tickMs, perCharMs, delayMs, mode, instant]);

  return { chars, done };
}
