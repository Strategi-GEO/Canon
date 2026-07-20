#!/usr/bin/env python3
"""Cancellation checks for the stop-session feature. Spawns NOTHING and calls NO model.

Every SDK seam (_sdk_session, _sdk_revise_session, the session entry points the engine
actually runs) is monkeypatched and every output root is a temp dir, so this never reads or
writes a real brand and never opens a session. What it pins is the one thing the stop button promises and the one thing
it must never do:

  1. A topic that FINISHED keeps its verdict, its score and its ledger entry through a stop.
  2. A topic that did NOT finish gets exactly one terminal `stopped` line, so its SSE stream
     closes and the operator's watch view does not heartbeat forever on a dead session.

Both halves failed in ways that only a cancel could reach, which is why they are tested here
rather than left to the static checks: CancelledError is a BaseException, so every `except
Exception` in the engine steps over it, and each of these paths had an arm that was missing,
unguarded, or reading the wrong lines.

  .venv/bin/python tests/stop_check.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import facts_gen, runner  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def _lines(out_dir):
    path = Path(out_dir) / "status.jsonl"
    if not path.is_file():
        return []
    return [json.loads(raw) for raw in path.read_text(encoding="utf-8").splitlines() if raw.strip()]


def _terminals(out_dir):
    return [line for line in _lines(out_dir) if line.get("status") in runner.TERMINAL_STATUSES]


def _append(out_dir, slug, **kwargs):
    """Append through the real status.py path, exactly as the engine does."""
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    payload = {"stage": "eval", "event": "end", "iter": 1, "score": None, "status": "running",
               "note": ""}
    payload.update(kwargs)
    runner._status_module().append_status(str(out_dir), slug, **payload)


def _rows(n):
    return [{"topic": f"Topic {i}", "topic_slug": f"topic-{i}", "index": i} for i in range(n)]


class _Roots:
    """Point every output root at a temp dir. No real brand is ever touched.

    has_canonical_facts is stubbed True on purpose, and the reason is worth stating: left alone,
    run_batch finds no fact base for the fake brand and spends the whole test inside the FACTS
    phase, so the topics are never dispatched and every batch assertion below silently tests the
    facts path instead of the one it names. The sweep answers there too, which is exactly what
    makes it silent. A stubbed fact base puts the run where these tests say it is.

    canonical_facts_path is stubbed the same way and for the same reason one level down: the
    engine has no mock path any more, so run_topic and revise_topic ALWAYS run their real-mode
    preflight, and a fake brand with no clients/<slug>/canonical-facts.md would refuse before
    the session seam these tests drive. The stub points preflight at a real reviewed file in
    the sandbox, so the run reaches the seam the test names.

    The session seams themselves, _sdk_session and _sdk_revise_session, are saved and restored
    here because every test below monkeypatches one of them with its own fake: they are the
    ONLY session entry points, and a fake left behind would leak into the next suite.
    """

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved_root = runner.OUTPUTS_ROOT
        self.saved_facts = runner.has_canonical_facts
        self.saved_facts_path = runner.canonical_facts_path
        self.saved_sdk_session = runner._sdk_session
        self.saved_sdk_revise = runner._sdk_revise_session
        runner.OUTPUTS_ROOT = Path(self.tmp.name)
        runner.has_canonical_facts = lambda slug, **k: True
        facts = Path(self.tmp.name) / "canonical-facts.md"
        facts.write_text("# canonical-facts.md for the test sandbox: reviewed, no placeholder\n",
                         encoding="utf-8")
        runner.canonical_facts_path = lambda slug, clients_root=None: facts
        return Path(self.tmp.name)

    def __exit__(self, *exc):
        runner.OUTPUTS_ROOT = self.saved_root
        runner.has_canonical_facts = self.saved_facts
        runner.canonical_facts_path = self.saved_facts_path
        runner._sdk_session = self.saved_sdk_session
        runner._sdk_revise_session = self.saved_sdk_revise
        self.tmp.cleanup()


# ---------------------------------------------------------------------------
# run_topic
# ---------------------------------------------------------------------------

def test_stop_mid_topic_writes_one_stopped_line():
    async def scenario():
        with _Roots():
            out = runner.output_dir("brand", "topic-0")

            async def hang(*a, **k):
                await asyncio.sleep(10)

            runner._sdk_session = hang
            task = asyncio.create_task(runner.run_topic("brand", _rows(1)[0]))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            terminals = _terminals(out)
            check("a stopped topic gets exactly one terminal line",
                  len(terminals) == 1, f"got {terminals}")
            check("that line is stopped, not failed",
                  terminals and terminals[0]["status"] == "stopped",
                  f"got {terminals}")
            check("a stopped topic is never given a score it did not earn",
                  terminals and terminals[0].get("score") is None, f"got {terminals}")

    asyncio.run(scenario())


def test_stop_keeps_a_blog_that_finished_microseconds_earlier():
    """The operator's own promise: whichever blogs have been created will be kept."""
    async def scenario():
        with _Roots():
            out = runner.output_dir("brand", "topic-0")

            async def ships_then_hangs(client_slug, row, topic_slug, out_dir):
                _append(out_dir, topic_slug, status="done", score=96, note="shipped")
                await asyncio.sleep(10)

            runner._sdk_session = ships_then_hangs
            task = asyncio.create_task(runner.run_topic("brand", _rows(1)[0]))
            # Cancel only once the done line is ON DISK. run_topic now runs a materialize hook
            # (a real round trip, skipped for this unknown brand but still a query) before the
            # session, so a fixed sleep races it and stops a session that has not shipped yet,
            # which is a different scenario from the one this test names: a stop landing AFTER
            # the blog finished.
            for _ in range(400):
                if _terminals(out):
                    break
                await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            terminals = _terminals(out)
            check("a stop never appends a second terminal line over a done topic",
                  len(terminals) == 1, f"got {terminals}")
            check("the done blog keeps done through a stop",
                  terminals and terminals[-1]["status"] == "done", f"got {terminals}")
            check("the done blog keeps its score through a stop",
                  terminals and terminals[-1]["score"] == 96, f"got {terminals}")

    asyncio.run(scenario())


