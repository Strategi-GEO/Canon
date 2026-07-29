"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { RewriteJob } from "@/types";

export type RewriteJobsState = {
  /** Every batch the engine holds, running and settled, oldest first. [] is the empty state. */
  jobs: RewriteJob[];
  /** The engine's own reason the list could not be read, or null. */
  error: ApiError | null;
  /** Adopts the batch a POST just handed back, and re-arms the poll. */
  adopt: (job: RewriteJob) => void;
  /** Drops one batch after a 204 from DELETE. */
  clear: (jobId: string) => void;
  /** Union of every RUNNING batch's row indices: the rows currently being rewritten. */
  rowsInFlight: ReadonlySet<number>;
};

/** Four seconds, the same cadence and the same reasoning as use-roadmap-gen's poll. */
const POLL_MS = 4000;

/**
 * One brand's rewrite batches, read from the engine and nowhere else.
 *
 * The shape mirrors use-roadmap-gen deliberately, LIST-shaped because several batches run at
 * once: the durability rules are identical (the engine owns the work, the browser only
 * watches, nothing is cached locally), and the poll stops itself the moment nothing is
 * running. `onSettled` is the owner's hook for the one edge that matters: a batch landing
 * means the sheet changed on disk, and whoever holds the roadmap state re-reads it.
 */
export function useRewriteJobs(
  brandSlug: string,
  onSettled?: () => void,
): RewriteJobsState {
  const [state, setState] = React.useState<{
    slug: string;
    jobs: RewriteJob[];
    error: ApiError | null;
  }>({ slug: brandSlug, jobs: [], error: null });

  /** Bumped by adopt, and by nothing else: the loop stops itself once nothing runs, so a
   *  newly started batch needs the effect to run again to re-arm it. */
  const [attempt, setAttempt] = React.useState(0);

  // A ref so the poll closure always calls the latest callback without re-arming the effect,
  // written from an effect because writing a ref during render is a lint error for a reason:
  // a render that React discards would still have mutated it.
  const settledRef = React.useRef(onSettled);
  React.useEffect(() => {
    settledRef.current = onSettled;
  }, [onSettled]);

  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let inFlight = false;
    // The ids seen running on the previous read, so a running -> settled transition is
    // detectable across polls. Ids, not a count: one batch landing while another starts
    // would leave the count level and swallow the edge.
    let running = new Set<string>();

    function schedule(jobs: RewriteJob[]) {
      window.clearTimeout(timer);
      if (!jobs.some((job) => job.state === "running")) {
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      timer = window.setTimeout(poll, POLL_MS);
    }

    function onVisible() {
      if (document.visibilityState !== "visible") {
        return;
      }
      poll();
    }

    function poll() {
      if (inFlight) {
        return;
      }
      inFlight = true;
      api.rewriteJobs(brandSlug, controller.signal).then(
        (res) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          const nowRunning = new Set(
            res.jobs.filter((job) => job.state === "running").map((job) => job.id),
          );
          const landed = [...running].some((id) => !nowRunning.has(id));
          running = nowRunning;
          setState({ slug: brandSlug, jobs: res.jobs, error: null });
          if (landed) {
            settledRef.current?.();
          }
          schedule(res.jobs);
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
          // The list on screen is NOT cleared: it was true when read, and one dropped
          // request has not told us any batch ended. The loop keeps trying as long as
          // something was running.
          setState((prev) => ({
            slug: brandSlug,
            jobs: prev.slug === brandSlug ? prev.jobs : [],
            error,
          }));
          if (running.size > 0) {
            timer = window.setTimeout(poll, POLL_MS);
          }
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
    (job: RewriteJob) => {
      setState((prev) => ({
        slug: brandSlug,
        jobs: prev.slug === brandSlug ? [...prev.jobs, job] : [job],
        error: null,
      }));
      setAttempt((n) => n + 1);
    },
    [brandSlug],
  );

  const clear = React.useCallback(
    (jobId: string) =>
      setState((prev) => ({
        slug: brandSlug,
        jobs: prev.slug === brandSlug ? prev.jobs.filter((j) => j.id !== jobId) : [],
        error: null,
      })),
    [brandSlug],
  );

  // Derived rather than reset from an effect, exactly as use-roadmap-gen derives it: showing
  // one brand's batches under another brand's name is the worst answer available. Memoised so
  // the stale branch's [] is one stable value rather than a fresh array per render.
  const stale = state.slug !== brandSlug;
  const jobs = React.useMemo(
    () => (stale ? [] : state.jobs),
    [stale, state.jobs],
  );

  const rowsInFlight = React.useMemo(() => {
    const taken = new Set<number>();
    for (const job of jobs) {
      if (job.state === "running") {
        for (const index of job.row_indices) {
          taken.add(index);
        }
      }
    }
    return taken;
  }, [jobs]);

  return {
    jobs,
    error: stale ? null : state.error,
    adopt,
    clear,
    rowsInFlight,
  };
}
