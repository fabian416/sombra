import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  /**
   * After the entrance resolves, let a short run of characters briefly fall
   * back to cipher every 8–14s. The text "remembering" it is ciphertext.
   * This is the app's one idle animation; nothing else may loop at rest.
   */
  ambient?: boolean;
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
  ambient = false,
}: GlyphScrambleOptions): {
  chars: ScrambledChar[];
  done: boolean;
  pulse: (at?: number) => void;
} {
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

  /**
   * Briefly re-cipher a short contiguous run, then let it resolve back. Never
   * touches more than a few characters, so the line never reflows and the
   * effect reads as a flicker rather than a re-entrance.
   */
  const pulseRef = useRef<number>(0);
  const [pulseWindow, setPulseWindow] = useState<[number, number] | null>(null);

  const pulse = useCallback(
    (at?: number) => {
      if (reduced) return;
      const source = text.split("");
      const spots = source
        .map((ch, i) => (isStatic(ch) ? -1 : i))
        .filter((i) => i >= 0);
      if (!spots.length) return;

      const width = 2 + Math.floor(Math.random() * 3);
      const start =
        at !== undefined
          ? Math.max(0, Math.min(at, source.length - width))
          : spots[Math.floor(Math.random() * Math.max(1, spots.length - width))];

      window.clearTimeout(pulseRef.current);
      setPulseWindow([start, start + width]);
      pulseRef.current = window.setTimeout(
        () => setPulseWindow(null),
        420 + Math.random() * 180,
      );
    },
    [text, reduced],
  );

  // Cycle glyphs inside the active pulse window, and schedule the next one.
  const [pulseTick, setPulseTick] = useState(0);
  useEffect(() => {
    if (!pulseWindow) return;
    const id = setInterval(() => setPulseTick((n) => n + 1), 55);
    return () => clearInterval(id);
  }, [pulseWindow]);

  useEffect(() => {
    if (!ambient || !done || reduced) return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          // Idle motion has no business running against a tab nobody is looking at.
          if (!document.hidden) pulse();
          schedule();
        },
        8_000 + Math.random() * 6_000,
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [ambient, done, reduced, pulse]);

  useEffect(() => () => window.clearTimeout(pulseRef.current), []);

  const withPulse = useMemo(() => {
    if (!pulseWindow) return chars;
    void pulseTick;
    const glyph = () => glyphs[Math.floor(Math.random() * glyphs.length)];
    return chars.map((c, i) =>
      i >= pulseWindow[0] && i < pulseWindow[1] && !isStatic(c.ch)
        ? { ch: glyph(), resolved: false }
        : c,
    );
  }, [chars, pulseWindow, pulseTick, glyphs]);

  return { chars: withPulse, done, pulse };
}
