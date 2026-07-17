/**
 * What one blog's questions MEAN: which of three situations the operator is actually in, and
 * which blogs in a library are waiting on a person.
 *
 * Pure, and separate from the panel that renders it, because these are the rules the form is
 * right or wrong about. Reading a hold as "show a warning" rather than as "there is no way
 * forward but the form", or offering a submit the engine will 409, are both defects that live
 * in this decision rather than in any markup, so the decision is one function that can be read
 * on its own.
 *
 * OPEN QUESTIONS HOLD A BLOG AT ANY SCORE. The question state is checked FIRST and the score is
 * not checked at all: a 96 with current questions is HELD, and answering it is a DEMAND rather
 * than an offer. The rule this replaces held a blog only below 95 and let a question on a passing
 * draft be declined forever, and it shipped two canonical-facts violations at 96 doing so. A
 * question nobody had to answer is a question nobody answered.
 *
 * NOTHING HERE IS DERIVED FROM A SCORE, and that is now true in the strong sense: the score
 * cannot hold a blog and cannot release one. The engine's `blocking` flag is not read either.
 * It is the engine's own copy of a decision the score used to govern, and branching on it here
 * would let the old rule back in through the wire.
 *
 * THE AXIS IS THE QUESTION STATE, four-valued and not a binary: current holds, and none, stale,
 * and answered all release. The last two group with none for one reason: THE APP ALREADY REFUSES
 * THEM. A stale ask is about a draft that no longer exists and the engine 409s it; an answered
 * form has already had the one act it demands. Neither summons anybody, so neither may hold a
 * blog hostage to an act that cannot be performed.
 */

import type { BlogQuestions } from "@/types";

export type QuestionsMode =
  /**
   * Current questions, at ANY score. The blog is HELD and the form is the only way out: no
   * proceed, no dismiss, and no score high enough to excuse the answer.
   */
  | "held"
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
 * `answered` also outranks `held`, which is what keeps a spent form from holding a blog forever:
 * the operator answered, the revise then crashed or was stopped before the form was cleared, and
 * the file is still on disk and still iteration-matched. Holding on it would summon a human to an
 * act the app itself refuses, because the form is already answered. That is a dead end with no
 * door, which is the exact thing the needs_review definition forbids.
 *
 * `stale` outranks `held` because a stale question cannot be answered at all: the engine refuses
 * it. A held panel there would demand the one act the engine will not accept.
 */
export function modeOf(questions: BlogQuestions): QuestionsMode {
  if (questions.answered) {
    return "answered";
  }
  if (questions.stale) {
    return "stale";
  }
  return "held";
}

/**
 * What the library shows on a row: how many questions this blog is holding for the operator.
 *
 * A COUNT AND NOTHING ELSE. This carried a `blocking` flag too, so a row could say "shipped, 2
 * open questions" beside one saying "2 questions to answer", and the operator learned that the
 * first kind was theirs to ignore. There is now one obligation, so there is one shape: every row
 * with a signal is a blog held for an answer, whatever it scored.
 */
export type WaitingSignal = {
  count: number;
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
  if (modeOf(questions) !== "held") {
    return null;
  }
  return { count: questions.questions.length };
}

/**
 * The library's headline: how many blogs are held for an answer.
 *
 * ONE NUMBER, because there is one obligation. This used to return a blocking count beside a
 * total so the banner could separate a queue from an invitation, and the invitation half was the
 * old rule's whole mistake: it taught an operator that some of the evaluator's questions were
 * decoration. None of them are.
 */
export function countWaiting(signals: ReadonlyMap<string, WaitingSignal>): { total: number } {
  return { total: signals.size };
}
