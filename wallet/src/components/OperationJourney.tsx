import { useEffect, useMemo, useRef, useState } from "react";
import { Eclipse } from "./Eclipse";

/**
 * The operation overlay: a conveyor of token cards passing through a standing
 * particle curtain. On the cipher side of the curtain the same cards render as
 * dense ciphertext; on the clear side they are legible. Encryption happens at
 * a place, and the cards travel through it.
 *
 * Direction is protocol-honest: operations that enter confidentiality encrypt
 * left of the curtain (cards travel into cipher); operations that exit resolve
 * as they cross. The caption below names the operation; nothing claims a
 * progress the client does not report.
 *
 * Act 2 — settlement: on success the stream resolves into one centered card
 * and a final sweep; on failure the overlay exits and the error toast speaks.
 */
type Op = "shield" | "unshield" | "send" | "swap" | "recover";

interface OpSpec {
  /** Caption line, cyan. */
  pill: string;
  /** Second caption line, gray — the concrete honest step. */
  step: string;
  /** Route caption on the card. */
  route: string;
  /** Card face. */
  icon: "stellar" | "eclipse" | "pool" | "archive";
  title: string;
  /** Cards travel right→left; which side of the curtain is ciphertext. */
  cipherSide: "left" | "right";
}

const SPECS: Record<Op, OpSpec> = {
  shield: {
    pill: "Processando depósito…",
    step: "Este depósito é público — o que acontece depois dele não é.",
    route: "Stellar Testnet → Saldo confidencial",
    icon: "stellar",
    title: "XLM",
    cipherSide: "left",
  },
  unshield: {
    pill: "Processando saque…",
    step: "O valor sacado volta a ser público na chain.",
    route: "Saldo confidencial → Stellar Testnet",
    icon: "stellar",
    title: "XLM",
    cipherSide: "right",
  },
  send: {
    pill: "Processando transferência confidencial…",
    step: "Endereços visíveis, valor oculto — apenas um compromisso viaja.",
    route: "Sua carteira → Destinatário",
    icon: "eclipse",
    title: "XLM",
    cipherSide: "left",
  },
  swap: {
    pill: "Executando a rota…",
    step: "Só o meio do caminho é público — e não pertence a ninguém.",
    route: "Pool blindado → Pool blindado",
    icon: "pool",
    title: "XLM",
    cipherSide: "right",
  },
  recover: {
    pill: "Restaurando histórico…",
    step: "Cada evento reproduzido é verificado contra a chain.",
    route: "Sombra Archive → Sua carteira",
    icon: "archive",
    title: "Eventos",
    cipherSide: "right",
  },
};

export function OperationJourney({
  op,
  active,
  succeeded,
}: {
  op: Op;
  active: boolean;
  succeeded: boolean;
}) {
  const spec = SPECS[op];
  const [stage, setStage] = useState<"idle" | "journey" | "settle">("idle");
  const wasActive = useRef(false);

  useEffect(() => {
    if (active) {
      setStage("journey");
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    if (succeeded) {
      setStage("settle");
      const id = window.setTimeout(() => setStage("idle"), 1_800);
      return () => window.clearTimeout(id);
    }
    setStage("idle");
  }, [active, succeeded]);

  if (stage === "idle") return null;

  return (
    <div
      className="fixed inset-0 z-[90] bg-umbra"
      aria-live="polite"
    >
      <style>{JOURNEY_CSS}</style>
      {stage === "journey" ? <Conveyor spec={spec} /> : <Settle spec={spec} />}
    </div>
  );
}

/* ------------------------- Act 1: the conveyor --------------------------- */

/** Card pitch: width + gap. Both layers and the loop math share it. */
const CARD_W = 380;
const CARD_GAP = 110;
const PITCH = CARD_W + CARD_GAP;
const CARDS = 6;
/** Where the curtain stands, as a fraction of the viewport width. */
const CURTAIN = 0.44;

function Conveyor({ spec }: { spec: OpSpec }) {
  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* Clear layer. */}
      <ConveyorLayer spec={spec} cipher={false} />

      {/* Cipher layer: the same stream, clipped to the curtain's side. Both
          layers run the same animation, so a card is always one card — it just
          renders differently on each side of the line. */}
      <div
        className="absolute inset-0"
        style={{
          clipPath:
            spec.cipherSide === "left"
              ? `inset(0 ${(1 - CURTAIN) * 100}% 0 0)`
              : `inset(0 0 0 ${CURTAIN * 100}%)`,
        }}
      >
        <ConveyorLayer spec={spec} cipher />
      </div>

      <ParticleCurtain />

      <div className="absolute inset-x-0 bottom-14 flex flex-col items-center gap-1.5 px-6 text-center">
        <p className="glow-text text-[17px] font-medium text-cyan">
          {spec.pill}
        </p>
        <p className="text-[13px] text-ash">{spec.step}</p>
      </div>
    </div>
  );
}

