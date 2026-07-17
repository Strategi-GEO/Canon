"""Read the evaluator's questions for one topic, and record the operator's answers.

The write half of this loop is .claude/questions.py, which an evaluator runs when it hits a gap
no rewrite closes. This module is the read half plus answers.json: it finds that file, works out
whether the operator MUST answer it and whether it is still worth answering, and records what
they said. Nothing here decides what a revise does with an answer; that is runner.revise_topic.

Three computed fields carry the whole contract, and each one exists because of a specific way
this loop goes wrong:

- blocking: these questions are CURRENT, so answering is the only way this blog moves. AT ANY
  SCORE, including a 96. There is no proceed option and no dismiss, because a question is the
  evaluator saying the draft may be WRONG, and a wrong 96 is not better than a wrong 89. See
  is_blocking.
- stale: the questions belong to an iteration the blog has already moved past. See is_stale.
- answered: an answers.json exists for the SAME iteration, so the operator has already said their
  piece and a revise has already been dispatched for those answers. It is what stops a spent form
  HOLDING the blog a second time (see runner._questions_state), and it is NOT a refusal: api_answers
  does not consult it, so a second submit goes through, which is deliberate because it is the one
  door out of a revise that died holding an answered form.

The blog's current iteration AND its current score both come from runner._summarize and from
nowhere else. A second way to read either out of status.jsonl is how two parts of one app come to
disagree about which draft exists and what it scored, and this module's entire job is catching
exactly that disagreement.
"""
import importlib.util
import json
import os
from datetime import datetime, timezone

from . import runner

QUESTIONS_NAME = "questions.json"
ANSWERS_NAME = "answers.json"

_WRITER_MODULE = None


