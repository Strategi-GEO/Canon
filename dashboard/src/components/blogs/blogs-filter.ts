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
import { adminUrgency, blogState } from "@/lib/blog-state";

export type SortKey = "created" | "score" | "status" | "topic" | "roadmap";
export type SortDir = "asc" | "desc";
export type StatusFilter = BlogStatus | "all";

export const SORT_KEYS: SortKey[] = ["created", "score", "status", "topic", "roadmap"];
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

/* STATUS_ORDER and statusRank lived here and are GONE, not misplaced. They ranked the six raw
 * run statuses, and the status column no longer shows one: it shows a BlogStateTag, under which
 * every sent, approved and published article is the same `done` and would have collapsed into
 * one indistinguishable block. Their ordering was carefully reasoned and that reasoning was not
 * thrown away with them: it moved to ADMIN_URGENCY in lib/blog-state.ts, which still ranks the
 * mute states early and still keeps a stopped blog below the ones that want an explanation. */

export function sortBlogs(blogs: BlogSummary[], key: SortKey, dir: SortDir): BlogSummary[] {
  const sorted = [...blogs].sort((a, b) => {
    if (key === "created") {
      return a.created.localeCompare(b.created);
    }
    if (key === "roadmap") {
      // Sheet order, which is the order the operator and their client discuss the work in:
      // "we are done with six, send seven". A blog on no row has no number to sort by and
      // sorts last, exactly as a blog with no score does rather than posing as row one.
      // Infinity rather than -1 here because these numbers are 0 based, so -1 would sort a
      // rowless blog ABOVE row 1.
      return (a.roadmap_index ?? Infinity) - (b.roadmap_index ?? Infinity);
    }
    if (key === "status") {
      // SORTS BY THE THING THE CELL SHOWS. That column renders a BlogStateTag now, so ranking
      // by the raw run status would sort by an axis the operator cannot see: every sent,
      // approved and published article is `done`, so the four states the tag distinguishes
      // would land in one indistinguishable block, and clicking the header would look broken.
      //
      // adminUrgency answers the question this header is clicked for, which is "which of these
      // is mine to move": held and changes-requested first, then the mute ones that cannot
      // explain themselves, then the bench, then everything waiting on somebody else.
      //
      // THE FILTER STILL WORKS ON THE RAW RUN STATUS and that is not an inconsistency to tidy
      // away. Sorting asks "what should I look at first", which is a question about the whole
      // article; filtering asks "show me only the failed ones", which is a question about how
      // the loop ended. Those are different axes and the STATUS_FILTERS list names the second.
      return adminUrgency(blogState(a)) - adminUrgency(blogState(b));
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
 *
 * A BARE NUMBER, or one written "#6", means the roadmap row and nothing else. That is a real
 * exception to the substring rule and it is deliberate: in a library where every blog carries a
 * number, an operator who types 6 means blog six, not the nine titles containing the character
 * "6". Substring matching a digit is what makes a number search useless, because "1" matches
 * almost everything. Anything that is not purely digits is text and searches as text, so a title
 * with a number in it stays findable by typing more than the number.
 */
const ROW_QUERY = /^#?\s*(\d+)$/;

export function matchesQuery(blog: BlogSummary, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === "") {
    return true;
  }

  const row = ROW_QUERY.exec(trimmed);
  if (row) {
    // Displayed numbers are 1 based, so the operator's "6" is index 5. A blog on no row can
    // never match a row query: it has no number, and matching it would be answering a question
    // about the sheet with a blog that is not on it.
    return blog.roadmap_index !== null && blog.roadmap_index + 1 === Number(row[1]);
  }

  const needle = trimmed.toLowerCase();
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
