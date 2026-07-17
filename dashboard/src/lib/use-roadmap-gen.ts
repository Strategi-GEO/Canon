"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { RoadmapGenJob } from "@/types";

export type RoadmapGenState = {
  /**
   * This brand's generation job. Null both while the answer is unknown and when the brand has
   * never had one, which is why `checking` exists: null with `checking` false is the real
   * "there has never been one".
   */
  job: RoadmapGenJob | null;
  /** The engine's own reason it could not be read, or null. A 404 is NOT one: it is the empty state. */
  error: ApiError | null;
  checking: boolean;
  /** Adopts the job a POST just handed back, and re-arms the poll below. */
  adopt: (job: RoadmapGenJob) => void;
  /** Drops a job after a 204 from DELETE. No payload to adopt, and null IS the state. */
  clear: () => void;
  /**
   * Reads the job again, now. For a 409: the engine refused to start a second generation
   * because one is already running, and the running one is the thing the operator needs to
   * see. Asking the engine for it beats parsing it out of the refusal body.
   */
  recheck: () => void;
};

/**
 * Four seconds, matching the run list's poll for the same reason: this endpoint is served from
 * the engine's own process memory on the same machine as the browser, so the cost is a rounding
 * error, and the transition being watched for (a session that has been running for twenty
 * minutes finishing) is the entire reason anyone has this page open.
 */
const POLL_MS = 4000;

/**
 * One brand's roadmap generation, read from the engine and nowhere else.
 *
 * THE POINT OF THIS FILE IS DURABILITY. The generation is a background task inside the engine,
 * so the browser is a viewer and never an owner. On mount this GETs the job: a generation
 * started before a refresh, in another tab, or by another operator is picked up and shown as
 * running, with its elapsed measured from the ENGINE's `started`, so a refresh twenty minutes
 * in still reads twenty minutes.
 *
 * NOTHING is cached in localStorage. The engine is the truth, and a stored run hint is a run
 * that a refresh resurrects as a ghost: this project has already deleted one for lying.
 *
 * WHY A POLL AND NOT THE SSE FEED: that feed is per blog run and reports stages of the writing
 * pipeline. A roadmap generation is one agent session with no stages to report, and the engine
 * emits no frame for it on any channel a browser could subscribe to. The job record is the
 * only authority, so asking it repeatedly is the only way to watch it settle.
 *
 * There is one of these per route rather than a provider, because the Overview and the Content
 * Roadmap tab are different pages and are never mounted together. Both call this, so they read
 * one shape through one code path and cannot disagree about what is running.
 */
export function useRoadmapGen(brandSlug: string): RoadmapGenState {
  const [state, setState] = React.useState<{
    slug: string;
    job: RoadmapGenJob | null;
    error: ApiError | null;
    checking: boolean;
  }>({ slug: brandSlug, job: null, error: null, checking: true });

  /**
   * Bumped by adopt and recheck, and by nothing else. The loop below stops itself the moment
   * it reads a settled job, so a newly started generation needs the effect to run again to
   * re-arm it. `clear` deliberately does NOT bump: the job is gone, and re-running would only
   * ask the engine to 404 at us to confirm what the 204 already said.
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
    let last: RoadmapGenJob | null = null;

    /**
     * Only a RUNNING job earns another read. A settled one is final, so polling past it would
     * ask the engine the same question forever, and a brand that has never generated has
     * nothing to ask about at all.
     *
     * A hidden tab is nobody watching, and a generation runs for many minutes: idle background
     * tabs hitting the same asyncio loop that runs the generation is a real cost for a screen
     * no one is looking at. Nothing is lost by stopping, because the job is read whole on every
     * poll rather than as a stream of deltas, so the first read on return is complete.
     */
    function schedule(job: RoadmapGenJob | null) {
      window.clearTimeout(timer);
      if (job === null || job.state !== "running") {
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    }

    // Immediately on return, not on the next tick: a job the operator left running may well
    // have finished while the tab was hidden, and its report is the first thing they came back
    // for. This also recovers a loop that a failed request stopped.
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
      api.roadmapGeneration(brandSlug, controller.signal).then(
        (job) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          last = job;
          setState({ slug: brandSlug, job, error: null, checking: false });
          schedule(job);
        },
        (cause: unknown) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          const error =
            cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);

          // A 404 is the engine saying this brand has never had a generation, or that a
          // deleted job is gone. Both are the empty state, so neither is reported as a problem.
          if (error.status === 404) {
            last = null;
            setState({ slug: brandSlug, job: null, error: null, checking: false });
            return;
          }

          // The job already on screen is NOT cleared. It was true when read, and an engine
          // that stopped answering has not told us the generation ended: blanking it here
          // would report a live session as gone on one dropped request. The error rides
          // alongside it, and the loop keeps trying as long as there was something to watch.
          setState((prev) => ({
            slug: brandSlug,
            job: prev.slug === brandSlug ? prev.job : null,
            error,
            checking: false,
          }));
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

  const adopt = React.useCallback(
    (job: RoadmapGenJob) => {
      setState({ slug: brandSlug, job, error: null, checking: false });
      setAttempt((n) => n + 1);
    },
    [brandSlug],
  );

  const clear = React.useCallback(
    () => setState({ slug: brandSlug, job: null, error: null, checking: false }),
    [brandSlug],
  );

  const recheck = React.useCallback(() => setAttempt((n) => n + 1), []);

  // Derived rather than reset from an effect. Were the brand to change without the owner
  // remounting, the state above still describes the PREVIOUS brand until its fetch settles,
  // and showing one brand's generation under another brand's name is the worst answer
  // available: this one names a live spend against the wrong client.
  const stale = state.slug !== brandSlug;

  return {
    job: stale ? null : state.job,
    error: stale ? null : state.error,
    checking: stale || state.checking,
    adopt,
    clear,
    recheck,
  };
}
