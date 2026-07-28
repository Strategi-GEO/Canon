/**
 * What state a roadmap row is in, and therefore what colour it wears.
 *
 * The operator's rule: generated rows are green and cannot be selected, in progress rows are
 * yellow, failed rows are red. Failed stays SELECTABLE on purpose: a failed blog is exactly
 * the one an operator wants to retry, so disabling it would hide the only useful action.
 *
 * needs_review is amber and LOCKED. Its blog already exists on disk and is held pending an
 * answer the operator owes it, so ticking it to generate again would refuse at the API
 * boundary and, worse, hide the fact that a human still has to act before it ships. It is
 * NOT selectable, exactly as the operator asked: these rows require review first.
 *
 * Colour is never the burnt orange accent. Green, amber and red are the status tokens and
 * the accent stays reserved for interaction, so a blocked row can never read as a button.
 * Colour is also never the only signal: every coloured row carries a text label and a chip,
 * because an operator who cannot tell red from green still has to work here.
 */

import type { Duplicate, RoadmapRow } from "@/types";

export type RowState =
  /** In a live run right now. Yellow, locked: the engine would refuse it as in_flight. */
  | "in_progress"
  /** A blog already exists on disk for this topic. Green, locked. */
  | "generated"
  /**
   * A blog exists on disk but is HELD: the evaluator asked the operator a question and it
   * ships only once that is answered. Amber, locked. Answering happens on the Blogs page,
   * never here, so this row cannot be selected to generate.
   */
  | "needs_review"
  /** Its last terminal status was failed AND it scored below 90. Red, still selectable to retry. */
  | "failed"
  /**
   * Its last run ended failed but scored 90 to 94: below the 95 ship bar, not a failure. Yellow
   * and SELECTABLE, exactly like failed, because a rerun for 95 is the obvious next move. It is
   * the create-page face of the Blogs tab's "Below bar" tag, split off failed by the same score
   * band (scoreTone in lib/blog-state.ts), so one blog cannot read "failed" here and "Below bar"
   * there.
   */
  | "below_bar"
  /** Missing topic, covers or prompts, so the engine cannot write it at all. */
  | "incomplete"
  | "ready";

export type RowFacts = {
  /** Topic slugs in a live run right now, from GET /api/runs and the SSE stream. */
  live: ReadonlySet<string>;
  /**
   * Topic slugs whose last terminal status was failed AND scored below 90, from GET
   * /api/clients/{brand}/blogs. The 90-to-94 failures live in `belowBar` instead.
   */
  failed: ReadonlySet<string>;
  /**
   * Topic slugs that ended failed but scored 90 to 94, split from `failed` by the shared score
   * band (scoreTone) so they wear the yellow "below bar" chip, not the red one. The two sets are
   * disjoint by construction.
   */
  belowBar: ReadonlySet<string>;
  /**
   * Topic slugs whose blog is held for the operator's answer (status needs_review), from the
   * same blogs call. A held blog is never in the ledger, so it is neither generated nor failed,
   * and without this set it would fall through to a plain selectable row with no tag.
   */
  needsReview: ReadonlySet<string>;
  /** What the engine refused on the last submit, keyed by row index. */
  duplicates: ReadonlyMap<number, Duplicate>;
};

/**
 * Resolves one row's state.
 *
 * Order matters. A 409 duplicate is checked first because the engine has just told us the
 * true state of that row and it outranks anything the browser inferred. Then live, because a
 * failed topic being retried right now is generating, not failed. Then generated, then
 * needs_review, then failed, then incomplete.
 *
 * needs_review sits below live and generated on purpose. A live run supersedes an older held
 * blog, so a topic generating right now reads as in progress rather than held. A held blog is
 * never in the ledger, so it can never also be generated, and the two sets never overlap.
 */
export function resolveRowState(row: RoadmapRow, facts: RowFacts): RowState {
  const duplicate = facts.duplicates.get(row.index);
  if (duplicate?.reason === "in_flight") {
    return "in_progress";
  }
  if (duplicate?.reason === "already_generated") {
    return "generated";
  }
  if (facts.live.has(row.topic_slug)) {
    return "in_progress";
  }
  if (row.already_generated) {
    return "generated";
  }
  if (facts.needsReview.has(row.topic_slug)) {
    return "needs_review";
  }
  // belowBar before failed: both are terminal-failed blogs, split by score, and the two sets are
  // disjoint so order is for clarity, not correctness.
  if (facts.belowBar.has(row.topic_slug)) {
    return "below_bar";
  }
  if (facts.failed.has(row.topic_slug)) {
    return "failed";
  }
  if (!row.complete) {
    return "incomplete";
  }
  return "ready";
}

/**
 * Whether a row can be ticked.
 *
 * Green is genuinely disabled, not merely unchecked: the blog exists, and the engine answers
 * a 409 for it. Yellow, both the in-progress and the needs_review kind, is disabled for the
 * same reason: a held blog already exists and must be reviewed before anything runs. Red is
 * enabled, which is the point of colouring it. Incomplete is refused at the API boundary with
 * a 422, so it is not offered.
 */
export function isSelectable(state: RowState): boolean {
  return state === "ready" || state === "failed" || state === "below_bar";
}

/**
 * Rows that "select all" ticks. Green, both yellows (in progress and needs_review) and
 * incomplete are excluded, as the operator asked.
 */
export function selectableRows(rows: RoadmapRow[], facts: RowFacts): RoadmapRow[] {
  return rows.filter((row) => isSelectable(resolveRowState(row, facts)));
}

/**
 * Topic slugs a live run is currently working on.
 *
 * A topic that has not emitted its first frame yet is still in the run, so it counts: the
 * engine holds it behind the semaphore and refuses a second request for it as in_flight.
 * Only a topic that has reached a terminal status drops out.
 */
export function liveTopicSlugs(
  topics: readonly { topicSlug: string; status: string }[],
  finished: boolean,
): Set<string> {
  if (finished) {
    return new Set();
  }
  return new Set(
    topics.filter((topic) => topic.status === "running").map((topic) => topic.topicSlug),
  );
}
