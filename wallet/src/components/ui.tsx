import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** The layer a piece of UI operates on. Real information, not decoration. */
export type Layer = "CT" | "SPP" | "ARCHIVE" | "PUBLIC";

/* Cyan marks the private layers. Public is deliberately colourless — it is the
   absence of the brand, which is the whole point. */
const LAYER_TONE: Record<Layer, string> = {
  CT: "text-cyan border-cyan/35",
  SPP: "text-cyan-mid border-cyan-mid/35",
  ARCHIVE: "text-cyan border-cyan/35",
  PUBLIC: "text-corona-dim border-white/20",
};

export function LayerTag({ layer }: { layer: Layer }) {
  return (
    <span
      className={cx(
        "eyebrow inline-flex items-center rounded-full border px-2 py-px leading-none",
        LAYER_TONE[layer],
      )}
    >
      {layer}
    </span>
  );
}

export function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("eyebrow", className)}>{children}</div>;
}

export function Panel({
  children,
  className,
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <Tag className={cx("panel", className)}>{children}</Tag>;
}

export function PanelHeader({
  title,
  layer,
  note,
  action,
}: {
  title: string;
  layer?: Layer;
  note?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-limb px-5 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Eyebrow>{title}</Eyebrow>
          {layer && <LayerTag layer={layer} />}
        </div>
        {note && <p className="mt-1 text-[13px] text-ash">{note}</p>}
      </div>
      {action}
    </header>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
  busy?: boolean;
};

export function Button({
  variant = "ghost",
  busy = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    "relative inline-flex items-center justify-center gap-2 rounded-full border px-5 py-2.5 text-[13px] font-medium tracking-[0.01em] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0";
  const tone =
    variant === "primary"
      ? "border-transparent bg-gradient-to-r from-cyan-400 via-sky-400 to-blue-500 font-semibold text-black glow-cta hover:-translate-y-0.5"
      : variant === "danger"
        ? "border-chroma/45 bg-chroma/5 text-chroma hover:border-chroma hover:bg-chroma/15"
        : "border-white/20 bg-white/5 text-corona-dim backdrop-blur hover:-translate-y-0.5 hover:border-white/40 hover:bg-white/10 hover:text-corona";

  return (
    <button
      className={cx(base, tone, className)}
      disabled={disabled || busy}
      {...rest}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block size-3 shrink-0 rounded-full border border-current border-r-transparent",
        className,
      )}
      style={{ animation: "corona-drift 700ms linear infinite" }}
      aria-hidden
    />
  );
}

export function Field({
  label,
  hint,
  suffix,
  error,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  suffix?: ReactNode;
  error?: string | null;
}) {
  return (
    <label className={cx("block", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>{label}</Eyebrow>
        {hint && <span className="text-[12px] text-ash">{hint}</span>}
      </div>
      <div
        className={cx(
          "mt-2 flex items-center rounded-xl border bg-white/5 backdrop-blur transition-colors",
          error
            ? "border-chroma/60"
            : "border-white/15 focus-within:border-cyan/60",
        )}
      >
        <input
          className="numeral w-full bg-transparent px-3.5 py-3 text-[15px] placeholder:text-ash/45 focus:outline-none"
          {...rest}
        />
        {suffix && (
          <span className="eyebrow shrink-0 pr-3.5 text-ash">{suffix}</span>
        )}
      </div>
      {error && <p className="mt-1.5 text-[12.5px] text-chroma">{error}</p>}
    </label>
  );
}

export function Stat({
  label,
  value,
  tone = "corona",
  sub,
}: {
  label: string;
  value: ReactNode;
  tone?: "corona" | "cyan" | "pool" | "ash";
  sub?: ReactNode;
}) {
  const tones = {
    corona: "text-corona",
    cyan: "text-cyan",
    pool: "text-pool",
    ash: "text-ash",
  } as const;
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className={cx("numeral mt-1.5 text-[19px]", tones[tone])}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[12.5px] text-ash">{sub}</div>}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "good";
  children: ReactNode;
}) {
  const tones = {
    info: "border-white/12 bg-white/[0.04] text-ash",
    warn: "border-chroma/40 bg-chroma/[0.07] text-chroma",
    good: "border-cyan/35 bg-cyan/[0.07] text-cyan",
  } as const;
  return (
    <div
      className={cx(
        "rounded-xl border px-4 py-3 text-[13px] leading-relaxed backdrop-blur",
        tones[tone],
      )}
    >
      {children}
    </div>
  );
}

/** A monospace address with a copy affordance. */
export function CopyLine({
  value,
  display,
  label,
}: {
  value: string;
  display?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(value)}
      className="group flex w-full items-center justify-between gap-3 rounded-xl border border-white/15 bg-white/5 px-3.5 py-2.5 text-left backdrop-blur transition-colors hover:border-cyan/50"
      title={`Copy ${label ?? "value"}`}
    >
      <span className="numeral truncate text-[13px] text-corona-dim">
        {display ?? value}
      </span>
      <span className="eyebrow shrink-0 text-ash transition-colors group-hover:text-cyan group-hover:[text-shadow:0_0_14px_rgba(56,226,255,0.6)]">
        Copy
      </span>
    </button>
  );
}