def _writer_module():
    """Load .claude/questions.py by file path: .claude is not a package.

    Exactly how runner._status_module loads .claude/status.py, and for the same reason. The write
    half owns the shape, so the read half borrows its code rather than restating it: two functions
    that agree today about what a Sourcing question looks like are two functions that can stop
    agreeing tomorrow, silently.
    """
    global _WRITER_MODULE
    if _WRITER_MODULE is None:
        path = runner.REPO_ROOT / ".claude" / "questions.py"
        spec = importlib.util.spec_from_file_location("geo_questions", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _WRITER_MODULE = module
    return _WRITER_MODULE


class NoQuestions(Exception):
    """No questions.json for this topic, or one that cannot be read. The endpoint's 404."""


class StaleQuestions(Exception):
    """The questions describe a draft that no longer exists. The endpoint's 409."""


class UnansweredQuestions(Exception):
    """One or more questions came back blank or missing. The endpoint's 422.

    It carries the ids because the operator is looking at a form and needs to know which field to
    fill, and a message that only says "some answers are blank" sends them hunting through five of
    them.
    """

    def __init__(self, ids):
        self.ids = list(ids)
        joined = ", ".join(self.ids)
        super().__init__(f"unanswered question(s): {joined}. Every question needs a non-blank answer")


def questions_path(client_slug, topic_slug, root=None):
    return runner.output_dir(client_slug, topic_slug, root=root) / QUESTIONS_NAME


def answers_path(client_slug, topic_slug, root=None):
    return runner.output_dir(client_slug, topic_slug, root=root) / ANSWERS_NAME


def _read_json(path):
    """The file's parsed contents, or None when it is not there.

    A file that is present but unparseable RAISES rather than reading as absent. The operator's
    questions are not something to lose quietly: answering None for a corrupt file would render
    an empty form and tell them nobody asked anything, when in fact something asked and the
    record broke.
    """
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise NoQuestions(f"{path} exists but cannot be read: {exc}")


def read_questions(client_slug, topic_slug, root=None):
    return _read_json(questions_path(client_slug, topic_slug, root=root))


def read_answers(client_slug, topic_slug, root=None):
    return _read_json(answers_path(client_slug, topic_slug, root=root))


def _current(client_slug, topic_slug, root=None):
    """What the blog is actually on right now, via runner._summarize and nothing else.

    _summarize is what the runner reports a topic with and what the blog history table renders,
    so reading through it means this module cannot drift away from either of them.
    """
    out_dir = runner.output_dir(client_slug, topic_slug, root=root)
    lines = runner._read_status(out_dir)
    return runner._summarize(topic_slug, lines)


def current_iteration(client_slug, topic_slug, root=None):
    """The iteration the blog is actually on."""
    return _current(client_slug, topic_slug, root=root)["iterations"]


def current_score(client_slug, topic_slug, root=None):
    """The score the blog carries RIGHT NOW, which is not the score in questions.json.

    questions.json records the score AT ASKING TIME. The blog then moves: a revise runs, a fresh
    evaluator scores the new draft, and the number in that file is a fact about a moment that has
    passed. It is kept as a record of that moment (see write_answers), never read as the blog's
    current standing.

    THIS IS THE ONLY READER OF THE CURRENT SCORE IN THIS MODULE, and it stays that way. is_blocking
    no longer consults a score at all, because a current question holds a blog at every score, but
    anything here that ever does consult one reads it through this function and never out of
    questions.json. The stored number and the live one disagree in live data: one blog was asked
    about at 85 and now scores 96.
    """
    return _current(client_slug, topic_slug, root=root)["score"]


def is_stale(raw, client_slug, topic_slug, root=None):
    """Do these questions still describe the draft on disk?

    This is a real bug in live data, not a hypothetical. One BLR Brewing topic has a questions.json
    saying iteration 1 and score 89, while the blog finished at iteration 2 scoring 95: the
    iteration-1 evaluator asked, the revise fixed things, and the iteration-2 evaluator did not
    re-ask. The file describes an article that no longer exists. Answering it would feed answers
    about a superseded draft into a surgical revise of a different one, which is worse than not
    asking at all, because the answers would look authoritative.

    runner._lead_prompt now tells the lead to delete questions.json before every evaluator
    dispatch, which stops new files going stale. This check stays regardless: it is what protects
    the files already on disk, and a rule that has to be followed by an agent is not a rule the
    app gets to assume held.
    """
    return raw.get("iter") != current_iteration(client_slug, topic_slug, root=root)


def is_blocking(client_slug, topic_slug, root=None):
    """Is answering the only way this blog moves? Whenever the questions are CURRENT, YES.

    THE SCORE NO LONGER ENTERS THIS, and its removal is the rule rather than a simplification.
    This used to return False at or above runner.SHIP_SCORE, on the ground that the blog had
    already shipped, so the answer was an offer the operator could decline forever. A question is
    the evaluator saying the DRAFT MAY BE WRONG, and a wrong 96 is not better than a wrong 89.
    The offer branch shipped exactly that: two blogs went out at 96 over their own open
    questions, one publishing a claim its canonical-facts file lists as not citable, the other
    citing a date from a source recorded as never fetched in full. ANSWERING IS A DEMAND AT EVERY
    SCORE. There is no dismiss and no proceed-anyway, so the UI must never offer a way past this.

    ONE COMPUTATION, runner._questions_state, and never a second opinion. It is the same function
    runner._resolve_needs_review holds the blog on, so what the app demands and what the engine
    holds for cannot drift apart, which is the entire disagreement this module exists to catch.
    Its non-current values are the ways a form summons nobody NEW: a stale form the app refuses, an
    unreadable one it cannot render, no form at all, and an answered one whose answers are already
    on disk with a revise already dispatched for them. None of those leaves an act outstanding, so
    none of them blocks.

    NO SCORE AT ALL STILL BLOCKS, and it is now the ordinary case rather than an edge. An
    evaluator that asked and then died before writing its scored eval-end line leaves current
    questions and no number, _resolve_needs_review holds it, ledger.record_success never fires,
    and the blog's own row reads needs_review. Reading that as "not below the band, so not
    blocking" told the operator a held, unshipped blog had shipped and that answering was
    optional, when answering was the only way out.
    """
    return runner._questions_state(client_slug, topic_slug, root=root) == "current"


def has_area_question(client_slug, topic_slug, area, root=None):
    """Is a LIVE question of this area on disk right now? The predicate behind --check-area.

    THE RULE IT SERVES: A SOURCING QUESTION ENDS THE REVISE LOOP IMMEDIATELY, at the iteration it is
    filed. At SCORE < 95 the lead checks this before dispatching a revise, and where it holds, the
    loop ends now: the terminal needs_review line, no revise, no further evaluator, and the form
    stays on disk. Structure, Draft and Mechanics questions do NOT end the loop, so they are
    superseded by the next iteration's form and the lead deletes questions.json before the next
    evaluator as before. At SCORE >= 95 nothing changes: the loop ends anyway and terminal
    resolution holds the blog on ANY current question, of any area.

    THE REASON: Sourcing is the ONE area no rewrite can close, which the contract says in its own
    words, "the writer has no authority to invent a citation or URL". A Sourcing QUESTION names a
    fact only a person has, so iterating past one spends research and revise budget rediscovering
    what the evaluator already knew was terminal. Live proof: the date-night blog filed Sourcing
    questions at iteration 1, ran a bounded research top-up and two full revises, and landed at
    iteration 3 on FOUR Sourcing questions about claims no rewrite could have fixed.

    THE DISTINCTION a reader will get wrong: a Sourcing FIX-LIST ITEM still routes to a bounded
    Agent R top-up and still does NOT end the loop, unchanged, and it works. A fix-list item says "a
    machine can find this source"; a question says "only a person holds this fact". Same area word,
    opposite implications for the loop.

    THE ENFORCEMENT LIMIT: the rule is a LEAD INSTRUCTION and this function cannot enforce it. The
    loop runs inside the SDK session and the backend cannot reach into it to stop a revise, which is
    a real departure from this project's "the check is in Python where nothing can argue with it"
    principle and is named rather than papered over. What makes it acceptable: THE FAILURE MODE IS
    COST, NOT CORRECTNESS. A lead that ignores it burns iterations and then hits terminal
    resolution, where the final form still holds the blog in Python, through _resolve_needs_review.
    It cannot ship a blog it should have held.

    LIVENESS FIRST, through runner._questions_state and never a second reading of it: a stale,
    unreadable, answered, or absent form summons nobody, so it carries no live question of any area
    and ends no loop. The area filter is .claude/questions.py's questions_in_area, the same function
    the CLI runs, so what the lead is told and what the engine computes are ONE answer.
    """
    if runner._questions_state(client_slug, topic_slug, root=root) != "current":
        return False
    raw = read_questions(client_slug, topic_slug, root=root)
    return bool(_writer_module().questions_in_area(raw, area))


def is_answered(raw, client_slug, topic_slug, root=None):
    """An answers.json for the SAME iteration. A file from an earlier iteration is not an answer
    to these questions, it is the record of a different round."""
    answers = read_answers(client_slug, topic_slug, root=root)
    return answers is not None and answers.get("iter") == raw.get("iter")


def describe_questions(client_slug, topic_slug, root=None):
    """The GET payload: the file plus the three computed fields. Raises NoQuestions for the 404.

    `score` here is the file's own score, the one the draft carried when the evaluator asked, and
    it is reported as the record it is. `blocking` is NOT derived from it, and is not derived from
    any score: a current question blocks at every score, so this field is a record of a past moment
    and never a condition. Anyone tempted to compute blocking from it should read is_blocking
    first.
    """
    raw = read_questions(client_slug, topic_slug, root=root)
    if raw is None:
        raise NoQuestions(
            f"no {QUESTIONS_NAME} for {client_slug}/{topic_slug}: the evaluator asked nothing here"
        )
    return {
        "slug": raw.get("slug") or topic_slug,
        "asked": raw.get("asked"),
        "iter": raw.get("iter"),
        "score": raw.get("score"),
        "questions": raw.get("questions") or [],
        "stale": is_stale(raw, client_slug, topic_slug, root=root),
        "blocking": is_blocking(client_slug, topic_slug, root=root),
        "answered": is_answered(raw, client_slug, topic_slug, root=root),
    }


def write_answers(client_slug, topic_slug, submitted, root=None):
    """Validate the submission against the questions on disk and write answers.json.

    The QUESTIONS FILE is the authority on what was asked, never the request body. Every question
    it lists needs a non-blank answer, and an id in the body that the file does not ask about is
    dropped: recording it would put an answer in answers.json that no question ever asked, and a
    year from now nobody could tell which of the two was the mistake.

    The question TEXT is copied in beside each answer. answers.json outlives the questions.json it
    came from, deliberately: a successful revise deletes the questions, so a file of bare ids and
    answers would be a record of what somebody said with no record of what they were asked.
    """
    raw = read_questions(client_slug, topic_slug, root=root)
    if raw is None:
        raise NoQuestions(
            f"no {QUESTIONS_NAME} for {client_slug}/{topic_slug}: there is nothing to answer"
        )

    by_id = {}
    for item in submitted or []:
        if isinstance(item, dict) and item.get("id"):
            by_id[str(item["id"])] = item.get("answer")

    built = []
    missing = []
    for question in raw.get("questions") or []:
        qid = str(question.get("id"))
        text = str(by_id.get(qid) or "").strip()
        if not text:
            missing.append(qid)
            continue
        built.append({"id": qid, "question": question.get("question"), "answer": text})
    if missing:
        raise UnansweredQuestions(missing)

    payload = {
        "slug": raw.get("slug") or topic_slug,
        "answered_at": datetime.now(timezone.utc).isoformat(),
        "iter": raw.get("iter"),
        # The score the draft carried when the question was asked, not the score it ends up
        # shipping at. This file is the record of a decision the operator made at one moment, and
        # the moment is half of it: "answered while it stood at 89" and "answered while it stood
        # at 96" are two different acts.
        "score_when_asked": raw.get("score"),
        "answers": built,
    }
    _write_atomic(answers_path(client_slug, topic_slug, root=root), payload)
    return payload


def _write_atomic(path, payload):
    """Temp file then os.replace, exactly as .claude/questions.py writes questions.json.

    A half written answers file is not a cosmetic problem here: the revise session reads this file
    and hands what it finds to a writer as binding client guidance, so a truncated answer becomes
    a truncated instruction that the writer follows in good faith. os.replace is atomic on the
    same filesystem, so a reader sees either the old file or the whole new one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, str(path))


def clear_questions(client_slug, topic_slug, root=None):
    """Remove questions.json once a revise has consumed the answers.

    They are answered, so the form is spent, and a spent form left on disk is exactly the stale
    file this feature already tripped over once. answers.json stays: that is the durable record.

    runner.revise_topic calls this from a FINALLY arm, so a crashed or stopped revise cannot leave
    a spent form holding the blog. Called on the success path only, it left this: the operator
    answers, the session dies before the clear, and the answered form holds the blog while the app
    refuses a second submit on it. Idempotent by way of missing_ok, so an exit path that clears a
    form another already cleared is a no-op rather than an error.
    """
    questions_path(client_slug, topic_slug, root=root).unlink(missing_ok=True)
