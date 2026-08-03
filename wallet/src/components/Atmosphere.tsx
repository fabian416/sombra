import { useMemo } from "react";

/**
 * The layer everything else floats over: a cyan wash from the top, two soft
 * orbs pushed partly off-canvas, and a static starfield that twinkles in CSS.
 *
 * The starfield is ours rather than a generic particle field — Sombra is named
 * for a shadow cast across a sky, so the sky is the one thing that should be
 * moving when nothing else is.
 */
export function Atmosphere() {
  return (
    <>
      <Starfield />
      <div className="atmosphere-wash" aria-hidden />
      {/* Painted as radial gradients rather than blurred solids. A
          `filter: blur(150px)` on a 500px element is one of the most expensive
          things a page can ask for, it is repainted on every composite, and at
          these radii the two are visually indistinguishable. */}
      <div
        className="orb -left-40 -top-32 h-[520px] w-[520px]"
        style={{
          background:
            "radial-gradient(circle, rgba(56,226,255,0.16) 0%, rgba(56,226,255,0.06) 45%, transparent 70%)",
        }}
        aria-hidden
      />
      <div
        className="orb -bottom-48 -right-40 h-[440px] w-[440px]"
        style={{
          background:
            "radial-gradient(circle, rgba(99,102,241,0.18) 0%, rgba(99,102,241,0.06) 45%, transparent 70%)",
        }}
        aria-hidden
      />
    </>
  );
}

/**
 * A starfield that paints once and twinkles on the compositor.
 *
 * Two earlier versions of this were worse. A requestAnimationFrame loop never
 * lets the page reach idle and keeps a core warm for the whole session. A
 * canvas fixed over the viewport is cheap to paint but opaque to anything that
 * inspects the page, including our own screenshot tooling.
 *
 * Plain SVG circles have neither problem: the browser paints them once, an
 * opacity animation runs entirely on the compositor, and the field is ordinary
 * DOM. Two layers on offset cycles read as individual stars twinkling.
 */
function Starfield() {
  return (
    <>
      <StarLayer seed={1} durationSec={7} delaySec={0} />
      <StarLayer seed={2} durationSec={11} delaySec={-4} />
    </>
  );
}

const FIELD_W = 1600;
const FIELD_H = 900;

function StarLayer({
  seed,
  durationSec,
  delaySec,
}: {
  seed: number;
  durationSec: number;
  delaySec: number;
}) {
  // Deterministic, so the sky is the same on every render and every reload.
  const stars = useMemo(() => {
    let s = seed * 9871;
    const rand = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    return Array.from({ length: 70 }, () => {
      const r = rand() * 1.5 + 0.4;
      return {
        cx: rand() * FIELD_W,
        cy: rand() * FIELD_H,
        r,
        // Bright stars pick up the cyan; the rest stay white so the accent
        // still reads as an accent.
        fill: r > 1.4 ? "#38E2FF" : "#FFFFFF",
        opacity: rand() * 0.45 + 0.15,
      };
    });
  }, [seed]);

  return (
    <svg
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
      viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
      preserveAspectRatio="xMidYMid slice"
      style={{
        animation: `star-twinkle ${durationSec}s ease-in-out ${delaySec}s infinite`,
      }}
      aria-hidden
    >
      {stars.map((star, i) => (
        <circle
          key={i}
          cx={star.cx}
          cy={star.cy}
          r={star.r}
          fill={star.fill}
          opacity={star.opacity}
        />
      ))}
    </svg>
  );
}
