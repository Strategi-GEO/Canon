#!/usr/bin/env python3
"""The needs_review resolver and the Sourcing-question predicate: what ends a loop, and why.

Spawns NOTHING, calls NO model, and every output root is a temp dir, so this reads and writes
no real brand. It pins one table and nothing else, because that table is the whole of what
`needs_review` means:

  | Questions                      | Score              | Status       |
  | current                        | >= 95              | done         |
  | current                        | < 95, or none      | needs_review |
  | none/stale/unreadable/answered | >= 95              | done         |
  | none/stale/unreadable/answered | < 95, or none      | failed       |

THE SCORE IS CHECKED FIRST NOW, AND 95+ PASSES REGARDLESS OF QUESTIONS. At or above the ship bar
the draft passes to internal admin review, and any question the evaluator raised rides there with
it for the admin, who is the backstop and can dispatch it to the client ("Get it answered") or
send the blog as-is. This REVERSES the earlier rule (a current question held the blog at any
score, 96 included) on the product owner's explicit call: above the bar the score decides, and the
admin, not a client-facing hold, weighs whatever the evaluator could not settle.

BELOW THE BAR THE QUESTION STATE STILL HOLDS. A current question under 95 is needs_review, the
client-facing hold, because a sub-95 draft has not earned a pass to override it. With no current
question the score decides the rest: below 95 the loop exhausted itself and is failed, and no score
is failed too, since an evaluator that died before writing its scored end line has no question in a
dead session. stale, unreadable and answered group with none because THE APP ALREADY REFUSES THEM,
so they summon nobody, and a hold on a form nobody can submit is a blog with no exit.

The second half pins `questions.has_area_question`, the predicate behind the in-loop rule that A
SOURCING QUESTION ENDS THE REVISE LOOP IMMEDIATELY, at the iteration it is filed. Sourcing is the
ONE area no rewrite can close, which the contract says in its own words, "the writer has no
authority to invent a citation or URL": a Sourcing QUESTION names a fact only a person has, so
iterating past one spends research and revise budget rediscovering what the evaluator already knew
was terminal. The date-night blog filed Sourcing questions at iteration 1, ran a bounded research
top-up and two full revises, and landed at iteration 3 on FOUR Sourcing questions no rewrite could
ever have fixed. Three iterations bought nothing.

Only the PREDICATE is tested here, never the lead's behaviour, because the lead is an agent and no
unit test reaches it. That gap is the honest shape of the rule: it is a LEAD INSTRUCTION and the
engine CANNOT enforce it, since the loop runs inside the SDK session and the backend cannot reach
into it to stop a revise. What makes it acceptable is that THE FAILURE MODE IS COST, NOT
CORRECTNESS: a lead that ignores the rule burns iterations and then hits terminal resolution, where
the final form still holds the blog in Python, through the resolver the first half pins. It cannot
ship a blog it should have held.

The predicate's liveness rule is the resolver's, deliberately: a stale, unreadable, answered or
absent form summons nobody, so it carries no live question of any area and ends no loop.

  .venv/bin/python tests/questions_check.py
"""
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import questions, runner  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


class _Roots:
    """Point the output root at a temp dir. No real brand is ever touched."""

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_root = runner.OUTPUTS_ROOT
        runner.OUTPUTS_ROOT = Path(self.tmp.name)
        return Path(self.tmp.name)

    def __exit__(self, *exc):
        runner.OUTPUTS_ROOT = self.saved_root
        self.tmp.cleanup()


def _seed_blog(slug="topic-0", score=96, iterations=1):
    """A finished topic at a given score and iteration, written through the real status path.

    The iteration matters as much as the score here: is_stale compares the form's iteration
    against the blog's, so seeding one without the other would test a staleness rule this file
    does not own.
    """
    out = runner.output_dir("brand", slug)
    out.mkdir(parents=True, exist_ok=True)
    (out / "blog.md").write_text("a draft", encoding="utf-8")
    append = runner._status_module().append_status
    for i in range(1, iterations + 1):
        append(str(out), slug, stage="eval", event="end", iter=i,
               score=score if i == iterations else None, status="running", note="")
    return out


