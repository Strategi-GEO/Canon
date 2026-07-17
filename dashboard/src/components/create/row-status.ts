/**
 * What state a roadmap row is in, and therefore what colour it wears.
 *
 * The operator's rule: generated rows are green and cannot be selected, in progress rows are
 * yellow, failed rows are red. Failed stays SELECTABLE on purpose: a failed blog is exactly
 * the one an operator wants to retry, so disabling it would hide the only useful action.
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
  /** Its last terminal status was failed. Red, and still selectable so it can be retried. */
  | "failed"
  /** Missing topic, covers or prompts, so the engine cannot write it at all. */
  | "incomplete"
  | "ready";

export type RowFacts = {
  /** Topic slugs in a live run right now, from GET /api/runs and the SSE stream. */
  live: ReadonlySet<string>;
  /** Topic slugs whose last terminal status was failed, from GET /api/clients/{brand}/blogs. */
  failed: ReadonlySet<string>;
  /** What the engine refused on the last submit, keyed by row index. */
  duplicates: ReadonlyMap<number, Duplicate>;
};

/**
 * Resolves one row's state.
 *
 * Order matters. A 409 duplicate is checked first because the engine has just told us the
 * true state of that row and it outranks anything the browser inferred. Then live, because a
 * failed topic being retried right now is generating, not failed. Then generated, then
 * failed, then incomplete.
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
 * a 409 for it. Yellow is disabled for the same reason. Red is enabled, which is the point of
 * colouring it. Incomplete is refused at the API boundary with a 422, so it is not offered.
 */
export function isSelectable(state: RowState): boolean {
  return state === "ready" || state === "failed";
}

/** Rows that "select all" ticks. Green and yellow are excluded, as the operator asked. */
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
