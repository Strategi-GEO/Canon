"use client";

import * as React from "react";

/**
 * A clock that ticks once a second while a run is live, for elapsed times.
 *
 * Why a clock at all: a run takes minutes and the engine sends a frame only when a stage
 * turns over, so between frames nothing on screen changes. Without a ticking elapsed the view
 * is indistinguishable from a frozen one, and "is it stuck?" becomes unanswerable. Elapsed is
 * NOT progress and never implies a total: it is the one honest number here, because the
 * revise loop runs 0 to 4 iterations and no denominator exists to turn it into a percentage.
 *
 * Returns null until mounted. The server has no meaningful "now", so rendering an elapsed
 * during SSR would produce markup the client immediately disagrees with; callers render a
 * placeholder for one frame instead of a hydration mismatch.
 *
 * When `active` goes false the interval stops and the last value is KEPT, which freezes a
 * finished run's elapsed rather than letting it tick on past the end.
 */
export function useNow(active: boolean): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);

  React.useEffect(() => {
    if (!active) {
      return;
    }
    // The wall clock is the external system and the interval is the subscription, so every
    // write below happens in a callback rather than in the effect body: setting state
    // synchronously here would cascade a second render on every mount for no gain.
    //
    // The first tick is scheduled rather than immediate because waiting a whole second for
    // it would show the placeholder longer than the value it stands in for. A frame is not
    // perceptible; a second is.
    const first = window.requestAnimationFrame(() => setNow(new Date()));
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => {
      window.cancelAnimationFrame(first);
      window.clearInterval(id);
    };
  }, [active]);

  return now;
}
