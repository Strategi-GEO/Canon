"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { BlogComment } from "@/types";

/**
 * On the same machine as the engine, which serves this from one small read. Four seconds
 * keeps an applying comment's spinner honest without hammering the loop.
 */
const APPLY_POLL_MS = 4000;

export type BlogCommentsState = {
  comments: BlogComment[];
  /** True until the first read lands, so an empty list is not claimed before it is known. */
  checking: boolean;
  error: ApiError | null;
  /** Re-read now: after a POST files a comment, a resolve starts one, or a dismiss settles one. */
  refresh: () => void;
};

/**
 * One blog's comment threads, watched ONLY while an apply this machine started is settling.
 *
 * THE CLIENT'S SIDE IS NOT POLLED, deliberately. A blog out with the client has a second
 * author with no channel into this app, and this hook did poll for them every ten seconds.
 * The operator's call is that live cross-person updates are worth nothing here: a client's
 * suggestion is minutes to days of human work away, everyone refreshes anyway, and a timer in
 * every open stage tab buys seconds of freshness for traffic nobody asked for. What survives
 * that decision is the NOTIFICATION: the blogs library rings the bell for whatever it finds at
 * its own next read, so a refresh is what tells an operator a client wrote something.
 *
 * An applying comment is a different thing entirely and keeps its loop. It is not another
 * person's work arriving, it is THIS operator's own click finishing seconds later, and a
 * spinner that never resolves until someone hits refresh reads as a broken button rather than
 * as a page that does not live-update.
 *
 * The house polling shape (use-facts-gen): a self-scheduling setTimeout after each read
 * settles, never setInterval, so a slow engine can never stack requests that all land at once
 * on recovery. Hidden tabs stop the loop and a visibilitychange poll restarts it, which also
 * recovers a loop a failed request stopped. A failure never clears the last read value: it
 * was true when read, and the loop keeps trying.
 *
 * `enabled` false keeps the hook entirely idle: the hosted build and a demo brand have no
 * comment flow, and an idle hook is how the page says so without a second code path.
 */
export function useBlogComments(
  brandSlug: string,
  topicSlug: string,
  enabled: boolean,
): BlogCommentsState {
  const [state, setState] = React.useState<{
    key: string;
    comments: BlogComment[] | null;
    error: ApiError | null;
  }>({ key: `${brandSlug}/${topicSlug}`, comments: null, error: null });
  const [attempt, setAttempt] = React.useState(0);
  const key = `${brandSlug}/${topicSlug}`;

  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    let timer = 0;
    let inFlight = false;
    // The last successful read, so a FAILED poll can re-arm from it: a transient error
    // while a comment is applying must keep the loop alive, not end it. use-facts-gen
    // keeps the same variable for the same reason.
    let last: BlogComment[] | null = null;

    function schedule(comments: BlogComment[] | null) {
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        return;
      }
      if (comments === null || !comments.some((comment) => comment.state === "applying")) {
        return;
      }
      timer = window.setTimeout(poll, APPLY_POLL_MS);
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
      api.blogComments(brandSlug, topicSlug, controller.signal).then(
        (data) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          last = data.comments;
          setState({ key, comments: data.comments, error: null });
          schedule(data.comments);
        },
        (cause: unknown) => {
          inFlight = false;
          if (controller.signal.aborted) {
            return;
          }
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
          setState((prev) => ({
            key,
            comments: prev.key === key ? prev.comments : null,
            error,
          }));
          // Re-arm from the last GOOD read: while a comment was applying, a single failed
          // poll must not end the loop and freeze the spinner until a tab switch.
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
  }, [brandSlug, topicSlug, enabled, key, attempt]);

  const refresh = React.useCallback(() => setAttempt((n) => n + 1), []);

  // Derived, never reset from an effect: a topic switch reports the empty checking state
  // rather than another topic's comments under this topic's title.
  const current = state.key === key ? state : { key, comments: null, error: null };
  return {
    comments: current.comments ?? [],
    checking: enabled && current.comments === null && current.error === null,
    error: current.error,
    refresh,
  };
}
