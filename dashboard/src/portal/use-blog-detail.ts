"use client";

import * as React from "react";
import { ApiError, api } from "@/portal/api";
import type { PortalBlogDetail } from "@/portal/types";

export type BlogDetailState = {
  blog: PortalBlogDetail | null;
  error: ApiError | null;
  /** Read again, keeping what is on screen. Used after the client acts: the article is
   *  still the article, so swapping in a skeleton would make a small act feel like a
   *  navigation. */
  refetch: () => void;
  /** Clear and read again. The hard reset, for an error retry and for an act that changes
   *  which VIEW the blog gets (answering a form hands it back to the team). */
  reload: () => void;
};

/**
 * One blog's detail, read once per visit.
 *
 * THERE IS NO POLL, and that is a decision rather than an omission. This page did poll every
 * fifteen seconds so a resolution or a team reply would appear under a client who was already
 * looking at it. The operator's call is that live updates are worth nothing here: the events
 * are minutes to days apart, everyone refreshes anyway, and a timer running in every open
 * portal tab buys a few seconds of freshness at the cost of traffic nobody asked for. A
 * refresh is the update mechanism, so what actually matters is that a refresh SHOWS what
 * changed, which is what the attention counts on the home page do.
 *
 * refetch() is what an ACT uses. The client approving or filing a comment changes the record
 * they are looking at, and re-reading right then is not a poll: it is the page telling the
 * truth about the thing they just did.
 *
 * A DROPPED READ NEVER CLEARS THE ARTICLE. Once a detail has been read, a failed refetch
 * leaves it exactly where it is: replacing a perfectly good article with an error card
 * because one request timed out would make the page worse than doing nothing. Only a FIRST
 * read that fails reports, and it reports because there is nothing else to show.
 */
export function useBlogDetail(brand: string, topic: string): BlogDetailState {
  const key = `${brand}/${topic}`;
  const [state, setState] = React.useState<{
    key: string;
    blog: PortalBlogDetail | null;
    error: ApiError | null;
  }>({ key, blog: null, error: null });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const current = `${brand}/${topic}`;
    const controller = new AbortController();
    // The last detail actually read, so a failed re-read knows whether there is anything on
    // screen worth protecting. A question a failed request cannot answer for itself.
    let last: PortalBlogDetail | null = null;

    api.blog(brand, topic, controller.signal).then(
      (blog) => {
        if (controller.signal.aborted) {
          return;
        }
        last = blog;
        setState({ key: current, blog, error: null });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        const failure = cause instanceof ApiError ? cause : new ApiError(0, String(cause));
        if (last === null) {
          setState({ key: current, blog: null, error: failure });
        }
      },
    );

    return () => controller.abort();
  }, [brand, topic, attempt]);

  const refetch = React.useCallback(() => setAttempt((n) => n + 1), []);
  const reload = React.useCallback(() => {
    setState({ key, blog: null, error: null });
    setAttempt((n) => n + 1);
  }, [key]);

  // Derived rather than reset from an effect. Navigating from one article to another leaves
  // the state above describing the PREVIOUS blog until its read settles, and rendering one
  // article's body under another's title is worse than a skeleton for a moment.
  const mine = state.key === key ? state : { blog: null, error: null };
  return { blog: mine.blog, error: mine.error, refetch, reload };
}
