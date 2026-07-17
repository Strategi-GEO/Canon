"""Read the evaluator's questions for one topic, and record the operator's answers.

The write half of this loop is .claude/questions.py, which an evaluator runs when it hits a gap
no rewrite closes. This module is the read half plus the answers, and since the Supabase rewire
it is split down the middle by WHO is asking:

- RUNNER-FACING (terminal resolution and the revise finally arm): read_questions, read_answers,
  is_stale, is_answered, has_area_question, current_score, and the disk half of
  clear_questions. These read the DISK, the same surface the agents wrote seconds earlier, and
  they must keep doing so: the terminal resolver runs BEFORE sync.commit_topic pushes scratch to
  the record, so a DB read here would race the commit and re-create the exact
  shipped-past-an-open-question failure the resolver exists to prevent. runner._questions_state's
  five values (current / none / stale / answered / unreadable) and the revise finally arm's
  keep-vs-clear matrix rest on these functions behaving exactly as they always have.
- ROUTE-FACING (app.py's GET questions and POST answers): describe_questions, write_answers,
  and current_iteration. These read and write review_notes in Supabase, because scratch can be
  reclaimed and the record is the truth the dashboard renders. A question is a review_notes row
  with author 'evaluator' and no parent; an answer is a child row with author 'operator' whose
  parent_id is the question row's id. write_answers records the answers in the record, then
  calls sync.materialize_answers so the upcoming revise session finds questions.json and
  answers.json on disk exactly as Agent E expects. sync.py owns that rebuild; this module never
  duplicates it.

Three computed fields carry the operator contract, and each one exists because of a specific way
this loop goes wrong:

- blocking: these questions are CURRENT, so answering is the only way this blog moves. AT ANY
  SCORE, including a 96. There is no proceed option and no dismiss, because a question is the
  evaluator saying the draft may be WRONG, and a wrong 96 is not better than a wrong 89. On the
  route side it is computed exactly as runner._questions_state computes "current": rows exist,
  they are not stale, and they are not answered. Never from the score. See is_blocking.
- stale: the questions belong to an iteration the blog has already moved past. On disk that is
  is_stale; in the record it is the same comparison, asked_iter against the iteration derived
  from status_events.
- answered: on disk, an answers.json for the SAME iteration; in the record, every question row
  has a child answer row. Either way it is what stops a spent form HOLDING the blog a second
  time (see runner._questions_state), and it is NOT a refusal: write_answers does not consult
  it, so a second submit goes through, which is deliberate because it is the one door out of a
  revise that died holding an answered form.

"unreadable" is a disk-native state with no DB analogue: a review_notes row that exists is
readable by construction, so the route path deliberately maps it to absent (NoQuestions).

On the runner-facing side the blog's current iteration AND its current score both come from
runner._summarize and from nowhere else. A second way to read either out of status.jsonl is how
two parts of one app come to disagree about which draft exists and what it scored, and this
module's entire job is catching exactly that disagreement.
"""
import importlib.util
import json
import logging
import os
from datetime import datetime, timezone

from . import db, runner

log = logging.getLogger("geo.questions")

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
    """No questions for this topic, or a file that cannot be read. The endpoint's 404."""


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
    so reading through it means this module cannot drift away from either of them. This is the
    DISK read, and every runner-facing check comes through it: the terminal resolver must see
    the surface the agents just wrote, never a record the commit has not reached yet.
    """
    out_dir = runner.output_dir(client_slug, topic_slug, root=root)
    lines = runner._read_status(out_dir)
    return runner._summarize(topic_slug, lines)


def current_iteration(client_slug, topic_slug, root=None):
    """The iteration the blog is actually on.

    ROUTE-FACING since the Supabase rewire: with no root it reads the record, the high-water
    iter over status_events, the same fold topic_rollup runs, because app.py quotes this number
    to an operator whose scratch may already be reclaimed. A caller passing an explicit root is
    scoped to a disk sandbox, so it gets the disk read the sandbox was built for. The
    runner-facing staleness check does NOT come through here: is_stale reads the disk directly,
    for the reason its docstring gives.
    """
    if root is not None:
        return _current(client_slug, topic_slug, root=root)["iterations"]
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return 0
    return db.q(
        "select coalesce(max(iter), 0) from status_events where topic_id = %s",
        (tid,), fetch="val")


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

    RUNNER-FACING: the iteration here is the DISK iteration through _current, never the record.
    _questions_state runs this during terminal resolution, before sync.commit_topic has pushed
    the session's status lines, so a record read here would compare the form against a blog that
    is one session behind and hold or release it wrongly.
    """
    return raw.get("iter") != _current(client_slug, topic_slug, root=root)["iterations"]


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

    RUNNER-FACING: this is the disk predicate. The route-facing describe_questions computes its
    own `blocking` from the record, translated from the same "current" arm: rows exist, they are
    not stale, and they are not answered.
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


# ---------------------------------------------------------------------------
# Route-facing reads and writes: review_notes is the record the dashboard sees
# ---------------------------------------------------------------------------

