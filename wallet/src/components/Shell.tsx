import { NavLink, Outlet } from "react-router-dom";
import { Wordmark } from "../routes/Connect";
import { ArchiveStatus } from "./ArchiveStatus";
import { LayerTag, cx, type Layer } from "./ui";
import { useSombra } from "../state/SombraProvider";
import { truncateAddress } from "../lib/format";

/** `layer` names the privacy primitive each screen drives. */
const NAV: Array<{ to: string; label: string; layer?: Layer }> = [
  { to: "/", label: "Saldos" },
  { to: "/send", label: "Enviar e receber", layer: "CT" },
  { to: "/shield", label: "Pool blindado", layer: "SPP" },
  { to: "/recover", label: "Recuperar", layer: "ARCHIVE" },
  { to: "/swap", label: "Troca", layer: "SPP" },
];

export function Shell() {
  const { identity, disconnect, hasLocalState, preview } = useSombra();

  return (
    <div className="relative z-10 flex min-h-dvh flex-col md:flex-row">
      <nav className="shrink-0 border-b border-limb md:w-[216px] md:border-b-0 md:border-r">
        <div className="px-5 py-5 md:px-6 md:py-6">
          <Wordmark compact />
        </div>

        <ul className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:gap-0 md:overflow-visible md:px-3 md:pb-0">
          {NAV.map((item) => (
            <li key={item.to} className="shrink-0 md:shrink">
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  cx(
                    "group relative flex items-center justify-between gap-2 whitespace-nowrap px-3 py-2.5 text-[13.5px] transition-colors",
                    isActive
                      ? "text-corona"
                      : "text-ash hover:text-corona-dim",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={cx(
                        "absolute left-0 top-1/2 hidden h-4 w-px -translate-y-1/2 transition-colors md:block",
                        isActive ? "bg-cyan" : "bg-transparent",
                      )}
                      aria-hidden
                    />
                    <span className="flex items-center gap-2">
                      {item.label}
                      {item.to === "/recover" && !hasLocalState && (
                        <span
                          className="size-1.5 rounded-full bg-chroma"
                          title="Estado local apagado — recuperação necessária"
                          aria-label="Recuperação necessária"
                        />
                      )}
                    </span>
                    {item.layer && <LayerTag layer={item.layer} />}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        {identity && (
          <div className="hidden border-t border-limb px-6 py-4 md:mt-6 md:block">
            <div className="eyebrow text-ash">Conta</div>
            <div className="numeral mt-1.5 text-[13px] text-corona-dim">
              {truncateAddress(identity.address, 6)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="eyebrow inline-flex rounded-full border border-limb px-2 py-0.5 text-ash">
                {identity.network}
              </span>
              {preview && (
                <span className="eyebrow inline-flex rounded-full border border-limb-bright px-2 py-0.5 text-ash">
                  Dados de demonstração
                </span>
              )}
            </div>
            <button
              onClick={disconnect}
              className="eyebrow mt-3 block text-ash underline decoration-limb-bright underline-offset-4 transition-colors hover:text-chroma"
            >
              Desconectar
            </button>
          </div>
        )}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 px-6 py-8 sm:px-8 lg:py-10">
          <div className="mx-auto w-full max-w-[900px]">
            {identity && identity.network !== "TESTNET" && (
              <div className="mb-6 rounded-xl border border-chroma/40 bg-chroma/[0.06] px-4 py-3 text-[13px] leading-relaxed text-chroma backdrop-blur">
                O Freighter está em{" "}
                <span className="numeral">{identity.network}</span>. Os contratos
                do Sombra estão na Testnet — troque de rede no Freighter antes de
                enviar qualquer coisa.
              </div>
            )}
            <Outlet />
          </div>
        </main>
        <ArchiveStatus />
      </div>
    </div>
  );
}

export function ScreenHeader({
  title,
  lede,
  action,
}: {
  title: string;
  lede?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-[34rem]">
        <h1 className="text-[clamp(1.6rem,3.4vw,2.15rem)] text-corona">
          {title}
        </h1>
        {lede && (
          <p className="mt-2.5 text-[14.5px] leading-relaxed text-ash">{lede}</p>
        )}
      </div>
      {action}
    </header>
  );
}
