import { Suspense, lazy, useEffect, useState } from "react";

const SplashCursor = lazy(() => import("./SplashCursor"));

/**
 * The gate in front of the fluid simulation.
 *
 * The simulation itself is ~25kB of solver that only ever runs on the landing,
 * so it is a lazy chunk: a phone that will never render it never downloads it.
 * Three conditions have to hold before we ask for that chunk.
 *
 *   Fine pointer — the effect *is* the cursor. On touch there is nothing to
 *   stir, and the WebGL context would cost a device that can least afford it.
 *   Still — `prefers-reduced-motion` means no ambient motion, and a fluid wake
 *   is nothing but ambient motion. There is no reduced variant worth shipping.
 *   Late — the landing has to paint first. The gate opens one beat after mount
 *   so the fluid never competes with the headline for the first frame.
 */
export function SplashCursorLayer() {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const fine = window.matchMedia("(pointer: fine)").matches;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || still) return;

    const id = window.setTimeout(() => setArmed(true), 500);
    return () => window.clearTimeout(id);
  }, []);

  if (!armed) return null;

  return (
    <Suspense fallback={null}>
      <SplashCursor />
    </Suspense>
  );
}
