import { useEffect, useState } from "react";
import { dismissToast, subscribe, type Toast } from "../lib/toast";
import { cx } from "./ui";

/** Renders whatever the toast bus is holding. Mounted once, at the app root. */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => subscribe(setToasts), []);

  if (!toasts.length) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-6 right-6 z-[100] flex w-[min(92vw,22rem)] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            "animate-rise pointer-events-auto rounded-xl border bg-umbra/90 px-4 py-3 backdrop-blur-xl",
            t.tone === "success"
              ? "border-cyan/35 glow-soft"
              : "border-chroma/45",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <p
              className={cx(
                "text-[13.5px] font-medium",
                t.tone === "success" ? "text-cyan" : "text-chroma",
              )}
            >
              {t.title}
            </p>
            <button
              onClick={() => dismissToast(t.id)}
              className="eyebrow shrink-0 text-ash transition-colors hover:text-corona"
              aria-label="Dismiss"
            >
              Close
            </button>
          </div>
          {t.description && (
            <p className="numeral-wrap mt-1 text-[12px] leading-relaxed text-ash">
              {t.description}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