def test_a_resumed_topic_is_stoppable_again():
    """The regression: the guard read the WHOLE file, found run 1's stopped line, and wrote
    nothing for run 2, so run 2's SSE window never saw a terminal status and hung forever."""
    async def scenario():
        with _Roots():
            out = runner.output_dir("brand", "topic-0")
            _append(out, "topic-0", status="stopped", note="run 1, stopped by the operator")
            before = len(_lines(out))

            async def hang(*a, **k):
                await asyncio.sleep(10)

            runner._sdk_session = hang
            task = asyncio.create_task(runner.run_topic("brand", _rows(1)[0]))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            window = _lines(out)[before:]
            terminal = [line for line in window if line.get("status") in runner.TERMINAL_STATUSES]
            check("a resumed topic stopped a second time writes a line in ITS OWN sse window",
                  len(terminal) == 1, f"window was {window}")

    asyncio.run(scenario())


def test_a_resumed_topic_retries_its_own_dead_session():
    """The mirror of the same bug: the retry loop saw run 1's terminal line and broke on
    attempt 1, so a dead session never retried and reported run 1's verdict as run 2's."""
    async def scenario():
        with _Roots():
            out = runner.output_dir("brand", "topic-0")
            _append(out, "topic-0", status="stopped", note="run 1, stopped by the operator")
            attempts = []

            async def dies_without_a_verdict(client_slug, row, topic_slug, out_dir):
                attempts.append(1)

            runner._sdk_session = dies_without_a_verdict
            result = await runner.run_topic("brand", _rows(1)[0])

            check("a died session on a resumed topic still retries",
                  len(attempts) == 2, f"attempted {len(attempts)} times")
            check("a died session on a resumed topic reports failed, not the old verdict",
                  result["status"] == "failed", f"got {result}")

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# run_batch
# ---------------------------------------------------------------------------

