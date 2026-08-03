import { useEffect, useRef } from "react";

/**
 * The layer everything else floats over: a cyan wash from the top, two blurred
 * orbs pushed partly off-canvas, and a drifting starfield.
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
      <div
        className="orb -left-40 -top-32 h-[520px] w-[520px] bg-cyan/20"
        aria-hidden
      />
      <div
        className="orb -bottom-48 -right-40 h-[440px] w-[440px] bg-indigo-500/25"
        aria-hidden
      />
    </>
  );
}

interface Star {
  x: number;
  y: number;
  r: number;
  base: number;
  phase: number;
  drift: number;
}

function Starfield() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    let stars: Star[] = [];
    let frame = 0;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      el.width = width * dpr;
      el.height = height * dpr;
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Density by area, so a laptop and a projector look the same.
      const count = Math.round((width * height) / 9_000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.1 + 0.25,
        base: Math.random() * 0.45 + 0.12,
        phase: Math.random() * Math.PI * 2,
        drift: Math.random() * 0.02 + 0.004,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const t = frame / 60;
      for (const star of stars) {
        const twinkle = reduced
          ? star.base
          : star.base + Math.sin(t + star.phase) * 0.16;
        const alpha = Math.max(0.04, twinkle);
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        // Bright stars pick up the cyan; the rest stay white so the accent
        // still reads as an accent.
        ctx.fillStyle =
          star.r > 1
            ? `rgba(56, 226, 255, ${alpha})`
            : `rgba(255, 255, 255, ${alpha * 0.8})`;
        ctx.fill();

        if (!reduced) {
          star.y += star.drift;
          if (star.y > height) star.y = 0;
        }
      }
      frame += 1;
      raf = requestAnimationFrame(draw);
    };

    let raf = 0;
    resize();
    raf = requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvas}
      className="pointer-events-none fixed inset-0 z-0"
      aria-hidden
    />
  );
}