def _write_questions(out, slug, iteration, score=96):
    (out / "questions.json").write_text(json.dumps({
        "slug": slug, "iter": iteration, "score": score,
        "questions": [{"id": "q1", "question": "Does the Deccan Herald piece carry the claim?",
                       "why": "C21 rests on a source pulled mid loop", "area": "Sourcing"}],
    }), encoding="utf-8")


def _write_questions_in_areas(out, slug, iteration, areas, score=96):
    """A form carrying one question per area given, in order.

    The area is the only thing that varies, because the area is the only thing has_area_question
    reads out of a question: the rest is here so the form is the shape the write half produces.
    """
    (out / "questions.json").write_text(json.dumps({
        "slug": slug, "iter": iteration, "score": score,
        "questions": [
            {"id": f"q{position}", "area": area,
             "question": f"A question about {area.lower()}",
             "why": f"It caps {area} at 2"}
            for position, area in enumerate(areas, 1)
        ],
    }), encoding="utf-8")


def _write_answers(out, slug, iteration):
    (out / "answers.json").write_text(json.dumps({
        "slug": slug, "iter": iteration, "score_when_asked": 96,
        "answers": [{"id": "q1", "question": "Does the Deccan Herald piece carry the claim?",
                     "answer": "No. Cut the claim."}],
    }), encoding="utf-8")


def test_a_passing_blog_ships_over_a_current_question():
    """THE HEADLINE REVERSAL. A 96 with a current question now PASSES to internal admin review.

    The earlier rule held it and called the question a demand no score could dismiss. The product
    owner reversed it: above the ship bar the score decides, the blog passes to done, and the
    question rides into internal review for the admin to weigh (dispatch to the client, or send
    the blog as-is). Below the bar a current question still holds; the score is what changed the
    outcome here, which is why the reason is no longer None.
    """
    with _Roots():
        out = _seed_blog(score=96)
        _write_questions(out, "topic-0", iteration=1)

        check("a current question reads as current",
              runner._questions_state("brand", "topic-0") == "current",
              f"got {runner._questions_state('brand', 'topic-0')!r}")

        status, reason = runner._resolve_needs_review("brand", "topic-0", 96)
        check("a 96 with a current question passes to internal review", status == "done",
              f"got {status}")
        check("the pass carries a reason naming the question riding into internal review",
              reason is not None and "internal" in reason.lower(), f"got {reason!r}")


def test_a_current_question_holds_a_failing_blog_too():
    """The score genuinely does not enter it. Below the band, a current question is the same
    needs_review it is above the band, and for the same reason: a human owes an answer."""
    with _Roots():
        out = _seed_blog(score=88)
        _write_questions(out, "topic-0", iteration=1, score=88)

        status, _ = runner._resolve_needs_review("brand", "topic-0", 88)
        check("an 88 with a current question is held", status == "needs_review", f"got {status}")


def test_a_current_question_holds_a_blog_with_no_score():
    """An evaluator that asked and then died before scoring leaves current questions and no
    number. A human still owes an answer, so the hold stands: this is the one place a None score
    does NOT fall to failed, because the question state is checked first."""
    with _Roots():
        out = _seed_blog(score=None)
        _write_questions(out, "topic-0", iteration=1, score=None)

        status, _ = runner._resolve_needs_review("brand", "topic-0", None)
        check("a scoreless blog with a current question is held",
              status == "needs_review", f"got {status}")


def test_nothing_to_answer_lets_the_score_decide():
    """The other branch of the table, where no human is involved at all and the number is the
    only thing left to read."""
    with _Roots():
        _seed_blog(score=96)
        status, reason = runner._resolve_needs_review("brand", "topic-0", 96)
        check("no questions and a 96 ships", status == "done", f"got {status}")
        check("the engine records why the hold did not stand", bool(reason))

    with _Roots():
        _seed_blog(slug="topic-1", score=88)
        status, _ = runner._resolve_needs_review("brand", "topic-1", 88)
        check("no questions and an 88 fails", status == "failed", f"got {status}")