def test_topics_queued_behind_the_semaphore_are_stopped():
    """Any selection larger than five has topics suspended at TOPIC_SEMAPHORE. The cancel
    lands on the acquire, before run_topic, so nothing there writes their line."""
    async def scenario():
        with _Roots():
            async def hang(*a, **k):
                await asyncio.sleep(10)

            runner._sdk_session = hang
            rows = _rows(8)
            task = asyncio.create_task(runner.run_batch("brand", rows))
            await asyncio.sleep(0.1)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            missing = [row["topic_slug"] for row in rows
                       if not _terminals(runner.output_dir("brand", row["topic_slug"]))]
            doubled = [row["topic_slug"] for row in rows
                       if len(_terminals(runner.output_dir("brand", row["topic_slug"]))) > 1]
            check("every topic of eight gets a terminal line, not just the five in flight",
                  not missing, f"no terminal line for {missing}")
            check("no topic gets two terminal lines from one stop",
                  not doubled, f"doubled for {doubled}")

    asyncio.run(scenario())


def test_a_run_stopped_while_queued_on_the_client_lock_is_swept():
    """The wait for CLIENT_LOCK is 'many minutes' for real blogs, so it is where a stop is
    most likely to land. guarded never runs, so not one status.jsonl would exist."""
    async def scenario():
        with _Roots():
            rows = _rows(3)
            async with runner.CLIENT_LOCK:
                task = asyncio.create_task(runner.run_batch("brand", rows))
                await asyncio.sleep(0.05)
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            statuses = [
                (_terminals(runner.output_dir("brand", row["topic_slug"])) or [{}])[0].get("status")
                for row in rows
            ]
            check("a run stopped while queued still terminates every one of its topics",
                  statuses == ["stopped"] * 3, f"got {statuses}")

    asyncio.run(scenario())


def test_the_client_lock_is_released_on_the_cancel_path():
    """The highest-consequence line in the feature: a leaked CLIENT_LOCK bricks every brand
    in the repo until someone restarts the API."""
    async def scenario():
        with _Roots():
            async def hang(*a, **k):
                await asyncio.sleep(10)

            runner._sdk_session = hang
            task = asyncio.create_task(runner.run_batch("brand", _rows(2)))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            check("CLIENT_LOCK is not leaked by a stop", not runner.CLIENT_LOCK.locked())

    asyncio.run(scenario())


def test_a_blog_that_shipped_still_reaches_the_ledger():
    """The window between the lead writing done and guarded's notify is hundreds of ms of
    session wind-down. A cancel there lost the ledger entry for a blog that IS on disk, so a
    later Generate would re-spend real quota rewriting a blog that already shipped."""
    async def scenario():
        with _Roots():
            recorded = []

            async def on_topic_done(payload):
                recorded.append(payload)

            async def ships_then_hangs(client_slug, row, topic_slug, out_dir):
                _append(out_dir, topic_slug, status="done", score=96, note="shipped")
                await asyncio.sleep(10)

            runner._sdk_session = ships_then_hangs
            task = asyncio.create_task(
                runner.run_batch("brand", _rows(1), on_topic_done=on_topic_done))
            # Cancel only once the done line is ON DISK, for the reason
            # test_stop_keeps_a_blog_that_finished_microseconds_earlier states: the materialize
            # hooks in front of the session make a fixed sleep a race, and the window this test
            # pins opens AFTER the lead writes done.
            for _ in range(400):
                if _terminals(runner.output_dir("brand", "topic-0")):
                    break
                await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await asyncio.sleep(0.05)

            check("a blog that shipped before the stop still reaches the ledger",
                  len(recorded) == 1, f"ledger got {recorded}")
            check("the ledger entry carries the score the blog earned",
                  recorded and recorded[0].get("score") == 96, f"ledger got {recorded}")

    asyncio.run(scenario())


def test_a_stopped_blog_never_reaches_the_ledger():
    """generated.csv is shipped blogs only."""
    async def scenario():
        with _Roots():
            recorded = []

            async def on_topic_done(payload):
                recorded.append(payload)

            async def hang(*a, **k):
                await asyncio.sleep(10)

            runner._sdk_session = hang
            task = asyncio.create_task(
                runner.run_batch("brand", _rows(1), on_topic_done=on_topic_done))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await asyncio.sleep(0.05)

            check("a stopped topic is never appended to the ledger",
                  not recorded, f"ledger got {recorded}")

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# revise_topic
# ---------------------------------------------------------------------------

