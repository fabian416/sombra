import { useEffect, useRef, useState } from "react";
import { Eclipse } from "./Eclipse";
import { useGlyphScramble } from "../lib/useGlyphScramble";

/**
 * The two-act operation animation.
 *
 * Act 1 — the journey: origin and destination cards joined by a line, with
 * value traveling between them. A cipher curtain sits midway; whatever crosses
 * it flips between legible and ciphertext, in the direction the protocol
 * actually implies (encrypting on the way into confidentiality, resolving on
 * the way out). The pill on top counts real elapsed time.
 *
 * Act 2 — settlement: when the operation succeeds, the journey resolves into a
 * single token card and one sweep, then leaves. On failure the overlay simply
 * exits — the error toast is the honest surface, not this.
 *
 * Everything here is presentational; the timing authority is the caller's
 * `active` flag (the real busy state of the mock or live client). Indeterminate
 * by design: no fake progress, no phase captions the client cannot back.
 */
type Op = "shield" | "unshield" | "send" | "swap" | "recover";

interface Endpoint {
  icon: "stellar" | "eclipse" | "pool" | "archive" | "recipient";
  name: string;
  role: string;
}

interface OpSpec {
  pill: string;
  left: Endpoint;
  right: Endpoint;
  /** Which side of the curtain shows ciphertext travelers. */
  flip: "encrypt" | "decrypt" | "always-cipher";
  /** The one honest sentence under the journey. */
  note: string;
  /** Traveler shape: coins for value, chips for events. */
  traveler: "coin" | "chip";
  settleAsset?: string;
}

const SPECS: Record<Op, OpSpec> = {
  shield: {
    pill: "Processando depósito",
    left: { icon: "stellar", name: "Stellar Testnet", role: "Origem pública" },
    right: { icon: "eclipse", name: "Saldo confidencial", role: "Destino oculto" },
    flip: "encrypt",
    note: "Este depósito é público — o que acontece depois dele não é.",
    traveler: "coin",
    settleAsset: "XLM",
  },
  unshield: {
    pill: "Processando saque",
    left: { icon: "eclipse", name: "Saldo confidencial", role: "Origem oculta" },
    right: { icon: "stellar", name: "Stellar Testnet", role: "Destino público" },
    flip: "decrypt",
    note: "O valor sacado volta a ser público na chain.",
    traveler: "coin",
    settleAsset: "XLM",
  },
  send: {
    pill: "Transferência confidencial",
    left: { icon: "eclipse", name: "Sua carteira", role: "Origem" },
    right: { icon: "recipient", name: "Destinatário", role: "Endereço visível" },
    flip: "always-cipher",
    note: "Endereços visíveis, valor oculto — apenas um compromisso viaja.",
    traveler: "coin",
    settleAsset: "XLM",
  },
  swap: {
    pill: "Executando rota",
    left: { icon: "pool", name: "Pool blindado", role: "Origem" },
    right: { icon: "pool", name: "Pool blindado", role: "Destino" },
    flip: "decrypt",
    note: "Só o meio do caminho é público — e não pertence a ninguém.",
    traveler: "coin",
    settleAsset: "XLM",
  },
  recover: {
    pill: "Restaurando histórico",
    left: { icon: "archive", name: "Sombra Archive", role: "Histórico durável" },
    right: { icon: "eclipse", name: "Sua carteira", role: "Saldo restaurado" },
    flip: "decrypt",
    note: "Cada evento reproduzido é verificado contra a chain.",
    traveler: "chip",
    settleAsset: "XLM",
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
      className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-umbra/95 backdrop-blur-sm"
      aria-live="polite"
    >
      <style>{JOURNEY_CSS}</style>
      {stage === "journey" ? <Journey spec={spec} /> : <Settle spec={spec} />}
    </div>
  );
}

/* ------------------------------- Act 1 ---------------------------------- */

