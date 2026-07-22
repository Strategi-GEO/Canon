"use client";

/**
 * One brand's monthly analyses, fetched once. Twin of use-reports: never a 404, a brand with no
 * analyses is a 200 whose `analyses` array holds only the current month at status "none", which the
 * tab renders as "run this month". `reload` re-reads after a run lands or a delete.
 */
import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { AnalysisResponse } from "@/types";

export type AnalysisState = {
  data: AnalysisResponse | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
};

export function useAnalysis(brandSlug: string): AnalysisState {
  const [state, setState] = React.useState<{
    slug: string;
    data: AnalysisResponse | null;
    error: ApiError | null;
    loading: boolean;
  }>({ slug: brandSlug, data: null, error: null, loading: true });

  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    api.analysis(brandSlug, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setState({ slug: brandSlug, data, error: null, loading: false });
        }
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
        setState({ slug: brandSlug, data: null, error, loading: false });
      },
    );
    return () => controller.abort();
  }, [brandSlug, attempt]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);

  const stale = state.slug !== brandSlug;
  return {
    data: stale ? null : state.data,
    error: stale ? null : state.error,
    loading: stale || state.loading,
    reload,
  };
}
