import type { BlogSummary, RoadmapRow } from "@/types";

/**
 * Where a roadmap stands, from the two payloads that between them know: the roadmap says what
 * was planned, the blogs list says what exists on disk. Neither answers alone, which is why
 * this takes both.
 *
 * The two are counted against DIFFERENT populations, by the operator's instruction, and the
 * split is the whole design of this module. Every outcome (shipped, review, failed, running)
 * counts EVERY blog the brand has, whether or not its topic is still on the roadmap: the
 * question those tiles answer is "how are my blogs doing", and a blog whose row was deleted is
 * still a blog that shipped. Only `remaining` consults the roadmap, because remaining is
 * meaningless without a list to remain against.
 *
 * That is why `remaining` alone joins the two, and it joins BY topic_slug. It was once by
 * index, on the reasoning that both lists came from the same sheet in the same order, and they
 * do not: the blogs list is a scan of the output directory, in its own order, holding blogs for
 * rows that were since deleted. Index matching paired blogs with unrelated topics.
 */

export type RoadmapStats = {
  topics: number;
  /** Every blog on disk for this brand, which is the population the four outcomes below count.
   *  It can exceed `topics`: a brand accumulates blogs across every sheet it has ever had. */
  blogs: number;
  /** Status "done". In this house a blog reaches "done" only on a first eval score of 95 or
   *  above with no question left waiting, so this is the shipped count exactly and not a count of
   *  what was attempted. */
  shipped: number;
  /** Status "needs_review". NOT a failure and NOT a verdict, and exactly one thing: the evaluator
   *  asked the operator something research cannot settle, and the answer is still owed. The score
   *  does not enter it. A blog held at 96 is counted here rather than in `shipped`, because what
   *  the tile counts is work a person owes, and that blog owes an answer whatever its verdict. */
  review: number;
  failed: number;
  /** Status "stopped". The operator halted this brand's session before the blog finished, so the
   *  engine made no judgement about it at all. Counted apart from `failed` because it is not one:
   *  folding the two would report a person's own Stop back to them as blogs that went wrong. */
  stopped: number;
  running: number;
  /** Roadmap topics with no blog at all. Not the same as topics whose blog failed, and the one
   *  number here measured against the roadmap rather than against the blogs on disk. */
  remaining: number;
  /** Rows the engine refused to call complete. They cannot be written until they are fixed. */
  incomplete: RoadmapRow[];
  /** Every distinct field name the incomplete rows are missing, so the fix can be named. */
  missingFields: string[];
};

export function roadmapStats(rows: RoadmapRow[], blogs: BlogSummary[]): RoadmapStats {
  // Every outcome counts the WHOLE blogs list, never just the rows still on the sheet.
  const count = (status: BlogSummary["status"]) =>
    blogs.filter((blog) => blog.status === status).length;

  // One topic slug is one output directory, so this set answers "does this row have a blog"
  // exactly. A blog for a topic no longer on the roadmap simply never gets looked up, which is
  // correct: it is counted in the outcomes above and it is not a row anyone still has to write.
  const written = new Set(blogs.map((blog) => blog.topic_slug));

  const incomplete = rows.filter((row) => !row.complete);

  return {
    topics: rows.length,
    blogs: blogs.length,
    shipped: count("done"),
    review: count("needs_review"),
    failed: count("failed"),
    stopped: count("stopped"),
    running: count("running"),
    remaining: rows.filter((row) => !written.has(row.topic_slug)).length,
    incomplete,
    missingFields: [...new Set(incomplete.flatMap((row) => row.missing))].sort(),
  };
}