function Journey({ spec }: { spec: OpSpec }) {
  const seconds = useElapsedSeconds();

  return (
    <div className="animate-rise flex w-full max-w-[820px] flex-col items-center px-6">
      <div className="panel flex items-center gap-2.5 rounded-full px-5 py-2.5">
        <span className="sj-spinner" aria-hidden />
        <span className="text-[13.5px] text-cyan">
          {spec.pill} <span className="text-ash">•</span>{" "}
          <span className="numeral">{seconds}s</span>
        </span>
      </div>

      <div className="mt-12 flex w-full items-center gap-5">
        <EndpointCard endpoint={spec.left} />

        <div className="relative h-32 flex-1">
          {/* The line. */}
          <div
            className="absolute left-0 right-0 top-1/2 h-px"
            style={{
              background:
                "linear-gradient(to right, rgba(56,226,255,0.05), rgba(56,226,255,0.55), rgba(56,226,255,0.05))",
            }}
          />
          <Curtain />
          {[0, 1, 2].map((i) => (
            <Traveler key={i} index={i} spec={spec} />
          ))}
        </div>

        <EndpointCard endpoint={spec.right} />
      </div>

      <p className="mt-10 max-w-[30rem] text-center text-[12.5px] leading-relaxed text-ash">
        {spec.note}
      </p>
    </div>
  );
}

function useElapsedSeconds(): number {
  const [s, setS] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const id = setInterval(
      () => setS(Math.floor((performance.now() - started) / 1000)),
      250,
    );
    return () => clearInterval(id);
  }, []);
  return s;
}

function EndpointCard({ endpoint }: { endpoint: Endpoint }) {
  return (
    <div className="panel flex w-[172px] shrink-0 flex-col items-center px-4 py-5 text-center">
      <div className="flex h-12 w-12 items-center justify-center">
        <EndpointIcon icon={endpoint.icon} />
      </div>
      <div className="mt-3 text-[13.5px] font-semibold text-corona">
        {endpoint.name}
      </div>
      <div className="eyebrow mt-1">{endpoint.role}</div>
    </div>
  );
}

function EndpointIcon({ icon }: { icon: Endpoint["icon"] }) {
  switch (icon) {
    case "eclipse":
      return <Eclipse size={40} intensity={0.9} spinSeconds={40} />;
    case "stellar":
      return <StellarMark size={34} />;
    case "pool":
      return (
        <svg viewBox="0 0 24 24" width={34} height={34} aria-hidden>
          <circle
            cx="12"
            cy="12"
            r="9.2"
            fill="none"
            stroke="#38E2FF"
            strokeOpacity="0.55"
            strokeWidth="1.4"
          />
          <path
            d="M6 11.2c2-1.5 4-1.5 6 0s4 1.5 6 0M6 14.6c2-1.5 4-1.5 6 0s4 1.5 6 0"
            fill="none"
            stroke="#38E2FF"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      );
    case "archive":
      return <ArchiveGlyph size={34} />;
    case "recipient":
      return (
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-limb-bright bg-umbra-lift">
          <span className="numeral text-[12px] text-corona-dim">G…</span>
        </div>
      );
  }
}

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
      <g
        fill="none"
        stroke="#EDF3FF"
        strokeWidth="2.1"
        strokeLinecap="round"
      >
        <path d="M2.6 14.8 A 9.7 9.7 0 0 1 19.2 6.4 L 21.6 5.2" />
        <path d="M21.4 9.2 A 9.7 9.7 0 0 1 4.8 17.6 L 2.4 18.8" />
      </g>
    </svg>
  );
}

/** The vertical cipher curtain at the midpoint of the line. */
function Curtain() {
  const { chars } = useGlyphScramble({
    text: "0110100101101",
    mode: "hold",
    tickMs: 80,
  });

  return (
    <div
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      aria-hidden
    >
      <div className="relative flex items-center">
        {/* Faint cipher column bleeding off the encrypted side. */}
        <p
          className="numeral absolute right-2 text-[9px] leading-[1.35] text-cyan/45"
          style={{ writingMode: "vertical-rl" }}
        >
          {chars.map((c) => c.ch).join("")}
        </p>
        <div
          className="h-24 w-[3px] rounded-full"
          style={{
            background:
              "linear-gradient(to bottom, transparent, rgba(56,226,255,0.95), transparent)",
            boxShadow:
              "0 0 18px rgba(56,226,255,0.8), 0 0 44px rgba(56,226,255,0.35)",
          }}
        />
      </div>
    </div>
  );
}

