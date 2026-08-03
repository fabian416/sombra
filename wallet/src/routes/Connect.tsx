import { useEffect, useState } from "react";
import { Eclipse } from "../components/Eclipse";
import { Button, Eyebrow } from "../components/ui";
import { useSombra } from "../state/SombraProvider";
import { detectFreighter } from "../lib/freighter";

/** Facts, not features. Each one is checkable. */
const LEDGER = [
  { figure: "7 days", note: "Soroban RPC keeps events this long" },
  { figure: "Indefinite", note: "Sombra Archive keeps them this long" },
  { figure: "Zero trust", note: "every replay is checked against the chain" },
];

export function Connect() {
  const { connect, connecting, connectError } = useSombra();
  const [installed, setInstalled] = useState<boolean | null>(null);

  useEffect(() => {
    void detectFreighter().then(setInstalled);
  }, []);

  const missing = installed === false;

  return (
    <main className="relative z-10 mx-auto flex min-h-dvh w-full max-w-[1180px] flex-col px-6 py-8 sm:px-10 lg:py-12">
      <header className="flex items-center justify-between gap-6">
        <Wordmark />
        <div className="flex items-center gap-2">
          <span className="eyebrow border border-limb px-2 py-1 text-ash">
            Testnet
          </span>
        </div>
      </header>

      <div className="grid flex-1 items-center gap-14 py-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:py-8">
        <div className="max-w-[36rem] animate-rise">
          <Eyebrow className="text-horizon">
            Confidential Token &nbsp;·&nbsp; Private payment pools
          </Eyebrow>

          <h1 className="mt-5 text-[clamp(2.6rem,6.4vw,4.35rem)]">
            <span className="block text-corona">Hidden on chain.</span>
            <span
              className="block"
              style={{
                color: "#F2A03D",
                textShadow: "0 0 44px rgba(242,160,61,0.28)",
              }}
            >
              Never lost.
            </span>
          </h1>

          <p className="mt-6 max-w-[33rem] text-[15.5px] leading-[1.7] text-corona-dim">
            A confidential balance on Stellar is a commitment, not a number. To
            spend it your wallet has to replay your account's whole history from
            seed — and Stellar RPC only keeps seven days of that history.
          </p>
          <p className="mt-3.5 max-w-[33rem] text-[15.5px] leading-[1.7] text-ash">
            Lose your device after day eight and the funds are still yours on
            paper, still visible on chain, and permanently unspendable. Sombra
            keeps the history that makes them spendable.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              busy={connecting}
              onClick={() => void connect()}
              className="px-6 py-3 text-[14px]"
            >
              {connecting ? "Waiting for Freighter" : "Connect Freighter"}
            </Button>
            {missing && (
              <a
                href="https://www.freighter.app/"
                target="_blank"
                rel="noreferrer"
                className="eyebrow text-ash underline decoration-limb-bright underline-offset-4 transition-colors hover:text-corona"
              >
                Install Freighter
              </a>
            )}
          </div>

          {connectError && (
            <p className="mt-4 max-w-[30rem] text-[13px] text-chroma">
              {connectError}{" "}
              {missing
                ? "Install the extension, then reload this page."
                : "Open the extension, unlock it, and try again."}
            </p>
          )}

          <dl className="mt-12 grid max-w-[34rem] grid-cols-1 gap-px border border-limb bg-limb sm:grid-cols-3">
            {LEDGER.map((item) => (
              <div key={item.figure} className="bg-umbra px-4 py-3.5">
                <dt className="numeral text-[15px] text-corona">
                  {item.figure}
                </dt>
                <dd className="mt-1 text-[12.5px] leading-snug text-ash">
                  {item.note}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <EclipsePlate />
      </div>

      <footer className="eyebrow flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-limb pt-5 text-ash">
        <span>Stellar Builder Summit SP 26</span>
        <span className="text-limb-bright">/</span>
        <span>Privacy lane</span>
        <span className="text-limb-bright">/</span>
        <span>OpenZeppelin &nbsp;+&nbsp; Nethermind</span>
      </footer>
    </main>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <Eclipse size={compact ? 26 : 30} intensity={0.9} />
      <span
        className="display leading-none text-corona"
        style={{
          fontSize: compact ? 15 : 17,
          fontVariationSettings: '"wdth" 125',
          fontWeight: 700,
          letterSpacing: "0.22em",
        }}
      >
        SOMBRA
      </span>
    </div>
  );
}

/**
 * The thesis as an image: one object, two readings. The black disc is what an
 * observer gets; the corona is what only the key holder sees. Annotated like a
 * plate from an observatory bulletin, because that is what it is.
 */
function EclipsePlate() {
  return (
    <div className="flex justify-center lg:justify-end">
      <div className="relative aspect-square w-[min(86vw,440px)]">
        <Eclipse
          size={440}
          intensity={1}
          className="absolute inset-0 h-full w-full"
        />

        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          <g stroke="#3A2D59" strokeWidth="0.22" fill="none">
            <path d="M 58 42 L 74 24 L 88 24" />
            <path d="M 30 61 L 16 76 L 3 76" />
          </g>
          <circle cx="58" cy="42" r="0.7" fill="#8B82A6" />
          <circle cx="30" cy="61" r="0.7" fill="#DCE7F5" />
        </svg>

        <div className="absolute left-[80%] top-[12%] w-[9rem] -translate-y-full pb-1">
          <Eyebrow className="text-ash">The chain sees</Eyebrow>
          <p className="numeral mt-1 text-[12px] leading-snug text-ash">
            0x04a1…9f3c
          </p>
          <p className="mt-1 text-[12px] leading-snug text-ash/70">
            a Pedersen commitment
          </p>
        </div>

        <div className="absolute left-0 top-[78%] w-[10.5rem]">
          <Eyebrow className="text-corona-dim">You see</Eyebrow>
          <p className="numeral mt-1 text-[13px] leading-snug text-corona">
            840.2500000 XLM
          </p>
          <p className="mt-1 text-[12px] leading-snug text-ash">
            spendable, right now
          </p>
        </div>
      </div>
    </div>
  );
}
