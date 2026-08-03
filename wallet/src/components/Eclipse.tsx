import { useId } from "react";

interface EclipseProps {
  size?: number;
  /** 0 = an unlit disc, 1 = full totality. Drives the corona, never the disc. */
  intensity?: number;
  /** Ring of arc segments around the limb, for stepped progress. */
  segments?: { total: number; complete: number };
  /**
   * "mark" is the logo: a few bold, uneven streamers so the rotation reads at
   * 24–36px. "full" is the plate, with the fine ray field.
   */
  variant?: "full" | "mark";
  /** Seconds per corona revolution. Defaults: 9 for the mark, 48 for the plate. */
  spinSeconds?: number;
  className?: string;
}

/**
 * The Sombra mark and the app's one piece of theatre.
 *
 * A total eclipse, drawn honestly: the disc is always black — that is what the
 * ledger holds, and it never brightens. What returns is the corona.
 *
 * The disc never moves. The light rotates around it and cannot get in: the
 * private thing stays fixed while everything else turns.
 */
export function Eclipse({
  size = 320,
  intensity = 1,
  segments,
  variant = "full",
  spinSeconds,
  className,
}: EclipseProps) {
  const uid = useId().replace(/:/g, "");
  const t = Math.max(0, Math.min(1, intensity));

  const c = size / 2;
  const disc = size * 0.235;
  const glow = size * 0.5;
  const limb = (disc / glow) * 100;

  const isMark = variant === "mark";
  const spin = spinSeconds ?? (isMark ? 9 : 48);

  /**
   * The mark needs asymmetry to read as spinning at logo size, so it gets a
   * handful of long uneven streamers instead of the plate's even field.
   */
  // Lengths stay under (size/2 - disc) so the longest streamer never clips the
  // viewBox at logo size.
  const markUnit = size * 0.5 - disc;
  const rays = isMark
    ? [
        { angle: 8, length: markUnit * 0.86, width: size * 0.05, opacity: 0.95 },
        { angle: 52, length: markUnit * 0.3, width: size * 0.032, opacity: 0.5 },
        { angle: 104, length: markUnit * 0.62, width: size * 0.042, opacity: 0.75 },
        { angle: 143, length: markUnit * 0.24, width: size * 0.028, opacity: 0.42 },
        { angle: 199, length: markUnit * 0.98, width: size * 0.055, opacity: 1 },
        { angle: 248, length: markUnit * 0.34, width: size * 0.03, opacity: 0.48 },
        { angle: 296, length: markUnit * 0.72, width: size * 0.046, opacity: 0.82 },
        { angle: 334, length: markUnit * 0.28, width: size * 0.03, opacity: 0.45 },
      ]
    : Array.from({ length: 40 }, (_, i) => {
        // Deterministic pseudo-random so the ray field is stable across renders.
        const n = Math.sin(i * 12.9898) * 43758.5453;
        const r = n - Math.floor(n);
        return {
          angle: (i / 40) * 360 + r * 5,
          length: disc * (0.22 + r * 0.95),
          width: 0.5 + r * 1.1,
          opacity: 0.1 + r * 0.3,
        };
      });

  const segRadius = disc + size * 0.055;
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
          <stop offset={`${limb}%`} stopColor="#EAFDFF" stopOpacity="0" />
          <stop
            offset={`${limb + 0.6}%`}
            stopColor="#38E2FF"
            stopOpacity={0.62 * t}
          />
          <stop
            offset={`${limb + 5}%`}
            stopColor="#38E2FF"
            stopOpacity={0.2 * t}
          />
          <stop
            offset={`${limb + 15}%`}
            stopColor="#22B8D8"
            stopOpacity={0.07 * t}
          />
          <stop
            offset={`${limb + 30}%`}
            stopColor="#38E2FF"
            stopOpacity={0.025 * t}
          />
          <stop offset="100%" stopColor="#38E2FF" stopOpacity="0" />
        </radialGradient>

        <filter id={`soft-${uid}`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation={size * 0.005} />
        </filter>
      </defs>

      <circle cx={c} cy={c} r={glow} fill={`url(#corona-${uid})`} />

      {/* The streamers turn; the disc below them does not. */}
      <g
        filter={isMark ? undefined : `url(#soft-${uid})`}
        opacity={t}
        style={{
          transformOrigin: "center",
          animation: `corona-drift ${spin}s linear infinite`,
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
            fill="#9BEEFF"
            opacity={ray.opacity}
            transform={`rotate(${ray.angle} ${c} ${c})`}
          />
        ))}
      </g>

      {/* Hydrogen-alpha prominence: one flare, off-axis, at high intensity only. */}
      {variant === "full" && t > 0.85 && (
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
                stroke={done ? "#38E2FF" : "rgba(255,255,255,0.14)"}
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

      {/* The chain's view. Always black. */}
      <circle cx={c} cy={c} r={disc} fill="#000308" />
      {/* The limb: the one hard, bright edge in the whole mark. */}
      <circle
        cx={c}
        cy={c}
        r={disc}
        fill="none"
        stroke="#38E2FF"
        strokeWidth={Math.max(0.75, size * 0.0045)}
        opacity={0.12 + 0.78 * t}
      />
    </svg>
  );
}