def test_no_score_and_nothing_to_answer_is_failed():
    """A dead evaluator must never become a permanent hold. With no question on disk there is no
    human task in it, so the loop exhausted itself and `failed` is the honest word."""
    with _Roots():
        _seed_blog(score=None)
        status, _ = runner._resolve_needs_review("brand", "topic-0", None)
        check("a scoreless blog with nothing to ask is failed", status == "failed", f"got {status}")


def test_stale_and_unreadable_and_answered_all_summon_nobody():
    """The three states that LOOK like questions and are not.

    Each groups with none for one shared reason: the app already refuses them, so no operator
    can act on any of them. A hold on a form that cannot be submitted is the dead end the
    needs_review definition forbids, whatever the score.
    """
    with _Roots():
        out = _seed_blog(score=96, iterations=2)
        _write_questions(out, "topic-0", iteration=1)  # the blog is on iteration 2
        check("a form about an earlier draft reads as stale",
              runner._questions_state("brand", "topic-0") == "stale",
              f"got {runner._questions_state('brand', 'topic-0')!r}")
        status, _ = runner._resolve_needs_review("brand", "topic-0", 96)
        check("a stale form never holds a blog", status == "done", f"got {status}")

    with _Roots():
        out = _seed_blog(slug="topic-1", score=88)
        (out / "questions.json").write_text("{not json at all", encoding="utf-8")
        check("a corrupt form reads as unreadable",
              runner._questions_state("brand", "topic-1") == "unreadable",
              f"got {runner._questions_state('brand', 'topic-1')!r}")
        status, _ = runner._resolve_needs_review("brand", "topic-1", 88)
        check("an unreadable form never holds a blog", status == "failed", f"got {status}")

    with _Roots():
        out = _seed_blog(slug="topic-2", score=96)
        _write_questions(out, "topic-2", iteration=1)
        _write_answers(out, "topic-2", iteration=1)
        check("an already-answered form reads as answered",
              runner._questions_state("brand", "topic-2") == "answered",
              f"got {runner._questions_state('brand', 'topic-2')!r}")
        status, _ = runner._resolve_needs_review("brand", "topic-2", 96)
        check("an answered form never holds a blog", status == "done", f"got {status}")


def test_an_answers_file_from_an_earlier_round_does_not_answer_these_questions():
    """The narrow edge of 'answered', and it has to stay narrow. An answers.json from iteration 1
    is the record of a different round, not an answer to iteration 2's form, so the current
    questions still hold the blog."""
    with _Roots():
        out = _seed_blog(score=96, iterations=2)
        _write_questions(out, "topic-0", iteration=2)
        _write_answers(out, "topic-0", iteration=1)

        check("an old answers file leaves the new form current",
              runner._questions_state("brand", "topic-0") == "current",
              f"got {runner._questions_state('brand', 'topic-0')!r}")
        # The form is genuinely current (not answered by the previous round's file), which is the
        # point of this test. At 96 that current question no longer holds: 95+ passes and carries
        # the question into internal review. Below the bar it would still be needs_review.
        status, _ = runner._resolve_needs_review("brand", "topic-0", 96)
        check("a current form the previous round did not answer passes at 96", status == "done",
              f"got {status}")