/**
 * One traveler on the line. Two stacked faces whose opacities swap exactly at
 * the curtain (50% of the path), so the flip happens where the flip happens.
 */
function Traveler({ index, spec }: { index: number; spec: OpSpec }) {
  const dur = 3.4;
  const delay = index * (dur / 3);
  const cipherFace = (
    <span className="sj-face flex h-full w-full items-center justify-center rounded-full border border-limb-bright bg-umbra text-[10px] font-mono text-cyan [text-shadow:0_0_8px_rgba(56,226,255,0.8)]">
      {index % 2 ? "1" : "0"}
    </span>
  );
  const clearFace = (
    <span className="sj-face flex h-full w-full items-center justify-center rounded-full border border-ash/40 bg-umbra">
      {spec.traveler === "chip" ? (
        <span className="numeral text-[8px] text-corona-dim">ev</span>
      ) : (
        <StellarMark size={12} />
      )}
    </span>
  );

  const before = spec.flip === "encrypt" ? clearFace : cipherFace;
  const after =
    spec.flip === "encrypt" || spec.flip === "always-cipher"
      ? cipherFace
      : clearFace;

  return (
    // A full-width, zero-height track carrying the dot at its left edge.
    // Animating the track's transform (not `left`) keeps the whole journey on
    // the compositor: three travelers cost zero layout work per frame.
    <span
      className="absolute left-0 right-0 top-1/2 h-0"
      style={{
        animation: `sj-travel ${dur}s linear ${delay}s infinite`,
        opacity: 0,
      }}
      aria-hidden
    >
      <span className="absolute -top-2.5 h-5 w-5" style={{ left: "-10px" }}>
        <span
          className="sj-a absolute inset-0"
          style={{ animationDuration: `${dur}s`, animationDelay: `${delay}s` }}
        >
          {before}
        </span>
        <span
          className="sj-b absolute inset-0"
          style={{ animationDuration: `${dur}s`, animationDelay: `${delay}s` }}
        >
          {after}
        </span>
      </span>
    </span>
  );
}

/* ------------------------------- Act 2 ---------------------------------- */

function Settle({ spec }: { spec: OpSpec }) {
  return (
    <div className="animate-rise flex flex-col items-center">
      <div className="panel glow-soft relative w-[290px] overflow-hidden px-8 py-9 text-center">
        <div className="flex justify-center">
          <EndpointIcon icon={spec.right.icon} />
        </div>
        <div className="mt-4 text-[19px] font-semibold text-corona">
          {spec.settleAsset}
        </div>
        <div className="mt-1.5 text-[12.5px] text-ash">
          {spec.left.name} → {spec.right.name}
        </div>

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
  );
}

/* ------------------------------ Local CSS -------------------------------- */

const JOURNEY_CSS = `
@keyframes sj-travel {
  0% { transform: translateX(0); opacity: 0; }
  6% { opacity: 1; }
  94% { opacity: 1; }
  100% { transform: translateX(100%); opacity: 0; }
}
@keyframes sj-faceA {
  0%, 49% { opacity: 1; }
  51%, 100% { opacity: 0; }
}
@keyframes sj-faceB {
  0%, 49% { opacity: 0; }
  51%, 100% { opacity: 1; }
}
.sj-a { animation-name: sj-faceA; animation-timing-function: linear; animation-iteration-count: infinite; }
.sj-b { animation-name: sj-faceB; animation-timing-function: linear; animation-iteration-count: infinite; }
.sj-face { display: flex; }
.sj-spinner {
  width: 13px; height: 13px; border-radius: 999px;
  border: 1.5px solid rgba(56,226,255,0.25);
  border-top-color: rgba(56,226,255,0.95);
  animation: sj-spin 0.9s linear infinite;
}
@keyframes sj-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .sj-spinner { animation: none; }
}
`;