def _seed_shipped_blog(root, slug="topic-0"):
    out = runner.output_dir("brand", slug)
    out.mkdir(parents=True, exist_ok=True)
    (out / "blog.md").write_text("the draft that scored 96", encoding="utf-8")
    # eval.md is seeded beside the draft because the restore owes back the ARTIFACT SET, not just
    # the draft. The score describes a pair: the bytes that were graded and the verdict that
    # graded them. Snapshotting one and not the other leaves the restored original sitting next
    # to a DISCARDED draft's eval.md and its SCORE: NN, which is a blog whose verdict describes
    # bytes that no longer exist anywhere.
    (out / "eval.md").write_text("SCORE: 96\nthe verdict on the draft that scored 96\n",
                                 encoding="utf-8")
    _append(out, slug, status="done", score=96, note="shipped at 96")
    return out


def test_a_stopped_revise_does_not_unship_a_done_blog():
    """The contract, twice over: a stop after SCORE >= 95 does not un-ship the blog, and a
    topic that already wrote its terminal line keeps that line, its score and its ledger
    entry. This arm used to write `stopped` over a 96 and the CMS gate then refused it
    forever.

    THE CANCELLATION PATH IS WHERE THE BYTE-FOR-BYTE RESTORE STILL LIVES. An answer-driven
    revise now ships its clarified draft whatever it scores, because truth beats score, but a
    stop mid-revise is not a clarified draft: it is a half-applied one, and half-applied is
    what the restore exists to make impossible. So this arm holds, and it holds over the whole
    artifact set."""
    async def scenario():
        with _Roots() as root:
            out = _seed_shipped_blog(root)

            async def hang(*a, **k):
                # The session gets as far as a real one does before the stop lands: it clobbers
                # BOTH artifacts and then dies mid-flight. A hang that touched nothing would let
                # this test pass on a restore that never ran.
                (out / "blog.md").write_text("half revised, scored by nobody", encoding="utf-8")
                (out / "eval.md").write_text("SCORE: 91\nthe verdict on a draft that dies here\n",
                                             encoding="utf-8")
                await asyncio.sleep(10)

            runner._sdk_revise_session = hang
            task = asyncio.create_task(runner.revise_topic("brand", "topic-0"))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            summary = runner._summarize("topic-0", _lines(out))
            check("a stopped revise leaves the shipped blog done",
                  summary["status"] == "done", f"got {summary}")
            check("a stopped revise leaves the shipped score intact",
                  summary["score"] == 96, f"got {summary}")
            check("a stopped revise restores the original draft byte for byte",
                  (out / "blog.md").read_text(encoding="utf-8") == "the draft that scored 96",
                  f"got {(out / 'blog.md').read_text(encoding='utf-8')!r}")
            # The other half of the artifact set. The restore returns what the score DESCRIBED,
            # and the 96 describes a draft and the eval that graded it. Give back the draft alone
            # and the blog ships a 96 next to an eval.md reading SCORE: 91 about bytes that were
            # thrown away, so the trail says one thing and the artifact says another.
            check("a stopped revise restores the eval that graded the original",
                  (out / "eval.md").read_text(encoding="utf-8")
                  == "SCORE: 96\nthe verdict on the draft that scored 96\n",
                  f"got {(out / 'eval.md').read_text(encoding='utf-8')!r}")

    asyncio.run(scenario())


def test_a_crashed_revise_does_not_fail_a_done_blog():
    """Same shape, the sibling arm: a bookkeeping crash on a revise must never turn a shipped
    blog into a failure."""
    async def scenario():
        with _Roots() as root:
            out = _seed_shipped_blog(root)

            async def boom(*a, **k):
                raise RuntimeError("the revise session died")

            runner._sdk_revise_session = boom
            try:
                await runner.revise_topic("brand", "topic-0")
            except RuntimeError:
                pass

            summary = runner._summarize("topic-0", _lines(out))
            check("a crashed revise leaves the shipped blog done",
                  summary["status"] == "done", f"got {summary}")
            check("a crashed revise leaves the shipped score intact",
                  summary["score"] == 96, f"got {summary}")

    asyncio.run(scenario())


