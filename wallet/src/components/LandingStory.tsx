import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./ui";

/**
 * The selling half of the landing: after the features grid, three sections that
 * make the case the way the team's brand does it — problem told as a story,
 * numbers a judge can audit, and one last chance to connect.
 *
 * Everything below the fold is static by rule (one entrance reveal each). The
 * drama comes from the facts: the RPC refusal is a real error code, the stats
 * are real test counts, and every claim here is reproducible from the repo.
 */
export function LandingStory({
  onConnect,
  connecting,
}: {
  onConnect: () => void;
  connecting: boolean;
}) {
  return (
    <>
      <Problem />
      <Numbers />
      <FinalCall onConnect={onConnect} connecting={connecting} />
    </>
  );
}

/* ------------------------- The seven-day story --------------------------- */

const DAYS: Array<{
  eyebrow: string;
  title: string;
  body: string;
  tone: "neutral" | "bad" | "good";
}> = [
  {
    eyebrow: "Dia 1",
    title: "Você deposita",
    body: "Seu saldo vira um compromisso Pedersen: visível para todos, legível só para você. Cada movimento emite eventos na chain.",
    tone: "neutral",
  },
  {
    eyebrow: "Dia 8",
    title: "O RPC esquece",
    body: "A Stellar retém eventos por 7 dias. Perdeu o dispositivo? Sem o histórico, o saldo continua na chain — e ninguém consegue gastá-lo. Para sempre.",
    tone: "bad",
  },
  {
    eyebrow: "Com Sombra",
    title: "O Archive lembra",
    body: "Cada evento fica guardado indefinidamente. Sua assinatura + o Archive reconstroem as chaves de gasto — e a chain confirma cada byte.",
    tone: "good",
  },
];