def test_a_sourcing_question_is_reported_and_the_other_areas_are_not():
    """THE PREDICATE THE IN-LOOP RULE RESTS ON, and the whole of what it discriminates.

    A Sourcing question reports one, so the lead ends the loop at the iteration it is filed: no
    rewrite closes Sourcing, and the writer has no authority to invent a citation or URL, so the
    remaining budget would rediscover what the evaluator already knew was terminal. Structure,
    Draft and Mechanics report none, so the loop runs on and the next iteration's form supersedes
    them, because a rewrite is precisely what closes those.
    """
    with _Roots():
        out = _seed_blog(score=88)
        _write_questions_in_areas(out, "topic-0", iteration=1, areas=["Sourcing"], score=88)
        check("a Sourcing question is reported",
              questions.has_area_question("brand", "topic-0", "Sourcing") is True)

    with _Roots():
        out = _seed_blog(slug="topic-1", score=88)
        _write_questions_in_areas(out, "topic-1", iteration=1, score=88,
                                  areas=["Structure", "Draft", "Mechanics"])
        check("a form of Structure, Draft and Mechanics questions reports no Sourcing",
              questions.has_area_question("brand", "topic-1", "Sourcing") is False)
        check("the other areas are still readable, so the filter reads the area and not the file",
              questions.has_area_question("brand", "topic-1", "Draft") is True)


def test_a_mixed_form_is_reported_on_its_sourcing_question():
    """One Sourcing question among two Draft ones still ends the loop. The rule is about the
    question that no iteration can reach, and questions a rewrite CAN close do not dilute it."""
    with _Roots():
        out = _seed_blog(score=88)
        _write_questions_in_areas(out, "topic-0", iteration=1, score=88,
                                  areas=["Draft", "Sourcing", "Draft"])
        check("a mixed form reports its Sourcing question",
              questions.has_area_question("brand", "topic-0", "Sourcing") is True)


def test_a_stale_form_reports_nothing_however_it_is_worded():
    """A STALE form with a Sourcing question in it reports NONE, and this is the same rule the
    resolver runs on: the app already refuses a stale form, so it summons nobody, and a question
    nobody will ever be asked cannot end a loop. Liveness is checked before the area, never after.
    """
    with _Roots():
        out = _seed_blog(score=88, iterations=2)
        _write_questions_in_areas(out, "topic-0", iteration=1, areas=["Sourcing"], score=88)
        check("the form is stale to start with",
              runner._questions_state("brand", "topic-0") == "stale",
              f"got {runner._questions_state('brand', 'topic-0')!r}")
        check("a stale Sourcing question ends no loop",
              questions.has_area_question("brand", "topic-0", "Sourcing") is False)


def test_an_unreadable_form_reports_nothing_rather_than_raising():
    """The lead asks this on every sub-95 iteration, so a corrupt file must be an answer and not an
    exception: raising here would take down a loop that a bad byte on disk has nothing to say
    about. It reports none for the same reason the resolver refuses it, nobody can render it."""
    with _Roots():
        out = _seed_blog(score=88)
        (out / "questions.json").write_text("{not json at all", encoding="utf-8")
        check("an unreadable form reports no Sourcing question rather than raising",
              questions.has_area_question("brand", "topic-0", "Sourcing") is False)


def test_no_form_at_all_reports_nothing():
    """The ordinary sub-95 iteration: the evaluator asked nothing, so nothing ends the loop and the
    revise the lead was about to dispatch is exactly the right spend."""
    with _Roots():
        _seed_blog(score=88)
        check("no form reports no Sourcing question",
              questions.has_area_question("brand", "topic-0", "Sourcing") is False)


def main():
    print("questions_check: the needs_review resolver and the Sourcing-question predicate. No "
          "model called, no real brand touched.")
    for test in (test_a_passing_blog_ships_over_a_current_question,
                 test_a_current_question_holds_a_failing_blog_too,
                 test_a_current_question_holds_a_blog_with_no_score,
                 test_nothing_to_answer_lets_the_score_decide,
                 test_no_score_and_nothing_to_answer_is_failed,
                 test_stale_and_unreadable_and_answered_all_summon_nobody,
                 test_an_answers_file_from_an_earlier_round_does_not_answer_these_questions,
                 test_a_sourcing_question_is_reported_and_the_other_areas_are_not,
                 test_a_mixed_form_is_reported_on_its_sourcing_question,
                 test_a_stale_form_reports_nothing_however_it_is_worded,
                 test_an_unreadable_form_reports_nothing_rather_than_raising,
                 test_no_form_at_all_reports_nothing):
        print(f"\n{test.__name__}")
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("questions_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