def _seed_answered_form(out, slug, iteration=1):
    """A questions.json the operator has ALREADY answered, at the blog's current iteration.

    Iteration-matched on purpose: that is what makes the form pass the staleness gate, and a form
    that passes the staleness gate is a form that can hold the blog.
    """
    (out / "questions.json").write_text(json.dumps({
        "slug": slug, "iter": iteration, "score": 96,
        "questions": [{"id": "q1", "question": "Does Deccan Herald carry the 33 percent claim?",
                       "why": "C21 rests on it", "area": "Sourcing"}],
    }), encoding="utf-8")
    (out / "answers.json").write_text(json.dumps({
        "slug": slug, "iter": iteration, "score_when_asked": 96,
        "answers": [{"id": "q1", "question": "Does Deccan Herald carry the 33 percent claim?",
                     "answer": "No, it does not. Cut the claim."}],
    }), encoding="utf-8")


def test_a_crashed_revise_does_not_leave_a_spent_form_holding_the_blog():
    """A BLOG WITH NO EXIT is what this arm forbids, and it is the dead end the needs_review
    definition exists to outlaw.

    Questions now hold a blog at ANY score, so a spent form is no longer harmless paperwork.
    The operator answers a 96, the surgical revise crashes before clear_questions runs, and the
    form stays on disk: iteration-matched, so not stale, so 'current', so the resolver holds the
    blog AGAIN. Meanwhile the app refuses a second submit, because the form is already answered.
    Nobody can answer it and nothing can ship it.

    Both halves of the fix are pinned here. An ANSWERED form summons nobody, so it groups with
    none and stale rather than reading as 'current'. And clearing the spent form happens in a
    finally-arm, so a revise that dies on its way out cannot leave one behind at all.
    """
    async def scenario():
        with _Roots() as root:
            out = _seed_shipped_blog(root)
            _seed_answered_form(out, "topic-0")

            check("an answered form does not read as current",
                  runner._questions_state("brand", "topic-0") == "answered",
                  f"got {runner._questions_state('brand', 'topic-0')!r}")

            status, _ = runner._resolve_needs_review("brand", "topic-0", 96)
            check("an answered form never holds a blog that passed",
                  status == "done", f"got {status}")

            async def boom(*a, **k):
                raise RuntimeError("the revise session died after the operator answered")

            runner._sdk_revise_session = boom
            try:
                await runner.revise_topic("brand", "topic-0")
            except RuntimeError:
                pass

            check("a crashed revise clears the form it spent",
                  not (out / "questions.json").is_file())
            # answers.json is the durable record of what the operator said and is NOT cleared:
            # losing it would leave a cut claim with nothing on disk explaining who cut it.
            check("a crashed revise keeps the answers as the record",
                  (out / "answers.json").is_file())

    asyncio.run(scenario())


def test_a_stopped_revise_on_an_unfinished_topic_is_stopped():
    """The other half of the same rule: with no verdict to keep, `stopped` is the honest word,
    and the line still has to exist or the revise's own SSE stream never closes."""
    async def scenario():
        with _Roots():
            out = runner.output_dir("brand", "topic-0")
            out.mkdir(parents=True, exist_ok=True)
            (out / "blog.md").write_text("a draft nobody scored", encoding="utf-8")

            async def hang(*a, **k):
                await asyncio.sleep(10)

            runner._sdk_revise_session = hang
            task = asyncio.create_task(runner.revise_topic("brand", "topic-0"))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            terminals = _terminals(out)
            check("a revise stopped on a topic with no verdict reports stopped",
                  len(terminals) == 1 and terminals[0]["status"] == "stopped", f"got {terminals}")

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# _stop_line_if_unterminated: the question-form carve-out
#
# The tests above reach the write site through revise_topic and run_batch, which is the right
# way to pin the guard but the wrong way to pin the carve-out: a cancellation only ever gets a
# topic into ONE of the four form states, so the boundaries the contract calls "the rule" would
# go untested. These four call the write site DIRECTLY with a form seeded into each state in
# turn, because the arms are what the wording in CLAUDE.md is about and a carve-out whose
# boundaries are prose is a carve-out that drifts.
# ---------------------------------------------------------------------------

