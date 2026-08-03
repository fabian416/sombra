import { useId } from "react";

interface EclipseProps {
  size?: number;
  /** 0 = an unlit disc, 1 = full totality. Drives the corona, never the disc. */
  intensity?: number;
  /** Ring of arc segments around the limb, for stepped progress. */
  segments?: { total: number; complete: number };
  className?: string;
}

/**
 * The Sombra mark and the app's one piece of theatre.
 *
 * A total eclipse, drawn honestly: the disc is always black — that is the chain's
 * view, and it never brightens. What returns is the corona. Recovery does not
 * reveal your balance to the world; it gives you back the only light that was
 * ever yours to see.
 */
export function Eclipse({
  size = 320,
  intensity = 1,
  segments,
  className,
}: EclipseProps) {
  const uid = useId().replace(/:/g, "");
  const t = Math.max(0, Math.min(1, intensity));

  const c = size / 2;
  const disc = size * 0.235;
  const glow = size * 0.5;

  const rayCount = 44;
  const rays = Array.from({ length: rayCount }, (_, i) => {
    // Deterministic pseudo-random so the ray field is stable across renders.
    const n = Math.sin(i * 12.9898) * 43758.5453;
    const r = n - Math.floor(n);
    return {
      angle: (i / rayCount) * 360 + r * 4,
      length: disc * (0.35 + r * 1.25),
      width: 0.6 + r * 1.6,
      opacity: 0.18 + r * 0.42,
    };
  });

  const segRadius = disc + size * 0.052;
  const segCirc = 2 * Math.PI * segRadius;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={
        segments
          ? `Eclipse, ${segments.complete} of ${segments.total} steps complete`
          : "Sombra eclipse mark"
      }
    >
      <defs>
        {/* Tight at the limb, gone well before the edge — a corona, not a haze.
            Offsets are fractions of `glow`, so the limb sits at `limb`%. */}
        <radialGradient id={`corona-${uid}`}>
          <stop offset={`${limb}%`} stopColor="#F4F8FF" stopOpacity="0" />
          <stop
            offset={`${limb + 0.6}%`}
            stopColor="#EDF3FF"
            stopOpacity={0.62 * t}
          />
          <stop
            offset={`${limb + 5}%`}
            stopColor="#D2E0F5"
            stopOpacity={0.2 * t}
          />
          <stop
            offset={`${limb + 15}%`}
            stopColor="#A9B8DA"
            stopOpacity={0.07 * t}
          />
          <stop
            offset={`${limb + 30}%`}
            stopColor="#9B7CE8"
            stopOpacity={0.025 * t}
          />
          <stop offset="100%" stopColor="#9B7CE8" stopOpacity="0" />
        </radialGradient>

        <filter id={`soft-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation={size * 0.005} />
        </filter>
      </defs>

      <circle cx={c} cy={c} r={glow} fill={`url(#corona-${uid})`} />

      {/* Streamers. They drift because the corona does. */}
      <g
        filter={`url(#soft-${uid})`}
        opacity={t}
        style={{
          transformOrigin: "center",
          animation: "corona-drift 240s linear infinite",
        }}
      >
        {rays.map((ray, i) => (
          <rect
            key={i}
            x={c - ray.width / 2}
            y={c - disc - ray.length}
            width={ray.width}
            height={ray.length}
            rx={ray.width / 2}
            fill="#DCE7F5"
            opacity={ray.opacity}
            transform={`rotate(${ray.angle} ${c} ${c})`}
          />
        ))}
      </g>

      {/* Hydrogen-alpha prominence: one flare, off-axis, at high intensity only. */}
      {t > 0.85 && (
        <path
          d={`M ${c + disc * 0.62} ${c - disc * 0.78}
              q ${disc * 0.26} ${-disc * 0.2} ${disc * 0.34} ${disc * 0.06}
              q ${-disc * 0.16} ${-disc * 0.04} ${-disc * 0.34} ${disc * 0.1} Z`}
          fill="#FF4D6D"
          opacity={0.5 * (t - 0.85) * 6.6}
          filter={`url(#soft-${uid})`}
        />
      )}

      {segments && segments.total > 0 && (
        <g transform={`rotate(-90 ${c} ${c})`}>
          {Array.from({ length: segments.total }, (_, i) => {
            const gapDeg = 5;
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
                stroke={done ? "#F2A03D" : "#251C3A"}
                strokeWidth={size * 0.007}
                strokeLinecap="round"
                strokeDasharray={`${dash} ${segCirc - dash}`}
                strokeDashoffset={-((i * segCirc) / segments.total)}
                opacity={done ? 1 : 0.9}
                style={{ transition: "stroke 500ms ease, opacity 500ms ease" }}
              />
            );
          })}
        </g>
      )}

      {/* The chain's view. Always black. */}
      <circle cx={c} cy={c} r={disc} fill="#050309" />
      <circle
        cx={c}
        cy={c}
        r={disc}
        fill="none"
        stroke="#DCE7F5"
        strokeWidth={size * 0.0035}
        opacity={0.1 + 0.35 * t}
      />
    </svg>
  );
}
