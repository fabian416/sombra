import { useEffect, useRef, useState } from "react";

/**
 * Fires once, the first time the element crosses into view, and then stops
 * observing. Deliberately not reversible: content that fades back out when you
 * scroll up is a toy, and re-running the entrance on every pass is the thing
 * that turns a rise into a loop.
 *
 * Returns `true` immediately when IntersectionObserver is unavailable, so the
 * fallback is "visible", never "blank".
 */
export function useRevealOnce<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  shown: boolean;
} {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setShown(true);
        observer.disconnect();
      },
      { rootMargin: "-10% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, shown };
}
