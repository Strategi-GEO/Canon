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
 * The BANDS are the single source the list, the roadmap and the stage page all read, so an 87 can
 * no longer read "shipped" on one screen and "below bar" on another. blog-state.ts still owns the
 * LABELS (adminTag, ADMIN_BELOW_BAR_TAG); this file owns only the score-to-band arithmetic.
 *
 * THE ENGINE HAS ONE NUMBER AND THIS FILE HAS TWO, AND EVERY MENTION HAS TO SAY WHICH. SHIP_BAR
 * is the engine's bar and the band is BINARY at it: at or above it a blog ships, below it it does
 * not. BELOW_BAR_FLOOR draws no engine line at all, only the boundary between two LABELS worn by
 * blogs that already failed. Calling either one "the bar" without saying which is a defect.
 */

/**
 * The house bar, and the ONLY score threshold the engine has: the band is BINARY at it, so a run
 * settling at or above it resolves done and ships, and a run settling below it resolves failed.
 * It is what the writer aims at, what the lead's in-loop branch tests, and what the rubric's Ship
 * band names. It MIRRORS SHIP_SCORE in server/runner.py and the engine does not serve the value,
 * so moving it there means editing this line too, exactly as ENGINE_SLOTS in lib/sessions.ts
 * mirrors GEO_CONCURRENCY.
 *
 * IT IS 90 AND NOT 95 BECAUSE 95 STOPPED BEING ATTAINABLE. tests/concurrency-proof.md records six
 * topics ending done at 95, 95, 96, 97, 98 and 98, under the rubric as it stood then, when the
 * weights totalled 25 for a maximum of 75. C4 and D2 took the weights to 30 and the maximum to 90
 * with the percentage held constant, and rubric.md normalises as round(weighted_total / 90 * 100),
 * so round(85/90*100) is 94 and round(86/90*100) is 96: the value 95 is now skipped entirely. The
 * measured 12 blog run that followed scored only five of its twelve topics, at 72 to 89 to 88, 84
 * to 84 to 87, 79 to 80, 82 and 73, the other seven dying in research on iteration 1 unscored. Zero
 * of the twelve ever reached 95. 90 is exactly attainable: it is 81 of the 90 weighted points
 * available.
 */
export const SHIP_BAR = 90;

/**
 * PRESENTATIONAL, and it is a LABEL boundary rather than a threshold: a blog scoring 80 to 89 is
 * terminal FAILED and reaches a client only when the operator presses Send, so nothing here
 * softens the binary band above and no surface may word this range as a ship.
 *
 * IT EXISTS BECAUSE A NEAR MISS AND AN OUTRIGHT FAILURE WANT DIFFERENT WORDS. Both are the same
 * `failed` verdict, and an operator reading a list of them is asking which are worth opening: an
 * 89 is one point short and a 61 is not close, and one red chip for both hides that.
 *
 * THE FLOOR IS 80 BECAUSE THAT IS THE RANGE THE OPERATOR ACTUALLY READS. It was 85, which put the
 * commonest real outcomes in red beside genuine collapses: live trajectories cluster at 80 to 84
 * (80-84-84, 81-81-83, 79-79-86, 74-82-81), all of them drafts a person may well decide to send.
 * Widening the amber band changes no verdict and no engine behaviour, only which chip a failed
 * row wears.
 *
 * NOTHING IN THE ENGINE COMPARES A SCORE AGAINST THIS NUMBER. The engine's only threshold is
 * SHIP_BAR. A monotonic loop-stop rule once shared the old value of 85, which made that
 * coincidence look meaningful; it was deleted for ending the loop on four blogs whose next
 * iteration reached 90, and this constant is now free to move on presentational grounds alone.
 */
export const BELOW_BAR_FLOOR = 80;

/**
 * The band a bare score falls in: at or above SHIP_BAR it shipped (green), BELOW_BAR_FLOOR to one
 * under the bar is the near miss the operator decides on (amber), below that the run failed
 * outright (red). Null when there is no score to colour.
 *
 * The amber band is NOT a second ship band. An 87 did not ship, and its terminal status is failed
 * until a person sends it, so the colour says "your call", never "out the door".
 */
export function scoreTone(score: number | null): StateTone | null {
  if (typeof score !== "number") {
    return null;
  }
  if (score >= SHIP_BAR) {
    return "ship";
  }
  return score >= BELOW_BAR_FLOOR ? "owed" : "trouble";
}

/**
 * A score in the near miss band: at or above BELOW_BAR_FLOOR and still short of SHIP_BAR. The
 * UPPER bound is load-bearing, not decoration: without it a sent 96 sitting on a stale
 * `failed` row would wear the amber "one point short" chip.
 */
export function isBelowBar(score: number | null): boolean {
  return typeof score === "number" && score >= BELOW_BAR_FLOOR && score < SHIP_BAR;
}

/**
 * The other face of the failed tag, split on the one fact the state cannot carry: the score. A
 * failed draft in the near miss band is BELOW BAR, a point or two under SHIP_BAR and worth
 * reading before sending; under the floor is the failure the red tag is for. Both are the
 * `failed` STATE and keep its bench, so this is a label split like adminCommentsTag, never a new
 * state. A missing score reads as the plain failure, the honest floor when the loop never scored
 * a draft.
 */
export function adminFailedTag(score: number | null): StateTag {
  return isBelowBar(score) ? ADMIN_BELOW_BAR_TAG : adminTag("failed");
}

/** Text-only colour for a bare score number, sharing the tag tones so a 92 reads the same green as
 *  a shipped tag and an 87 the same amber as an owed one. `waiting` and `busy` never occur for a
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