function ConveyorLayer({ spec, cipher }: { spec: OpSpec; cipher: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center" aria-hidden={cipher}>
      <div
        className="flex"
        style={{
          gap: `${CARD_GAP}px`,
          width: `${CARDS * PITCH}px`,
          animation: `sj-conveyor 5.5s linear infinite`,
          willChange: "transform",
        }}
      >
        {Array.from({ length: CARDS }, (_, i) =>
          cipher ? (
            <CipherCard key={i} seed={i} />
          ) : (
            <TokenCard key={i} spec={spec} />
          ),
        )}
      </div>
    </div>
  );
}

function TokenCard({ spec }: { spec: OpSpec }) {
  return (
    <div
      className="panel flex shrink-0 flex-col items-center justify-center px-10 py-12"
      style={{ width: CARD_W, height: 300 }}
    >
      <CardBadge icon={spec.icon} />
      <div className="mt-6 text-[26px] font-semibold tracking-tight text-corona">
        {spec.title}
      </div>
      <div className="mt-2 text-[14px] text-corona-dim">{spec.route}</div>
    </div>
  );
}

function CardBadge({ icon }: { icon: OpSpec["icon"] }) {
  if (icon === "eclipse")
    return <Eclipse size={104} intensity={0.95} spinSeconds={48} />;
  return (
    <span
      className="flex h-[104px] w-[104px] items-center justify-center rounded-full"
      style={{
        background:
          icon === "stellar"
            ? "linear-gradient(140deg, #0e7490, #155e75)"
            : "rgba(56,226,255,0.10)",
        border: "1px solid rgba(56,226,255,0.35)",
        boxShadow: "0 0 40px rgba(56,226,255,0.25)",
      }}
    >
      {icon === "stellar" && <StellarMark size={56} />}
      {icon === "pool" && <PoolWave size={56} />}
      {icon === "archive" && <ArchiveGlyph size={54} />}
    </span>
  );
}

/**
 * The same card, already through the curtain: the frame survives, the content
 * is ciphertext. Rows are seeded-random and stable — the stream reads as text,
 * not as noise being re-rolled.
 */
function CipherCard({ seed }: { seed: number }) {
  const rows = useMemo(() => cipherRows(seed, 13, 34), [seed]);
  return (
    <div
      className="flex shrink-0 flex-col justify-center overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.02] px-6"
      style={{ width: CARD_W, height: 300 }}
    >
      {rows.map((row, i) => (
        <p
          key={i}
          className="numeral truncate text-[11px] leading-[1.55] text-cyan/45"
        >
          {row}
        </p>
      ))}
    </div>
  );
}

