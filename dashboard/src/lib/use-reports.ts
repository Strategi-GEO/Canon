"use client";

/**
 * One brand's monthly reports, fetched once. Unlike the roadmap read, the list is never a 404:
 * a brand with no reports is a 200 whose `reports` array holds only the current month at status
 * "none", which the tab renders as "generate this month". `reload` re-reads after a generation
 * lands, a share, or a delete, keeping whatever is on screen until the new answer arrives.
 */
import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { ReportsResponse } from "@/types";

export type ReportsState = {
  data: ReportsResponse | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
};

export function useReports(brandSlug: string): ReportsState {
  const [state, setState] = React.useState<{
    slug: string;
    data: ReportsResponse | null;
    error: ApiError | null;
    loading: boolean;
  }>({ slug: brandSlug, data: null, error: null, loading: true });

  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    api.reports(brandSlug, controller.signal).then(
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
