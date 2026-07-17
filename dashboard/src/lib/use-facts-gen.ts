"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { FactsGenJob } from "@/types";

export type FactsGenState = {
  /**
   * This brand's fact base build, or null when the engine holds none. Null also covers the
   * moment before the first read settles, which no caller here has to tell apart: the only
   * thing null costs is the facts notice, and a run whose build has not been read yet reports
   * exactly what it reports without one.
   */
  job: FactsGenJob | null;
  /**
   * Reads the job again, now. The build is started by a blog run rather than by this browser,
   * so a run that just began has a job the poll below stopped looking for one read ago.
   */
  recheck: () => void;
};

/**
 * Four seconds, matching the run list and the roadmap generation for the same reason: the
 * endpoint is served from the engine's own process memory on the same machine as the browser,
 * so the cost is a rounding error, and the transition being watched for is the entire reason
 * anyone has this page open.
 */
const POLL_MS = 4000;

/**
 * One brand's canonical-facts.md build, read from the engine and nowhere else.
 *
 * THE POINT OF THIS FILE IS DURABILITY, the same point use-roadmap-gen.ts makes about the same
 * kind of job. The build is a background task inside the engine, so the browser is a viewer and
 * never an owner. On mount this GETs the job: a build started before a refresh, in another tab,
 * or by another operator is picked up and shown, with its elapsed measured from the ENGINE's
 * `started`, so a refresh twenty minutes in still reads twenty minutes.
 *
 * NOTHING is cached in localStorage. The engine is the truth, and a stored hint is a job that a
 * refresh resurrects as a ghost.
 *
 * WHY A POLL AND NOT THE SSE FEED: that feed streams a topic's status.jsonl, and a fact base
 * build has no topic and writes no status line. It is one agent session with nothing to report
 * until it lands, so the job record is the only authority and asking it repeatedly is the only
 * way to watch it settle.
 *
 * A failed read is deliberately not reported to callers, which is the one place this diverges
 * from use-roadmap-gen. That hook's tab is ABOUT the generation, so an unreadable job is the
 * whole screen failing and has to be said. This one decorates a run view that has plenty else
 * to report, and what a dropped read costs here is nothing: the last job read stays, its clock
 * measures from the engine's own timestamp so the reading stays true either way, and a read
 * that has never landed leaves this null, which is the run view exactly as it was before this
 * hook existed. What it must never do is invent a phase, and null cannot.
 */
export function useFactsGen(brandSlug: string): FactsGenState {
  const [state, setState] = React.useState<{ slug: string; job: FactsGenJob | null }>({
    slug: brandSlug,
    job: null,
  });

  /**
   * Bumped by recheck and by nothing else. The loop below stops itself the moment it reads a
   * settled job or a 404, so a build that starts after that needs the effect to run again to
   * re-arm it.
   */
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    // Guards the one overlap available: a poll in flight while the tab is hidden, settling
    // after the operator returns and onVisible has already started another. Two settles would
    // schedule two timers, and the loop would quietly double its rate for the rest of the run.
    let inFlight = false;
    // The last job actually read. It decides whether there is anything left to poll FOR, which
    // is a question a failed request cannot answer for itself.
    let last: FactsGenJob | null = null;

    /**
     * Only a RUNNING job earns another read. A settled one is final, so polling past it would
     * ask the engine the same question forever, and a brand whose fact base was never built by
     * the engine has nothing to ask about at all.
     *
     * A hidden tab is nobody watching, and this build runs for many minutes. Nothing is lost by
     * stopping, because the job is read whole on every poll rather than as a stream of deltas,
     * so the first read on return is complete.
     */
    function schedule(job: FactsGenJob | null) {
      window.clearTimeout(timer);
      if (job === null || job.state !== "running") {
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    }

    // Immediately on return, not on the next tick: a build the operator left running may well
    // have finished while the tab was hidden, and the blogs it was holding up are the first
    // thing they came back for. This also recovers a loop that a failed request stopped.
    function onVisible() {
      if (document.visibilityState !== "visible") {
        return;
      }
      poll();
    }

    // Scheduled AFTER each read settles rather than on a bare interval, so a slow engine can
    // never stack requests that all land at once on recovery, each writing older state over
    // newer.
    function poll() {
      if (inFlight) {
        return;
      }
      inFlight = true;
      api.factsGeneration(brandSlug, controller.signal).then(
        (job) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          last = job;
          setState({ slug: brandSlug, job });
          schedule(job);
        },
        (cause: unknown) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);

          // A 404 is the engine saying it has never built this brand's fact base, which is the
          // ordinary case: most brands arrive with a hand written canonical-facts.md and never
          // have a job at all. It is the empty state, so it clears rather than reports.
          if (error.status === 404) {
            last = null;
            setState({ slug: brandSlug, job: null });
            return;
          }

          // The job already read is NOT cleared. It was true when read, and one dropped
          // request is not the engine saying the build ended.
          schedule(last);
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
  }, [brandSlug, attempt]);

  const recheck = React.useCallback(() => setAttempt((n) => n + 1), []);

  // Derived rather than reset from an effect. Were the brand to change without the owner
  // remounting, the state above still describes the PREVIOUS brand until its fetch settles, and
  // showing one brand's build under another brand's name would name a live spend against the
  // wrong client.
  return { job: state.slug === brandSlug ? state.job : null, recheck };
}

/**
 * The fact base build a given run is waiting on, or null when it is waiting on none.
 *
 * This is what a run's PHASE is derived from, and it is derived here once so that no view has
 * to decide it twice. Three conditions, each of which alone would produce a false claim:
 *
 *  - run_id must match. The engine keeps a settled build around after its run ends, and a build
 *    from last week's run says nothing about this one.
 *  - the job must be RUNNING. A build that is done is the reason blogs are now moving, not a
 *    reason to say the run has not started, and a build that failed is over: what happens to a
 *    run behind it is the engine's business, and the run's own state is what reports it.
 *  - there must be a run at all, since a build with no run to hold up is not a phase of one.
 */
export function factsBuildOf(runId: string | null, job: FactsGenJob | null): FactsGenJob | null {
  if (runId === null || job === null) {
    return null;
  }
  if (job.run_id !== runId || job.state !== "running") {
    return null;
  }
  return job;
}
