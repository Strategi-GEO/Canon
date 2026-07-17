/**
 * Finding one blog in a brand's library: search, filter, sort.
 *
 * All of it is client side and none of it is debounced. The list is one directory listing,
 * so the whole set is already in memory and a round trip to filter it would be slower than
 * the filter. Kept out of the component because the URL layer has to validate the same
 * values it parses, and a second copy of "which sort keys are legal" is a second copy that
 * can drift.
 */

import type { BlogStatus, BlogSummary } from "@/types";

export type SortKey = "created" | "score" | "status" | "topic";
export type SortDir = "asc" | "desc";
export type StatusFilter = BlogStatus | "all";

export const SORT_KEYS: SortKey[] = ["created", "score", "status", "topic"];
export const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "done",
  "needs_review",
  "failed",
  "running",
  "stopped",
];

/**
 * The engine reports status "unknown" for a topic that has a blog.md but no status.jsonl to
 * summarise, and the wire really does send it. It is now a modelled BlogStatus with its own
 * badge, so it belongs here: this guard is what routes a status to StatusBadge, and excluding
 * "unknown" would suppress the badge for the one state most worth showing. The guard remains
 * a real guard, because a status the engine adds tomorrow still must not index a lookup table
 * with a key it lacks.
 */
export const KNOWN_STATUSES: BlogStatus[] = [
  "done",
  "needs_review",
  "failed",
  "running",
  "unknown",
  "stopped",
];

export function isKnownStatus(status: string): status is BlogStatus {
  return (KNOWN_STATUSES as string[]).includes(status);
}

/** Sorting status alphabetically would be arbitrary, so it sorts by how much it wants a
 *  human: failures first, then the review queue, then what already shipped. A blog the engine
 *  cannot describe wants a human early, and it is never evidence that anything is in flight.
 *
 *  A stopped blog sorts after the ones that want an explanation and before the ones in flight.
 *  It is the only state here the operator already knows about, because they caused it, so it
 *  never earns the top of a list they opened to find out what went wrong. It ranks above
 *  `running` because it is a decision left open: generating the topic again is the way to
 *  resume, and nothing else on this list is waiting on that call. */
const STATUS_ORDER: Record<BlogStatus, number> = {
  failed: 0,
  needs_review: 1,
  unknown: 2,
  stopped: 3,
  running: 4,
  done: 5,
};

/**
 * An unmodelled status sorts with the unknown ones rather than crashing the compare. It sorted
 * with the RUNNING ones until "unknown" became a real state, which quietly grouped every blog
 * the engine could not describe in among the ones actually in flight.
 */
function statusRank(status: string): number {
  return isKnownStatus(status) ? STATUS_ORDER[status] : STATUS_ORDER.unknown;
}

export function sortBlogs(blogs: BlogSummary[], key: SortKey, dir: SortDir): BlogSummary[] {
  const sorted = [...blogs].sort((a, b) => {
    if (key === "created") {
      return a.created.localeCompare(b.created);
    }
    if (key === "status") {
      return statusRank(a.status) - statusRank(b.status);
    }
    if (key === "topic") {
      // Natural language, so it collates by the reader's locale rather than by code point,
      // which would file "Ürgüp" after "Zurich".
      return a.topic.localeCompare(b.topic, undefined, { sensitivity: "base" });
    }
    // A blog that never reached an eval has no score. It sorts below every real score
    // rather than pretending to be a zero.
    const left = a.score ?? -1;
    const right = b.score ?? -1;
    return left - right;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}

/**
 * Title search, matched against the slug too. An operator who has the folder open in Finder
 * is holding a slug, not a title, and a search that made them translate one to the other
 * would be a search that fails on the operator's own vocabulary.
 */
export function matchesQuery(blog: BlogSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return true;
  }
  return (
    blog.topic.toLowerCase().includes(needle) || blog.topic_slug.toLowerCase().includes(needle)
  );
}

export function selectBlogs(
  blogs: BlogSummary[],
  query: string,
  status: StatusFilter,
  key: SortKey,
  dir: SortDir,
): BlogSummary[] {
  const filtered = blogs.filter(
    (blog) => (status === "all" || blog.status === status) && matchesQuery(blog, query),
  );
  return sortBlogs(filtered, key, dir);
}
