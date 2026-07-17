"""Read the evaluator's questions for one topic, and record the operator's answers.

The write half of this loop is .claude/questions.py, which an evaluator runs when it hits a gap
no rewrite closes. This module is the read half plus answers.json: it finds that file, works out
whether the operator MUST answer it and whether it is still worth answering, and records what
they said. Nothing here decides what a revise does with an answer; that is runner.revise_topic.

Three computed fields carry the whole contract, and each one exists because of a specific way
this loop goes wrong:

- blocking: the blog's CURRENT score has not reached the ship band, so there is no proceed
  option. A 95 or a 96 held for a citation confirmation is the operator's choice to answer,
  because the blog already ships. Short of the band, including with no score recorded at all, it
  is not shipping either way, so answering is the only path forward and the UI must not offer a
  way past it. See is_blocking.
- stale: the questions belong to an iteration the blog has already moved past. See is_stale.
- answered: an answers.json exists for the SAME iteration, so a second submit does not silently
  overwrite the first with a form the operator filled in from a different draft.

The blog's current iteration AND its current score both come from runner._summarize and from
nowhere else. A second way to read either out of status.jsonl is how two parts of one app come to
disagree about which draft exists and what it scored, and this module's entire job is catching
exactly that disagreement.
"""
import json
import os
from datetime import datetime, timezone

from . import runner

QUESTIONS_NAME = "questions.json"
ANSWERS_NAME = "answers.json"


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
    """Is answering the only way this blog moves?

    Computed from the blog's CURRENT score, and NEVER from the score recorded in questions.json.
    That distinction is a real bug in live data, not a hypothetical: a blog asked about while it
    stood at 85 now scores 96, and reading the stored 85 showed the operator "you must answer this
    before it ships" about a blog that had already shipped. The question survived the revise; the
    85 did not.

    AT OR ABOVE runner.SHIP_SCORE the blog has already shipped and the answer is an offer the
    operator may decline forever, which is the house rule that 95 ships. ONLY that case is an
    offer. Anything else is blocking: the blog is not shipping either way, so answering is the
    only path forward and the UI must not offer a way past it.

    NO SCORE AT ALL IS BLOCKING, and this is the case the rule is stated around rather than an
    edge of it. An evaluator that asked and then died before writing its scored eval-end line
    leaves exactly this: current questions, no number. runner._resolve_needs_review reads that
    None as "nothing reached the ship band" and the hold STANDS, ledger.record_success never
    fires, and the blog's own row reads needs_review. Reading it here as "not below the band, so
    not blocking" made this module the disagreement it exists to catch: the UI took the offer
    branch and told the operator a held, unshipped blog had shipped and that answering was
    optional, when answering was the only way out. The test is therefore the ship band and never
    the absence of a number, which is the same test _resolve_needs_review applies first.
    """
    score = current_score(client_slug, topic_slug, root=root)
    return not (score is not None and score >= runner.SHIP_SCORE)


def is_answered(raw, client_slug, topic_slug, root=None):
    """An answers.json for the SAME iteration. A file from an earlier iteration is not an answer
    to these questions, it is the record of a different round."""
    answers = read_answers(client_slug, topic_slug, root=root)
    return answers is not None and answers.get("iter") == raw.get("iter")


def describe_questions(client_slug, topic_slug, root=None):
    """The GET payload: the file plus the three computed fields. Raises NoQuestions for the 404.

    `score` here is the file's own score, the one the draft carried when the evaluator asked, and
    it is reported as the record it is. `blocking` is deliberately NOT derived from it: the blog
    moves after the question is asked, so the two can disagree, and when they disagree the current
    score is the true one. Anyone tempted to compute blocking from this field should read
    is_blocking first.
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
    """
    questions_path(client_slug, topic_slug, root=root).unlink(missing_ok=True)
