"use client";

/**
 * One brand's monthly-report generation, watched from the engine and nowhere else. A near-exact
 * twin of use-roadmap-gen: the generation is a background task inside the engine, so the browser
 * is a viewer, never an owner. On mount it GETs the job, so a generation started before a refresh,
 * in another tab, or by another operator is picked up and shown running, its elapsed measured from
 * the engine's own `started`. Nothing is cached in localStorage. See use-roadmap-gen.ts for the
 * full account of why this is a poll and not the SSE feed.
 */
import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { ReportGenJob } from "@/types";

export type ReportGenState = {
  job: ReportGenJob | null;
  error: ApiError | null;
  checking: boolean;
  /** Adopts the job a POST just handed back, and re-arms the poll. */
  adopt: (job: ReportGenJob) => void;
  /** Drops a job after a 204 from DELETE. Null IS the state. */
  clear: () => void;
  /** Reads the job again now, e.g. after a 409 that names a generation already running. */
  recheck: () => void;
};

const POLL_MS = 4000;

export function useReportGen(brandSlug: string): ReportGenState {
  const [state, setState] = React.useState<{
    slug: string;
    job: ReportGenJob | null;
    error: ApiError | null;
    checking: boolean;
  }>({ slug: brandSlug, job: null, error: null, checking: true });

  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let inFlight = false;
    let last: ReportGenJob | null = null;

    function schedule(job: ReportGenJob | null) {
      window.clearTimeout(timer);
      if (job === null || job.state !== "running") return;
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(poll, POLL_MS);
    }

    function onVisible() {
      if (document.visibilityState !== "visible") return;
      poll();
    }

    function poll() {
      if (inFlight) return;
      inFlight = true;
      api.reportGeneration(brandSlug, controller.signal).then(
        (job) => {
          inFlight = false;
          if (controller.signal.aborted) return;
          last = job;
          setState({ slug: brandSlug, job, error: null, checking: false });
          schedule(job);
        },
        (cause: unknown) => {
          inFlight = false;
          if (controller.signal.aborted) return;
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
          if (error.status === 404) {
            last = null;
            setState({ slug: brandSlug, job: null, error: null, checking: false });
            return;
          }
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
    (job: ReportGenJob) => {
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
