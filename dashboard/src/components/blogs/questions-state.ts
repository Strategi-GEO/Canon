/**
 * What one blog's questions MEAN: which of four situations the operator is actually in, and
 * which blogs in a library are waiting on a person.
 *
 * Pure, and separate from the panel that renders it, because these are the rules the form is
 * right or wrong about. Reading `blocking` as "show a warning" rather than as "there is no way
 * forward but the form", or offering a submit the engine will 409, are both defects that live
 * in this decision rather than in any markup, so the decision is one function that can be read
 * on its own.
 *
 * Nothing here is derived from a score. The ENGINE decides blocking, from the same rule
 * geo-factory/CLAUDE.md states: BELOW 95 is a draft that has not shipped and cannot ship until a
 * human answers, and 95 or above is a blog that already shipped. Recomputing that from `score` in
 * the browser would be a second copy of the house rule, free to drift from the one that actually
 * governs the engine's 409.
 *
 * THE BOUNDARY IS 95 SHIPS, and exactly 95 is the case worth naming, because an earlier draft of
 * this feature blocked there and broke the house rule the rest of the app is built on: "95 ships.
 * 96 ships. No score at or above 95 is borderline." A blog at 95 with four open questions is a
 * shipped blog carrying an offer, never a blog held hostage to it.
 */

import type { BlogQuestions } from "@/types";

export type QuestionsMode =
  /** Below 95, with questions. The form is the only way forward: no proceed, no dismiss. */
  | "blocking"
  /** 95 or above. The blog has shipped and stays shipped; answering is an offer it can decline. */
  | "offer"
  /** The questions describe a draft that has since been revised. The engine 409s a submit. */
  | "stale"
  /** An answers.json exists for this iteration: the revise is either running or has landed. */
  | "answered";

/**
 * The one situation this blog is in.
 *
 * `answered` outranks `stale` deliberately, and the pair is not a contradiction: it is the
 * ordinary end state. Answers are filed against iteration 2, the revise they start carries the
 * blog to iteration 3, and the questions file is left describing the iteration it was asked at.
 * Reading that as "stale, you cannot answer these" would tell an operator their submission
 * failed at the exact moment it succeeded.
 *
 * `stale` outranks `blocking` because a stale question cannot be answered at all: the engine
 * refuses it. A blocking panel there would demand the one act the engine will not accept.
 */
export function modeOf(questions: BlogQuestions): QuestionsMode {
  if (questions.answered) {
    return "answered";
  }
  if (questions.stale) {
    return "stale";
  }
  return questions.blocking ? "blocking" : "offer";
}

/**
 * What the library shows on a row: how many questions are open, and whether they block a ship.
 *
 * `blocking` is the whole of the difference an operator scanning twelve rows needs: a blocking row
 * is a blog below 95 that cannot ship until they answer, and a non blocking row is a blog that has
 * already shipped and is offering. Same fact, opposite obligations, so the row states which.
 */
export type WaitingSignal = {
  count: number;
  blocking: boolean;
};

/**
 * The row signal for one blog, or null when the row has nothing to say.
 *
 * A STALE blog gets no signal, and that is the point rather than an oversight: the operator can
 * do nothing about it from this list, the engine refuses the only act it would suggest, and a
 * chip that means "you cannot help this one" in a column of chips that mean "this one needs you"
 * teaches an operator to ignore both. The blog view says plainly what happened to it.
 *
 * An ANSWERED blog gets none either: the answering is done, and whatever it produced is a score,
 * which the row already carries in its own column.
 */
export function waitingSignal(questions: BlogQuestions | null | undefined): WaitingSignal | null {
  if (!questions || questions.questions.length === 0) {
    return null;
  }
  const mode = modeOf(questions);
  if (mode !== "blocking" && mode !== "offer") {
    return null;
  }
  return { count: questions.questions.length, blocking: mode === "blocking" };
}

/** The library's headline: how many blogs are waiting, and how many of those cannot ship. */
export function countWaiting(signals: ReadonlyMap<string, WaitingSignal>): {
  total: number;
  blocking: number;
} {
  let blocking = 0;
  for (const signal of signals.values()) {
    if (signal.blocking) {
      blocking += 1;
    }
  }
  return { total: signals.size, blocking };
}