def _seed_current_form(out, slug, iteration=1):
    """An UNANSWERED, iteration-matched form: the one state that holds a blog.

    The mirror image of _seed_answered_form above, and the difference is the whole carve-out:
    no answers.json beside it, so nobody has been summoned yet and the summons is still live.
    """
    (out / "questions.json").write_text(json.dumps({
        "slug": slug, "iter": iteration, "score": 96,
        "questions": [{"id": "q1", "question": "Does Deccan Herald carry the 33 percent claim?",
                       "why": "C21 rests on it", "area": "Sourcing"}],
    }), encoding="utf-8")


def _seed_unterminated(out, slug, iteration=1):
    """A topic mid-flight: a running line and no terminal one. That gap IS the stop window."""
    _append(out, slug, status="running", note="evaluating", iter=iteration)


def test_a_stop_on_a_current_form_is_held_for_the_answer():
    """THE CARVE-OUT ITSELF, and nothing else in this file reached it.

    The evaluator wrote the form and the lead had not yet appended its terminal line, so the stop
    lands in the gap every asking topic spends real time inside. Recording `stopped` there leaves
    a topic api_answers still ACCEPTS an answer for, on a status whose admin bench is empty, so
    the form is live and no surface offers the door to it: the dead end with no door, reached from
    the form's side instead of the status's.
    """
    with _Roots():
        out = runner.output_dir("brand", "topic-0")
        out.mkdir(parents=True, exist_ok=True)
        (out / "blog.md").write_text("a draft the evaluator asked about", encoding="utf-8")
        _seed_unterminated(out, "topic-0")
        _seed_current_form(out, "topic-0")

        check("an unanswered iteration-matched form reads as current",
              runner._questions_state("brand", "topic-0") == "current",
              f"got {runner._questions_state('brand', 'topic-0')!r}")

        wrote = runner._stop_line_if_unterminated(
            "brand", "topic-0", out, 0, "the operator stopped this brand")
        terminals = _terminals(out)

        check("a stop with no verdict on the topic writes its terminal line", wrote is True)
        check("exactly one terminal line, as on every other stop path",
              len(terminals) == 1, f"got {terminals}")
        check("a stop landing on a live form is held, not stopped",
              terminals and terminals[0]["status"] == "needs_review", f"got {terminals}")
        check("the NEEDS_REVIEW marker is written beside the hold",
              (out / "NEEDS_REVIEW").is_file())
        check("no score is invented for a loop that never finished",
              runner._summarize("topic-0", _lines(out))["score"] is None)


def test_a_stop_with_no_form_is_stopped():
    """The ordinary stop, pinned at the write site so the carve-out has a floor.

    Nobody was asked anything, so `stopped` is the honest word and no marker is written. The
    marker assertion is the load-bearing half: a NEEDS_REVIEW file left beside a stopped topic
    is the app disagreeing with itself on disk.
    """
    with _Roots():
        out = runner.output_dir("brand", "topic-1")
        out.mkdir(parents=True, exist_ok=True)
        _seed_unterminated(out, "topic-1")

        runner._stop_line_if_unterminated(
            "brand", "topic-1", out, 0, "the operator stopped this brand")
        terminals = _terminals(out)

        check("a stop with nothing to answer is stopped",
              len(terminals) == 1 and terminals[0]["status"] == "stopped", f"got {terminals}")
        check("no NEEDS_REVIEW marker on the ordinary stop arm",
              not (out / "NEEDS_REVIEW").is_file())


def test_a_stop_on_a_stale_form_is_stopped():
    """A BOUNDARY, and the one the Ship criteria wording had to be narrowed to exclude.

    The form asks about iteration 1 while the blog moved to iteration 2, so api_answers refuses
    the submit outright. Holding here summons a person the app will then turn away, which is the
    same dead end the carve-out exists to prevent, arrived at by being too generous.
    """
    with _Roots():
        out = runner.output_dir("brand", "topic-2")
        out.mkdir(parents=True, exist_ok=True)
        _seed_unterminated(out, "topic-2", iteration=2)
        _seed_current_form(out, "topic-2", iteration=1)

        check("a form describing a superseded draft reads as stale",
              runner._questions_state("brand", "topic-2") == "stale",
              f"got {runner._questions_state('brand', 'topic-2')!r}")

        runner._stop_line_if_unterminated(
            "brand", "topic-2", out, 0, "the operator stopped this brand")
        terminals = _terminals(out)

        check("a stop on a form the app refuses is stopped, never held",
              len(terminals) == 1 and terminals[0]["status"] == "stopped", f"got {terminals}")
        check("no NEEDS_REVIEW marker on the stale arm",
              not (out / "NEEDS_REVIEW").is_file())


