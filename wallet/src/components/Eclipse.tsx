import { useId } from "react";

interface EclipseProps {
  size?: number;
  /** 0 = an unlit disc, 1 = full totality. Drives the corona, never the disc. */
  intensity?: number;
  /** Ring of arc segments around the limb, for stepped progress. */
  segments?: { total: number; complete: number };
  /** Seconds per corona revolution. Defaults: 9 below 40px, 48 above. */
  spinSeconds?: number;
  /** Set false to hold the corona still. Below the fold nothing loops. */
  animate?: boolean;
  className?: string;
}

/**
 * The Sombra mark.
 *
 * A total eclipse, drawn the way one actually looks: a pure black void, a
 * luminous rim, and haze. No hairline rays — a real corona is light, not
 * scratches — so the streamers are a handful of broad, very faint wedges that
 * only register as asymmetry while they turn.
 *
 * The disc is empty by rule: nothing is drawn inside it and no annotation
 * crosses into it. It is the thing nobody gets to see, and the single brilliant
 * point on its rim is the thing you do.
 */
export function Eclipse({
  size = 320,
  intensity = 1,
  segments,
  spinSeconds,
  animate = true,
  className,
}: EclipseProps) {
  const uid = useId().replace(/:/g, "");
  const t = Math.max(0, Math.min(1, intensity));

  const c = size / 2;
  const disc = size * 0.235;
  const outer = size * 0.5;
  const limbPct = (disc / outer) * 100;

  // Below ~40px the streamers are noise; the mark is disc + limb + point.
  const showStreamers = size >= 40;
  const spin = spinSeconds ?? (size < 40 ? 9 : 48);

  /** Broad, tapered haze wedges. Uneven on purpose, so rotation reads. */
  const streamers = [
    { angle: 12, spread: 15, reach: 1.85, opacity: 0.5 },
    { angle: 78, spread: 9, reach: 1.35, opacity: 0.28 },
    { angle: 152, spread: 18, reach: 2.1, opacity: 0.6 },
    { angle: 214, spread: 8, reach: 1.25, opacity: 0.24 },
    { angle: 279, spread: 13, reach: 1.7, opacity: 0.42 },
    { angle: 331, spread: 7, reach: 1.2, opacity: 0.2 },
  ];

  /** A wedge that starts wide at the limb and thins as it reaches out. */
  const wedge = (angle: number, spread: number, reach: number) => {
    const inner = disc * 0.99;
    const far = disc * reach;
    const taper = 0.45;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const p = (r: number, a: number) =>
      `${c + r * Math.sin(a)},${c - r * Math.cos(a)}`;
    return [
      `M ${p(inner, rad(angle - spread))}`,
      `L ${p(far, rad(angle - spread * taper))}`,
      `L ${p(far, rad(angle + spread * taper))}`,
      `L ${p(inner, rad(angle + spread))}`,
      "Z",
    ].join(" ");
  };

  const segRadius = disc + size * 0.075;
  const segCirc = 2 * Math.PI * segRadius;

  // The diamond point sits on the rim, off-axis.
  const pointAngle = (38 * Math.PI) / 180;
  const px = c + disc * Math.sin(pointAngle);
  const py = c - disc * Math.cos(pointAngle);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={
        segments
          ? `Eclipse, ${segments.complete} de ${segments.total} etapas`
          : "Marca Sombra"
      }
    >
      <defs>
        {/* The limb: brightest exactly at the rim, gone within a few percent.
            A gradient rather than a stroke, so it glows instead of outlining. */}
        <radialGradient id={`limb-${uid}`}>
          <stop offset={`${limbPct - 1}%`} stopColor="#EAFDFF" stopOpacity="0" />
          <stop
            offset={`${limbPct}%`}
            stopColor="#CFF7FF"
            stopOpacity={0.95 * t}
          />
          <stop
            offset={`${limbPct + 1.6}%`}
            stopColor="#38E2FF"
            stopOpacity={0.55 * t}
          />
          <stop
            offset={`${limbPct + 6}%`}
            stopColor="#38E2FF"
            stopOpacity={0.16 * t}
          />
          <stop
            offset={`${limbPct + 18}%`}
            stopColor="#38E2FF"
            stopOpacity={0.05 * t}
          />
          <stop offset="100%" stopColor="#38E2FF" stopOpacity="0" />
        </radialGradient>

        {/* Haze fill for the streamers: fades to nothing before the edge. */}
        <radialGradient id={`haze-${uid}`}>
          <stop offset={`${limbPct}%`} stopColor="#9BEEFF" stopOpacity="0.5" />
          <stop
            offset={`${limbPct + 22}%`}
            stopColor="#38E2FF"
            stopOpacity="0.16"
          />
          <stop offset="100%" stopColor="#38E2FF" stopOpacity="0" />
        </radialGradient>

        <radialGradient id={`point-${uid}`}>
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity={t} />
          <stop offset="22%" stopColor="#CFF7FF" stopOpacity={0.9 * t} />
          <stop offset="55%" stopColor="#38E2FF" stopOpacity={0.35 * t} />
          <stop offset="100%" stopColor="#38E2FF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Haze first, so the limb reads on top of it. */}
      {showStreamers && (
        <g
          opacity={t * 0.85}
          style={{
            transformOrigin: "center",
            animation: animate
              ? `corona-drift ${spin}s linear infinite`
              : undefined,
            willChange: animate ? "transform" : undefined,
          }}
        >
          {streamers.map((s, i) => (
            <path
              key={i}
              d={wedge(s.angle, s.spread, s.reach)}
              fill={`url(#haze-${uid})`}
              opacity={s.opacity}
            />
          ))}
        </g>
      )}

      <circle cx={c} cy={c} r={outer} fill={`url(#limb-${uid})`} />

      {segments && segments.total > 0 && (
        <g transform={`rotate(-90 ${c} ${c})`}>
          {Array.from({ length: segments.total }, (_, i) => {
            const gapDeg = 7;
            const spanDeg = 360 / segments.total - gapDeg;
            const dash = (spanDeg / 360) * segCirc;
            const done = i < segments.complete;
            return (
              <circle
                key={i}
                cx={c}
                cy={c}
                r={segRadius}
                fill="none"
                stroke={done ? "#38E2FF" : "rgba(255,255,255,0.1)"}
                strokeWidth={size * 0.008}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${segCirc - dash}`}
                strokeDashoffset={-((i * segCirc) / segments.total)}
                style={{ transition: "stroke 600ms ease" }}
              />
            );
          })}
        </g>
      )}

      {/* The void. Painted last so nothing can bleed into it. */}
      <circle cx={c} cy={c} r={disc} fill="#000000" />

      {/* The diamond ring: the one point of light you are allowed to see. */}
      <circle cx={px} cy={py} r={size * 0.075} fill={`url(#point-${uid})`} />
      <circle
        cx={px}
        cy={py}
        r={Math.max(0.6, size * 0.011)}
        fill="#FFFFFF"
        opacity={t}
      />
    </svg>
  );
}
