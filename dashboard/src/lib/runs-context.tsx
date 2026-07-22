"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import { queueOf, type Session } from "@/lib/sessions";
import type { RunSummary } from "@/types";

/**
 * The engine-wide session queue, read from GET /api/runs and nothing else.
 *
 * WHY POLLING, when this app already has an SSE client it refuses to duplicate: that feed is
 * per run. /api/runs/{id}/events tells a subscriber about the run it names and cannot report a
 * run that does not exist yet, so it can never answer "who is ahead of me". The transition
 * that matters most here is a run taking CLIENT_LOCK, and the engine emits no frame for it on
 * any channel this browser could subscribe to. The list is therefore the only authority, and
 * asking it repeatedly is the only way to watch the queue move.
 *
 * WHY ONE POLL FOR THE WHOLE APP: the topbar indicator and a brand's Overview card both need
 * this, and two independent reads of one list is exactly the shape that produced the phantom
 * row bug. There is one fetch, above both, and every consumer derives from the same array.
 *
 * What the list MEANS lives in lib/sessions. This file only keeps it fresh.
 */

type RunsState = {
  /** Every run the engine still remembers, live or not, exactly as sent. */
  runs: RunSummary[];
  /** The live sessions, already in the engine's own queue order. The list IS the queue. */
  queue: Session[];
  /** The engine's own reason the list could not be read, or null. Never flattened to empty. */
  error: ApiError | null;
  /** True until the first answer lands. An empty queue with this true means "not known yet". */
  checking: boolean;
};

const RunsContext = React.createContext<RunsState | null>(null);

/**
 * Four seconds. A short session can appear and vanish between slower reads, so a lazier poll
 * would let a whole session go unseen, and this endpoint is served from the engine's own process
 * memory on the same machine as the browser. The cost is a rounding error; missing the queue
 * moving is the entire failure this view exists to prevent.
 */
const POLL_MS = 4000;

const NO_RUNS: RunSummary[] = [];

export function RunsProvider({ children }: { children: React.ReactNode }) {
  const [runs, setRuns] = React.useState<RunSummary[]>(NO_RUNS);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [checking, setChecking] = React.useState(true);

  // The engine is an external system, so this effect subscribes to it and writes state only
  // from the settled callbacks.
  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    // Guards the ONE way two reads could overlap: a poll in flight while the tab is hidden,
    // settling after the operator returns and onVisible has already started another. Two
    // settles would then schedule two timers, and the stacking this file avoids by not using
    // an interval would arrive by the back door.
    let inFlight = false;

    /**
     * A hidden tab is nobody watching. Six operators share one deployment and every one of
     * their idle tabs was hitting this every four seconds forever, against the same asyncio
     * loop that runs the blog generation: the poll exists to keep a queue on SCREEN fresh, and
     * a tab in the background has no screen. Nothing is lost by stopping, because the run list
     * is server state read whole on every poll rather than a stream of deltas, so the first
     * read on return is complete.
     */
    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    }

    // Immediately, not on the next tick: the queue on screen is as stale as the tab has been
    // hidden, which can be hours, and it is the first thing the operator looks at on return.
    function onVisible() {
      if (document.visibilityState !== "visible") {
        return;
      }
      poll();
    }

    // Scheduled AFTER each read settles rather than on a bare interval. A slow or hanging
    // engine would otherwise stack requests it never answered, and every one of them would
    // land at once the moment it recovered, each writing older state over newer.
    function poll() {
      if (inFlight) {
        return;
      }
      inFlight = true;
      api.runs(controller.signal).then(
        ({ runs: next }) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          setRuns(next);
          setError(null);
          setChecking(false);
          schedule();
        },
        (cause: unknown) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          // The runs already on screen are NOT cleared. They were true when read, and an
          // engine that stopped answering has not told us that any session ended: blanking the
          // queue here would report every live session as gone on one dropped request. The
          // error rides alongside them, and the indicator says the state is unknown.
          setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
          setChecking(false);
          schedule();
        },
      );
    }

    poll();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const value = React.useMemo<RunsState>(
    () => ({ runs, queue: queueOf(runs), error, checking }),
    [runs, error, checking],
  );

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>;
}

export function useRuns(): RunsState {
  const ctx = React.useContext(RunsContext);
  if (!ctx) {
    throw new Error("useRuns must be used inside RunsProvider");
  }
  return ctx;
}
