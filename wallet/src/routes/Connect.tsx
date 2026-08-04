import { useEffect, useState } from "react";
import { Eclipse } from "../components/Eclipse";
import { DecryptText } from "../components/DecryptText";
import { ArchivePanel } from "../components/ArchivePanel";
import { LandingFeatures } from "../components/LandingFeatures";
import { LandingStory } from "../components/LandingStory";
import { SplashCursorLayer } from "../components/SplashCursorLayer";
import { Button } from "../components/ui";
import { ARCHIVE_URL, useSombra } from "../state/SombraProvider";
import { detectFreighter } from "../lib/freighter";

/**
 * Copy deck — the gate, in reading order. Kept beside the screen so the demo
 * script and the UI cannot drift apart.
 *
 *   Chips      Confidential Token · Stellar / Conforme à spec · Trustless · Open source
 *   Headline   Oculto na chain. / Nunca perdido.
 *   Body       Um saldo confidencial é um compromisso, não um número. Gastá-lo
 *              exige reproduzir todo o histórico de eventos da conta, e a RPC
 *              da Stellar guarda sete dias.
 *   CTA        Conectar Freighter → · ver status do Archive ↗
 *   Painel     A chain vê / Você vê · Cobertura do histórico · Ingestão
 *
 * Register: state the mechanism, then its consequence. No superlatives, no
 * filler. The numbers carry the weight on their own.
 */

/**
 * The landing, in four movements.
 *
 * The first viewport is the gate and nothing else: one claim, one action.
 * Below it, for the visitor who didn't connect on sight: the four functions
 * (LandingFeatures), then the sell (LandingStory) — the seven-day story told
 * in three panels, the RPC-refusal receipts, numbers a judge can audit, and
 * one last CTA. Long enough to sell, short enough to stay a wallet.
 */
export function Connect() {
  const { connect, connecting, connectError, enterPreview } = useSombra();
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    void detectFreighter().then(setInstalled);
  }, []);

  const missing = installed === false;

  return (
    <>
      {/* Landing only. Nothing inside the wallet loops at rest. */}
      <SplashCursorLayer />
      <div className="relative z-10 flex min-h-dvh flex-col px-6 py-6 sm:px-10">
        <header className="flex items-center justify-between gap-6">
          <Wordmark />
          <span className="eyebrow rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-ash backdrop-blur">
            Testnet
          </span>
        </header>

        <main className="grid flex-1 items-center gap-12 py-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10 lg:py-4">
          <div className="max-w-[34rem]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="eyebrow rounded-full border border-cyan/35 px-2.5 py-1 text-cyan">
                Confidential Token · Stellar
              </span>
              <span className="eyebrow text-ash">
                Conforme à spec · Trustless · Open source
              </span>
            </div>

            <h1 className="mt-6 text-[clamp(2.5rem,6vw,4.1rem)]">
              <DecryptText
                as="span"
                text="Oculto na chain."
                delayMs={160}
                perCharMs={34}
                ambient
                className="block text-corona"
              />
              <DecryptText
                as="span"
                text="Nunca perdido."
                delayMs={720}
                perCharMs={40}
                ambient
                className="glow-text block text-cyan"
              />
            </h1>

            <p className="mt-6 max-w-[32rem] text-[15.5px] leading-[1.7] text-corona-dim">
              Um saldo confidencial é um compromisso, não um número. Gastá-lo exige
              reproduzir todo o histórico de eventos da conta, e a RPC da Stellar
              guarda sete dias.
            </p>
            <p className="mt-3.5 max-w-[32rem] text-[15.5px] leading-[1.7] text-ash">
              Depois dessa janela o saldo continua visivelmente seu e deixa de ser
              gastável. O Sombra guarda o histórico que o torna gastável de novo.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Button
                variant="primary"
                busy={connecting}
                onClick={() => void connect()}
                className="px-6 py-3 text-[14px]"
              >
                {connecting ? "Aguardando o Freighter" : "Conectar Freighter →"}
              </Button>
              <a
                href={`${ARCHIVE_URL}/v1/health`}
                target="_blank"
                rel="noreferrer"
                className="eyebrow text-ash underline decoration-white/20 underline-offset-4 transition-colors hover:text-corona"
              >
                ver status do Archive ↗
              </a>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-4">
              {missing && (
                <a
                  href="https://www.freighter.app/"
                  target="_blank"
                  rel="noreferrer"
                  className="eyebrow text-cyan underline decoration-cyan/40 underline-offset-4"
                >
                  Instalar o Freighter
                </a>
              )}
              <button
                type="button"
                onClick={enterPreview}
                className="eyebrow text-ash/70 underline decoration-white/15 underline-offset-4 transition-colors hover:text-corona"
              >
                Explorar com dados de demonstração
              </button>
            </div>

            {connectError && (
              <p className="mt-4 max-w-[30rem] text-[13px] text-chroma">
                {connectError}{" "}
                {missing
                  ? "Instale a extensão e recarregue a página."
                  : "Abra a extensão, desbloqueie e tente de novo."}
              </p>
            )}
          </div>

          <div className="flex justify-center lg:justify-end">
            <ArchivePanel />
          </div>
        </main>

        <ScrollHint />
      </div>

      <LandingFeatures
        onConnect={() => void connect()}
        connecting={connecting}
      />

      <LandingStory
        onConnect={() => void connect()}
        connecting={connecting}
      />
    </>
  );
}

/**
 * The one thing in the gate that admits there is more page. It has to be quiet
 * enough that a visitor who came to connect never notices it, and moving
 * enough that a visitor who is still reading knows to keep going — so: a label,
 * a chevron, and a slow bob. Clicking it scrolls; it is a control, not a
 * decoration.
 *
 * A button and not an anchor: the app is on a HashRouter, so `#funcionalidades`
 * in the URL is a route, not a target.
 */
function ScrollHint() {
  return (
    <div className="flex justify-center pt-2">
      <button
        type="button"
        onClick={() =>
          document
            .getElementById("funcionalidades")
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
        className="group flex flex-col items-center gap-1.5 py-1 text-ash transition-colors hover:text-corona"
      >
        <span className="eyebrow transition-colors group-hover:text-corona">
          Funcionalidades
        </span>
        <svg
          viewBox="0 0 16 10"
          width="16"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="opacity-70"
          style={{ animation: "scroll-hint 2.4s ease-in-out infinite" }}
          aria-hidden
        >
          <path d="M2 2.5 8 8 14 2.5" />
        </svg>
      </button>
    </div>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Eclipse size={compact ? 26 : 30} intensity={1} />
      <span
        className="display leading-none text-corona"
        style={{
          fontSize: compact ? 15 : 17,
          fontWeight: 600,
          letterSpacing: "0.26em",
        }}
      >
        SOMBRA
      </span>
    </div>
  );
}
