import type { BlogSummary, RoadmapRow } from "@/types";

/**
 * Where a roadmap stands, from the two payloads that between them know: the roadmap says what
 * was planned, the blogs list says what exists on disk. Neither answers alone, which is why
 * this takes both.
 *
 * EVERY TILE COUNTS ONE MONTH, THE LATEST, and `rows` is what says which month that is: the tab
 * reads GET /roadmap with no month, which the engine answers with the newest sheet. The outcomes
 * used to count every blog the brand had ever written, across every sheet it had ever held, and
 * that read as nonsense the moment a brand had two months: a second month one day old reported
 * ten blogs written beside ten topics remaining to write, because the ten were last month's.
 * A tile answers "where is this month", so it counts this month.
 *
 * The join is BY topic_slug, in both directions. It was once by index, on the reasoning that
 * both lists came from the same sheet in the same order, and they do not: the blogs list is a
 * scan of the output directory, in its own order, holding blogs for rows that were since
 * deleted. Index matching paired blogs with unrelated topics.
 */

export type RoadmapStats = {
  topics: number;
  /** This month's blogs on disk, which is the population every outcome below counts. It can
   *  still exceed `topics`, by the off-roadmap blogs that were made without a row. */
  blogs: number;
  /** Status "done". In this house a blog reaches "done" only on a first eval score of 90 or
   *  above with no question left waiting, so this is the shipped count exactly and not a count of
   *  what was attempted. */
  shipped: number;
  /** Status "needs_review". NOT a failure and NOT a verdict, and exactly one thing: the evaluator
   *  asked the operator something research cannot settle, and the answer is still owed. The score
   *  does not enter it. A blog held at 96 is counted here rather than in `shipped`, because what
   *  the tile counts is work a person owes, and that blog owes an answer whatever its verdict. */
  review: number;
  /** Terminal `failed` with a VERDICT: the loop ran, scored, and missed the bar. There is a draft
   *  to read and the only open question is whether to send it. */
  failed: number;
  /** Terminal `failed` with NO verdict: the session died, stopped responding, or was refused
   *  before it opened. Counted apart from `failed` for the same reason `stopped` is: folding them
   *  reports work the engine still owes as work it judged and rejected, and the two want opposite
   *  things from the operator (a retry, against a decision). */
  died: number;
  /** Status "stopped". The operator halted this brand's session before the blog finished, so the
   *  engine made no judgement about it at all. Counted apart from `failed` because it is not one:
   *  folding the two would report a person's own Stop back to them as blogs that went wrong. */
  stopped: number;
  running: number;
  /** Roadmap topics with no blog at all. Not the same as topics whose blog failed. */
  remaining: number;
  /** Rows the engine refused to call complete. They cannot be written until they are fixed. */
  incomplete: RoadmapRow[];
  /** Every distinct field name the incomplete rows are missing, so the fix can be named. */
  missingFields: string[];
};

export function roadmapStats(rows: RoadmapRow[], blogs: BlogSummary[]): RoadmapStats {
  // One topic slug is one output directory, so this set answers "does this row have a blog"
  // exactly, and it is also what scopes the tiles to this month.
  const planned = new Set(rows.map((row) => row.topic_slug));

  // THIS MONTH'S BLOGS. On the sheet, or on no sheet at all: a blog with no row was made
  // off-roadmap while this month was current, which is the same rule the Blogs tab's month
  // picker files one under (lib/blog-month.ts). A blog whose row belongs to an earlier month is
  // another month's business and is not counted here, which is what keeps every tile speaking
  // about one population: `remaining` always joined on this sheet, so the outcomes had to too.
  const mine = blogs.filter((blog) => blog.month == null || planned.has(blog.topic_slug));

  const count = (status: BlogSummary["status"]) =>
    mine.filter((blog) => blog.status === status).length;

  // `failed` is SPLIT on the engine's own flag, so the two tiles sum to every failed row exactly.
  // Counting either one independently would double-count or drop rows the moment the flag moved.
  const died = mine.filter((blog) => blog.status === "failed" && blog.died).length;

  const written = new Set(mine.map((blog) => blog.topic_slug));

  const incomplete = rows.filter((row) => !row.complete);

  return {
    topics: rows.length,
    blogs: mine.length,
    shipped: count("done"),
    review: count("needs_review"),
    failed: count("failed") - died,
    died,
    stopped: count("stopped"),
    running: count("running"),
    remaining: rows.filter((row) => !written.has(row.topic_slug)).length,
    incomplete,
    missingFields: [...new Set(incomplete.flatMap((row) => row.missing))].sort(),
  };
}