const CIPHER_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&*+-/:;<=>?@[]^`{|}~";

function cipherRows(seed: number, rows: number, cols: number): string[] {
  // Tiny deterministic PRNG — stable rows per card, no Math.random in render.
  let s = 0x2f6e2b1 + seed * 0x9e3779b9;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
  return Array.from({ length: rows }, () =>
    Array.from(
      { length: cols },
      () => CIPHER_ALPHABET[Math.floor(next() * CIPHER_ALPHABET.length)],
    ).join(""),
  );
}

/** The standing curtain: a luminous core with a spray of particles. */
function ParticleCurtain() {
  const dots = useMemo(() => {
    let s = 0xc0ffee;
    const next = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 0xffffffff;
    };
    return Array.from({ length: 110 }, () => ({
      x: (next() - 0.5) * 26,
      y: next() * 460,
      r: 0.6 + next() * 1.5,
      o: 0.25 + next() * 0.75,
    }));
  }, []);

  return (
    <div
      className="pointer-events-none absolute top-1/2 -translate-y-1/2"
      style={{ left: `${CURTAIN * 100}%` }}
      aria-hidden
    >
      <div className="relative -translate-x-1/2">
        {/* Core. */}
        <div
          className="h-[440px] w-[3px] rounded-full"
          style={{
            background:
              "linear-gradient(to bottom, transparent, rgba(56,226,255,0.9) 12%, rgba(56,226,255,0.9) 88%, transparent)",
            boxShadow:
              "0 0 22px rgba(56,226,255,0.8), 0 0 70px rgba(56,226,255,0.3)",
          }}
        />
        {/* Spray. */}
        <svg
          viewBox="0 0 30 460"
          width="30"
          height="460"
          className="absolute left-1/2 top-0 -translate-x-1/2"
        >
          {dots.map((d, i) => (
            <circle
              key={i}
              cx={15 + d.x}
              cy={d.y}
              r={d.r}
              fill={i % 3 ? "#EDF3FF" : "#38E2FF"}
              opacity={d.o}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------- Act 2 ----------------------------------- */

function Settle({ spec }: { spec: OpSpec }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center">
      <div className="animate-rise flex flex-col items-center">
        <div
          className="panel glow-soft relative flex flex-col items-center justify-center overflow-hidden px-10 py-12 text-center"
          style={{ width: CARD_W, height: 300 }}
        >
          <CardBadge icon={spec.icon} />
          <div className="mt-6 text-[26px] font-semibold tracking-tight text-corona">
            {spec.title}
          </div>
          <div className="mt-2 text-[14px] text-corona-dim">{spec.route}</div>

          {/* One sweep, then done. */}
          <div
            className="pointer-events-none absolute inset-x-0 h-px"
            style={{
              top: "-4%",
              background:
                "linear-gradient(to right, transparent, rgba(56,226,255,0.9), transparent)",
              boxShadow: "0 0 16px rgba(56,226,255,0.7)",
              animation: "cipher-sweep 1.3s ease-in-out 1 forwards",
            }}
          />
        </div>
        <span className="eyebrow mt-5 text-cyan/80">Concluído</span>
      </div>
    </div>
  );
}

/* ------------------------------ Glyph marks ------------------------------ */

/** The Archive: a database cylinder. Also the landing's "open infra" glyph. */
export function ArchiveGlyph({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <ellipse
        cx="12"
        cy="6"
        rx="8"
        ry="3"
        fill="none"
        stroke="#38E2FF"
        strokeWidth="1.4"
      />
      <path
        d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"
        fill="none"
        stroke="#38E2FF"
        strokeOpacity="0.7"
        strokeWidth="1.4"
      />
    </svg>
  );
}

/**
 * The official Stellar symbol, drawn inline (public brand asset; standard use
 * for ecosystem projects). Two rotated arcs of the same circle.
 */
export function StellarMark({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <g fill="none" stroke="#EDF3FF" strokeWidth="2.1" strokeLinecap="round">
        <path d="M2.6 14.8 A 9.7 9.7 0 0 1 19.2 6.4 L 21.6 5.2" />
        <path d="M21.4 9.2 A 9.7 9.7 0 0 1 4.8 17.6 L 2.4 18.8" />
      </g>
    </svg>
  );
}

function PoolWave({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M4 10.2c2.7-2 5.3-2 8 0s5.3 2 8 0M4 14.8c2.7-2 5.3-2 8 0s5.3 2 8 0"
        fill="none"
        stroke="#38E2FF"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------ Local CSS -------------------------------- */

const JOURNEY_CSS = `
@keyframes sj-conveyor {
  from { transform: translateX(0); }
  to   { transform: translateX(-${PITCH}px); }
}
`;
