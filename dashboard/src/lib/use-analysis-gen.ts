"use client";

/**
 * One brand's monthly-analysis run, watched from the engine and nowhere else. A near-exact twin of
 * use-report-gen: the run is a background task inside the engine, so the browser is a viewer. On
 * mount it GETs the job, so a run started before a refresh, in another tab, or by another operator
 * is picked up and shown running. Nothing is cached in localStorage. Poll, not SSE, for the same
 * reasons the report and roadmap generations are polled.
 */
import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { AnalysisGenJob } from "@/types";

export type AnalysisGenState = {
  job: AnalysisGenJob | null;
  error: ApiError | null;
  checking: boolean;
  adopt: (job: AnalysisGenJob) => void;
  clear: () => void;
  recheck: () => void;
};

const POLL_MS = 4000;

export function useAnalysisGen(brandSlug: string): AnalysisGenState {
  const [state, setState] = React.useState<{
    slug: string;
    job: AnalysisGenJob | null;
    error: ApiError | null;
    checking: boolean;
  }>({ slug: brandSlug, job: null, error: null, checking: true });

  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let inFlight = false;
    let last: AnalysisGenJob | null = null;

    function schedule(job: AnalysisGenJob | null) {
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
      api.analysisGeneration(brandSlug, controller.signal).then(
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
    (job: AnalysisGenJob) => {
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