def test_a_stop_on_an_already_answered_form_is_stopped():
    """The other boundary, and it groups with stale on a DIFFERENT ground worth pinning.

    The app does not refuse an answered form: its answers are recorded and a revise was already
    dispatched for them, so it summons nobody NEW. Holding here would strand the blog behind a
    question that has already been answered once.
    """
    with _Roots():
        out = runner.output_dir("brand", "topic-3")
        out.mkdir(parents=True, exist_ok=True)
        _seed_unterminated(out, "topic-3")
        _seed_answered_form(out, "topic-3")

        check("an answered form does not read as current",
              runner._questions_state("brand", "topic-3") == "answered",
              f"got {runner._questions_state('brand', 'topic-3')!r}")

        runner._stop_line_if_unterminated(
            "brand", "topic-3", out, 0, "the operator stopped this brand")
        terminals = _terminals(out)

        check("a stop on a spent form is stopped, never held a second time",
              len(terminals) == 1 and terminals[0]["status"] == "stopped", f"got {terminals}")
        check("no NEEDS_REVIEW marker on the answered arm",
              not (out / "NEEDS_REVIEW").is_file())


# ---------------------------------------------------------------------------
# facts_gen
# ---------------------------------------------------------------------------

def test_a_stopped_facts_build_leaves_no_hollow_fact_base():
    """The worst of the ten. The session authors canonical-facts.md as it goes, so a stop
    lands on a real file with no do-not-claim list. has_canonical_facts is a bare is_file(),
    so the next Generate SKIPS the build, and preflight only checks existence and
    PLACEHOLDER, neither of which a truncated file trips. Every blog for the brand would then
    inherit a fact base that forbids nothing."""
    async def scenario():
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "canonical-facts.md"
            path.write_text("# Facts\n\n## 1. Entity\n\n## 5. URLs\n", encoding="utf-8")

            facts_gen.facts_path = lambda slug: path

            async def hangs_holding_write(slug):
                await asyncio.sleep(10)

            facts_gen.generate_facts = hangs_holding_write
            task = asyncio.create_task(facts_gen.ensure_facts("brand"))
            await asyncio.sleep(0.05)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

            job = facts_gen.get_job("brand")
            check("a stopped facts build discards the half written fact base",
                  not path.is_file(), "the hollow file survived the stop")
            check("a stopped facts build does not strand the job on running",
                  job and job["state"] != "running", f"job state was {job and job['state']}")
            check("a stopped facts build records why nothing is on disk",
                  job and job["error"], f"job error was {job and job['error']}")

    asyncio.run(scenario())


def main():
    print("stop_check: cancellation paths only. No CLI spawned, no query() called, "
          "no real brand touched.")
    for test in (test_stop_mid_topic_writes_one_stopped_line,
                 test_stop_keeps_a_blog_that_finished_microseconds_earlier,
                 test_a_resumed_topic_is_stoppable_again,
                 test_a_resumed_topic_retries_its_own_dead_session,
                 test_topics_queued_behind_the_semaphore_are_stopped,
                 test_a_run_stopped_while_queued_on_the_client_lock_is_swept,
                 test_the_client_lock_is_released_on_the_cancel_path,
                 test_a_blog_that_shipped_still_reaches_the_ledger,
                 test_a_stopped_blog_never_reaches_the_ledger,
                 test_a_stopped_revise_does_not_unship_a_done_blog,
                 test_a_crashed_revise_does_not_fail_a_done_blog,
                 test_a_crashed_revise_does_not_leave_a_spent_form_holding_the_blog,
                 test_a_stopped_revise_on_an_unfinished_topic_is_stopped,
                 test_a_stop_on_a_current_form_is_held_for_the_answer,
                 test_a_stop_with_no_form_is_stopped,
                 test_a_stop_on_a_stale_form_is_stopped,
                 test_a_stop_on_an_already_answered_form_is_stopped,
                 test_a_stopped_facts_build_leaves_no_hollow_fact_base):
        print(f"\n{test.__name__}")
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("stop_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