def _db_form_rows(topic_id):
    """The current form's rows: the latest asking round in review_notes.

    questions.json is rewritten whole per eval, so the record's analogue of "the form" is the
    newest round: every evaluator question sharing the blog_version_id of the most recently
    created one. Older rounds survive in the table only when answered (sync.commit_topic deletes
    unanswered ones), and they are history, not the form: folding them in would render spent
    questions to the operator and demand re-answers for them on submit.
    """
    return db.q(
        """select n.id, n.client_id, n.blog_version_id, n.ref, n.area, n.body,
                  n.why, n.asked_score, n.asked_iter, n.created_at,
                  exists (select 1 from review_notes r where r.parent_id = n.id)
           from review_notes n
           where n.topic_id = %s and n.author = 'evaluator' and n.parent_id is null
             and n.blog_version_id = (
                 select n2.blog_version_id from review_notes n2
                 where n2.topic_id = %s and n2.author = 'evaluator'
                   and n2.parent_id is null
                 order by n2.created_at desc limit 1)
           order by n.created_at, n.ref""",
        (topic_id, topic_id))


def describe_questions(client_slug, topic_slug, root=None):
    """The GET payload: the form plus the three computed fields. Raises NoQuestions for the 404.

    ROUTE-FACING: with no root this reads review_notes, not the disk, because scratch can be
    reclaimed and the record is what the dashboard renders. The wire shape is preserved exactly:
    slug, asked, iter, score, questions [{id, area, question, why}], stale, blocking, answered.
    A caller passing an explicit root is scoped to a disk sandbox and gets the disk read.

    `score` is the form's own score, the one the draft carried when the evaluator asked, and it
    is reported as the record it is. `blocking` is NOT derived from it, and is not derived from
    any score: a current question blocks at every score, so this field is a record of a past
    moment and never a condition. Anyone tempted to compute blocking from it should read
    is_blocking first.
    """
    if root is not None:
        return _describe_questions_from_disk(client_slug, topic_slug, root=root)

    tid = db.topic_id(client_slug, topic_slug)
    rows = _db_form_rows(tid) if tid else []
    if not rows:
        # Absent covers "unreadable" too, and that mapping is deliberate: unreadable is a
        # disk-native state (a file that exists but cannot be parsed) with no DB analogue,
        # because a review_notes row that exists is readable by construction. Nothing on this
        # path can be present-but-corrupt, so nothing maps to it.
        raise NoQuestions(
            f"no {QUESTIONS_NAME} for {client_slug}/{topic_slug}: the evaluator asked nothing here"
        )

    form_iter = next((r[8] for r in rows if r[8] is not None), None)
    form_score = next((r[7] for r in rows if r[7] is not None), None)
    asked = min((r[9] for r in rows if r[9] is not None), default=None)
    # stale mirrors is_stale, the ITERATION comparison, not the version anchor: is_stale compares
    # the form's iter against the blog's current iteration, so the record-side twin compares
    # asked_iter against the status_events high-water iter. The blog_version anchor also goes
    # stale when a new version lands, but a restore that commits no new version moves the
    # iteration while keeping the anchor, and the iteration is what today's behavior reads.
    stale = form_iter != current_iteration(client_slug, topic_slug)
    answered = all(r[10] for r in rows)
    return {
        "slug": topic_slug,
        "asked": asked.isoformat() if asked is not None else None,
        "iter": form_iter,
        "score": form_score,
        "questions": [
            {"id": r[3], "area": r[4], "question": r[5], "why": r[6] or ""}
            for r in rows
        ],
        "stale": stale,
        # blocking is current-and-unanswered, runner._questions_state's "current" arm translated
        # to the record: rows exist, they are not stale, and they are not answered. Never the
        # score, see is_blocking.
        "blocking": (not stale) and (not answered),
        "answered": answered,
    }


