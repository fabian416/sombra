import type { ElementType } from "react";
import {
  useGlyphScramble,
  type ScrambleMode,
} from "../lib/useGlyphScramble";
import { cx } from "./ui";

interface DecryptTextProps {
  text: string;
  className?: string;
  /** Applied only to characters that have not resolved yet. */
  cipherClassName?: string;
  glyphs?: string;
  tickMs?: number;
  perCharMs?: number;
  delayMs?: number;
  mode?: ScrambleMode;
  run?: boolean;
  /** Periodic idle re-cipher of a few glyphs. Hero headline only. */
  ambient?: boolean;
  as?: ElementType;
}

/**
 * Text that arrives as ciphertext and decrypts in place.
 *
 * This is the app's signature effect and it is not decoration: a confidential
 * balance really is stored on chain as bytes nobody else can read, so showing
 * it resolve out of cipher glyphs states something true about where the number
 * came from. Used sparingly — the resting state is what makes each reveal read
 * as an event.
 */
export function DecryptText({
  text,
  className,
  cipherClassName,
  glyphs,
  tickMs,
  perCharMs,
  delayMs,
  mode,
  run,
  ambient,
  as: Tag = "span",
}: DecryptTextProps) {
  const { chars, pulse } = useGlyphScramble({
    text,
    glyphs,
    tickMs,
    perCharMs,
    delayMs,
    mode,
    run,
    ambient,
  });

  return (
    <Tag
      className={className}
      aria-label={text}
      onMouseEnter={ambient ? () => pulse() : undefined}
    >
      {chars.map((c, i) => {
        const real = text[i];
        // Whitespace never scrambles and never needs width games.
        if (c.resolved && c.ch === real) {
          return (
            <span key={i} aria-hidden>
              {c.ch}
            </span>
          );
        }
        // Reserve the FINAL character's width and overlay the cipher glyph, so
        // the line never reflows while glyphs (a different face) cycle.
        return (
          <span key={i} aria-hidden className="relative inline-block">
            <span className="invisible">{real}</span>
            <span
              className={cx(
                "absolute inset-0 flex items-center justify-center",
                cipherClassName ??
                  "font-mono text-cyan [text-shadow:0_0_12px_rgba(56,226,255,0.75)]",
              )}
            >
              {c.ch}
            </span>
          </span>
        );
      })}
    </Tag>
  );
}
