"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { RoadmapResponse } from "@/types";

export type RoadmapState = {
  /** Null while loading, and null when the brand simply has no roadmap yet. */
  data: RoadmapResponse | null;
  /** The engine's own reason. A 404 is NOT an error here: it is the empty state. */
  error: ApiError | null;
  loading: boolean;
  /**
   * Adopts a freshly parsed upload as the current roadmap. The upload response IS the parsed
   * roadmap, so re-fetching it would be a second round trip for bytes already in hand. The
   * row endpoints answer with the whole reparsed roadmap too, so they land here as well.
   */
  set: (data: RoadmapResponse) => void;
  /**
   * Drops the roadmap after a 204 from DELETE. Separate from `set` because there is no
   * payload to adopt: the sheet is gone, and null IS the state, the same null a brand that
   * never had one reports. Re-fetching to confirm would only ask the engine to 404 at us.
   */
  clear: () => void;
  /**
   * Re-reads the CSV from the engine, keeping whatever is on screen until the new answer
   * lands.
   *
   * For when something OUTSIDE this page wrote the file: a roadmap generation is an agent
   * session in the engine, and the CSV it writes is the first thing the operator wants to see
   * once it lands. `set` cannot serve that, because the generation hands back a report rather
   * than a parsed roadmap, and only the engine can say how it read the sheet.
   */
  reload: () => void;
};

/**
 * One brand's roadmap, fetched once.
 *
 * This exists because the brand overview used to render two roadmap cards that each fetched
 * the same CSV independently, so one view made two GETs for one piece of data and could
 * render two different answers if they disagreed. Lifting the read here makes the overview
 * fetch once and lets every card that needs the roadmap read the same object.
 */
export function useRoadmap(brandSlug: string): RoadmapState {
  const [state, setState] = React.useState<{
    slug: string;
    data: RoadmapResponse | null;
    error: ApiError | null;
    loading: boolean;
  }>({ slug: brandSlug, data: null, error: null, loading: true });

  /**
   * Bumped by `reload` alone. It re-runs the read below WITHOUT flipping `loading` back on, so
   * a roadmap already on screen stays there until the new one lands rather than collapsing
   * into a skeleton for a file that is only being confirmed.
   */
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();

    api.roadmap(brandSlug, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) {
          setState({ slug: brandSlug, data, error: null, loading: false });
        }
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        // A brand with no roadmap yet answers 404. That is a normal empty state and not a
        // problem to report, so it parks as "no data" rather than as an error the operator
        // would read as something being broken.
        const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
        setState({
          slug: brandSlug,
          data: null,
          error: error.status === 404 ? null : error,
          loading: false,
        });
      },
    );

    return () => controller.abort();
  }, [brandSlug, attempt]);

  const set = React.useCallback(
    (data: RoadmapResponse) => setState({ slug: brandSlug, data, error: null, loading: false }),
    [brandSlug],
  );

  const clear = React.useCallback(
    () => setState({ slug: brandSlug, data: null, error: null, loading: false }),
    [brandSlug],
  );

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);

  // Derived rather than reset from an effect. Were the brand to change without this component
  // remounting, the state above still describes the PREVIOUS brand until its fetch settles,
  // and showing one brand's roadmap under another brand's name is the worst answer available.
  // Comparing the slug the state was built for against the slug being asked about costs
  // nothing and needs no second render to correct itself.
  const stale = state.slug !== brandSlug;

  return {
    data: stale ? null : state.data,
    error: stale ? null : state.error,
    loading: stale || state.loading,
    set,
    clear,
    reload,
  };
}