def _describe_questions_from_disk(client_slug, topic_slug, root=None):
    """The disk twin of describe_questions, for sandbox roots.

    A scoped root is a disposable output tree (what tests point somewhere disposable, in
    runner.py's own words), and its forms never reached the record, so the record has nothing
    to say about them. Same wire shape, computed off the file exactly as before the rewire.
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
    """Validate the submission against the record's form and record the answers.

    ROUTE-FACING. The QUESTION ROWS are the authority on what was asked, never the request body,
    the same rule the file version enforced. Every question the form lists needs a non-blank
    answer, an id in the body that the form does not ask about is dropped, and the blank ones are
    named in UnansweredQuestions so the 422 can point at the fields to fill.

    One child row per answer, in ONE transaction: author 'operator', parent_id the question row's
    id, body the answer text. A re-submit UPDATES the existing child rather than inserting a
    second one, which preserves the file behavior of overwriting answers.json whole and keeps
    materialize_answers' one-answer-per-question join honest.

    THEN sync.materialize_answers rebuilds questions.json and answers.json on disk from the
    record, so the upcoming revise session finds both exactly as Agent E expects. The old direct
    answers.json write moved INTO that rebuild; writing the file here as well would be writing it
    twice. The question text still travels with each answer, on the parent row the child points
    at, so the durable record keeps what was asked next to what was said.
    """
    if root is not None:
        return _write_answers_to_disk(client_slug, topic_slug, submitted, root=root)

    tid = db.topic_id(client_slug, topic_slug)
    rows = _db_form_rows(tid) if tid else []
    if not rows:
        raise NoQuestions(
            f"no {QUESTIONS_NAME} for {client_slug}/{topic_slug}: there is nothing to answer"
        )

    by_id = {}
    for item in submitted or []:
        if isinstance(item, dict) and item.get("id"):
            by_id[str(item["id"])] = item.get("answer")

    built = []
    missing = []
    for row in rows:
        row_id, cid, vid, ref, _area, question, _why, _score, _iter, _at, _answered = row
        qid = str(ref)
        text = str(by_id.get(qid) or "").strip()
        if not text:
            missing.append(qid)
            continue
        built.append((row_id, cid, vid, qid, question, text))
    if missing:
        raise UnansweredQuestions(missing)

    with db.tx() as cur:
        for row_id, cid, vid, _qid, _question, text in built:
            # Update-then-insert rather than ON CONFLICT: the child carries no ref (a ref would
            # collide with its parent's under unique(blog_version_id, ref)), so there is no
            # conflict target to name.
            cur.execute(
                "update review_notes set body = %s "
                "where parent_id = %s and author = 'operator'",
                (text, row_id))
            if cur.rowcount == 0:
                cur.execute(
                    """insert into review_notes
                         (topic_id, client_id, blog_version_id, parent_id, author, body)
                       values (%s, %s, %s, %s, 'operator', %s)""",
                    (tid, cid, vid, row_id, text))

    # After the commit, never inside it: the rebuild reads through its own connection, so it must
    # see the rows the transaction just made durable. Imported here, not at module top, to keep
    # the import graph the shape it already has: sync reaches runner lazily, and this module
    # already imports runner at the top.
    from . import sync
    sync.materialize_answers(client_slug, topic_slug)

    return {
        "slug": topic_slug,
        "answered_at": datetime.now(timezone.utc).isoformat(),
        "iter": next((r[8] for r in rows if r[8] is not None), None),
        # The score the draft carried when the question was asked, not the score it ends up
        # shipping at. This is the record of a decision the operator made at one moment, and
        # the moment is half of it: "answered while it stood at 89" and "answered while it stood
        # at 96" are two different acts.
        "score_when_asked": next((r[7] for r in rows if r[7] is not None), None),
        "answers": [
            {"id": qid, "question": question, "answer": text}
            for _row_id, _cid, _vid, qid, question, text in built
        ],
    }


def _write_answers_to_disk(client_slug, topic_slug, submitted, root=None):
    """The disk twin of write_answers, for sandbox roots: validate against the file and write
    answers.json directly, exactly as before the rewire.

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
    """Remove the spent form, from BOTH surfaces, disk first.

    They are answered, so the form is spent, and a spent form left on disk is exactly the stale
    file this feature already tripped over once. answers.json stays: that is the durable record,
    and its DB analogue, the operator's child rows, stays too, which is why the delete below
    touches only UNANSWERED evaluator rows.

    runner.revise_topic calls this from a FINALLY arm, so a crashed or stopped revise cannot leave
    a spent form holding the blog. Called on the success path only, it left this: the operator
    answers, the session dies before the clear, and the answered form holds the blog while the app
    refuses a second submit on it. Idempotent by way of missing_ok, so an exit path that clears a
    form another already cleared is a no-op rather than an error.

    THE DISK UNLINK COMES FIRST AND CANNOT BE BLOCKED BY THE DB: the finally arm this runs on
    protects a CancelledError on its way out, so the record delete is best effort, guarded to
    the canonical outputs tree, and swallows Exception (never BaseException) with a log. A DB
    blip leaves an orphaned unanswered row that describe_questions will report as stale the
    moment the iteration moves, which is the lesser harm.
    """
    questions_path(client_slug, topic_slug, root=root).unlink(missing_ok=True)

    # The record half only mirrors the canonical outputs tree. A scoped root, or an OUTPUTS_ROOT
    # a test has pointed at a temp dir, is a disk sandbox whose form never reached review_notes,
    # and deleting live rows on its behalf would let a test write to the production table.
    if root is not None or runner.OUTPUTS_ROOT != runner.REPO_ROOT / "outputs":
        return
    try:
        if not db.db_configured():
            return
        tid = db.topic_id(client_slug, topic_slug)
        if tid:
            # The same delete sync.commit_topic runs when no form is on disk: unanswered
            # evaluator questions go, answered ones stay as history with their answers.
            db.q(
                """delete from review_notes n
                   where n.topic_id = %s and n.author = 'evaluator'
                     and n.parent_id is null
                     and not exists (select 1 from review_notes r
                                     where r.parent_id = n.id)""",
                (tid,), fetch="none")
    except Exception as exc:
        log.warning("clear_questions: record delete skipped for %s/%s: %s",
                    client_slug, topic_slug, exc)
