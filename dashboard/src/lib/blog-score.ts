// Explicit relative .ts, not the @/ alias: blog-state.test.ts imports this module and runs under
// `node --test` with no loader, which cannot resolve @/ for a VALUE import (only type imports are
// erased). Same reason postgrest.ts imports "./env.ts". adminTag + ADMIN_BELOW_BAR_TAG are values.
import { adminTag, ADMIN_BELOW_BAR_TAG, type StateTag, type StateTone } from "./blog-state.ts";

/**
 * The evaluator score, and how it is coloured. ADMIN-ONLY, and that is the whole reason this file
 * exists apart from blog-state.ts: a score never crosses the client wire, so the vocabulary of
 * scoring must not sit in a module the client bundle imports. blog-state.ts and blog-state-tag.tsx
 * both ship to the portal, so tests/portal_check.py forbids the word there; these helpers live
 * here, imported only by admin surfaces, exactly as ScoreTag lives in the admin status-badge.
 *
 * The BANDS are the single source the list, the roadmap and the stage page all read, so a 92 can
 * no longer read "shipped" on one screen and "below bar" on another. blog-state.ts still owns the
 * LABELS (adminTag, ADMIN_BELOW_BAR_TAG); this file owns only the score-to-band arithmetic.
 */

/** The band a bare score falls in: 95+ ships (green), 90 to 94 is owed (amber, one rerun from the
 *  bar), below 90 is trouble (red). Null when there is no score to colour. */
export function scoreTone(score: number | null): StateTone | null {
  if (typeof score !== "number") {
    return null;
  }
  if (score >= 95) {
    return "ship";
  }
  if (score >= 90) {
    return "owed";
  }
  return "trouble";
}

/**
 * The other face of the failed tag, split on the one fact the state cannot carry: the score. A
 * draft that scored 90 to 94 is BELOW BAR, one rerun from the 95 ship bar, not a plain failure;
 * below 90 is the failure the red tag is for. Both are the `failed` STATE and keep its bench, so
 * this is a label split like adminCommentsTag, never a new state. A missing score reads as the
 * plain failure, the honest floor when the loop never scored a draft.
 */
export function adminFailedTag(score: number | null): StateTag {
  return typeof score === "number" && score >= 90 && score < 95
    ? ADMIN_BELOW_BAR_TAG
    : adminTag("failed");
}

/** Text-only colour for a bare score number, sharing the tag tones so a 95 reads the same green as
 *  a shipped tag and a 92 the same amber as an owed one. `waiting` and `busy` never occur for a
 *  score and fall to muted, as does no score at all. */
const SCORE_TONE_TEXT: Record<StateTone, string> = {
  busy: "text-muted-foreground",
  owed: "text-review",
  waiting: "text-muted-foreground",
  ship: "text-ship",
  trouble: "text-fail",
};

export function scoreClass(score: number | null): string {
  const tone = scoreTone(score);
  return tone ? SCORE_TONE_TEXT[tone] : "text-muted-foreground";
}