function Problem() {
  const { ref, shown } = useRevealOnce<HTMLElement>();

  return (
    <section
      ref={ref}
      className="relative z-10 px-6 py-24 sm:px-10"
    >
      <div className="mx-auto w-full max-w-[1180px]">
        <Reveal shown={shown}>
          <span className="eyebrow text-cyan">O problema</span>
          <h2 className="mt-3 max-w-[30rem] text-[clamp(1.6rem,3.2vw,2.25rem)] text-corona">
            Sete dias separam privacidade de perda permanente.
          </h2>
        </Reveal>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {DAYS.map((day, i) => (
            <Reveal key={day.eyebrow} shown={shown} delayMs={110 + i * 110}>
              <article
                className={
                  "panel relative h-full overflow-hidden px-6 py-6 " +
                  (day.tone === "good" ? "glow-soft" : "")
                }
              >
                <span
                  className={
                    "eyebrow " +
                    (day.tone === "bad"
                      ? "text-chroma"
                      : day.tone === "good"
                        ? "text-cyan"
                        : "text-ash")
                  }
                >
                  {day.eyebrow}
                </span>
                <h3 className="mt-2.5 text-[17px] font-semibold text-corona">
                  {day.title}
                </h3>
                <p className="mt-2.5 text-[13px] leading-relaxed text-ash">
                  {day.body}
                </p>
                {day.tone === "good" && (
                  <div
                    className="pointer-events-none absolute inset-x-0 top-0 h-px"
                    style={{
                      background:
                        "linear-gradient(to right, transparent, rgba(56,226,255,0.8), transparent)",
                    }}
                    aria-hidden
                  />
                )}
              </article>
            </Reveal>
          ))}
        </div>

        {/* The receipts: same request, two answers. Both real. */}
        <Reveal shown={shown} delayMs={470}>
          <div className="mt-12 grid gap-4 md:grid-cols-2">
            <div className="panel px-6 py-5">
              <div className="flex items-center justify-between gap-4">
                <span className="eyebrow">Soroban RPC · ledger antigo</span>
                <span className="eyebrow text-chroma">recusado</span>
              </div>
              <p className="numeral-wrap mt-3 text-[12.5px] leading-relaxed text-chroma/85">
                {"error -32600: startLedger must be within the ledger range"}
              </p>
              <p className="mt-3 text-[12px] leading-relaxed text-ash">
                A mesma pergunta, feita ao RPC, sobre um ledger fora da janela.
              </p>
            </div>
            <div className="panel glow-soft px-6 py-5">
              <div className="flex items-center justify-between gap-4">
                <span className="eyebrow">Sombra Archive · mesmo ledger</span>
                <span className="eyebrow text-cyan">respondido</span>
              </div>
              <p className="numeral-wrap mt-3 text-[12.5px] leading-relaxed text-cyan/85">
                {'{ "events": [10], "complete": true }'}
              </p>
              <p className="mt-3 text-[12px] leading-relaxed text-ash">
                O Archive responde — com a flag de completude honesta que a spec
                exige.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------- Numbers you can audit ------------------------- */

const STATS: Array<{ figure: string; note: string }> = [
  { figure: "26", note: "testes de conformidade, um por cláusula da spec" },
  { figure: "102", note: "testes do kit, fixados byte a byte às fixtures" },
  { figure: "13", note: "transações reais na testnet, com provas UltraHonk" },
  { figure: "0", note: "ledgers de atraso na ingestão, agora" },
];

function Numbers() {
  const { ref, shown } = useRevealOnce<HTMLElement>();

  return (
    <section ref={ref} className="relative z-10 px-6 pb-24 sm:px-10">
      <div className="mx-auto w-full max-w-[1180px]">
        <Reveal shown={shown}>
          <span className="eyebrow text-cyan">Números auditáveis</span>
          <h2 className="mt-3 max-w-[30rem] text-[clamp(1.6rem,3.2vw,2.25rem)] text-corona">
            Nada aqui é promessa. Rode os testes.
          </h2>
        </Reveal>

        <div className="mt-9 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 lg:grid-cols-4">
          {STATS.map((stat, i) => (
            <Reveal key={stat.note} shown={shown} delayMs={90 + i * 80}>
              <div className="h-full bg-umbra px-6 py-6">
                <div className="numeral text-[34px] leading-none text-cyan glow-text">
                  {stat.figure}
                </div>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-ash">
                  {stat.note}
                </p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal shown={shown} delayMs={430}>
          <p className="mt-6 text-[12.5px] leading-relaxed text-ash">
            Primeira implementação da spec{" "}
            <span className="numeral text-corona-dim">INDEXER.md</span> da
            OpenZeppelin — o scorecard cláusula por cláusula está no repositório,
            e o endpoint de saúde do Archive responde em tempo real.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------ Final call ------------------------------- */

function FinalCall({
  onConnect,
  connecting,
}: {
  onConnect: () => void;
  connecting: boolean;
}) {
  const { ref, shown } = useRevealOnce<HTMLElement>();

  return (
    <section ref={ref} className="relative z-10 px-6 pb-20 sm:px-10">
      <div className="mx-auto w-full max-w-[1180px]">
        <Reveal shown={shown}>
          <div className="panel glow-hero relative overflow-hidden px-8 py-14 text-center sm:px-14">
            <h2 className="mx-auto max-w-[24rem] text-[clamp(1.7rem,3.4vw,2.4rem)] text-corona">
              Pronto para nunca mais perder um saldo?
            </h2>
            <p className="mx-auto mt-4 max-w-[26rem] text-[13.5px] leading-relaxed text-ash">
              Conecte a Freighter na testnet e veja um saldo confidencial ser
              apagado, recuperado e verificado — em menos de um minuto.
            </p>
            <div className="mt-8 flex justify-center">
              <Button
                variant="primary"
                busy={connecting}
                onClick={onConnect}
                className="px-7 py-3.5 text-[14px]"
              >
                {connecting ? "Aguardando a Freighter" : "Conectar Freighter →"}
              </Button>
            </div>

            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-40"
              style={{
                background:
                  "radial-gradient(ellipse at bottom, rgba(56,226,255,0.14), transparent 65%)",
              }}
              aria-hidden
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------- Helpers --------------------------------- */

function useRevealOnce<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || shown) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.18 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shown]);

  return { ref, shown };
}

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
