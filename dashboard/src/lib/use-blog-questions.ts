"use client";

import * as React from "react";
import { ApiError, api } from "@/lib/api";
import type { BlogQuestions } from "@/types";

/** One topic's answer from the engine. Both fields null is the ordinary case: no questions. */
export type TopicQuestions = {
  /**
   * The engine's payload, or null when it holds no questions.json for this topic. A 404 is the
   * empty state here, so null is a real answer and not a failure.
   */
  payload: BlogQuestions | null;
  /** The engine's own refusal, or null. A 404 is NOT one. Never flattened into a null payload. */
  error: ApiError | null;
};

export type QuestionsIndex = {
  /** Keyed by topic slug. A topic missing from the map has not been read yet. */
  byTopic: ReadonlyMap<string, TopicQuestions>;
  /** True until the first full pass lands. An empty map with this true means "not known yet". */
  checking: boolean;
  /** Reads every topic again, now: after a submit files an answers.json, and after a revise ends. */
  reload: () => void;
};

const EMPTY: ReadonlyMap<string, TopicQuestions> = new Map();

/**
 * How many of these reads are in flight at once.
 *
 * The contract has no bulk endpoint, so a library of twelve blogs is twelve reads. Four at a
 * time keeps a library-open from firing a dozen simultaneous requests at the same asyncio loop
 * that is running the operator's blogs, and the whole pass still settles in one round trip's
 * worth of wall clock at this size. It is a courtesy to the engine, never a correctness bound.
 */
const POOL = 4;

/**
 * Every blog's questions for one brand, read from the engine and nowhere else.
 *
 * WHY THE LIBRARY READS THIS AT ALL: a blog whose evaluator asked the operator something is
 * waiting on a person, and an operator with twelve blogs will not click into each one to find
 * the four that need them. The signal has to be in the list, so the list has to know.
 *
 * This is a ONE SHOT read per brand rather than a poll. Nothing but the operator's own submit
 * writes an answers.json, and only a run they can already watch rewrites a questions.json, so
 * there is no transition here that arrives on its own the way a run taking CLIENT_LOCK does.
 * `reload` covers the two moments this can change under the page: the submit, and the revise
 * settling.
 *
 * NOTHING is cached in localStorage and nothing is cached across brands: GET /blogs scans the
 * disk and so does this, and a cache would keep offering questions about a topic somebody
 * deleted in Finder.
 */
export function useBlogQuestions(
  brandSlug: string,
  topicSlugs: readonly string[],
): QuestionsIndex {
  // The topic set as ONE value, so the effect below re-runs when the blogs change and not when
  // the caller happens to build a new array of the same slugs. A newline cannot appear in a
  // slug, which is what makes joining and splitting it lossless.
  const key = topicSlugs.join("\n");

  const [index, setIndex] = React.useState<{
    brand: string;
    key: string;
    byTopic: ReadonlyMap<string, TopicQuestions>;
  } | null>(null);

  /** Bumped by `reload` alone. Deliberately not part of the state key below, so a reload leaves
   *  the map that is already on screen alone until the new one lands. */
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const slugs = key === "" ? [] : key.split("\n");

    // Written once, when the whole pass has settled, and from the callback rather than from the
    // effect body: a partial map would flicker chips in one at a time, and a synchronous write
    // here would cascade a second render on every mount.
    void readAll(brandSlug, slugs, controller.signal).then((byTopic) => {
      if (controller.signal.aborted) {
        return;
      }
      setIndex({ brand: brandSlug, key, byTopic });
    });

    return () => controller.abort();
  }, [brandSlug, key, attempt]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);

  // Derived rather than reset from an effect. Were the brand or the blog list to change without
  // this hook's owner remounting, the state above still describes the PREVIOUS set, and marking
  // one brand's blog as waiting on an answer under another brand's name is a fabricated fact.
  const current = index !== null && index.brand === brandSlug && index.key === key ? index : null;

  return {
    byTopic: current?.byTopic ?? EMPTY,
    checking: current === null,
    reload,
  };
}

/** One topic. Never throws: an aborted read and a 404 are both just "nothing to show". */
async function readOne(
  brandSlug: string,
  topicSlug: string,
  signal: AbortSignal,
): Promise<TopicQuestions> {
  try {
    return { payload: await api.blogQuestions(brandSlug, topicSlug, signal), error: null };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      return { payload: null, error: null };
    }
    const error = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
    // The engine answers 404 for a topic whose evaluator asked nothing, which is most of them.
    if (error.status === 404) {
      return { payload: null, error: null };
    }
    // Anything else is carried, not swallowed. The library uses it for nothing, because a row
    // that cannot say whether it has questions should not claim it has none; the blog view is
    // where the engine's own words get shown, and it reads the same entry.
    return { payload: null, error };
  }
}

/** Every topic, POOL at a time, in whatever order they settle. */
async function readAll(
  brandSlug: string,
  slugs: readonly string[],
  signal: AbortSignal,
): Promise<ReadonlyMap<string, TopicQuestions>> {
  const byTopic = new Map<string, TopicQuestions>();
  let next = 0;

  async function worker(): Promise<void> {
    while (next < slugs.length) {
      const slug = slugs[next];
      next += 1;
      if (signal.aborted) {
        return;
      }
      byTopic.set(slug, await readOne(brandSlug, slug, signal));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(POOL, slugs.length) }, () => worker()),
  );
  return byTopic;
}
