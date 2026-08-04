import type { ReactNode } from "react";
import { Eclipse } from "./Eclipse";
import { ArchiveGlyph } from "./OperationJourney";
import { Button } from "./ui";
import { useRevealOnce } from "../lib/useRevealOnce";

/**
 * The second — and last — viewport of the landing.
 *
 * Everything below the fold is still: the gate above already spends the page's
 * motion budget on the corona, the starfield and the fluid. What moves here is
 * the entrance, once, when the band scrolls into view, and nothing after that.
 *
 * The four illustrations are not new art. Each is a miniature of a motif the
 * wallet already uses — the split card, the journey line and its cipher
 * curtain, the eclipse with its segment ring, the Archive cylinder — so the
 * promise a visitor reads here is drawn with the same hand as the screen that
 * keeps it.
 *
 * Copy deck, in reading order:
 *   Eyebrow    Funcionalidades
 *   Heading    Privacidade que sobrevive à janela de sete dias.
 *   Cards      Saldo oculto na chain / Envio confidencial /
 *              Recuperação além dos 7 dias / Infraestrutura aberta
 *   Passos     Conecte → Use em sigilo → Recupere sempre
 */
export function LandingFeatures({
  onConnect,
  connecting,
}: {
  onConnect: () => void;
  connecting: boolean;
}) {
  const { ref, shown } = useRevealOnce<HTMLElement>();

  return (
    <section
      ref={ref}
      id="funcionalidades"
      className="relative z-10 flex min-h-dvh flex-col px-6 pb-6 pt-16 sm:px-10"
    >
      <div className="mx-auto flex w-full max-w-[1180px] flex-1 flex-col justify-center">
        <Reveal shown={shown}>
          <span className="eyebrow text-cyan">Funcionalidades</span>
          <h2 className="mt-3 max-w-[26rem] text-[clamp(1.6rem,3.2vw,2.25rem)] text-corona">
            Privacidade que sobrevive à janela de sete dias.
          </h2>
        </Reveal>

        <div className="mt-9 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {FEATURES.map((feature, i) => (
            <Reveal key={feature.title} shown={shown} delayMs={90 + i * 80}>
              <article className="panel flex h-full flex-col px-5 py-5">
                <div className="flex h-[52px] items-center">
                  {feature.illustration}
                </div>
                <h3 className="mt-4 text-[14px] font-semibold leading-snug text-corona">
                  {feature.title}
                </h3>
                <p className="mt-2 text-[12.5px] leading-relaxed text-ash">
                  {feature.line}
                </p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal shown={shown} delayMs={430}>
          <div className="mt-12 flex flex-col items-center gap-6 border-t border-white/10 pt-9">
            <ol className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
              {["Conecte", "Use em sigilo", "Recupere sempre"].map((step, i) => (
                <li key={step} className="flex items-center gap-3">
                  {i > 0 && <span aria-hidden className="text-cyan/50">→</span>}
                  <span className="eyebrow text-corona-dim">{step}</span>
                </li>
              ))}
            </ol>

            <Button
              variant="primary"
              busy={connecting}
              onClick={onConnect}
              className="px-6 py-3 text-[14px]"
            >
              {connecting ? "Aguardando o Freighter" : "Conectar Freighter →"}
            </Button>
          </div>
        </Reveal>
      </div>

      <footer className="eyebrow mx-auto mt-12 flex w-full max-w-[1180px] flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/10 pt-4 text-ash">
        <span>Stellar Builder Summit SP 26</span>
        <span className="text-white/20">/</span>
        <span>Trilha de privacidade</span>
        <span className="text-white/20">/</span>
        <span>OpenZeppelin &nbsp;+&nbsp; Nethermind</span>
      </footer>
    </section>
  );
}

const FEATURES: Array<{ title: string; line: string; illustration: ReactNode }> =
  [
    {
      title: "Saldo oculto na chain",
      line: "Legível só para você, compromisso para todos os outros.",
      illustration: <SplitMotif />,
    },
    {
      title: "Envio confidencial",
      line: "Endereços visíveis, valores nunca.",
      illustration: <JourneyMotif />,
    },
    {
      title: "Recuperação além dos 7 dias",
      line: "Sua seed + o Archive reconstroem tudo, verificado na chain.",
      illustration: <Eclipse size={48} segments={{ total: 7, complete: 5 }} animate={false} />,
    },
    {
      title: "Infraestrutura aberta",
      line: "Primeira implementação da spec INDEXER.md — audite com curl.",
      illustration: <ArchiveGlyph size={44} />,
    },
  ];

/** One entrance, on the way in, and never again. */
function Reveal({
  shown,
  delayMs = 0,
  children,
}: {
  shown: boolean;
  delayMs?: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(10px)",
        transition: `opacity 620ms ease-out ${delayMs}ms, transform 620ms cubic-bezier(0.2,0.7,0.3,1) ${delayMs}ms`,
      }}
    >
      {children}
    </div>
  );
}

/** The split card, shrunk: ciphertext on the left, the amount on the right. */
function SplitMotif() {
  return (
    <div
      className="relative flex h-[46px] w-[112px] overflow-hidden rounded-lg border border-white/10 bg-white/[0.03]"
      aria-hidden
    >
      <div className="numeral flex flex-1 flex-col justify-center gap-1 px-2 text-[7px] leading-none text-cyan/45">
        <span>a4f1c0…</span>
        <span>9e2b71…</span>
      </div>
      <span
        className="w-px shrink-0"
        style={{
          background:
            "linear-gradient(to bottom, transparent, rgba(56,226,255,0.6) 20%, rgba(56,226,255,0.6) 80%, transparent)",
          boxShadow: "0 0 10px rgba(56,226,255,0.45)",
        }}
      />
      <div className="flex flex-1 items-center justify-center">
        <span className="numeral text-[12px] text-cyan">12,40</span>
      </div>
    </div>
  );
}

/** The journey line, held at rest: one endpoint, the curtain, the other. */
function JourneyMotif() {
  return (
    <div className="relative flex h-[46px] w-[112px] items-center" aria-hidden>
      <span
        className="absolute inset-x-0 top-1/2 h-px"
        style={{
          background:
            "linear-gradient(to right, rgba(56,226,255,0.08), rgba(56,226,255,0.5), rgba(56,226,255,0.08))",
        }}
      />
      <Node label="G" />
      <span className="flex-1" />
      <span
        className="absolute left-1/2 top-1/2 h-7 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "linear-gradient(to bottom, transparent, rgba(56,226,255,0.95), transparent)",
          boxShadow: "0 0 12px rgba(56,226,255,0.75)",
        }}
      />
      <Node label="0" cipher />
    </div>
  );
}

function Node({ label, cipher = false }: { label: string; cipher?: boolean }) {
  return (
    <span
      className={`numeral relative z-10 flex h-5 w-5 items-center justify-center rounded-full border bg-umbra text-[8px] ${
        cipher
          ? "border-limb-bright text-cyan [text-shadow:0_0_8px_rgba(56,226,255,0.8)]"
          : "border-ash/40 text-corona-dim"
      }`}
    >
      {label}
    </span>
  );
}
