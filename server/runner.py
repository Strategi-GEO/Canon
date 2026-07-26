"""Dispatch, concurrency, and retry for the GEO blog factory.

This module is the ONLY place concurrency lives. The prompt-level orchestrator
is gone: the backend opens one SDK session per blog and the session lead inside
it manages only its own topic. Progress is read exclusively from
clients/<client>/output/<topic_slug>/status.jsonl, never from agent output.

CLI (debugging and the validation step):
  .venv/bin/python -m server.runner --client <slug> --row 0
"""
import argparse
import asyncio
import importlib.util
import json
import logging
import os
import shutil
import sys
import traceback
import uuid
from contextlib import aclosing
from datetime import datetime, timezone
from pathlib import Path

from . import roadmap
from . import db
from . import sync

log = logging.getLogger("geo.runner")

REPO_ROOT = Path(__file__).resolve().parent.parent

# Blog output lives at the repo root, one folder per organisation, NOT inside
# clients/. Operators browse and prune these in Finder, so they get one obvious
# place instead of a path buried under each client's config. The filesystem is
# the source of truth for what exists: deleting a topic folder here removes the
# blog from the app, and frees the topic to be generated again.
OUTPUTS_ROOT = REPO_ROOT / "outputs"


def outputs_root(root=None):
    return Path(root) if root else OUTPUTS_ROOT


def client_output_dir(client_slug, root=None):
    return outputs_root(root) / client_slug


def output_dir(client_slug, topic_slug, root=None):
    return client_output_dir(client_slug, root) / topic_slug


def ensure_client_output_dir(client_slug, root=None):
    """Created at onboarding so an operator sees the folder before the first run."""
    path = client_output_dir(client_slug, root)
    path.mkdir(parents=True, exist_ok=True)
    return path


# Project-scoped stdio MCP config. The CLI reads this itself when
# setting_sources includes "project"; the runner only checks that it is there
# and well formed.
MCP_CONFIG_PATH = REPO_ROOT / ".mcp.json"
MCP_SERVER_NAMES = ("firecrawl", "dataforseo")

# The two concurrency limits, here and NOWHERE else.
# CLIENT_LOCK: one client's queue runs at a time, repo-wide.
# TOPIC_SEMAPHORE: five topics in flight. Every selected topic is dispatched at
# once with asyncio.gather and the semaphore admits five, so topic six starts
# the instant a slot frees, never "batch of five then wait".
# These are in-process primitives, so the deployment MUST run one uvicorn
# worker; --workers N would give N independent semaphores and the cap silently
# becomes 5N.
CLIENT_LOCK = asyncio.Lock()
TOPIC_SEMAPHORE = asyncio.Semaphore(5)

# A topic has stopped moving. "stopped" belongs here for one concrete reason: the SSE stream in
# app.py closes only when every topic's status.jsonl has grown a line whose status is in this set,
# and it never consults the run record. Leave "stopped" out and the operator presses Stop, watches
# /api/runs report the run finished, and watches their own watch view heartbeat at "running"
# forever on a session that is already dead.
#
# "stopped" is NOT a row of the three-state table below, and the ground for that is narrow and
# exact: THE LOOP NEVER RAN, so no score describes the topic. It is emphatically NOT that a
# stopped topic "reached no verdict" while the other three did. needs_review is no longer a
# verdict at all (see below), so that ground would prove nothing. A stopped topic is one whose
# loop was killed mid flight, and every state in the table is resolved from a score the loop
# produced. Feeding a killed run through _resolve_needs_review would launder it into done or
# failed by a number that belongs to a loop which never finished, which is why the resolver never
# sees it and why no score is ever inferred for it.
TERMINAL_STATUSES = {"done", "needs_review", "failed", "stopped"}

# The house ship band, in ONE place. It is the score half of the ship test and NOT the whole of
# it: a blog at or above this ships only when nothing on disk is holding it, because a current
# question holds a blog at ANY score (see _resolve_needs_review). Below it, no draft ships under
# any circumstances. revise_topic and the needs_review enforcement below both branch on it, and a
# second copy of the number is how an engine comes to ship at one threshold and report at another.
SHIP_SCORE = 95


class PreflightError(Exception):
    """canonical-facts.md missing or unreviewed: refuse before any SDK spawn."""


class RunnerConfigError(Exception):
    """Missing runner configuration (MCP env vars): fail loudly at dispatch."""


# ---------------------------------------------------------------------------
# Client config
# ---------------------------------------------------------------------------

def load_client_config(client_slug, clients_root=None):
    """Read clients/<slug>/gates.json, the machine-readable client config the
    gates already consume. Absent means an unconfigured client, so {}. Malformed
    raises: a client whose config cannot be parsed must not quietly inherit
    house defaults, because one of those defaults is "this is a real client".
    """
    root = Path(clients_root) if clients_root else REPO_ROOT / "clients"
    path = root / client_slug / "gates.json"
    if not path.is_file():
        return {}
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise RunnerConfigError(f"malformed gates.json for client {client_slug!r} at {path}: {exc}")
    if not isinstance(config, dict):
        raise RunnerConfigError(f"gates.json for client {client_slug!r} at {path} must be a JSON object")
    return config


def canonical_facts_path(client_slug, clients_root=None):
    """clients/<slug>/canonical-facts.md, defined once, here.

    Preflight reads it, facts_gen writes it, and the run_batch hook asks whether it exists. Three
    readers agreeing on the path by coincidence is three chances to disagree after a move, and the
    one that drifted would either refuse a client whose file is fine or pass one whose file is
    somewhere else.
    """
    root = Path(clients_root) if clients_root else REPO_ROOT / "clients"
    return root / client_slug / "canonical-facts.md"


def has_canonical_facts(client_slug, clients_root=None):
    """Does the file exist at all. Deliberately not "is it any good": see facts_gen.has_facts.

    A DISK read on purpose, even with Supabase as the record: run_batch runs
    sync.materialize_client before this is consulted, and materialization is what makes the
    disk agree with the record, so by the time this answers, the disk answer IS the record's.
    """
    return canonical_facts_path(client_slug, clients_root).is_file()


_STATUS_MODULE = None


def _status_module():
    """Load .claude/status.py by file path: .claude is not a package."""
    global _STATUS_MODULE
    if _STATUS_MODULE is None:
        path = REPO_ROOT / ".claude" / "status.py"
        spec = importlib.util.spec_from_file_location("geo_status", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _STATUS_MODULE = module
    return _STATUS_MODULE


def slugify(topic):
    return roadmap.slugify(topic)


# ---------------------------------------------------------------------------
# In-memory run registry for app.py. One uvicorn worker means exactly one
# process holds both the semaphore and this dict, so in-memory is fine: there
# is no second worker whose registry could drift out of sync.
# ---------------------------------------------------------------------------
RUNS = {}

# The cancel handles, keyed by run_id, and deliberately NOT a field on the RUNS record.
#
# list_runs() below returns the RUNS values RAW and app.py hands them straight to FastAPI as
# {"runs": runner.list_runs()}. An asyncio.Task is not JSON serialisable, so parking one inside a
# RUNS record would 500 /api/runs and take the whole status table down for every client at once,
# to add a field no browser can read. describe.py and roadmap_gen.py solve the same problem with an
# "_"-prefixed key that _public_job strips on the way out; that convention cannot be borrowed here
# because list_runs has no such filter, and a serialisation rule enforced by remembering to filter
# is a rule that survives exactly until the next caller. A separate dict cannot leak by accident.
RUN_TASKS = {}


def register_run_task(run_id, task):
    """Retain the cancel handle for a run's batch task.

    Without this a run is unstoppable: app.py's asyncio.create_task(...) return value was dropped
    on the floor, so nothing in the process could reach the coroutine tree once it was scheduled.
    """
    RUN_TASKS[run_id] = task
    return task


def _discard_run_task(run_id):
    """Drop the handle once the task is settled, from that task's own finally.

    A finished task is a strong reference to its whole coroutine frame, so keeping these past
    completion would grow the dict for the life of the process. Cancellation is the ONLY thing a
    handle is for, and a settled task cannot be cancelled.
    """
    return RUN_TASKS.pop(run_id, None)


def register_run(run_id, client, topics, kind="blog", channel=None):
    """Record a submitted run. It starts QUEUED, never running.

    Registration happens the moment the operator's POST lands, because their own submit has to
    be visible to them immediately. But CLIENT_LOCK admits ONE session repo-wide, so a run can
    sit here for as long as the session ahead of it takes, which for real blogs is many
    minutes. Reporting that as running would tell six operators that work is happening on their
    topics when nothing has started, and the honest answer, "queued behind another session", is
    the one that tells them whether to wait or go do something else.

    `kind` distinguishes a blog run from a repurpose run (server/repurpose.py). It defaults to
    "blog" so every existing caller and every existing reader is unchanged, and it is the ONE
    field blog code keys on to skip repurpose runs: a repurpose run's synthetic topic_slug is
    not a real blog, so app._live_run_slugs excludes it. `channel` is the repurpose target
    ("linkedin"|"medium"), None for a blog.
    """
    RUNS[run_id] = {
        "run_id": run_id,
        "client": client,
        "kind": kind,
        "channel": channel,
        # When the operator pressed Generate. Not when the engine picked the work up: see
        # started_running below. Two different questions, so two different fields.
        "started": datetime.now(timezone.utc).isoformat(),
        "live": True,
        "state": "queued",
        "started_running": None,
        # Which half of a running run this is: "facts" while the fact base is being built, then
        # "topics" once blogs are dispatched. None until the run starts, because a queued run is
        # not in any phase. It is separate from state on purpose: state answers whether the engine
        # picked this run up, and phase answers what it is doing now. A run can sit on "facts" for
        # a long session with no topic having moved, and an operator watching a still status table
        # deserves to know the engine is building the file every one of those blogs will inherit
        # rather than doing nothing.
        "phase": None,
        # When the CURRENT phase began, stamped by mark_phase at each flip. The dashboard's
        # blog-generation clock starts here when phase reads "topics", so the facts build's
        # minutes are never billed to the blogs. None until the run starts, like phase.
        "phase_started": None,
        # Named only when the fact base could not be built. The run's topics carry the same reason
        # into their own status lines; this is the run-level copy, so /api/runs can say why a run
        # produced nothing without every reader parsing five status.jsonl files.
        "error": None,
        "topics": topics,
    }
    return RUNS[run_id]


def mark_running(run_id):
    """Flip a run from queued to running, at the ONE instant it genuinely starts.

    Called immediately after CLIENT_LOCK is acquired, which is the only moment this session
    owns the engine. Anything earlier is a guess, and a guess here is the difference between an
    operator waiting on a live run and an operator waiting on nothing.
    """
    run = RUNS.get(run_id)
    if run is not None:
        run["state"] = "running"
        run["started_running"] = datetime.now(timezone.utc).isoformat()


def mark_phase(run_id, phase):
    """Record which half of the run is happening now: "facts" or "topics".

    Written at the two moments it genuinely changes, never predicted. A run that reported "topics"
    while the fact base was still being built would tell an operator their blogs were in flight
    while nothing had been dispatched, and the whole reason this field exists is that the facts
    phase is a long wait with no per-topic progress to watch.
    """
    run = RUNS.get(run_id)
    if run is not None:
        run["phase"] = phase
        # The instant the phase genuinely changed, same discipline as started_running: stamped
        # at the flip, never predicted. This is what lets the dashboard start a FRESH clock for
        # blog generation instead of billing the facts build's minutes to the blogs.
        run["phase_started"] = datetime.now(timezone.utc).isoformat()


def mark_topic_terminal(run_id, topic_slug):
    """Release ONE topic from a still-live run the moment its session settles.

    app.py's _live_run_slugs counts a live run's topics as in-flight so a second submit for
    the same topic is refused. Before this flag it counted ALL of them, so a topic that
    FAILED at iteration 3 stayed locked until its siblings finished, and the operator could
    not re-select the exact row a failure makes them want to retry. Set on the success and
    failure arms of run_batch's guarded(); never on a stop, because a stop flips the whole
    run's `live` off and every topic releases with it. In-memory on the run record, one
    uvicorn worker, exactly like every other mark_* here.
    """
    run = RUNS.get(run_id)
    if run is None:
        return
    for topic in run.get("topics", []):
        if topic.get("topic_slug") == topic_slug:
            topic["terminal"] = True


def mark_run_error(run_id, reason):
    """Name the reason a run cannot proceed, on the run record itself.

    Only the fact-base failure reaches here. A failed TOPIC is not a failed run: four blogs can
    ship while the fifth dies, and that run's answer lives in each topic's own status.jsonl. A
    missing fact base is different in kind, because it kills every topic for one reason, and
    repeating that reason five times is not the same as stating it once about the run.
    """
    run = RUNS.get(run_id)
    if run is not None:
        run["error"] = str(reason)


def list_runs():
    return list(RUNS.values())


def get_run(run_id):
    return RUNS.get(run_id)


def mark_run_stopped(run_id):
    """Record that the operator ended this run. Not an error: nothing failed, a person decided.

    The reason field is deliberately left alone. It names why a run COULD NOT proceed, and a run
    the operator stopped could have proceeded fine.
    """
    run = RUNS.get(run_id)
    if run is None:
        return None
    run["state"] = "stopped"
    run["live"] = False
    return run


def finish_run(run_id):
    """Settle a run, without ever overwriting the operator's stop.

    The state guard is not defensive coding, it is the ordinary path: _batch_task calls this from
    a finally that runs on EVERY exit including the cancelled one, and the cancel arrives strictly
    after stop_client has already marked the run stopped. Set "finished" unconditionally and the
    operator presses Stop and watches the run they just stopped report "finished" about a second
    later, with no way to tell it apart from one that ran to completion. "live" is still cleared on
    both paths, because a stopped run is just as over as a finished one.
    """
    run = RUNS.get(run_id)
    if run is None:
        return
    run["live"] = False
    if run.get("state") != "stopped":
        run["state"] = "finished"


def stop_client(client_slug):
    """Stop everything for one brand: every live run marked stopped, every handle cancelled.

    Brand scoped, because that is the scope the operator chose. Run scoping would make them press
    it once per run and race their own queue, which for a brand with five queued runs is not a stop
    at all.

    Synchronous ON PURPOSE, and the absence of an await in here is load bearing. Marking and
    cancelling happen in one uninterrupted step, so no run can be marked stopped and then, at an
    await, have its finally fire finish_run before the mark landed. task.cancel() only SCHEDULES
    the CancelledError, so every record is already correct by the time any of it is delivered.

    Idempotent by way of the "live" check: stopping a stopped brand, a finished brand or a brand
    with no runs reports zero and does nothing. The operator double clicking Stop is not an error
    condition, and an endpoint that 409'd the second press would be describing the button.
    """
    stopped = []
    for run_id, run in list(RUNS.items()):
        if run.get("client") != client_slug or not run.get("live"):
            continue
        mark_run_stopped(run_id)
        stopped.append(run_id)

    for run_id in stopped:
        task = RUN_TASKS.get(run_id)
        # A task that finished on its own between the operator's press and this line has nothing
        # to cancel, and its blogs are done and stay done.
        if task is not None and not task.done():
            task.cancel()

    return {"client": client_slug, "runs_stopped": len(stopped), "run_ids": stopped}


# ---------------------------------------------------------------------------
# status.jsonl reading
# ---------------------------------------------------------------------------

def _read_status(out_dir):
    path = Path(out_dir) / "status.jsonl"
    lines = []
    if not path.is_file():
        return lines
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            lines.append(json.loads(raw))
        except json.JSONDecodeError:
            continue
    return lines


def _terminal_line(lines):
    for line in reversed(lines):
        if line.get("status") in TERMINAL_STATUSES:
            return line
    return None


def _status_baseline(out_dir):
    """How many status lines existed when THIS session took over the topic.

    status.jsonl is append-only and OUTLIVES the run that created it, because a stopped or failed
    topic is offered back to the operator to generate again ("Generate again to resume", and the
    roadmap only ever withholds `done` topics). So the file a second run starts against already
    carries the FIRST run's terminal line, and every question worth asking here is about this
    session: did the session just now reach a verdict, or is it dying without one? Asking that of
    the whole file answers with a verdict that belongs to a run which ended hours ago.

    Both readers of this got it wrong the same way, and the bugs were mirror images. The retry
    loop saw the old run's terminal line, broke on attempt 1 without retrying, and reported the
    previous run's status as this run's result. The cancel arm saw the same line, skipped its
    stopped append, and left the SSE stream open forever on the session the operator had just
    killed, which is the exact failure that arm exists to prevent.

    Taken ONCE, at entry, before anything can append: a baseline recomputed later would swallow
    the very lines it is meant to notice.
    """
    return len(_read_status(out_dir))


def _stop_line_if_unterminated(client_slug, topic_slug, out_dir, baseline, note, root=None):
    """Append the terminal line for a topic THIS session left without a verdict.

    THE GUARD IS THE OPERATOR'S PROMISE, IN CODE. "Whichever blogs have been created will be
    kept" fails on one careless append here: a topic can reach done microseconds before the
    cancel lands, status.jsonl is append-only, and _terminal_line reads the LAST terminal line,
    so an unguarded append demotes a blog that shipped, is on disk, and may already be in the
    ledger. Every surface flips together, because they all read that same last line. The contract
    states the invariant plainly: a stop on an already-terminal topic is a no-op, never a second
    terminal line.

    Shared by run_topic (the topic that was mid-session) and run_batch (the topics that never
    got one, either queued behind the semaphore or never dispatched at all because the stop
    landed while the run was still waiting on CLIENT_LOCK or building the fact base). One
    implementation because the guard and the line shape must not drift apart: a second copy is
    how a topic comes to be stopped in one path and demoted in the other.

    THE WORD IS "stopped" UNLESS A CURRENT FORM IS ON DISK, AND THEN IT IS needs_review. That
    second arm closes a dead end with no door on either surface, and it is the one correction
    this function makes to the operator's own act. Two windows produce it, and neither is exotic:

      The evaluator writes questions.json through .claude/questions.py, and the session lead
      appends the terminal line LAST, so every asking topic spends real time carrying a live form
      and no verdict. A stop landing there used to write "stopped" over the form.

      A topic that already ended needs_review is offered back to the operator, because the
      roadmap withholds only done topics. Re-queue it, stop the brand before the semaphore
      admits it, and run_batch's sweep finds a baseline covering the whole existing file, so the
      slice is empty, the guard above does not fire, and the stopped line lands on top of a hold
      that was correct an hour ago.

    WHAT MADE IT A DEAD END RATHER THAN A DEMOTION. The engine still ACCEPTS an answer for that
    form: api_answers refuses a stale form, a live run and an approved article,
    and never once reads the terminal status. No surface offers one. The admin bench is
    adminActions, which grants "answer" to has_questions alone, and blogState maps a stopped
    status to the stopped state, whose bench is empty. clientCanSee is false for stopped, so the
    portal will not render the article either. The article's only remaining exit was a full
    regeneration, which throws away the dossier, the draft and the score the run had already paid
    for, and the operator's stop is documented as keeping exactly those.

    THE QUESTION AXIS NEEDS NO SCORE, WHICH IS WHY IT REACHES A KILLED RUN AND THE THREE-STATE
    TABLE DOES NOT. See TERMINAL_STATUSES: a stopped topic stays out of _resolve_needs_review
    because every row of that table is resolved from a score the loop produced, and a killed loop
    produced none, so passing one through would launder it into done or failed by a number that
    describes a different run. That ground is about the SCORE and it still stands, so this
    function does not call the resolver. A form on disk is not a score: it is a person's
    outstanding task, it was written before the stop, and it is answerable after it. The contract
    line saying an operator stop is "stopped, never needs_review" gives its own ground as "there
    is no question in it", and in this window there demonstrably is one, so the ground fails
    before the rule does. Nothing here manufactures a question on a stop's behalf; the evaluator
    had already asked.

    Returns True when a line was written, so a caller can report what it halted.
    """
    lines = _read_status(out_dir)
    if _terminal_line(lines[baseline:]) is not None:
        return False

    # READ THE FORM BEHIND A GUARD, because no line at all is the worse failure by a wide margin.
    # This runs inside a CancelledError arm, and the whole reason that arm exists is that a topic
    # with no terminal line hangs the SSE stream at running forever on a session the operator
    # already killed. A read that raises must therefore cost the topic its hold, never its line,
    # so a failure falls back to "stopped": that is the honest word for a topic whose form nobody
    # can prove is holding anything. Logged rather than swallowed silently, the same way
    # revise_topic's questions tidy-up reports a form it could not clear.
    #
    # IT IS ALL DISK AND IT STAYS SYNCHRONOUS, which is what makes it safe to call from here at
    # all. _questions_state reads questions.json, answers.json and status.jsonl through
    # server.questions, whose read_questions, read_answers and _current are file reads on every
    # root including None. Nothing here touches the record and nothing here awaits. A coroutine
    # can only be cancelled at an await, so an await added to this arm would be a cancellation
    # point inside the handler for cancellation: the second stop would unwind straight past the
    # append below and the topic would get no terminal line at all, which is the one outcome this
    # whole function exists to prevent.
    try:
        held = _questions_state(client_slug, topic_slug, root=root) == "current"
    except Exception as exc:
        print(f"[runner] could not read the question form for {client_slug}/{topic_slug} while "
              f"stopping it, so it is recorded stopped: {exc}", file=sys.stderr)
        held = False

    # Whatever stage was in flight, kept as-is. A stop is the one terminal line that can land on
    # any stage, so its "end" may have no matching "start"; consumers read the status field and
    # never the stage, which is what makes that harmless. No score is invented on either arm: a
    # topic that never reached a verdict does not get one attributed to it, and a held one is held
    # at whatever score it has or at none, exactly as _resolve_needs_review holds it.
    last = lines[-1] if lines else {}
    status = "stopped"
    if held:
        status = "needs_review"
        note = (
            f"{note}, and questions.json is on disk, asks about the draft that exists, and "
            f"nobody has answered it. A current question holds a blog at any score, so this "
            f"topic is held for that answer rather than recorded stopped: a stopped line would "
            f"leave a form the engine still accepts on a status no surface offers a door for, "
            f"and answering is the cheap exit that keeps the dossier and the draft"
        )
        # The marker goes with the status it marks, exactly as _enforce_terminal_status writes and
        # unlinks it in both directions. Nothing serves it, but a held blog with no marker beside
        # it is the app disagreeing with itself on disk. It is not written on the stopped arm and
        # is not removed there either: a stop deletes nothing, and a stale marker from an earlier
        # run is cleared by the resolver the next time this topic reaches a verdict.
        (Path(out_dir) / "NEEDS_REVIEW").write_text(
            f"The operator stopped this brand and the engine held this topic rather than "
            f"recording it stopped. {note}. See questions.json.\n",
            encoding="utf-8",
        )
    _status_module().append_status(
        str(out_dir), topic_slug,
        stage=last.get("stage", "research"), event="end",
        iter=last.get("iter", 1), status=status, note=note,
    )
    return True


def _restate_verdict_line(out_dir, topic_slug, note):
    """Append the verdict this topic ALREADY carries, again, so a refusal can close an open SSE
    stream without changing a word of what the topic says.

    THE PROBLEM THIS SOLVES HAS TWO WRONG ANSWERS AND THEY FAIL IN OPPOSITE DIRECTIONS. A refusal
    raised outside a try that has no terminal-line arm leaves status.jsonl with no terminal line,
    and _event_stream closes only once every tail has seen one, so the operator watches a topic
    heartbeat at running forever. That is the hang. Appending "failed" instead closes the stream
    and DEMOTES a blog that is on disk, in generated.csv and signed off by the client, which is
    the harm _stop_line_if_unterminated above exists to prevent, reached by a different road.

    Re-stating is the only line that is both terminal and true. The topic's own last terminal
    status, its own score and its own iteration count go back on the feed with the refusal as the
    note, so _terminal_line still reads the verdict it read a second ago and _summarize still
    computes the same three fields, while the tail sees a terminal status and closes. Nothing is
    demoted because nothing changed: only the reason is new.

    NO TERMINAL LINE AT ALL FALLS TO "failed", and that is not a demotion because there is no
    verdict to demote. A topic with nothing terminal on its feed never finished, and a run that
    refused before it started is exactly what "failed" describes.

    iter is the topic's EXISTING count, never one past it, for the reason revise_topic's
    restored_iter gives at length: this line describes bytes the refusal did not touch, so
    claiming a new iteration says the topic advanced to a draft that does not exist, and it would
    push the feed past a questions.json the app then refuses as stale.

    Stage "eval" matches every other terminal line the engine writes for itself, which is what
    keeps _last_eval_score and _summarize reading the score off the same kind of line.
    """
    lines = _read_status(out_dir)
    terminal = _terminal_line(lines)
    summary = _summarize(topic_slug, lines)
    _status_module().append_status(
        str(out_dir), topic_slug,
        stage="eval", event="end",
        iter=summary["iterations"] or 1,
        score=summary["score"],
        status=terminal["status"] if terminal else "failed",
        note=note,
    )
    return terminal


def _summarize(topic_slug, lines):
    """What a topic's status.jsonl adds up to: its status, its score, its iteration count.

    No terminal line means the topic has not finished, which is "running" and not "failed".
    run_topic never reaches that branch: it writes the failed line itself once retries are
    spent, so by the time it summarises, a terminal line always exists. _blog_history is the
    caller that does reach it, because it summarises whatever is on disk at the moment the
    operator loads the page, and Agent W writes blog.md BEFORE Agent E scores it. Defaulting
    to "failed" there declared every blog that was mid-eval a failure, under a banner on the
    same screen saying the run was live, and seconds before the same blog could score 96.
    """
    terminal = _terminal_line(lines)
    score = None
    for line in reversed(lines):
        if line.get("stage") == "eval" and line.get("event") == "end" and line.get("score") is not None:
            score = line["score"]
            break
    iterations = max((line.get("iter", 0) for line in lines), default=0)
    return {
        "topic_slug": topic_slug,
        "status": terminal["status"] if terminal else "running",
        "score": score,
        "iterations": iterations,
    }


# ---------------------------------------------------------------------------
# The three review states, enforced here and nowhere else.
#
# needs_review MEANS "this blog has questions waiting for the operator that are current, on disk,
# and answerable". AT ANY SCORE, and it means NOTHING ELSE. The score does not appear in that
# definition. needs_review is also NOT the loop's verdict any more: a blog held at 96 has a
# verdict and the verdict is SHIP. It is a WORKFLOW STATE, and what it says is that a human owes
# an answer before the shipping draft is the final one.
#
# THREE CASES, three states, and the QUESTION STATE IS CHECKED FIRST. The score is demoted to
# deciding only the branch where there is nothing to answer:
#
#   questions current                      -> needs_review, at ANY score, including no score.
#                                             HELD. A human owes an answer and the file names it.
#   none|stale|unreadable|answered, >= band -> done. It ships.
#   none|stale|unreadable|answered, below   -> failed. The loop exhausted itself with nothing to
#                                             ask, so there is no human task in it.
#
# THE FOUR NON-HOLDING STATES GROUP FOR ONE REASON: each summons NOBODY NEW. A stale form cannot
# be submitted, an unreadable one cannot be rendered, an absent one asked nothing, and an answered
# one has already been answered, so a revise has already been dispatched for exactly those answers
# and there is no second act for a human to perform. A status that demands a human act while
# naming no act the human can perform is a dead end: the app renders "A human has to confirm
# something before this ships" and offers no door. Four of the five blogs sitting on needs_review
# in live data were exactly that.
#
# THE GROUND FOR "answered" IS NOT "the app refuses it", and stating it that way would be a rule
# defended by a claim about the system that the system does not make true: api_answers refuses on
# stale and on a live run, and never consults the answered flag at all. A second submit is in fact
# ACCEPTED, and it is deliberately left accepted, because it is the one door out of a revise that
# died holding an answered form. The reason the form does not HOLD is about the form, not about
# the boundary: the operator has already said their piece, so nothing is waiting on them.
#
# NO SCORE FALLS TO failed, never to a hold. An evaluator that died before writing its scored end
# line asked nobody anything, and a topic with no score and no question is a loop that broke, not
# a person's task. Turning that into a permanent hold summons somebody to a form that does not
# exist. A gates FAIL is failed for the same reason: a machine failure with no question in it.
#
# WHY THE SCORE NO LONGER OVERRIDES A HOLD. The old rule shipped a passing blog over its own open
# questions, and it demonstrably shipped canonical-facts violations doing it: liquid-journey went
# out at 96 publishing a claim its canonical-facts section 9 lists as NOT citable, and ramen went
# out citing a publication date from a source its own record says was never fetched in full. Both
# had a question on disk naming the source and the claim. A question is the evaluator saying the
# draft may be WRONG, and being wrong at 96 is not better than being wrong at 89.
#
# The anecdote that used to defend the old rule here, a blog "held at 96 for a Sourcing top-up
# that had already resolved itself", was FALSE and is deleted rather than softened. That blog is
# the-best-beer-gardens: its questions.json says iteration 1 while the blog finished at iteration
# 2, so the form was STALE and _questions_state resolves it to done under this rule exactly as it
# did under the old one. THE STALENESS GATE KILLED THAT BUG, NOT THE SCORE GATE. Holding a 95
# open until someone answers is now the REQUIRED behaviour, so nothing here is a caution against
# it.
#
# So the ENGINE decides, after the session, by checking the claim against what is on disk. The
# session lead may ask for needs_review; whether it earned it is not the lead's call. A rule
# that lives only in an agent's instructions is a rule that gets talked out of, and this project
# learned that lesson twice in one day.
#
# THE COST, CHOSEN AND NOT DISCOVERED: OPERATOR SILENCE STRANDS THE BLOG. There is no timeout, no
# expiry, and no escalation. An unanswered hold never ships and never enters generated.csv, and it
# waits forever. That is deliberate: every automatic exit from a hold is an exit that ships a
# draft the evaluator flagged as possibly wrong, which is the exact outcome above. The mitigations
# are the ones the contract already carries, the cap of at most 5 questions and the "answerable in
# ten seconds" standard, and they now carry real weight rather than being advice.
# ---------------------------------------------------------------------------

# Why a needs_review claim did not stand, in the plain words the status trail records. Each of
# these is a different way of having no answerable question, which is the only thing the status
# is for.
_NO_QUESTIONS_REASONS = {
    "none": "no questions.json was written, so the status names no act for the human it summons",
    "answered": (
        "questions.json has already been answered and a revise was dispatched for those very "
        "answers, so the operator has already said their piece and the form summons nobody new"
    ),
    "stale": (
        "questions.json asks about an earlier iteration than the draft on disk, so the app "
        "refuses it as stale and the operator cannot submit it"
    ),
    "unreadable": (
        "questions.json cannot be read, so no form can be rendered from it and the operator has "
        "nothing to answer"
    ),
}


def _questions_state(client_slug, topic_slug, root=None):
    """Are there questions on disk that the operator can actually answer right now?

    FOUR VALUES, never a boolean: "current" (a real form, about the draft that exists), "none",
    "stale", "answered", or "unreadable". Only "current" holds a blog. The other four are the
    ways a form on disk summons nobody, and the whole engine reads this one function rather than
    asking its own version of the question.

    Staleness and answeredness are server.questions.is_stale and is_answered and are never
    recomputed here: that module owns both comparisons and the API boundary refuses a submit on
    the same calls, so a second rule here would be a way for the engine to hold a blog open on a
    form the app will not accept.

    THE STALENESS RULE IS VERSION **OR** ITERATION, and this path computes only the iteration
    arm. That is a real asymmetry rather than an oversight, so it is named here with what closes
    it. Migration 014 settled the rule across the four RECORD-side readers, and they are the whole
    set: server/questions.py describe_questions, the dashboard's portal-data.ts fold,
    server/client_answers.py _PENDING_SQL (which asks the complement and so reads "version matches
    AND iteration matches"), and the portal_submit_answers RPC that 014 replaces. Each of them
    reads review_notes, where blog_version_id is NOT NULL with a composite FK to blog_versions, so
    each of them HAS an anchor to compare.

    THIS PATH HAS NO ANCHOR TO COMPARE, and cannot acquire one honestly. The disk form is what
    .claude/questions.py wrote, and its payload is slug, asked, iter, score and questions and
    nothing else; sync.materialize_answers rebuilds it from the record with those same keys and
    drops the anchor too. So the version arm has no left-hand side here.

    WHAT MAKES THE MISSING ARM SAFE ON THIS PATH, which is the part worth reading before anyone
    "fixes" it by reaching for the record. Every runner-facing caller runs against a form that
    describes bytes NO blog_versions row exists for yet: terminal resolution runs strictly before
    sync.commit_topic (see run_topic), the revise finally arm runs before its scheduled commit
    (see _schedule_commit), and the lead's in-loop --check-area runs mid-session with nothing
    committed at all. A version cannot have landed under a draft that has not been committed once,
    so the arm that would fire has nothing to fire on.

    READING THE RECORD HERE WOULD BE WORSE THAN THE GAP. At terminal resolution the newest
    review_notes round is the PREVIOUS round and the newest blog_versions row is the PREVIOUS
    session's, so a comparison drawn from them describes a different form and would rate a live
    one stale. That releases a hold, which is the shipped-past-an-open-question failure this
    resolver exists to prevent, and it is the same race is_stale's own docstring refuses the
    record for. An arm that cannot fire truthfully is worth less than the hole it plugs.

    "answered" EXISTS BECAUSE A SPENT FORM COULD HOLD A BLOG FOREVER. This function read only
    raw["questions"] and is_stale, so it never consulted is_answered: the operator answered a 96,
    the surgical revise then crashed or was stopped before the form was cleared, and the file
    stayed on disk, stayed iteration matched, and read as "current". The resolver held the blog
    again on a form whose answers had already been given, so the hold was waiting on a person who
    had already acted. An answered form groups with none and stale because its answers are on disk
    and a revise has already been dispatched for them, so it summons nobody NEW. It is emphatically
    NOT because the app refuses it: api_answers refuses a stale form and a live run and never
    consults answeredness, so a second submit goes through, and that is the door out of a revise
    that died holding the form. revise_topic's finally arm is the other half of the fix and neither
    half is sufficient alone.

    Imported inside the function, not at module scope: server.questions imports this module, so
    a top-level import would close the cycle at startup, the same way revise_topic dodges it.
    """
    from . import questions as questions_mod

    try:
        raw = questions_mod.read_questions(client_slug, topic_slug, root=root)
    except questions_mod.NoQuestions:
        # Present but corrupt. Not the same event as nobody asking, but identical in what it
        # leaves the operator holding: a form that cannot be rendered cannot be answered.
        return "unreadable"
    if raw is None or not (raw.get("questions") or []):
        return "none"
    if questions_mod.is_stale(raw, client_slug, topic_slug, root=root):
        return "stale"
    if questions_mod.is_answered(raw, client_slug, topic_slug, root=root):
        return "answered"
    return "current"


def _resolve_needs_review(client_slug, topic_slug, score, root=None):
    """Which of the three states this topic actually ends on, and why.

    Returns (status, reason). reason is None ONLY when needs_review stands, because that is the
    one outcome needing no explanation: the questions on disk are the explanation. Otherwise it
    says in plain words why this status and not that one, so a caller can RECORD the engine's
    reasoning instead of silently substituting its own answer for the session's. Every reason
    reads as a whole sentence and starts capitalised, because both callers append it after one.

    THE QUESTION STATE IS CHECKED FIRST, BEFORE THE SCORE, and that order IS the rule rather than
    an implementation detail. A current question HOLDS THE BLOG AT ANY SCORE, including a 96 and
    including no score at all: the score is not grounds to override a hold, because a question is
    the evaluator saying the draft may be WRONG, and a wrong 96 is not better than a wrong 89.
    The old order shipped exactly that, twice, both at 96 and both against canonical-facts.

    THE SCORE THEN DECIDES THE NOTHING-TO-ANSWER BRANCH AND ONLY THAT BRANCH. With no form the
    app will accept, no human is summoned, so at or above SHIP_SCORE the blog ships and below it
    the loop exhausted itself without being able to say what it needed, which is failed rather
    than a review nobody can perform. No score falls here too, and falls to failed: an evaluator
    that died before writing its scored end line must never become a permanent hold. A gates FAIL
    lands here as well, and lands on failed: it is a machine failure with no human question in it.
    """
    state = _questions_state(client_slug, topic_slug, root=root)

    if state == "current":
        return "needs_review", None

    if score is not None and score >= SHIP_SCORE:
        return "done", (
            f"The score of {score} is at or above {SHIP_SCORE} and nothing is holding the blog, "
            f"so it ships: {_NO_QUESTIONS_REASONS[state]}"
        )

    if score is None:
        standing = f"No score was recorded, so nothing reached the {SHIP_SCORE} ship band"
    else:
        standing = f"The score of {score} is below {SHIP_SCORE}"
    return "failed", (
        f"{standing}, and {_NO_QUESTIONS_REASONS[state]}. With nothing for a human to answer, "
        f"the score decides and no human is involved: the loop exhausted itself without being "
        f"able to say what it needed"
    )


def _enforce_terminal_status(client_slug, topic_slug, out_dir, root=None):
    """Check the session's terminal claim against the three states and correct it where it fails.

    Returns the summary of the status the topic actually ends on.

    THE CHECK IS SYMMETRIC ON THE QUESTION AXIS, AND ONLY ON THAT AXIS. Both corrections run off
    _questions_state, in both directions:

      claimed needs_review, nothing current to answer -> corrected to done or failed BY ITS
        SCORE. The lead summoned a human to a form nobody can answer, which is the dead end with
        no door the needs_review definition forbids.
      claimed done or failed, a CURRENT question on disk -> corrected to needs_review. A current
        question holds the blog at ANY score, so a lead that wrote done at 96 over a live form
        shipped a draft its own evaluator said it could not vouch for.

    THE SECOND CORRECTION IS THE WHOLE OF WHAT MAKES THE HOLD REAL. Under the old score-gated
    rule it was inert, because a passing score shipped the blog regardless and there was nothing
    for a question to hold. Now that questions hold at any score, a done claim over a current
    form is the entire exposure: the done line stands, _summarize reports done, and the blog is
    ledgered. Without this arm the new rule would live only in an agent's instructions, and a
    rule that lives only there is a rule that gets talked out of, which this project learned
    twice in one day.

    THE SCORE CORRECTS NOTHING BY ITSELF, in either direction. A needs_review claimed at 96 with
    a current question STANDS, because a passing score is not grounds to override a hold. A done
    claimed at 88 with nothing to answer also stands: the score decides only the branch a
    needs_review claim falls into, and an engine that re-scored every claim would be a second
    author of the status rather than a check on the first.

    The correction is APPENDED, never a rewrite. _terminal_line reads the LAST terminal line, so
    the new line wins, while the lead's original claim stays visible above it with the engine's
    reason beside it. Silently rewriting an agent's terminal claim would hide the disagreement,
    and the disagreement is the entire reason for checking.
    """
    summary = _summarize(topic_slug, _read_status(out_dir))
    claimed = summary["status"]

    if claimed == "needs_review":
        status, reason = _resolve_needs_review(client_slug, topic_slug, summary["score"],
                                               root=root)
        if reason is None:
            return summary
    elif claimed in ("done", "failed"):
        if _questions_state(client_slug, topic_slug, root=root) != "current":
            return summary
        status = "needs_review"
        reason = (
            f"questions.json is on disk, asks about the draft that exists, and the operator has "
            f"not answered it, so a human owes this blog an answer. A current question holds a "
            f"blog at any score, including one at or above {SHIP_SCORE}: a question is the "
            f"evaluator saying the draft may be wrong, and a wrong 96 is not better than a wrong "
            f"89"
        )
    else:
        # running, or the stopped line the backend writes. Neither is a claim about a loop that
        # reached a verdict, so the three-state table has nothing to say about it. See
        # TERMINAL_STATUSES on why a stopped topic never reaches the resolver.
        #
        # THE TWO EXCLUSIONS HAVE THE SAME SENTENCE ABOVE AND DIFFERENT ANSWERS UNDERNEATH, so
        # the shared sentence is not the whole reason for either. It is right about the SCORE
        # axis for both: neither status carries a verdict, and _resolve_needs_review resolves its
        # nothing-to-answer branch from a score. It says nothing about the QUESTION axis, which
        # needs no score at all, and that is where the two part company.
        #
        # THE EXCLUSION WAS WRONG FOR "stopped" AND IS NOW CLOSED UPSTREAM. A stopped topic can
        # carry a live, answerable form: the evaluator writes questions.json before the lead
        # appends its terminal line, and a stop landing in that window used to record "stopped"
        # over it. The engine still accepts an answer for that form and no surface offers one, so
        # the article's only exit was a full regeneration. It is fixed at the WRITE SITE rather
        # than here, in _stop_line_if_unterminated, and deliberately so: the correction cannot
        # live in this function, because run_topic's cancel arm re-raises immediately after
        # writing that line and never reaches the resolver, and run_batch's sweep writes it for
        # topics run_topic never ran at all. A branch for "stopped" here would read as coverage
        # and never once fire.
        #
        # THE EXCLUSION IS RIGHT FOR "running", AND IT IS NOT THE SAME CASE. A running topic
        # legitimately carries a current form mid-loop: the evaluator asks at iteration 2, the
        # loop still has budget, and the lead deletes the form before the next evaluator. Holding
        # on it would freeze a working topic at an iteration it is about to move past, on a form
        # the next dispatch was going to replace. The hold would also be unanswerable while it
        # lasted, because api_answers refuses a submit while a run is live, and it would be
        # redundant once it ended, because the session's own terminal line then comes through
        # this resolver and the question axis is checked there. Nothing is stranded by waiting: a
        # running topic is one that something is still going to do. A stopped one is one that
        # nothing will ever do again, which is the whole of the difference.
        return summary

    # The marker file goes with the status it marks, in both directions. Nothing serves it (see
    # README), but a NEEDS_REVIEW file sitting beside a blog the engine just shipped is the app
    # disagreeing with itself on disk, and so is a held blog with no marker beside it, which is
    # what every rule in this section exists to stop.
    marker = Path(out_dir) / "NEEDS_REVIEW"
    if status == "needs_review":
        marker.write_text(
            f"The session ended this topic {claimed} and the engine changed it to needs_review. "
            f"{reason}. See questions.json.\n",
            encoding="utf-8",
        )
    else:
        marker.unlink(missing_ok=True)

    _status_module().append_status(
        str(out_dir), topic_slug, stage="eval", event="end",
        iter=summary["iterations"], score=summary["score"], status=status,
        note=f"engine correction: the session ended this topic {claimed} and the engine "
             f"changed it to {status}. {reason}",
    )
    return _summarize(topic_slug, _read_status(out_dir))


# ---------------------------------------------------------------------------
# Real SDK session
# ---------------------------------------------------------------------------

_URL_VARS = {"firecrawl": "FIRECRAWL_MCP_URL", "dataforseo": "DATAFORSEO_MCP_URL"}
_AUTH_VARS = {"firecrawl": "FIRECRAWL_MCP_AUTH", "dataforseo": "DATAFORSEO_MCP_AUTH"}


def _http_mcp_servers():
    """The HTTP transport, or None when no URL var is set. All-or-nothing: half
    the servers configured is a broken setup, not a partial one."""
    present = [name for name in MCP_SERVER_NAMES if os.environ.get(_URL_VARS[name])]
    if not present:
        return None
    servers = {}
    for name in MCP_SERVER_NAMES:
        url = os.environ.get(_URL_VARS[name])
        if not url:
            raise RunnerConfigError(
                f"http MCP transport is half configured: {_URL_VARS[present[0]]} is set but "
                f"{_URL_VARS[name]} is not, so the session would run without {name}"
            )
        config = {"type": "http", "url": url}
        auth = os.environ.get(_AUTH_VARS[name])
        if auth:
            config["headers"] = {"Authorization": auth}
        servers[name] = config
    return servers


def _stdio_mcp_config_ok():
    """Validate .mcp.json shape without spawning anything. Returns False when the
    file is absent; raises when it is present but unusable, because a broken
    project config that the CLI silently ignores is the exact failure this
    function exists to prevent."""
    if not MCP_CONFIG_PATH.is_file():
        return False
    try:
        config = json.loads(MCP_CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise RunnerConfigError(f"{MCP_CONFIG_PATH} is present but unreadable: {exc}")
    servers = config.get("mcpServers") if isinstance(config, dict) else None
    if not isinstance(servers, dict):
        raise RunnerConfigError(f"{MCP_CONFIG_PATH} has no mcpServers object")
    missing = [name for name in MCP_SERVER_NAMES if name not in servers]
    if missing:
        raise RunnerConfigError(
            f"{MCP_CONFIG_PATH} does not declare {', '.join(missing)}; a session without "
            f"those tools would invent sources"
        )
    return True


def _resolve_mcp_servers():
    """Resolve the MCP transport for a real session.

    Two transports, checked in this order:
    1. HTTP: FIRECRAWL_MCP_URL and DATAFORSEO_MCP_URL set. The map is built here
       and handed to the SDK.
    2. stdio: .mcp.json in the repo root. Return {} and let the CLI load the
       project config itself, which it does because setting_sources includes
       "project" and strict_mcp_config stays at its default of False. Setting
       strict_mcp_config True would suppress exactly this file, so the runner
       never touches it.

    Neither available is a loud RunnerConfigError at dispatch, never a silent
    skip: a session without Firecrawl would quietly produce an unsourced blog,
    because an agent with no fetch tool invents sources rather than failing.
    """
    http = _http_mcp_servers()
    if http is not None:
        return http
    if _stdio_mcp_config_ok():
        return {}
    raise RunnerConfigError(
        "real mode has no MCP transport. Either set FIRECRAWL_MCP_URL and DATAFORSEO_MCP_URL "
        f"for the http transport, or provide {MCP_CONFIG_PATH} declaring the firecrawl and "
        f"dataforseo stdio servers"
    )


def check_real_mode_ready():
    """(ok, reason) for the MCP setup, resolved WITHOUT spawning a CLI, an MCP
    server, or an SDK session. Callers use it to refuse a real run at submit
    time instead of twenty minutes in."""
    try:
        servers = _resolve_mcp_servers()
    except RunnerConfigError as exc:
        return False, str(exc)
    if servers:
        return True, "http MCP transport from FIRECRAWL_MCP_URL and DATAFORSEO_MCP_URL"
    return True, f"stdio MCP transport from {MCP_CONFIG_PATH.name}, loaded by the CLI as project config"


def _agent_definitions():
    """Role cards for the three subagents. They point at the contract and the
    skills; they do not copy them, so CLAUDE.md stays the single source."""
    from claude_agent_sdk import AgentDefinition

    researcher = AgentDefinition(
        description="Agent R: source-vetted research for one blog topic. Produces the frozen dossier.",
        prompt=(
            "You are Agent R, the researcher for one GEO blog topic. The dispatching lead gives "
            "you the client slug, topic slug, output dir, and current iteration number: use them "
            "for every path and never guess them.\n"
            "Before anything else read clients/<slug>/client.md, clients/<slug>/canonical-facts.md, "
            "and .claude/skills/geo-research/references/source-vetting.md, every run.\n"
            "Then read the operator's custom instructions, which bind this blog as a MAJOR "
            "priority, ABOVE house style and roadmap guidance but NEVER above canonical-facts.md, "
            "and never as licence to invent a source, statistic, or URL: "
            "clients/<slug>/custom-instructions.md (the brand's standing instructions, may be "
            "empty) and <out_dir>/session-instructions.md (this run's instructions, present only "
            "when the operator gave some). Follow both. When session-instructions.md exists, copy "
            "its text VERBATIM into the dossier under a '## Session instructions (this run)' "
            "heading, so the finished blog carries the instruction it was written under.\n"
            "Run the geo-research skill and write the dossier to <out_dir>/dossier.md. Fetched "
            "full text or it is not a source; search snippets are leads only.\n"
            "Append your own status lines with stage research (event start when you begin, end "
            "when the dossier is written), status running, the given iteration number:\n"
            "  python3 .claude/status.py --out <out_dir> --slug <topic_slug> --stage research "
            "--event start --iter <n>\n"
            "Return exactly one line summarizing the dossier. Your fetch logs and rejected "
            "sources never leave this context."
        ),
        tools=["Read", "Glob", "Grep", "Write", "Skill", "TodoWrite", "Bash(python3:*)",
               "mcp__firecrawl", "mcp__dataforseo"],
    )

    writer = AgentDefinition(
        description="Agent W: drafts or surgically revises blog.md from the frozen dossier, then gates and the link pass.",
        prompt=(
            "You are Agent W, the writer for one GEO blog topic. The dispatching lead gives you "
            "the client slug, topic slug, output dir, and CURRENT ITERATION NUMBER: use them for "
            "every path and every status line.\n"
            "Run the geo-content-writer skill against the FROZEN dossier at <out_dir>/dossier.md. "
            "Never re-research and never invent a citation or URL: a claim with no supporting "
            "source is a Sourcing failure to flag, not to patch.\n"
            "Follow the operator's custom instructions as a MAJOR priority, ABOVE house style and "
            "roadmap guidance and NEVER above canonical-facts.md, and never as licence to invent a "
            "source or URL: clients/<slug>/custom-instructions.md (the brand's standing "
            "instructions, may be empty) and <out_dir>/session-instructions.md (this run's "
            "instructions, present only when given, and still present and still binding on a "
            "revise).\n"
            "On iteration 1 you draft blog.md. On iteration 2 and later you receive the current "
            "blog.md and a fix list: apply ONLY the listed fixes, never rewrite the article, and "
            "never cut an honest negative to save words.\n"
            "After drafting, run: python3 .claude/gates.py --client <slug> <out_dir>/blog.md "
            "until it exits 0 (WARN passes, only FAIL blocks). Then run the link pass per "
            "CLAUDE.md, appending verified URLs to <out_dir>/links-verified.txt and skipping URLs "
            "already listed there.\n"
            "Append your own status lines via python3 .claude/status.py: stage write on iteration "
            "1 or revise on later iterations, then gates, then links, each with event start and "
            "end, status running, the given iteration number.\n"
            "Return only when the draft is gate-clean AND link-clean."
        ),
        tools=["Read", "Glob", "Grep", "Write", "Edit", "Skill", "TodoWrite", "Bash(python3:*)",
               "mcp__firecrawl", "mcp__dataforseo"],
    )

    evaluator = AgentDefinition(
        description="Agent E: hostile audit of blog.md against the rubric. Writes eval.md with SCORE: NN and a routed fix list.",
        prompt=(
            "You are Agent E, a hostile auditor for one GEO blog draft. The dispatching lead "
            "gives you the client slug, topic slug, output dir, and current iteration number.\n"
            "Your inputs are <out_dir>/blog.md, .claude/skills/geo-content-eval/references/"
            "rubric.md, clients/<slug>/canonical-facts.md, clients/<slug>/custom-instructions.md, "
            "<out_dir>/session-instructions.md WHEN IT EXISTS, and <out_dir>/answers.json WHEN ONE "
            "EXISTS, and nothing else. Never read the dossier, the writer's reasoning, or any "
            "prior eval: your isolation is intact, because an operator answer ranks with "
            "canonical-facts.md and above any internal doc, so it is an EXTENSION OF THE FACT "
            "BASE you already read and not the writer's reasoning.\n"
            "The custom instructions (the brand's clients/<slug>/custom-instructions.md and this "
            "run's <out_dir>/session-instructions.md) are operator directives the writer was TOLD "
            "to follow, exactly like the answers: read them so you do NOT mark the draft down for "
            "obeying them. Read this run's instructions from session-instructions.md, never from "
            "the dossier, which stays off-limits. They are NOT sources, they never become a "
            "citation, and they never override canonical-facts.md or a hard gate.\n"
            "READ THE ANSWERS BEFORE YOU SCORE. A negative answer forces the writer to CUT a "
            "claim, and an evaluator that cannot see the answer reads that cut as lost factual "
            "density and scores the draft DOWN for telling the truth. An answer is still NOT a "
            "source: it can never become a citation, and a claim needing one still needs a "
            "fetched source.\n"
            "Run the geo-content-eval skill with HOUSE bands: 95-100 SHIP, below 95 REJECT, no "
            "middle band, and any hard-gate failure is a REJECT regardless of score.\n"
            "Write <out_dir>/eval.md with SCORE: NN on its own line near the top, plus a fix "
            "list where every item carries an Area: Sourcing, Structure, Draft, or Mechanics.\n"
            "You MUST NOT touch blog.md. Do not edit it, fix it, or rewrite a single word of it: "
            "you audit the draft exactly as it stands and report through eval.md only.\n"
            "Append your own status lines via python3 .claude/status.py: stage eval, event start "
            "when you begin and end when eval.md is written, status running, the given iteration "
            "number, and --score NN on the end line."
        ),
        tools=["Read", "Glob", "Grep", "Write", "Skill", "TodoWrite", "Bash(python3:*)"],
    )

    return {"researcher": researcher, "writer": writer, "evaluator": evaluator}


def _lead_prompt(client_slug, row, topic_slug, out_dir):
    prompts = "\n".join(f'- {p}' for p in row.get("prompts", [])) or "- (none provided)"

    # Columns 1, 2 and 5 are found by position. EVERY other column the sheet carries is
    # forwarded here under its own header, because the sheet plans real instructions the writer
    # was never told: a "Comparison anchor" is a different piece from an "FAQ (entity)", and
    # Commercial intent frames differently from Informational. They used to be dropped at the
    # parser and this prompt said so.
    #
    # They are labelled, never positional. Position 3 is "Format" on a generated sheet and
    # "Approx. Volume (IN/mo)" on an operator's, so naming them by position would tell a writer
    # its format was ~1200.
    extras = row.get("extras") or []
    extra_lines = "\n".join(f"- {e['label']}: {e['value']}" for e in extras)
    extra_block = (
        f"""
From the roadmap row, under the sheet's own headers. These are GUIDANCE about the shape of the
piece and the frame of its language, and the writer follows them:
{extra_lines}

None of the above is a fact, a source, or a statistic. A volume or an estimate here shapes which
phrasing an H2 reaches for; it NEVER appears in the draft and it can NEVER be cited. Nothing here
overrides canonical-facts.md.
"""
        if extras
        else ""
    )

    return f"""You are the SESSION LEAD for exactly ONE blog topic. Follow CLAUDE.md, the engine
contract in this repo, exactly. You do not manage a queue and you never launch other blogs.

Client slug: {client_slug}
Topic: {row.get('topic', '')}
Topic slug: {topic_slug}
Output dir: {out_dir}
What the piece covers: {row.get('covers', '')}
Target prompts (BINDING, each answered verbatim somewhere liftable):
{prompts}
{extra_block}
Dispatch researcher -> writer -> evaluator via the Agent tool, in that order. Every
dispatch passes the subagent the client slug, topic slug, output dir, and CURRENT
ITERATION NUMBER, because a fresh writer on iteration 3 has no memory of iterations
1 and 2.

BEFORE EVERY EVALUATOR DISPATCH, including the first, delete any questions.json left
in the output dir:
  python3 -c "import pathlib; pathlib.Path('{out_dir}/questions.json').unlink(missing_ok=True)"
Run it every time, even when you believe no file is there. An evaluator that wants to
ask the operator something writes a fresh questions.json itself, so deleting costs
nothing and the questions on disk always belong to the draft that is being scored
right now. Skipping this is a real bug with a real victim: a file asking about
iteration 1's draft survived a revise, iteration 2's evaluator did not re-ask, and the
operator was left answering questions about an article that no longer existed. Their
answers would then be applied to a different draft, carrying all the authority of a
human answer and none of the relevance.

EVERY WRITER DISPATCH also passes the topic, what the piece covers, the target
prompts, and the roadmap guidance above, ALL VERBATIM. That includes the revise
dispatches on iterations 2, 3 and 4, which is where it is easiest to drop: a fresh
writer has none of this, so anything you do not hand it, it invents. Reaching your
context is not the same as reaching the writer's, and the writer is the agent that
acts on it. Pass the guidance under the same labels the sheet gave it; never rename a
label and never reorder it into a meaning of your own.

Branch on the numeric SCORE from the evaluator (its eval end status line and
eval.md), never on a verdict word. The in-loop branch reads the SCORE plus exactly
ONE property of the form, whether it carries a Sourcing question, and nothing else.
- SCORE >= 95 ENDS THE LOOP. Never re-evaluate a passing draft for any reason,
  including "the draft changed since" or "let me confirm". The terminal STATE is then
  decided by the question check below, not by the score alone: done only when no
  current questions are on disk, needs_review when any are, at any score including 95
  and 96.
- SCORE < 95, and BEFORE you dispatch anything: check the form on disk for a Sourcing
  QUESTION.
    python3 .claude/questions.py --out {out_dir} --slug {topic_slug} --iter <your current iteration> --check-area Sourcing
  --iter is REQUIRED and is the whole staleness guard: pass the iteration the draft
  is actually on, because a form from an earlier iteration describes a draft the blog
  has moved past and must not end anything. Omitting it is a usage error (exit 2), not
  a "no", and exit 2 also means an unusable form, so a failure never reads as absence.
  Exit 0 means a live Sourcing question exists, so THE LOOP ENDS NOW: write the
  terminal status line with status needs_review and STOP. Do not revise, do not
  dispatch another evaluator, and do NOT delete questions.json, because that form is
  the operator's only door and deleting it strands the blog. Exit 1 means no live
  Sourcing question, so continue to the revise below.
  The reason: Sourcing is the ONE area no rewrite can close, which this contract
  already says in its own words, "the writer has no authority to invent a citation or
  URL". A Sourcing QUESTION names a fact only a person has, so iterating past one
  spends research and revise budget rediscovering something the evaluator already knew
  was terminal. The live proof: the date-night blog filed Sourcing questions at
  iteration 1, ran a bounded research top-up and two full revises, and landed at
  iteration 3 on FOUR Sourcing questions about claims no rewrite could ever have
  fixed. Three iterations bought nothing.
  A question of area Structure, Draft or Mechanics does NOT end the loop. It is
  superseded by the next iteration's form exactly as before, and you delete
  questions.json before the next evaluator exactly as before.
- SCORE < 95 with no live Sourcing question: dispatch a FRESH writer with only the
  frozen dossier, the current blog.md, and the fix list, at iteration n+1, then a
  FRESH evaluator. Route fixes by Area: Sourcing goes to a bounded researcher top-up
  for that one claim, never to the writer alone; Structure, Draft, and Mechanics go to
  the writer.
  A Sourcing FIX-LIST ITEM is NOT a Sourcing QUESTION, and conflating them is the one
  mistake to avoid here. A fix-list item still routes to a bounded researcher top-up
  and still does NOT end the loop; that routing is unchanged and it works, because
  date-night's iteration 2 top-up sourced three Sourcing fix-list items successfully.
  A fix-list item says "a machine can find this source". A question says "only a
  person holds this fact". Same area word, opposite implications for the loop.
- Cap at 4 iterations, stop early after two consecutive no-gain iterations, and stop
  immediately on a live Sourcing question per the branch above.
- ONCE ANY ITERATION SCORES ABOVE 90, THE LOOP ONLY CLIMBS. From then on continue only
  while each new score is STRICTLY HIGHER than the best so far; the first iteration that
  fails to beat the best ends the loop, and the best draft is the result. A draft above 90
  is close, and another revise is as likely to break it as to lift it, so a non-gain there
  is a reason to stop and keep what you have, not to spend another iteration. (Below 90 the
  ordinary rules above run unchanged.) A score of 95 or higher still ends the loop at once.
- KEEPING THE BEST-SCORING DRAFT IS NOW ENFORCED BY THE ENGINE, not by you. The backend
  snapshots each new high and, once the loop ends, restores the highest-scoring draft as
  blog.md and eval.md and reports its score. You do not hand-restore an earlier draft and
  you never need to; write each iteration normally and let the loop rules above decide when
  to stop. This is the one elective-loop rule the engine can enforce, and it does.

needs_review MEANS "this blog has questions waiting for the operator that are current,
on disk, and answerable". AT ANY SCORE, and it means nothing else. The score is not
part of that definition. There are exactly three terminal states, and THE QUESTIONS
ARE CHECKED FIRST:
- At least one live question the evaluator asked through .claude/questions.py at the
  CURRENT iteration: needs_review, at ANY score, INCLUDING 95 and 96. A question is
  you saying the draft may be WRONG, and a wrong 96 is not better than a wrong 89, so
  a passing score never overrides a hold. Answering is a DEMAND, never an offer, and
  there is no dismiss and no proceed-anyway at any score.
- Nothing current to answer, score >= 95: done. It SHIPS.
- Nothing current to answer, score < 95 or no score at all: failed. The loop
  exhausted itself and cannot say what it needs, so there is no human task in it. A
  gates FAIL is failed for the same reason: there is no question in it.

Your SCORE >= 95 branch above is FINAL AND TERMINAL ONLY WHEN NO CURRENT QUESTIONS ARE
ON DISK. That is the one narrowing of the rule, and everything else about it stands:
you never re-evaluate a passing draft because "the draft changed", "eval.md and
blog.md are inconsistent", "the run was stopped and restarted", or "let me confirm".

A Sourcing top-up, or a claim whose source may not support it, is a QUESTION, and the
evaluator asks it naming the source and the claim; unasked, it is not a status.

The Sourcing-question stop above is a LEAD INSTRUCTION, and the engine CANNOT enforce
it, because the loop runs inside this session and the backend cannot reach into it to
stop a revise. That is a real departure from this contract's "the check is in Python
where nothing can argue with it" principle, so it is named here rather than papered
over. IT FAILS IN BOTH DIRECTIONS AND THEY ARE NOT SYMMETRIC. IGNORING it costs money,
not correctness: you burn iterations, then terminal resolution still holds the blog in
Python, so you cannot ship one you should have held. OVER-APPLYING it costs a good
blog: end the loop on a stale or another topic's form and you write needs_review with
iterations unspent, then terminal resolution reads that same form as non-holding and
corrects the topic to failed by its score, so a draft that could have reached 95 dies
instead. Pass --iter, every time. It is the whole of what closes that direction.

The engine checks all of this after your session ends and corrects a needs_review that
was not earned, recording the override against your terminal line. Claiming
needs_review with nothing on disk to answer does not hold the blog: it just puts your
claim and the engine's correction in the same trail. Claiming done over a current
question does not ship it either.

Absolute rules:
- Never write or edit the blog yourself.
- Never read dossiers or drafts into your own context.
- Each agent appends its own status lines. You write ONLY the terminal status
  line, exactly once, last, keeping the stage of the final step (normally eval):
  python3 .claude/status.py --out {out_dir} --slug {topic_slug} --stage eval \\
      --event end --iter <n> --score <final score> --status <done|needs_review|failed> \\
      --note "<one line>"
"""


def _session_options():
    """Build the exact ClaudeAgentOptions a real session runs with. Separate from
    _sdk_session so tests/config_check.py can assert on it without spawning a CLI
    or calling query()."""
    from claude_agent_sdk import ClaudeAgentOptions

    budget = os.environ.get("GEO_MAX_BUDGET_USD")
    return ClaudeAgentOptions(
        # Resolved from __file__, never os.getcwd(): the server may be started
        # from anywhere and CLAUDE.md must still load from the repo.
        cwd=str(REPO_ROOT),
        setting_sources=["project"],  # explicit, or CLAUDE.md never loads
        permission_mode="acceptEdits",
        # MUST include "Agent" and "Skill" or subagents never spawn and the
        # skills never run.
        #
        # This is the skip-the-prompt list, NOT a sandbox, and the Bash entries in
        # particular do not mean what they look like. `Bash(python3:*)` does not
        # confine the session to python3: it means python3 runs unprompted, while
        # any other command would need an approval that, under acceptEdits with no
        # human present, it effectively gets anyway. A sibling session proved it by
        # running jq and rm with no Bash entry on its list at all. The option that
        # actually denies is `disallowed_tools`, and nothing here is on it.
        #
        # Left as is deliberately: gates.py and status.py are python3, so those are
        # the calls worth naming, and a session that already holds Write and Edit
        # over the repo gains nothing it did not have from a shell. Anyone tightening
        # this must use disallowed_tools; adding entries here only changes what gets
        # prompted for.
        allowed_tools=[
            "Agent", "Skill", "Read", "Write", "Edit", "Glob", "Grep", "TodoWrite",
            "Bash(python3:*)", "Bash(python:*)", "mcp__firecrawl", "mcp__dataforseo",
        ],
        # {} means the CLI loads .mcp.json itself as project config. See
        # _resolve_mcp_servers: strict_mcp_config is deliberately left at its
        # default so that file is not suppressed.
        mcp_servers=_resolve_mcp_servers(),
        agents=_agent_definitions(),
        max_turns=int(os.environ.get("GEO_MAX_TURNS", "250")),
        max_budget_usd=float(budget) if budget else None,
        model=os.environ.get("GEO_MODEL") or None,
        # The CLI subprocess needs PATH (claude and npx must resolve) and every
        # MCP credential named by ${VAR} in .mcp.json. db.agent_env() is the
        # ALLOWLIST of what may cross: this session runs Bash under acceptEdits,
        # so any env var in this process is an env var an agent can read, and
        # the Supabase credentials must never be among them.
        env=db.agent_env(),
    )


async def _sdk_session(client_slug, row, topic_slug, out_dir):
    """One blog, one real SDK session. One session per BLOG, never per batch:
    a batch is a barrier where five blogs wait for the slowest, the revise loop
    runs 0 to 4 iterations so per-blog variance is huge, and one dead blog
    exits its own process without touching the other four."""
    from claude_agent_sdk import query

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    options = _session_options()

    # aclosing, rather than a bare `async for` over the call. query() is an async generator
    # driving a Node subprocess, and its own cleanup (closing the transport) lives in the
    # generator's finally. On the cancellation path a plain `async for` leaves that finally to
    # whenever the generator is garbage collected, which is not a guarantee of anything: the CLI
    # child can outlive the run as an orphan, still holding its MCP servers and still spending the
    # operator's PERSONAL subscription quota after they pressed Stop. Paying for a session someone
    # already cancelled is the one outcome a stop button cannot have. aclosing turns that into a
    # deterministic aclose() at the exact moment the frame unwinds. It is stdlib from 3.10 and this
    # repo runs 3.14.
    #
    # This closes the generator; it does not by itself guarantee the child is reaped. The SDK's own
    # transport close notes that a raw task.cancel() can skip its terminate-then-kill escalation,
    # so a stubborn child may still need the SDK's atexit reaper. Closing deterministically is
    # strictly better than not, and the remaining gap is the SDK's to shut.
    try:
        async with aclosing(query(prompt=_lead_prompt(client_slug, row, topic_slug, out_dir),
                                  options=options)) as session:
            async for _message in session:
                # Consume and DISCARD every message: the orchestrator records
                # outcomes from status.jsonl and never reads agent output into its
                # own context.
                pass
    except ClaudeSDKError as exc:
        # A dead CLI process is a died session, not a runner crash. Return and
        # let the caller's died-session logic write the terminal line or retry.
        print(f"[runner] SDK session for {topic_slug} died: {exc}", file=sys.stderr)
        return


# ---------------------------------------------------------------------------
# Supabase sync hooks: materialize scratch from the record before a session,
# commit scratch to the record after the terminal line.
#
# THE GUARD, IN ONE RULE: if db.client_id(slug) returns None, the record does
# not know this client, so there is nothing to lay down and nothing to push,
# and every hook here skips with a debug log. The guard lives HERE, not in
# sync.py, because it is a runner concern: the tests drive run_batch, run_topic
# and revise_topic with OUTPUTS_ROOT pointed at temp dirs and brands the record
# has never heard of, and those runs must stay inert against the live database
# while a real client's hooks stay loud.
# ---------------------------------------------------------------------------

# Strong references to in-flight commit tasks, mirroring _PENDING_NOTIFIES
# below and for the same reason: asyncio keeps only a WEAK set of tasks, so a
# fire-and-forget commit with no other owner can be garbage collected
# mid-write, losing exactly the record push it exists to make.
_PENDING_COMMITS = set()


def _materialize_client_scratch(client_slug):
    """Lay clients/<slug>/ down from the record, before the facts phase.

    Sync body on purpose: run_batch runs it via asyncio.to_thread. A failure for a KNOWN
    client raises to the caller, never swallowed, because a session spawned over scratch the
    record could not lay down would read facts the record no longer holds.
    """
    if db.client_id(client_slug) is None:
        log.debug("materialize skipped for %s: the record does not know this client, "
                  "so there is nothing to lay down", client_slug)
        return
    sync.materialize_client(client_slug)


def _materialize_topic_scratch(client_slug, topic_slug, answers=False):
    """Re-lay one topic's committed artifacts (dossier, blog, links) before its session.

    Existing scratch is left alone and status.jsonl is never touched, so every baseline taken
    before this call still counts only what the coming session appends. answers=True
    additionally rebuilds questions.json and answers.json from the record, which the
    answer-driven revise needs on disk before its snapshot.

    THE CLIENT SCRATCH IS RE-LAID HERE TOO, not only at batch start. The answer-driven revise
    reaches this function without passing run_batch's own _materialize_client_scratch call, and
    its writer reads clients/<slug>/custom-instructions.md as a MAJOR-priority directive. A
    brand instruction added after the last generate (the Add-to-brand-instructions button, a
    Settings edit) must bind the very next revise, and it lives in the record, so the disk is
    refreshed from the record before every session, whichever path opens it. Idempotent and
    cheap; run_batch's earlier call simply makes this one a no-op rewrite of the same bytes.
    """
    if db.client_id(client_slug) is None:
        log.debug("materialize skipped for %s/%s: the record does not know this client, "
                  "so there is nothing to lay down", client_slug, topic_slug)
        return
    sync.materialize_client(client_slug)
    sync.materialize_topic(client_slug, topic_slug)
    if answers:
        sync.materialize_answers(client_slug, topic_slug)


def _commit_topic_record(client_slug, topic_slug):
    """Push one topic's scratch to the record. NEVER raises into the run.

    A commit failure strands scratch on disk, and the startup reconciler
    (sync.reconcile_all, owned by app.py) is the DESIGNED recovery for exactly that window,
    so the failure is logged loudly and the run moves on: raising here would fail a blog the
    engine already finished over bookkeeping the next startup repairs anyway.
    """
    try:
        if db.client_id(client_slug) is None:
            log.debug("commit skipped for %s/%s: the record does not know this client, "
                      "so there is nothing to push", client_slug, topic_slug)
            return
        sync.commit_topic(client_slug, topic_slug)
    except Exception:
        log.exception(
            "commit_topic failed for %s/%s: scratch is stranded on disk until the startup "
            "reconciler (sync.reconcile_all) re-commits it", client_slug, topic_slug)


def _approved_refusal(client_slug, topic_slug, act):
    """The locked sentence when the client has approved this topic, or None. SYNC: call via
    asyncio.to_thread, exactly as the materialize and commit helpers above are called.

    THE POINT IS TO REFUSE BEFORE THE SPEND, NOT AT THE COMMIT. Migration 013's trigger
    refuses the blog_versions INSERT, and on this module's paths that INSERT is the very last
    thing a run does: a generate against an approved topic would research, draft, gate, link
    check and evaluate a whole article, burning a full Claude session plus Firecrawl and
    DataForSEO quota, and then die on its commit with a psycopg exception. The migration's own
    header names that outcome and accepts it as the price of having the invariant at all. This
    helper is the cheaper refusal in front of it, and it removes nothing: the trigger still
    stands behind every path, including the ones that never call this.

    blog_edit is imported HERE rather than at module scope because blog_edit imports this
    module, so a top-level import would close the cycle at startup. run_batch dodges the same
    cycle the same way for facts_gen.
    """
    from . import blog_edit
    approved = blog_edit.approved_at(client_slug, topic_slug)
    return None if approved is None else blog_edit.locked_detail(approved, act)


def _schedule_commit(client_slug, topic_slug):
    """Schedule the post-terminal commit as a fire-and-forget background task.

    The exact _PENDING_NOTIFIES pattern: create the task, hold a strong reference, discard on
    completion. NEVER awaited by any caller: the cancel arms schedule this between their
    terminal append and their re-raise, and an await there would break stop_client's
    synchronous mark-then-cancel guarantee and hand CancelledError a second place to land.
    The task body swallows every failure (see _commit_topic_record), so an unawaited task can
    never surface an unretrieved exception at GC.

    Ordering: callers schedule this strictly AFTER the terminal resolver or terminal append
    has read DISK, and the task first runs only when the scheduling coroutine next yields to
    the loop, so a finally arm that tidies questions.json still runs before the commit reads
    the file.
    """
    task = asyncio.ensure_future(asyncio.to_thread(_commit_topic_record, client_slug, topic_slug))
    _PENDING_COMMITS.add(task)
    task.add_done_callback(_PENDING_COMMITS.discard)
    return task


# ---------------------------------------------------------------------------
# Per-topic and per-batch dispatch
# ---------------------------------------------------------------------------

def _write_session_instructions(out_dir, text):
    """Lay this run's session instructions at <out_dir>/session-instructions.md, or clear a
    stale one.

    Deterministic and written from the row every run, so a retry or a resume re-lays THIS run's
    instructions, and a run with none REMOVES a prior run's file rather than letting it leak into
    a blog it was never meant for. The agents read it by path, exactly like answers.json; it is a
    scratch input and is never synced to the record, so the dossier (which Agent R copies it into)
    is what carries it onto a surface the dashboard can read.
    """
    path = out_dir / "session-instructions.md"
    text = (text or "").strip()
    if text:
        path.write_text(text + "\n", encoding="utf-8")
    else:
        path.unlink(missing_ok=True)


async def run_topic(client_slug, row, *, run_dir_root=None, precheck_error=None):
    """One blog, one SDK session, plus the died-session safety net.

    precheck_error carries a batch-level refusal (canonical-facts drafting failed) down to
    the per-topic failure path, so every topic still gets its terminal failed line naming
    the real reason instead of the generic missing-file one.
    """
    topic_slug = row.get("topic_slug") or slugify(row.get("topic", ""))
    if not topic_slug:
        raise ValueError("row has no topic to slugify")

    # Two separate roots now: client CONFIG lives under clients/, blog OUTPUT
    # under outputs/. run_dir_root overrides the output root only, which is what
    # tests point somewhere disposable.
    clients_root = REPO_ROOT / "clients"
    out_dir = output_dir(client_slug, topic_slug, root=run_dir_root)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Taken TWICE, and both takes are load-bearing. This first take is what the
    # cancel arm sees if a stop lands inside the materialize await below: for
    # existing scratch it counts exactly the prior runs' lines, so a resumed
    # topic stopped a second time still gets its own terminal line in its own
    # SSE window. The second take, after materialization, covers re-laid
    # scratch, where the file may have grown by the record's whole history.
    baseline = _status_baseline(out_dir)

    # THE APPROVED LOCK, BEFORE THE TRY AND BEFORE ANY AGENT IS SPAWNED.
    #
    # OUTSIDE the try DELIBERATELY, which is the opposite of where every other refusal in this
    # function sits, so the reason has to be stated. The PreflightError arm below appends a
    # terminal FAILED line. An approved topic already carries a terminal line and it says done:
    # approval can only follow a send, a send can only follow a ship. Appending failed over it
    # demotes a blog that is sitting in generated.csv, has been signed off by the client, and
    # is waiting on nothing but its CMS push. This module already documents that harm at length
    # in revise_topic's arms, where one word demoted a finished blog everywhere at once and left
    # the operator no door. A refusal must not do to the record what it exists to prevent.
    #
    # THE COST OF STAYING OUTSIDE IS AN SSE STREAM THAT NEVER CLOSES, AND IT IS PAID HERE RATHER
    # THAN ARGUED AWAY. An earlier version of this block claimed no watch view could hang on this
    # refusal, because a watch view exists only for a REGISTERED run and api_generate refuses an
    # approved topic before register_run, so anything reaching this line had bypassed the route.
    # THAT ARGUMENT IS WRONG. api_generate checks the approval, THEN registers the run, and the
    # batch task only reaches this line later, so an approval landing in that window passes the
    # route's check and arrives here with the run already registered and its stream already open.
    # Two engines share one record and the portal is the other writer, so a client approving mid
    # window is ordinary rather than exotic. With no terminal line appended, _event_stream's
    # completion test never passes and the operator watches a topic heartbeat at running forever,
    # on a run that refused before it spawned anything.
    #
    # SO THE VERDICT IS RE-STATED, NOT REPLACED. _restate_verdict_line appends the status this
    # topic already carries, which for an approved topic is the done it earned, with its own score
    # and iteration count and this refusal as the note. The tail reads the status field, so the
    # stream closes; _terminal_line reads the last terminal line, so every surface still reads the
    # verdict it read a second ago. Writing failed here is the demotion the paragraph above
    # forbids and writing nothing is the hang, which leaves re-stating as the only terminal line
    # that is also true.
    #
    # CALLED SYNCHRONOUSLY, NOT THROUGH asyncio.to_thread, AND THAT IS THE LOAD-BEARING HALF OF
    # STAYING OUTSIDE THE TRY. A coroutine can only be cancelled at an await, so an await here
    # would be a cancellation point sitting outside the arm that handles cancellation: a stop
    # landing on it would unwind straight past _stop_line_if_unterminated, and the topic would
    # get NO terminal line at all, which is the one outcome that arm exists to prevent. The
    # blocking cost is one indexed SELECT on a pooled connection, in a function that is about
    # to hold a Claude session open for minutes, and the two calls immediately above it
    # (mkdir and _status_baseline) already block the loop on disk for the same reason.
    #
    # THE INVARIANT, stated here as it is stated at revise_topic's copy: NOTHING ON A REFUSAL
    # PATH MAY TOUCH THE DATABASE UNTIL EVERY REFUSAL THAT CAN BE DECIDED WITHOUT IT HAS ALREADY
    # BEEN EVALUATED. This call is the expensive one, because blog_edit.approved_at walks
    # db.topic_id into server/db.py pool() and therefore needs a DATABASE_URL and a database
    # that answers.
    #
    # RUN_TOPIC ALREADY SATISFIES IT, AND THAT IS WORTH SAYING RATHER THAN LEAVING TO BE
    # REDISCOVERED. The only refusal above this line is the empty-slug ValueError, which reads
    # the row and nothing else, and it is correctly first. Everything below is INSIDE the try:
    # precheck_error, the missing canonical-facts.md and the PLACEHOLDER check. Those three are
    # cheap, so the invariant appears to ask for them to be hoisted above this call, and they
    # must NOT be. Their PreflightError arm is what appends the terminal FAILED line a real
    # client reads, and hoisting them out of the try would delete that line for exactly the
    # clients whose runs really did fail preflight. Pulling this call down into the try instead
    # is the same harm from the other side: an approved topic would then get "failed" written
    # over the done it already earned, which is the demotion the paragraphs above spend their
    # length preventing. So run_topic keeps this order.
    #
    # A NEW GUARD GOES ABOVE THIS LINE ONLY IF IT READS DISK OR ARGUMENTS AND NEEDS NO TERMINAL
    # LINE. Anything that reads the record belongs at or below this call.
    refusal = _approved_refusal(client_slug, topic_slug, "a generate run")
    if refusal is not None:
        _restate_verdict_line(
            out_dir, topic_slug,
            f"a generate run was refused before it started: {refusal} This topic keeps the "
            f"verdict it already earned, re-stated here so a watching stream can close",
        )
        raise PreflightError(refusal)

    append_status = _status_module().append_status
    try:
        # LAY THIS TOPIC'S SCRATCH DOWN FROM THE RECORD before the session spawns, and BEFORE
        # the baseline: materialization re-lays status.jsonl on reclaimed scratch so disk
        # ordinals continue the record's, which means the file can grow here, and a baseline
        # taken earlier would count the record's history as this session's lines. A resumed
        # topic finds its frozen dossier, blog.md and links-verified.txt exactly as the record
        # holds them; existing scratch is left alone. Skipped when the record
        # does not know the client (see _materialize_topic_scratch). A failure for a known
        # client falls to the generic handler below and writes the terminal failed line: a
        # session spawned over scratch the record could not lay down reads the wrong facts.
        await asyncio.to_thread(_materialize_topic_scratch, client_slug, topic_slug)

        # See _status_baseline: this topic may have been run before, and every terminal
        # question below is about THIS session rather than about the file.
        baseline = _status_baseline(out_dir)

        # Clear any best-draft snapshot a PRIOR run left, before this session scores anything.
        # status.py scopes capture to the lines after the last terminal line, which agrees with
        # `baseline` in every graceful flow; only a HARD KILL (SIGKILL, OOM, power loss) leaves a
        # scored loop with no terminal line AND a stale blog.best.md. Without this, a later run
        # whose own peak never beat that stale one would find blog.best.md unrefreshed and
        # _install_best_draft would ship the killed run's foreign draft. Clearing here means the
        # snapshot is always rebuilt from THIS session or absent, so the two scopings can never
        # disagree in a way that installs another run's bytes.
        _clear_best_snapshots(out_dir)

        # Lay this run's session instructions down for the agents to read by path (empty or
        # absent clears any file a prior run left). The brand's standing instructions arrived
        # separately via _materialize_topic_scratch -> materialize_client -> custom-instructions.md.
        _write_session_instructions(out_dir, row.get("session_instructions"))

        # A batch-level refusal is checked BEFORE preflight on purpose. precheck_error is not
        # preflight. Preflight asks whether THIS client's file is fit to write against.
        # precheck_error reports that the barrier ahead of this topic already failed, and a
        # run whose fact base could not be built is dead for every topic in it.
        if precheck_error is not None:
            raise PreflightError(str(precheck_error))

        # Preflight BEFORE any SDK spawn: every blog for the client inherits
        # canonical-facts.md, so an unreviewed one poisons the whole queue
        # silently. Refusing here costs nothing; refusing mid-run costs a blog.
        #
        # The missing branch is a backstop rather than the usual answer: run_batch builds a
        # missing fact base and waits, and refuses the whole run when it cannot. It stays
        # because run_topic is callable on its own, and because a file that vanished between
        # the hook and this line is a reason to stop, not to guess.
        facts = canonical_facts_path(client_slug, clients_root)
        if not facts.is_file():
            raise PreflightError(f"preflight failed for {client_slug}: {facts} is missing")
        if "PLACEHOLDER" in facts.read_text(encoding="utf-8"):
            raise PreflightError(
                f"preflight failed for {client_slug}: canonical-facts.md still contains "
                f"the token PLACEHOLDER and has not been reviewed"
            )

        retries = int(os.environ.get("GEO_RETRIES", "1"))
        attempt = 0
        while True:
            attempt += 1
            if attempt > 1:
                lines = _read_status(out_dir)
                last = lines[-1] if lines else {}
                append_status(
                    str(out_dir), topic_slug,
                    stage=last.get("stage", "research"), event="end",
                    iter=last.get("iter", 1), status="running",
                    note=f"session died without a terminal status; retry {attempt - 1} of "
                         f"{retries} with a fresh SDK session",
                )
            await _sdk_session(client_slug, row, topic_slug, out_dir)

            lines = _read_status(out_dir)
            # Only lines THIS session appended. Over the whole file, a resumed topic finds the
            # PREVIOUS run's terminal line sitting there, breaks on attempt 1, and never retries
            # the dead session this loop exists for; _enforce_terminal_status then returns that
            # old verdict as this run's result, so a topic nobody stopped reports stopped.
            if _terminal_line(lines[baseline:]):
                break
            if attempt > retries:
                # The session died and retries are spent: the lead never wrote its
                # terminal line, so the runner writes the failed one. Consumers
                # detect terminal state from the status field.
                last = lines[-1] if lines else {}
                append_status(
                    str(out_dir), topic_slug,
                    stage=last.get("stage", "research"), event="end",
                    iter=last.get("iter", 1), status="failed",
                    note="session died without writing a terminal status line",
                )
                lines = _read_status(out_dir)
                break
    except asyncio.CancelledError:
        # The operator pressed Stop. This handler is not a nicety: CancelledError inherits from
        # BaseException, so NEITHER handler below it sees a cancel, and without this arm a stopped
        # topic gets the exact treatment those two exist to prevent. No terminal line, so the SSE
        # stream never closes and the operator watches a topic hang at "running" forever, on a
        # session that died the instant they asked it to.
        #
        # The guard lives in _stop_line_if_unterminated, and it is the operator's promise in code:
        # a topic that reached done microseconds before the cancel landed keeps its done. The
        # baseline is what makes the guard read THIS session rather than the file, which matters
        # the moment a stopped topic is generated again: measured over the whole file the guard
        # finds run 1's stopped line, writes nothing for run 2, and hangs run 2's watch view at
        # running forever, which is precisely what this arm exists to prevent.
        _stop_line_if_unterminated(
            client_slug, topic_slug, out_dir, baseline,
            "stopped by the operator before this topic reached a verdict",
            root=run_dir_root,
        )
        # A STOPPED TOPIC COMMITS TOO: the frozen dossier is the expensive half of a blog and
        # the stop contract promises it is kept, so whatever this session left on disk goes to
        # the record. Fire-and-forget, never awaited (see _schedule_commit): stop_client's
        # mark-then-cancel guarantee must not gain an await, and the re-raise below propagates
        # CancelledError exactly as before.
        _schedule_commit(client_slug, topic_slug)
        # NEVER swallow a cancellation. Returning normally here would report this topic to gather
        # as a success, hand the caller a summary of work that did not happen, and leave a task
        # that was asked to cancel claiming it did not, which asyncio is entitled to complain about
        # at loop shutdown. Everything on disk stays exactly where it is: nothing is rolled back and
        # nothing is deleted, so a partial dossier survives and the topic is cheap to resume.
        raise
    except (PreflightError, RunnerConfigError) as exc:
        # A refusal (bad preflight, missing MCP env) raised before or at
        # dispatch would otherwise leave status.jsonl with no terminal line,
        # so the SSE stream never closes and the watch view hangs at queued.
        # CLAUDE.md's Preflight section mandates the terminal failed status
        # with a note naming the reason; write it, then re-raise so run_batch
        # still records the exception.
        append_status(
            str(out_dir), topic_slug,
            stage="research", event="end",
            iter=1, status="failed", note=str(exc),
        )
        # A refused topic commits too: the terminal failed line is a record the
        # dashboard reads, and waiting for the startup reconciler would leave the
        # record lying about this topic until the next restart. Fire-and-forget.
        _schedule_commit(client_slug, topic_slug)
        raise
    except Exception as exc:
        # Anything else: a bug in this module, a bad row, a disk error. Same
        # obligation as a refusal. Without a terminal line the topic is invisible
        # forever: the operator clicks Generate and watches an empty table with
        # nothing to explain it, which is strictly worse than a loud failure.
        # Broad on purpose, and it re-raises, so run_batch still records it.
        traceback.print_exc(file=sys.stderr)
        print(f"[runner] run_topic failed for {client_slug}/{topic_slug}: {exc}",
              file=sys.stderr)
        append_status(
            str(out_dir), topic_slug,
            stage="research", event="end",
            iter=1, status="failed",
            note=f"{type(exc).__name__}: {exc}",
        )
        # A crashed topic commits too, same reasoning as the refusal arm above:
        # the failed line is a record, and partial artifacts (a dossier the crash
        # left behind) are the expensive half the record should keep.
        _schedule_commit(client_slug, topic_slug)
        raise

    # Ship the highest-scoring draft, not whichever the loop edited last. This runs BEFORE the
    # resolver, so the score it reports and the status it resolves both describe the draft that
    # actually lands on disk. It is a no-op unless an earlier iteration outscored the final one and
    # nothing is holding the blog for the operator. See _install_best_draft.
    _install_best_draft(client_slug, topic_slug, out_dir, baseline, root=run_dir_root)
    # The lead's terminal claim is checked here, before the result is reported, because this is
    # where a topic's terminal line stops changing. A needs_review with no answerable question is
    # corrected to done or failed by its score and the override is recorded. See
    # _enforce_terminal_status.
    summary = _enforce_terminal_status(client_slug, topic_slug, out_dir, root=run_dir_root)
    # COMMIT STRICTLY AFTER THE RESOLVER. _enforce_terminal_status reads questions and status
    # from DISK, the same surface the agents wrote seconds earlier; committing first would let
    # the resolver race a store the last write never reached. The terminal line is now final,
    # so the record takes everything this topic accumulated. Fire-and-forget (see
    # _schedule_commit); the startup reconciler covers any window it loses.
    _schedule_commit(client_slug, topic_slug)
    return summary


# ---------------------------------------------------------------------------
# The surgical revise: one topic, re-opened because the operator answered the
# evaluator's questions.
#
# This is NOT run_topic with a different prompt. run_topic writes a blog from
# nothing and owns a 4-iteration loop. This re-opens a FINISHED topic, applies
# two specific inputs to the draft that already exists, and scores it once. The
# dossier is frozen and no research happens: the whole reason the operator was
# asked is that they knew something research could not settle, so re-researching
# would spend their quota rediscovering what they just typed in.
#
# The property everything else rests on: THE CLARIFIED DRAFT SHIPS, AND TRUTH
# BEATS SCORE. A revise driven by the operator's answers ships its result even
# when that result scores LOWER than the draft it replaced.
#
# "The higher score ships" used to live here, and inverting it is deliberate. It
# was written as a guard on an ELECTIVE improvement rerun, answering "what makes
# an optional rerun safe to ACCEPT". Answers are no longer elective: a current
# question holds the blog at every score, so this rerun is MANDATORY and a
# correctness pass, and as a guard on one that rule inverts into a
# correctness-suppression mechanism. Follow it through: a negative answer tells
# the writer a claim is wrong, the writer CUTS the claim, the draft loses the
# factual density that claim carried, the score falls, the original is restored
# WITH THE VIOLATION STILL IN IT, and the engine structurally prefers the
# non-compliant draft over the corrected one. The score drop is the truth costing
# points, not the draft getting worse.
#
# THE BYTE-FOR-BYTE RESTORE SURVIVES, ON THE CANCELLATION AND CRASH PATHS ONLY. A
# stop or a crash mid revise leaves a HALF APPLIED revise, which is not a
# clarified draft: nothing scored those bytes and no answer was fully applied to
# them, so they have earned nothing and the original goes back.
# ---------------------------------------------------------------------------

# The draft as it stood before the revise touched it. Not a temp file: it is
# written into the topic's own output dir and left there afterwards, so an
# operator can diff what the revise did to their blog. It is deliberately absent
# from app.OUTPUT_WHITELIST, so it is never served as if it were the article.
PREV_BLOG_NAME = "blog.prev.md"

# The elective loop's best-scoring draft, snapshotted by .claude/status.py as each new high is
# scored, because the loop revises blog.md IN PLACE and a lower later iteration would otherwise
# overwrite a higher one with nothing on disk to recover it. Local scratch: absent from
# app.OUTPUT_WHITELIST (never served) and read by neither sync.commit_topic nor materialization
# (never persisted), exactly like blog.prev.md. _install_best_draft consumes and clears them.
BEST_BLOG_NAME = "blog.best.md"
BEST_EVAL_NAME = "eval.best.md"


def _restore_artifact_set(blog, eval_md, blog_bytes, eval_bytes):
    """Put back the ARTIFACT SET the snapshotted score described: blog.md AND eval.md.

    THE RESTORE RETURNS WHAT SHIPPED, NOT JUST THE DRAFT. Restoring blog.md alone was a live bug:
    a discarded revise left the restored original sitting beside the DISCARDED draft's eval.md,
    carrying that draft's SCORE: NN and its fix list. The status trail then said one number and
    the file an operator opens said another, about an article the second file never audited.
    eval.md is half of what a score means, so it is half of what a restore owes back.

    An eval.md that did NOT exist at snapshot time is REMOVED rather than left: it describes only
    the draft that was just thrown away, and leaving it is the same lie in the other direction.
    """
    blog.write_bytes(blog_bytes)
    if eval_bytes is None:
        eval_md.unlink(missing_ok=True)
    else:
        eval_md.write_bytes(eval_bytes)


def _last_eval_score(lines):
    """The most recent eval end score in these lines, or None if none carries one."""
    for line in reversed(lines):
        if line.get("stage") == "eval" and line.get("event") == "end" and line.get("score") is not None:
            return line["score"]
    return None


def _eval_scores(lines):
    return [line["score"] for line in lines
            if line.get("stage") == "eval" and line.get("event") == "end"
            and line.get("score") is not None]


def _max_eval_score(lines):
    """The highest eval end score in these lines, or None if none carries one."""
    scores = _eval_scores(lines)
    return max(scores) if scores else None


def _first_iter_for_score(lines, score):
    """The iteration of the FIRST eval end that reached `score`, or the last iter seen."""
    for line in lines:
        if line.get("stage") == "eval" and line.get("event") == "end" and line.get("score") == score:
            return line.get("iter", 0)
    return max((line.get("iter", 0) for line in lines), default=0)


def _clear_best_snapshots(out_dir):
    (Path(out_dir) / BEST_BLOG_NAME).unlink(missing_ok=True)
    (Path(out_dir) / BEST_EVAL_NAME).unlink(missing_ok=True)


def _install_best_draft(client_slug, topic_slug, out_dir, baseline, root=None):
    """GUARANTEE the elective loop ships its HIGHEST-scoring draft, not its last one.

    The loop revises blog.md IN PLACE, so a later, lower-scoring iteration overwrites a higher
    one: the contract's "keep the best-scoring draft" had no code behind it and a real run peaked
    at 92 then shipped 89 ("unrecoverable, in-place edits"). status.py snapshots the top draft to
    blog.best.md as each new high is scored; here, once the loop is over, if the draft on disk is
    not the best this session produced, the best is restored, blog.md AND eval.md together, and a
    superseding eval end line records the swap so the reported score is the one that ships.

    Scoped to the CURRENT session by `baseline`, the same window the retry loop and the stop guard
    use, so a re-generation never inherits a prior run's peak. Two exclusions, both load-bearing:
      - A CURRENT question holds a SPECIFIC draft, the one the evaluator asked about. Swapping in a
        different, higher-scoring earlier draft would leave the operator answering about a draft no
        longer on disk, the staleness the questions guard exists to stop. So a current form vetoes
        the swap and the held draft stays put.
      - The ANSWER-DRIVEN revise ships the clarified draft EVEN WHEN LOWER (revise_topic), so it
        must never be second-guessed here. This runs from run_topic only; revise_topic never calls
        it.
    The swap never invents a score or a verdict: the best draft was already scored, gate-clean and
    link-clean, by a real evaluator this session (gates and links run before every eval), so this
    selects among computed scores rather than re-running one. The status is re-resolved from the
    best score through the same _resolve_needs_review the enforcer uses, so a discarded 96 that the
    loop wrongly ran past still ships done rather than dying at the last draft's 89.
    """
    session = _read_status(out_dir)[baseline:]
    best = _max_eval_score(session)
    last = _last_eval_score(session)
    best_blog = Path(out_dir) / BEST_BLOG_NAME
    if (_questions_state(client_slug, topic_slug, root=root) == "current"
            or best is None or last is None or best <= last or not best_blog.is_file()):
        _clear_best_snapshots(out_dir)
        return
    blog = Path(out_dir) / "blog.md"
    eval_md = Path(out_dir) / "eval.md"
    best_eval = Path(out_dir) / BEST_EVAL_NAME
    blog.write_bytes(best_blog.read_bytes())
    if best_eval.is_file():
        eval_md.write_bytes(best_eval.read_bytes())
    status, reason = _resolve_needs_review(client_slug, topic_slug, best, root=root)
    best_iter = _first_iter_for_score(session, best)
    _status_module().append_status(
        str(out_dir), topic_slug, stage="eval", event="end",
        iter=best_iter, score=best, status=status,
        note=(f"best-draft selection: restored the iteration {best_iter} draft scoring {best} and "
              f"discarded the later draft scoring {last}. {reason}"),
    )
    # The swap ships done or failed (a current form was excluded above), so any NEEDS_REVIEW
    # marker the lead left is stale. _enforce_terminal_status would normally clear it, but the
    # install line pre-empts its correction into an early return, so clear it here to keep the
    # on-disk marker honest with the terminal line just written.
    (Path(out_dir) / "NEEDS_REVIEW").unlink(missing_ok=True)
    _clear_best_snapshots(out_dir)


def _revise_lead_prompt(client_slug, row, topic_slug, out_dir, iteration):
    prompt_block = ""
    guidance_block = ""
    if row:
        # Best effort, and absent when the roadmap row has gone. The draft is what is being
        # revised, so this session works without the row: unlike a first draft, the article
        # already exists and the piece's shape is already decided. When the row IS still there it
        # rides along for the same reason the first-draft lead passes it, because a fresh writer
        # invents whatever it is not handed.
        prompts = "\n".join(f"- {p}" for p in row.get("prompts", []))
        if prompts:
            prompt_block = f"""
Target prompts (BINDING, each answered verbatim somewhere liftable):
{prompts}
"""
        extras = row.get("extras") or []
        if extras:
            extra_lines = "\n".join(f"- {e['label']}: {e['value']}" for e in extras)
            guidance_block = f"""
Roadmap guidance, under the sheet's own headers. Pass it to the writer VERBATIM, under these
same labels:
{extra_lines}

None of it is a fact, a source, or a statistic, and nothing in it overrides canonical-facts.md.
"""

    return f"""You are the SESSION LEAD for a SURGICAL REVISE of ONE blog that ALREADY EXISTS.
Follow CLAUDE.md, the engine contract in this repo, exactly. You do not manage a queue and you
never launch other blogs.

Client slug: {client_slug}
Topic: {row.get('topic', topic_slug) if row else topic_slug}
Topic slug: {topic_slug}
Output dir: {out_dir}
Iteration number for every dispatch and every status line: {iteration}
{prompt_block}{guidance_block}
THIS IS NOT A NEW BLOG. The article is at {out_dir}/blog.md and it is finished. You are
applying two specific inputs to it and nothing else.

THE DOSSIER IS FROZEN. Do NOT dispatch a researcher. Do NOT re-research anything, do not
re-verify a source that is already cited, and do not go looking for better ones. The operator
was asked precisely because the gap was something no amount of research closes: they hold a fact
about their own business that no page on the internet states. Re-researching now would spend
their quota rediscovering what they have already told you, and it would take a session that
should touch three paragraphs and turn it into a rewrite.

Apply ONLY these two things:
1. The operator's answers at {out_dir}/answers.json. Each answer names the question it answers.
2. The outstanding fix list in {out_dir}/eval.md.
Nothing else changes. Do not rewrite the article, do not restructure it, do not trim it for
length, and NEVER cut an honest negative to save words.

WHAT AN OPERATOR'S ANSWER IS, AND WHAT IT IS NOT. It is CLIENT-PROVIDED GUIDANCE, ranking with
clients/{client_slug}/canonical-facts.md and above any internal doc. It is NOT a source. An
answer can tell you a claim is wrong, that a figure is confirmed, or that a fact you hedged on
is settled, and it still cannot become a citation: no answer, and no sentence built on one, may
appear in Sources and References or be linked as evidence. A claim that needs a citation still
needs a source fetched in full, exactly as before. Where an answer says a claim is wrong, the
fix is to correct or remove the claim, never to cite the answer for it. This is CLAUDE.md's
"Asking the operator" rule and it is not negotiable.

Then, in this order:
- Dispatch a FRESH writer at iteration {iteration} with the current blog.md, the answers, and
  the fix list. Pass it the client slug, topic slug, and output dir. It applies only the listed
  changes.
- The writer runs the gates until they exit 0:
  python3 .claude/gates.py --client {client_slug} {out_dir}/blog.md
- The writer runs the link pass on CHANGED LINKS ONLY. Every URL already in
  {out_dir}/links-verified.txt is verified and is never re-fetched. Only a link the revise added
  or changed gets fetched.
- Delete any stale questions file before the evaluator runs:
  python3 -c "import pathlib; pathlib.Path('{out_dir}/questions.json').unlink(missing_ok=True)"
- Dispatch a FRESH evaluator at iteration {iteration}. It sees blog.md, the rubric,
  canonical-facts.md, and {out_dir}/answers.json: never the dossier, never the writer's
  reasoning, never the previous eval. It scores the draft blind of everything except the fact
  base, and writes eval.md plus its eval end status line carrying the score.
- THE EVALUATOR READS THE ANSWERS BECAUSE THEY ARE PART OF THE FACT BASE, ranking with
  canonical-facts.md, which it already reads. Its hostile isolation is intact: an answer is not
  the writer's reasoning. Withholding them punishes honesty, because a negative answer forces a
  claim to be CUT and an evaluator that cannot see the answer reads that cut as lost factual
  density and marks the draft DOWN for telling the truth. An answer is still NOT a source and can
  never become a citation.

STOP after that one evaluator. There is no loop here and no second revise: this session is one
pass, and the engine decides what happens to the result.

You do NOT write the terminal status line. THE CLARIFIED DRAFT SHIPS, even if your evaluator
scores it LOWER than the draft it replaced, because a lower score on a corrected draft is the
truth costing points and the engine will not restore a draft the operator's own answer says is
wrong. That decision is not yours to make and not yours to record, and it is NOT a licence to
chase a number: apply the answers and the fix list, nothing else.

Absolute rules:
- Never write or edit the blog yourself.
- Never read dossiers or drafts into your own context.
- Each agent appends its own status lines via python3 .claude/status.py, all at iteration
  {iteration}, all with status running.
"""


async def _sdk_revise_session(client_slug, row, topic_slug, out_dir, iteration):
    """One revise, one real SDK session, built exactly like _sdk_session: same options, same
    agents, a different lead prompt. The revise is a different JOB, not a different engine."""
    from claude_agent_sdk import query

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    options = _session_options()
    prompt = _revise_lead_prompt(client_slug, row, topic_slug, out_dir, iteration)

    try:
        async for _message in query(prompt=prompt, options=options):
            # Consume and DISCARD, as run_topic does: outcomes are read from
            # status.jsonl and never from agent output.
            pass
    except ClaudeSDKError as exc:
        # A dead CLI is a died session. Return and let revise_topic's compare step handle it,
        # which it does by scoring nothing and restoring the original.
        print(f"[runner] revise session for {topic_slug} died: {exc}", file=sys.stderr)
        return


def _row_for_topic(client_slug, topic_slug):
    """The roadmap row for this topic, or None. Best effort by design.

    A revise must not die because the operator deleted their roadmap after the blog shipped. The
    draft is the input here, not the row, so a missing row costs the writer some guidance and
    nothing more.
    """
    try:
        payload = roadmap.load_roadmap(client_slug)
    except Exception:
        return None
    for row in payload.get("rows", []):
        if row.get("topic_slug") == topic_slug:
            return row
    return None


def register_revise_run(run_id, client_slug, topic_slug, root=None):
    """Register a revise in RUNS before its task starts, mirroring api_generate.

    Registered by the CALLER, synchronously, at the instant the operator's POST lands, for the
    reason api_generate does it there: the 202 carries the record back, and _client_has_live_run
    must see this run immediately or a second POST slips through the gap before the task is
    scheduled. It starts queued, exactly like a batch, because CLIENT_LOCK is repo-wide and this
    session can sit behind another for minutes.
    """
    status_path = output_dir(client_slug, topic_slug, root=root) / "status.jsonl"
    try:
        tail_offset = status_path.stat().st_size
    except OSError:
        tail_offset = 0
    topics = [{"index": None, "topic_slug": topic_slug, "tail_offset": tail_offset}]
    return register_run(run_id, client_slug, topics)


async def revise_topic(client_slug, topic_slug, run_id=None, *, run_dir_root=None):
    """Re-open ONE finished topic with the operator's answers. THE CLARIFIED DRAFT SHIPS.

    Ships the clarified draft at whatever it scores, higher or lower, because the operator's
    answer is the reason it changed and TRUTH BEATS SCORE. The original comes back only where
    this session produced no clarified draft at all: a stop, a crash, or a session that died
    before scoring, each of which leaves a half applied revise rather than a corrected article.

    Returns the summary shape run_topic returns, describing the draft that SHIPPED, plus the
    roadmap row under "row". The row rides along because a revise can be the moment a topic
    first reaches done, and the caller records that ship in the ledger, which needs the
    operator's own topic text rather than a slug. It is the same summary-plus-row shape
    run_batch hands its per-topic callback, and it is None when the roadmap row has gone.
    """
    out_dir = output_dir(client_slug, topic_slug, root=run_dir_root)
    blog = out_dir / "blog.md"
    eval_md = out_dir / "eval.md"
    prev_blog = out_dir / PREV_BLOG_NAME
    clients_root = REPO_ROOT / "clients"
    append_status = _status_module().append_status

    # THE APPROVED LOCK, BEFORE THE RUN IS EVEN REGISTERED, and outside the try for the reason
    # run_topic states at length: this function's PreflightError arm appends a terminal FAILED
    # line, and an approved topic already carries a done line that is still true. A revise is
    # the path where that matters most, because everything below this point is built to protect
    # a verdict a revise might lose, and refusing one by writing "failed" over a shipped 96
    # would be this module doing the exact thing its own comments spend pages preventing.
    #
    # A revise commits a version like any other write, so the trigger would refuse it at the
    # end. Refusing here saves the session.
    #
    # A WATCH VIEW CAN BE OPEN ON THIS REFUSAL, which an earlier version of this comment denied on
    # the ground that api_answers and api_revise_answered both refuse an approved topic before
    # register_revise_run. They check FIRST and register SECOND, and _revise_task reaches this line
    # later still, so an approval landing in that window passes both routes and arrives here with
    # the run registered and its stream open. The portal is the other writer against one shared
    # record, so that ordering is ordinary. Left with no terminal line the stream heartbeats at
    # running forever, exactly as run_topic describes.
    #
    # RE-STATED, NOT REPLACED, for the reason above: the done this topic already earned goes back
    # on the feed with the refusal as its note, so the stream closes and the verdict does not move.
    #
    # SYNCHRONOUS, for the reason run_topic spells out: an await outside the try is a
    # cancellation point outside the arm that handles cancellation, and a stop landing on it
    # would leave this topic with no terminal line and its watch view heartbeating forever.
    # _restate_verdict_line is synchronous for the same reason and reads only disk.
    refusal = _approved_refusal(client_slug, topic_slug, "a revise")
    if refusal is not None:
        _restate_verdict_line(
            out_dir, topic_slug,
            f"a revise was refused before it started: {refusal} This topic keeps the verdict it "
            f"already earned, re-stated here so a watching stream can close",
        )
        raise PreflightError(refusal)

    # Callable on its own (a CLI, a test), so register if the caller has not. The endpoint always
    # has, and this is a no-op there.
    if run_id is None:
        run_id = uuid.uuid4().hex
    if get_run(run_id) is None:
        register_revise_run(run_id, client_slug, topic_slug, root=run_dir_root)

    # All of these are read by the failure handlers and the finally arm below, which can fire
    # before any of them is set: a refusal raises before the snapshot exists, and iteration is
    # only knowable once status.jsonl is read.
    prev_bytes = None
    prev_eval_bytes = None
    prev_terminal = None
    prev_score = None
    iteration = 1
    # The iteration the RESTORED draft is on, which is the one the topic was on before this
    # session opened. Every restore path stamps its terminal line with this rather than with
    # `iteration`, and the difference is load bearing rather than cosmetic. The line describes the
    # ORIGINAL bytes, so claiming the new iteration for them says the topic advanced to a draft
    # that was just thrown away. It also decides whether the operator has a door: staleness is
    # VERSION **OR** ITERATION since migration 014, and this stamp is what settles the ITERATION
    # arm, the form's iter against the topic's high-water iter. A restore that stamped `iteration`
    # pushed the topic past the very form it was keeping and the app refused the re-submit as
    # stale. Restoring the draft and stranding its form is not a restore. The VERSION arm needs
    # nothing from this line and holds for free, because A RESTORE COMMITS NO NEW VERSION: it puts
    # the artifact set back byte for byte, commit_topic sees bytes that match the latest committed
    # version and inserts no row, so the form's anchor still points at the topic's current
    # version. That case is 014's own stated reason for keeping the iteration arm at all.
    restored_iter = 1
    # Did a clarified draft actually ship? Read by the finally arm, which cannot see which branch
    # ran. False through every failure path, because none of them ships one.
    clarified_shipped = False

    try:
        async with CLIENT_LOCK:
            # Acquiring the lock IS the start of this session, exactly as in run_batch. Until now
            # it was queued behind whatever else held the engine.
            mark_running(run_id)
            mark_phase(run_id, "topics")

            if not blog.is_file():
                raise PreflightError(
                    f"cannot revise {client_slug}/{topic_slug}: {blog} does not exist, and a "
                    f"surgical revise edits a draft rather than writing one"
                )
            # The same refusal run_topic makes, for the same reason: the writer in this
            # session reads canonical-facts.md and every claim it touches inherits that file.
            # A revise is no less bound by it than a first draft.
            facts = canonical_facts_path(client_slug, clients_root)
            if not facts.is_file():
                raise PreflightError(f"preflight failed for {client_slug}: {facts} is missing")
            if "PLACEHOLDER" in facts.read_text(encoding="utf-8"):
                raise PreflightError(
                    f"preflight failed for {client_slug}: canonical-facts.md still contains "
                    f"the token PLACEHOLDER and has not been reviewed"
                )

            # THE VERDICT SNAPSHOT, BEFORE THE MATERIALIZE ROUND TRIP BELOW. materialize_topic
            # and materialize_answers never touch status.jsonl, so these reads are identical on
            # either side of the hook, and taking them FIRST closes the window the hook would
            # otherwise open: a stop landing inside the materialize await must re-state the
            # verdict this topic already earned, never write "stopped" over a done blog.
            # LAY THE SCRATCH DOWN FROM THE RECORD FIRST, before every snapshot. Materialization
            # can re-lay status.jsonl on reclaimed scratch (so disk ordinals continue the
            # record's) and re-lays blog.md, eval.md, dossier, links, questions.json and
            # answers.json. Every read below must therefore happen AFTER it: a verdict snapshot
            # taken before it would see an empty feed on reclaimed scratch and invent a topic
            # with no history, and a byte snapshot taken before it could miss an eval.md the
            # record holds but the disk lost, making the restore unlink an artifact the record
            # says exists. A stop landing INSIDE this await is handled by the failure arms,
            # which re-derive the verdict from disk when the snapshot never ran. Skipped when
            # the record does not know the client (see _materialize_topic_scratch).
            await asyncio.to_thread(_materialize_topic_scratch, client_slug, topic_slug,
                                    answers=True)

            lines_before = _read_status(out_dir)
            prev_score = _last_eval_score(lines_before)

            # THE VERDICT THIS TOPIC ALREADY EARNED, snapshotted beside the bytes that earned it.
            #
            # A revise is only ever opened on a topic that already finished, so there is almost
            # always a terminal line here, and it is the honest description of the draft the
            # restore puts back. The failure arms below need it for exactly that: when they give
            # the original bytes back, the original verdict is true again, and inventing a new one
            # over the top of it is what demoted a shipped 96 to stopped. None only when a revise
            # was driven at a topic that never reached a verdict, which the arms handle on their
            # own terms.
            prev_terminal = _terminal_line(lines_before)

            iteration = _summarize(topic_slug, lines_before)["iterations"] + 1
            restored_iter = max(1, iteration - 1)

            # THE BYTE SNAPSHOT, BEFORE ANYTHING CAN TOUCH THE DRAFT.
            #
            # This is what the stop and crash restores are built out of, so it happens before the
            # session opens rather than after it starts: a session that began writing before the
            # copy was taken could have already overwritten the draft those paths promise to give
            # back. Everything below is recoverable; a lost original is not.
            #
            # THE ARTIFACT SET, NOT THE DRAFT ALONE. eval.md is snapshotted beside blog.md because
            # a score describes both of them together, and a restore that returned only the draft
            # left the original sitting beside the discarded draft's eval.md and its SCORE: NN.
            # None is a real value here and means eval.md did not exist yet, which the restore
            # honors by removing it rather than leaving a stranger's audit behind.
            shutil.copy2(blog, prev_blog)
            prev_bytes = blog.read_bytes()
            prev_eval_bytes = eval_md.read_bytes() if eval_md.is_file() else None

            row = _row_for_topic(client_slug, topic_slug)

            await _sdk_revise_session(client_slug, row, topic_slug, out_dir, iteration)

            # Only lines this session appended. Re-reading the whole file would find the PREVIOUS
            # eval's score sitting there and read it as this revise's result, which for a session
            # that died before scoring would silently compare a draft against itself.
            new_lines = _read_status(out_dir)[len(lines_before):]
            new_score = _last_eval_score(new_lines)

            # The answer-driven revise NEVER installs a best snapshot: it ships the clarified draft
            # even when lower. status.py still wrote one during this session's eval, so clear it
            # here, before any terminal line, so the elective loop's guarantee (run_topic only)
            # cannot mistake a revise's draft for a peak it must restore.
            _clear_best_snapshots(out_dir)

            # THE CLARIFIED DRAFT SHIPS. NO COMPARISON, AT ALL.
            #
            # There is deliberately no `new_score > prev_score` here any more, and its absence is
            # the whole point of this block. This rerun is MANDATORY, because a current question
            # holds the blog at every score, and a score comparison guarding a mandatory
            # correctness pass suppresses corrections: the operator answers that a claim is wrong,
            # the writer cuts it, the density the claim carried goes with it, the score falls, and
            # the comparison hands back the ORIGINAL WITH THE VIOLATION STILL IN IT. The engine
            # would then structurally prefer the non-compliant draft, forever, and no operator
            # could ever fix that blog. A lower score on a clarified draft is the truth costing
            # points, so the clarified draft ships at 91 as readily as at 97.
            #
            # A None new_score is NOT that case and never was. It means this session produced no
            # verdict: the CLI died, or the evaluator never scored. Nothing read the answers
            # through to an audited article, so what is on disk is a HALF APPLIED REVISE, not a
            # clarified draft, and it has earned nothing. The original goes back, exactly as it
            # does on the stop and crash paths, and for exactly that reason.
            if new_score is None:
                # NO CLARIFIED DRAFT, SO THE RESTORED ORIGINAL KEEPS THE VERDICT IT ALREADY
                # CARRIED. This is the crash arm's answer to the identical event, written the
                # same way on purpose: the two paths describe one thing, a session that died
                # holding the draft, and an engine whose two arms disagree about that ships one
                # article under two verdicts depending on where the CLI happened to die.
                #
                # THE RESOLVER MAY ONLY EVER RUN ON A DRAFT THIS SESSION ACTUALLY SCORED. That is
                # the rule, and the reason is that the resolver answers "what does this score,
                # against what is on disk, add up to", which is a question about a draft that was
                # graded. These bytes were not: they are the original, restored, and the only
                # honest thing to say about them is what was already said. Running the resolver
                # here read the spent form as "answered", called that a non-holding state, and
                # returned done, so a blog HELD for an operator's answer shipped at its old 96
                # with the answer never applied and the violation still in it. The engine would
                # have laundered a dead session into a ship.
                #
                # STAGE "eval" AND prev_score, exactly as the failure arms below carry them:
                # _last_eval_score and _summarize read only stage="eval" end lines, and prev_score
                # is the number the restored bytes genuinely have.
                _restore_artifact_set(blog, eval_md, prev_bytes, prev_eval_bytes)
                append_status(
                    str(out_dir), topic_slug, stage="eval", event="end", iter=restored_iter,
                    score=prev_score,
                    status=prev_terminal["status"] if prev_terminal else "failed",
                    note=("surgical revise from operator answers: the revise session produced no "
                          "score, so no clarified draft exists. The original blog.md and eval.md "
                          "were restored byte for byte, and this topic keeps the verdict it "
                          "already earned"
                          if prev_terminal else
                          "surgical revise from operator answers: the revise session produced no "
                          "score, so no clarified draft exists. The original blog.md and eval.md "
                          "were restored byte for byte, and this topic never reached a verdict"),
                )
                # COMMIT AFTER THE RESTORE AND AFTER THE TERMINAL APPEND. The restore already put
                # the ORIGINAL bytes back on disk, so commit_topic sees restored bytes and
                # correctly re-commits nothing new: only the status lines this session appended
                # move. Fire-and-forget (see _schedule_commit).
                _schedule_commit(client_slug, topic_slug)
                return dict(_summarize(topic_slug, _read_status(out_dir)), row=row)

            clarified_shipped = True
            shipped_score = new_score
            note = (f"the clarified draft scored {new_score} against the original's "
                    f"{prev_score} and ships: the operator's answers drove it, so it ships "
                    f"whether the score rose or fell")

            # The terminal line describes the SHIPPED draft, never the session, and this branch is
            # the ONE place a revise reaches the resolver, because it is the one place this
            # session scored a draft.
            #
            # The SAME three states run_topic ends on, resolved by the same function, because a
            # revise ends a topic exactly as a first run does and two copies of this rule is how
            # an engine comes to ship at one threshold and hold at another. There is no lead claim
            # to correct here: the revise lead is forbidden from writing a terminal line, so the
            # reason is recorded as the engine's own reasoning rather than as an override.
            status, why = _resolve_needs_review(client_slug, topic_slug, shipped_score,
                                                root=run_dir_root)
            append_status(
                str(out_dir), topic_slug, stage="eval", event="end", iter=iteration,
                score=shipped_score, status=status,
                note=f"surgical revise from operator answers: {note}"
                     + (f". {why}" if why else ""),
            )
            # COMMIT AFTER THE TERMINAL APPEND. The resolver above read DISK and the terminal
            # line is now final, so the record takes the clarified draft, its eval and every
            # status line this session appended. Fire-and-forget (see _schedule_commit); the
            # startup reconciler covers any window it loses.
            _schedule_commit(client_slug, topic_slug)
            return dict(_summarize(topic_slug, _read_status(out_dir)), row=row)
    except asyncio.CancelledError:
        # The operator stopped the brand mid-revise. This arm exists because a revise is the ONE
        # path where a stop can destroy a blog that already shipped, and "whichever blogs have been
        # created will be kept" is the whole promise of the button that gets here.
        #
        # RESTORE FIRST, for the reason the handler below restores first, which a cancel skips
        # entirely because CancelledError is a BaseException: without this line a stop lands
        # mid-write and leaves a HALF REVISED draft on disk where a scored, shipped one was. No
        # file is deleted and the blog is still ruined, which is the failure mode that matters
        # here. Nothing scored the bytes now on disk, so nothing earns them the right to replace
        # the draft that did score. Skipped only when the snapshot was never taken, which means
        # the session never touched the draft.
        #
        # THIS IS THE PATH THE BYTE-FOR-BYTE RESTORE SURVIVES ON. The success path no longer
        # restores a lower scoring clarified draft, because an answer earned that draft. A stop
        # earns nothing: a half applied revise is not a clarified draft. The ARTIFACT SET goes
        # back, blog.md and eval.md together, because the verdict re-stated below describes both.
        if prev_bytes is not None:
            _restore_artifact_set(blog, eval_md, prev_bytes, prev_eval_bytes)
        # The terminal line is NOT optional here, and the guard used in run_topic would be wrong.
        # This topic already carried a terminal line from the run that produced it, and after the
        # restore that old line is accurate again. But register_revise_run recorded a tail_offset
        # at the size status.jsonl had when the revise was submitted, so the SSE stream for THIS
        # run reads only lines after it and would never see that older line. With nothing appended,
        # the operator's watch view hangs on a revise they stopped themselves.
        #
        # THE LINE RE-STATES THE OLD VERDICT; IT DOES NOT INVENT A NEW ONE. Needing to append
        # something is not a licence to append anything, and this arm used to write "stopped" over
        # a blog that had already shipped at 96. status.jsonl is append-only and every reader takes
        # the LAST terminal line, so that one word demoted a finished blog everywhere at once, and
        # permanently: the CMS gate refuses anything that is not done, re-answering 409s as stale,
        # and regenerating 409s as already_generated, so the operator had no door left. What was
        # stopped here is the OPTIONAL rerun, not the blog: the draft on disk is the one that
        # scored, byte for byte, so it keeps the verdict it earned. The contract says it twice, and
        # this is both halves: a stop after SCORE >= 95 does not un-ship the blog, and a topic that
        # already wrote its terminal line keeps that line, its score, and its ledger entry.
        #
        # Only a topic with NO verdict to restore is stopped here, which is a revise driven at a
        # topic that never finished, and then "stopped" is the honest word for it.
        #
        # STAGE "eval" AND prev_score, for the reason the handler below spells out: _last_eval_score
        # and _summarize read only stage="eval" end lines, and a stop can land after this session's
        # evaluator already scored the draft that was just thrown away. Tagging this "revise" would
        # leave that discarded score standing as the topic's latest, so the next revise would treat
        # a number no draft on disk carries as the baseline it must beat, and overwrite a better
        # draft with a worse one. Carrying prev_score names the score the restored bytes actually
        # have.
        #
        # restored_iter AND prev_score UNCONDITIONALLY, no longer gated on prev_bytes. The
        # materialize hook sits between the verdict snapshot and the byte snapshot, so a stop
        # landing inside its round trip has prev_terminal set while prev_bytes is still None:
        # nothing touched the draft, the bytes on disk ARE the original at restored_iter carrying
        # prev_score, and stamping `iteration` for them would push the topic past its own form
        # and close the operator's door. Where nothing was snapshotted at all, the defaults (1
        # and None) say exactly what the old else-branch said.
        # A stop or crash landing inside the materialize await arrives with no verdict
        # snapshot taken. The disk feed (materialized or original) is authoritative for the
        # verdict this topic already earned, so re-derive it rather than writing "stopped"
        # or a default iteration over a blog that has a real terminal line.
        if prev_terminal is None:
            _fresh = _read_status(out_dir)
            _t = _terminal_line(_fresh) if _fresh else None
            if _t is not None:
                prev_terminal = _t
                prev_score = _last_eval_score(_fresh)
                restored_iter = max(1, _summarize(topic_slug, _fresh)["iterations"])
        append_status(
            str(out_dir), topic_slug, stage="eval", event="end",
            iter=restored_iter,
            score=prev_score,
            status=prev_terminal["status"] if prev_terminal else "stopped",
            note=("the operator stopped this revise and the original draft was restored "
                  "unchanged, so this topic keeps the verdict it already earned"
                  if prev_terminal else
                  "the operator stopped this revise before this topic reached a verdict"),
        )
        # A STOPPED REVISE COMMITS TOO, after the restore and after the terminal append: the
        # restore already put the ORIGINAL bytes back on disk, so commit_topic sees restored
        # bytes and correctly re-commits nothing new, only the terminal line above.
        # Fire-and-forget, never awaited: CancelledError propagates below exactly as before.
        _schedule_commit(client_slug, topic_slug)
        raise
    except (PreflightError, RunnerConfigError) as exc:
        # Same obligation run_topic carries: a refusal raised before dispatch would otherwise
        # leave status.jsonl with no terminal line, so the SSE stream never closes and the watch
        # view hangs at queued forever. A refusal fires before the draft is touched, so there is
        # nothing to restore.
        append_status(
            str(out_dir), topic_slug, stage="revise", event="end", iter=iteration,
            status="failed", note=str(exc),
        )
        # Commit the terminal failed line after the append. Nothing touched the draft, so the
        # only thing that moves is the line itself. Fire-and-forget; the re-raise is unchanged.
        _schedule_commit(client_slug, topic_slug)
        raise
    except Exception as exc:
        # Anything else: a dead session, a disk error, a bug in this module. Two obligations, and
        # the first is the one this feature is built on.
        #
        # RESTORE FIRST. A crash can leave a half revised draft on disk, and a half revised draft
        # is the one thing a revise must never ship: a clarified draft ships because the
        # operator's answers were applied to it in full and a fresh evaluator then scored it, and
        # nothing here applied anything in full or scored anything at all. The ARTIFACT SET goes
        # back, blog.md and eval.md together, so the restored draft is not left beside an eval.md
        # auditing the draft that was just thrown away. Only skipped when the snapshot was never
        # taken, which means nothing was touched.
        #
        # Then the terminal line, for the reason above. Broad on purpose, and it re-raises, so
        # the caller still records the failure.
        #
        # STAGE "eval", NOT "revise", and the tag is what makes the score readable rather than
        # decorative. Both readers of a recorded score, _last_eval_score and _summarize, accept
        # only stage="eval" end lines, exactly as the success path at the end of the try block
        # relies on. A crash can land AFTER this session's evaluator already appended its own
        # eval line for the draft that was just thrown away, so tagging this line "revise" would
        # hide it behind that discarded score: the dashboard would report a number no draft on
        # disk carries, and the next revise would take it as the baseline it must beat and
        # overwrite a better draft with a worse one.
        if prev_bytes is not None:
            _restore_artifact_set(blog, eval_md, prev_bytes, prev_eval_bytes)
        traceback.print_exc(file=sys.stderr)
        print(f"[runner] revise_topic failed for {client_slug}/{topic_slug}: {exc}",
              file=sys.stderr)
        # THE VERDICT SURVIVES THE CRASH, for the reason the cancel arm above spells out at
        # length. A bookkeeping crash on an OPTIONAL rerun must never turn a shipped blog into a
        # failure: "the higher score ships" guarantees the artifact on disk is the one that
        # scored, the restore above is what honors it, and this line only has to say so. Writing
        # "failed" here counted a blog sitting in generated.csv at 96 among the failures, painted
        # it red, and had the CMS gate refuse it with no way back. What failed is this session,
        # which the note names and the traceback records. A topic with no verdict to keep has
        # genuinely failed, and only then does this say so.
        # restored_iter AND prev_score UNCONDITIONALLY, for the reason the cancel arm above
        # states: a crash inside the materialize round trip has the verdict snapshot without the
        # byte snapshot, the disk bytes are the untouched original, and the defaults cover the
        # nothing-snapshotted case exactly as the old else-branch did.
        # A stop or crash landing inside the materialize await arrives with no verdict
        # snapshot taken. The disk feed (materialized or original) is authoritative for the
        # verdict this topic already earned, so re-derive it rather than writing "stopped"
        # or a default iteration over a blog that has a real terminal line.
        if prev_terminal is None:
            _fresh = _read_status(out_dir)
            _t = _terminal_line(_fresh) if _fresh else None
            if _t is not None:
                prev_terminal = _t
                prev_score = _last_eval_score(_fresh)
                restored_iter = max(1, _summarize(topic_slug, _fresh)["iterations"])
        append_status(
            str(out_dir), topic_slug, stage="eval", event="end",
            iter=restored_iter,
            score=prev_score,
            status=prev_terminal["status"] if prev_terminal else "failed",
            note=f"revise failed and the original draft was restored unchanged, so this topic "
                 f"keeps the verdict it already earned: {type(exc).__name__}: {exc}"
                 if prev_terminal else
                 f"revise failed and the original draft was restored unchanged: "
                 f"{type(exc).__name__}: {exc}",
        )
        # A CRASHED REVISE COMMITS TOO, after the restore and after the terminal append: the
        # restore already put the ORIGINAL bytes back on disk, so commit_topic sees restored
        # bytes and correctly re-commits nothing new, only the terminal line above.
        # Fire-and-forget; the re-raise below still hands the caller the failure.
        _schedule_commit(client_slug, topic_slug)
        raise
    finally:
        # THE SPENT FORM GOES, ON EVERY EXIT PATH. IN A FINALLY, AND THAT IS THE POINT.
        #
        # The answers are spent, so the form the operator filled in is spent with them, and a
        # spent form left on disk is the stale file this feature already tripped over once.
        # answers.json stays: that is the durable record.
        #
        # This used to sit on the success path, where a crash or a stop skipped it, and skipping
        # it was a BLOG WITH NO EXIT. The operator answers a 96, this session crashes before the
        # clear, and the form stays on disk, iteration matched and answered. The resolver holds
        # the blog again while the app refuses a second submit because the form is already
        # answered, so nobody can answer it and nothing can ship it. _questions_state's new
        # "answered" value is the other half of that fix: it stops such a form reading as
        # current. Both halves are needed, because either alone leaves the other's window open.
        #
        # A "current" form is the ONE thing kept, and only when a clarified draft shipped: THIS
        # session's evaluator wrote it, it asks about the draft that is shipping right now, and
        # deleting it would throw away a live question and leave the topic held with nothing to
        # answer, which is the dead end this engine refuses to create. On every other path there
        # is no shipped clarified draft for such a form to describe, so it goes with the rest.
        #
        # A FORM IS SPENT BY A SCORED CLARIFIED DRAFT, NEVER BY A SESSION THAT DIED HOLDING IT.
        # That is the rule, and the restore paths are where it bites. A stop or a crash gives the
        # ORIGINAL bytes back and re-states the verdict they already carried, so nothing consumed
        # the answers: nothing read them through to an audited article. Where that re-stated
        # verdict is a HOLD, the form is the blog's ONLY door, and clearing it left a terminal
        # needs_review line with no form beside it. api_answers 404s on NoQuestions, so
        # revise_topic became unreachable and nothing could ever correct it: the operator was
        # summoned to a blog and handed no act to perform, which is the exact dead end with no
        # door the needs_review definition forbids, created by the fix for it. So a held topic
        # keeps its form and the operator can submit it again.
        #
        # KEEPING THE FORM IS THE WHOLE OF THE DOOR, and answers.json is deliberately NOT deleted
        # to open it. A second submit is not refused for being answered: api_answers refuses a
        # stale form and a live run and never consults answeredness at all, so the form has to
        # survive and be NOT STALE. Since migration 014 that is two conditions rather than one,
        # version OR iteration, and BOTH hold on this path. The iteration half is what
        # restored_iter above guarantees. The version half holds because a restore commits no new
        # version: the artifact set goes back byte for byte, so commit_topic finds the bytes
        # unchanged, inserts no blog_versions row, and the form's anchor still names the topic's
        # current version. answers.json stays because it is the durable record of what the
        # operator said, and write_answers overwrites it on the re-submit anyway.
        #
        # Where the re-stated verdict names no hold, the form goes, and the two rules agree rather
        # than compete. Nothing is waiting on an answer there, so there is no door to preserve,
        # and an answerable form left beside a done blog is a live question against an article
        # that already shipped: _enforce_terminal_status reads exactly that and corrects a done to
        # needs_review, so leaving it would hold a blog nobody asked to hold.
        #
        # Imported here, not at module scope: server.questions imports this module, so a
        # top-level import would close the cycle at startup, the same way facts_gen dodges it.
        from . import questions as questions_mod
        try:
            held = prev_terminal is not None and prev_terminal.get("status") == "needs_review"
            if clarified_shipped:
                if _questions_state(client_slug, topic_slug, root=run_dir_root) != "current":
                    questions_mod.clear_questions(client_slug, topic_slug, root=run_dir_root)
            elif not held:
                questions_mod.clear_questions(client_slug, topic_slug, root=run_dir_root)
        except Exception as exc:
            # A finally that raises REPLACES the exception on its way out, so a failure to tidy a
            # form would swallow the CancelledError a stop depends on and mask the traceback a
            # crash owes the operator. The form outliving this session is the lesser harm, and the
            # engine still refuses it as answered.
            print(f"[runner] could not clear questions for {client_slug}/{topic_slug}: {exc}",
                  file=sys.stderr)

        # Unlike run_batch, which hands this to app._batch_task, a revise owns its own lifecycle:
        # it is one topic and one session, and it is callable outside the API.
        finish_run(run_id)


# Strong references to in-flight ledger deliveries. asyncio keeps only a WEAK set of tasks, so a
# shielded delivery whose awaiter has been cancelled has no other owner and can be collected
# mid-write. That is the documented fire-and-forget footgun, and it would lose exactly the ledger
# entries this shield exists to save.
_PENDING_NOTIFIES = set()


async def _deliver(callback, payload):
    """Run the callback, swallowing whatever it raises.

    A callback is bookkeeping (appending to a ledger). Bookkeeping failing must never kill the blog
    that just finished, nor its siblings still in flight, so the exception is logged and dropped
    rather than propagating into gather. Swallowing also matters to the shield below: a detached
    task whose exception nobody retrieves gets reported at GC as an unhandled error, and this is
    the only place that could produce one.
    """
    try:
        await callback(payload)
    except Exception as exc:
        print(f"[runner] on_topic_done failed for {payload.get('topic_slug')}: {exc}",
              file=sys.stderr)


async def _notify(callback, payload):
    """Await the optional per-topic callback, SHIELDED from the caller's cancellation.

    The shield closes the one window where a stop can lose real, finished work. guarded() awaits
    this AFTER run_topic has returned, so the blog is already written, already scored, already
    checked and already terminal on disk. A cancel landing on a bare await here would abandon the
    ledger entry for a blog that shipped, and generated.csv is what dedupes the next batch: the
    topic would look ungenerated, so a later run would silently re-spend real quota rewriting a
    blog that is already finished, which is the one bill a stop button must never produce.

    Shield is the right instrument rather than a bigger hammer. It does NOT delay the stop: the
    CancelledError still propagates out of this await immediately, so the topic unwinds and the
    lock releases on the operator's timescale, while the delivery it protects finishes on its own
    in the background. The alternative, letting the entry go and reconciling from disk later, means
    the ledger is no longer the answer to what has been generated, and every reader of it grows a
    fallback. A shield is three lines and keeps one writer.

    The failure-path notify in guarded() is shielded by the same code and loses nothing by it: the
    ledger records only shipped blogs, so that call is already a no-op there.
    """
    if callback is None:
        return
    delivery = asyncio.ensure_future(_deliver(callback, payload))
    _PENDING_NOTIFIES.add(delivery)
    delivery.add_done_callback(_PENDING_NOTIFIES.discard)
    await asyncio.shield(delivery)


async def run_batch(client_slug, rows, *, on_topic_done=None, run_id=None):
    """Run every selected row for one client. return_exceptions=True because
    one failed topic must never cancel the other four in flight.

    on_topic_done, when given, is awaited ONCE PER TOPIC as that topic finishes,
    never at the end of the batch. The whole point of the semaphore design is
    that topic six starts the instant a slot frees, so a callback that fired at
    the final gather barrier would report every topic only after the slowest one
    landed, which is exactly the batch behavior this runner does not have.
    """
    async def guarded(position, row):
        topic_slug = row.get("topic_slug") or slugify(row.get("topic", ""))
        # The roadmap row index when the row carries one, so a ledger records
        # the operator's sheet position rather than an accident of selection.
        index = row.get("index", position)
        try:
            async with TOPIC_SEMAPHORE:
                result = await run_topic(client_slug, row,
                                         precheck_error=facts_error)
        except asyncio.CancelledError:
            # THE LEDGER ENTRY FOR A BLOG THAT SHIPPED ANYWAY. _notify's shield covers the window
            # from this await onward; this arm covers the window one await EARLIER, which was
            # open for the whole of a session's wind-down and is the likelier of the two to be hit.
            #
            # The lead runs status.py and writes done, then the session unwinds: a final assistant
            # message, a ResultMessage, the generator's aclose. Every one is an await, so a stop
            # landing anywhere in there cancels run_topic, whose own cancel arm correctly sees the
            # done line and keeps it. The blog is finished, on disk, terminal at 96. But
            # CancelledError is a BaseException, so `except Exception` below never sees it, the
            # notify at the end of this function is never reached, and no row is ever appended to
            # generated.csv. The ledger is what dedupes the next batch and there is no
            # reconciliation from disk anywhere, so the topic reads as ungenerated: it renders
            # selectable, Generate accepts it, and a full real session re-spends Firecrawl,
            # DataForSEO and model quota to overwrite a blog that already shipped, possibly with a
            # worse one. That is the one bill a stop button must never produce.
            #
            # Read the verdict from disk rather than from `result`, which cancellation means was
            # never assigned. Only a topic that actually reached done is reported: the ledger is
            # shipped blogs only, and a stopped topic is never appended to it.
            summary = _summarize(topic_slug, _read_status(output_dir(client_slug, topic_slug)))
            if summary["status"] == "done":
                await _notify(on_topic_done, dict(summary, row=row, index=index))
            raise
        except Exception as exc:
            # Report the failure through the same callback, then re-raise so
            # gather's return_exceptions still records it for the return value.
            # Released from the in-flight set FIRST: a failed topic is exactly
            # the one the operator wants to re-select, and holding it until the
            # batch ends refused the retry for as long as any sibling ran.
            mark_topic_terminal(run_id, topic_slug)
            await _notify(on_topic_done, {
                "topic_slug": topic_slug, "status": "failed", "score": None,
                "iterations": 0, "note": str(exc), "row": row, "index": index,
            })
            raise
        # Fire outside the semaphore: bookkeeping must not hold a slot that the
        # next topic is waiting on. The terminal release comes first for the same
        # reason as the failure arm's: this topic's session is over, its record is
        # committed (run_topic's own commit ran before it returned), and nothing
        # about it is in flight any more.
        mark_topic_terminal(run_id, topic_slug)
        await _notify(on_topic_done, dict(result, row=row, index=index))
        return result

    # THE BASELINES, BEFORE THE RUN QUEUES FOR THE LOCK.
    #
    # Taken here rather than inside guarded because the sweep below has to work for topics whose
    # guarded never ran at all, and taken before CLIENT_LOCK because that wait is where a stop is
    # MOST likely to land: the contract's own estimate of it is "many minutes", and a brand queued
    # behind another brand's twenty blogs sits here for all of them. See _status_baseline for why
    # the count and not the file.
    baselines = {}
    for position, row in enumerate(rows):
        topic_slug = row.get("topic_slug") or slugify(row.get("topic", ""))
        baselines[position] = (topic_slug, _status_baseline(output_dir(client_slug, topic_slug)))

    try:
        async with CLIENT_LOCK:
            # Acquiring the lock IS the start of this session: until now it was queued behind
            # whatever else held it. Recorded here rather than at submit time so a queued run
            # cannot masquerade as a working one.
            mark_running(run_id)

            # LAY THE CLIENT SCRATCH DOWN FROM THE RECORD, before the facts phase and before any
            # topic can spawn a session. Agents read clients/<slug>/ as real files (gates.json,
            # canonical-facts.md, Resources/), and materialize_client is what makes the disk
            # agree with the record: the has_canonical_facts read below is honest as a disk read
            # only because this ran first. Skipped when the record does not know the client (see
            # _materialize_client_scratch), which is what keeps test brands inert.
            #
            # A failure for a KNOWN client means the run cannot start correctly, and it takes the
            # SAME mark_run_error path a failed facts build takes, never a swallow: every topic
            # still gets its terminal failed line naming the real reason, and nothing is
            # dispatched against scratch the record could not lay down.
            facts_error = None
            try:
                await asyncio.to_thread(_materialize_client_scratch, client_slug)
            except Exception as exc:
                facts_error = (
                    f"clients/{client_slug} could not be materialized from the record, so no "
                    f"blog was written: {exc}"
                )
                mark_run_error(run_id, facts_error)
                print(f"[runner] {facts_error}", file=sys.stderr)

            # THE FACT BASE, BEFORE ANY TOPIC IS DISPATCHED, AND THE RUN WAITS FOR IT.
            #
            # canonical-facts.md is client scoped and every blog in this batch inherits it, so it is
            # built once per run and not once per topic. It happens INSIDE the lock, after
            # mark_running, because this is real work that belongs to this run: a session started
            # before the lock would run while another client's batch still held the engine, and it
            # would be invisible to the operator whose run had not started yet.
            #
            # Only a MISSING file is generated. A file carrying PLACEHOLDER is a human's unfinished
            # review: generating over it destroys their work, and running against it is what preflight
            # already refuses. Both wrong answers are avoided by not touching it, and run_topic's
            # preflight then refuses the run exactly as it does today.
            #
            # Imported here, not at module scope: facts_gen imports this module, so a top-level import
            # would close the cycle at startup. The old canonical-facts hook dodged it the same way.
            from . import facts_gen

            # ensure_facts commits the fact base to the record ITSELF (sync.commit_client_facts
            # runs inside it), so there is deliberately no facts commit anywhere in this module:
            # a second one here would be a double-commit of the same file.
            if facts_error is None and not has_canonical_facts(client_slug):
                mark_phase(run_id, "facts")
                try:
                    await facts_gen.ensure_facts(client_slug, run_id=run_id)
                except Exception as exc:
                    # Loud, and terminal for the whole run. There is deliberately no fall-through: a
                    # batch that wrote blogs against a missing fact base is the exact silent poisoning
                    # the contract's Preflight rule exists to prevent, and it would poison them
                    # quietly, twenty at a time, each one citing nothing.
                    facts_error = (
                        f"canonical-facts.md could not be built for {client_slug}, so no blog was "
                        f"written: {exc}"
                    )
                    mark_run_error(run_id, facts_error)
                    print(f"[runner] {facts_error}", file=sys.stderr)

            # The failure is carried into each topic rather than raised here. Every topic still needs
            # its own terminal failed line naming this reason: without one the SSE stream never closes
            # and the operator watches a run that hangs at queued forever, which is strictly worse than
            # a loud failure. run_topic refuses on precheck_error before any SDK session spawns, so
            # nothing is dispatched against a client with no facts and no blog is written.
            if facts_error is None:
                mark_phase(run_id, "topics")

            # Dispatch every topic at once; the semaphore admits five and topic six
            # starts the instant a slot frees.
            raw = await asyncio.gather(
                *(guarded(position, row) for position, row in enumerate(rows)),
                return_exceptions=True)
    except asyncio.CancelledError:
        # THE TOPICS NOBODY EVER DISPATCHED. Every arm before this one belongs to a topic that
        # got as far as a session; this one is for the topics that did not, and without it a stop
        # leaves them with no terminal line at all.
        #
        # Three ways to be one of them, and the first two are the common case rather than a
        # corner. The run is still QUEUED on CLIENT_LOCK behind another brand, so guarded has
        # never run and not one status.jsonl exists. The run is in the FACTS phase, inside the
        # lock, before any topic is dispatched. Or the run is live and topics six and up are
        # suspended at TOPIC_SEMAPHORE, which is any selection larger than five: the cancel lands
        # on the acquire, inside guarded but BEFORE run_topic, so run_topic's cancel arm, the only
        # thing that writes their stopped line, never runs.
        #
        # The SSE closer is what makes silence fatal. It closes only when every topic's own tail
        # has SEEN a terminal status, and it NEVER consults the run record, so marking the run
        # stopped does not save it: the operator presses Stop, /api/runs reports the run finished,
        # and their watch view heartbeats at "running" forever on a session that is already dead.
        # That is verbatim the harm TERMINAL_STATUSES was written to prevent.
        #
        # Ordering is what makes this a sweep and not a race. A cancelled gather cancels its
        # children and completes only once every one of them has finished unwinding, so by the
        # time this arm runs, topics one to five have already written their own lines through
        # run_topic. The guard inside _stop_line_if_unterminated then sees them and skips: this
        # writes for the silent topics only, and a topic that reached done keeps its done.
        for topic_slug, baseline in baselines.values():
            out_dir = output_dir(client_slug, topic_slug)
            out_dir.mkdir(parents=True, exist_ok=True)
            _stop_line_if_unterminated(
                client_slug, topic_slug, out_dir, baseline,
                "the operator stopped this brand before this topic reached a verdict",
            )
            # ONE COMMIT PER BASELINED TOPIC, after its stopped line lands: a stopped topic
            # commits too, because the frozen dossier is the expensive half of a blog and the
            # stop contract keeps it. Idempotent against the commit run_topic's own cancel arm
            # already scheduled for the dispatched topics. Fire-and-forget, never awaited: no
            # await lands between this sweep and the re-raise, so CancelledError propagates
            # exactly as before.
            _schedule_commit(client_slug, topic_slug)
        # NEVER swallow a cancellation, exactly as run_topic does not. CLIENT_LOCK releases on the
        # way out because `async with` unwinds on the exception path like any other, which is the
        # single highest-consequence line in this feature: a leaked lock bricks every brand in the
        # repo until someone restarts the API.
        raise

    results = []
    for row, outcome in zip(rows, raw):
        if isinstance(outcome, BaseException):
            results.append({
                "topic_slug": row.get("topic_slug") or slugify(row.get("topic", "")),
                "status": "failed",
                "score": None,
                "iterations": 0,
                "note": str(outcome),
            })
        else:
            results.append(outcome)
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m server.runner",
        description="Run one or more roadmap rows for a client, one SDK session per blog.",
    )
    parser.add_argument("--client", required=True, help="client slug under clients/")
    parser.add_argument("--row", required=True, type=int, action="append",
                        help="0-based roadmap row index; repeatable")
    args = parser.parse_args(argv)

    try:
        payload = roadmap.load_roadmap(args.client)
    except roadmap.RoadmapNotFound as exc:
        print(f"[runner] {exc}", file=sys.stderr)
        return 1

    try:
        rows = [payload["rows"][index] for index in args.row]
    except IndexError:
        print(f"[runner] row index out of range: roadmap has {len(payload['rows'])} rows",
              file=sys.stderr)
        return 1

    results = asyncio.run(run_batch(args.client, rows))
    print(json.dumps(results, indent=2))

    exit_code = 0
    for result in results:
        if result["status"] == "failed":
            print(f"[runner] FAILED {result['topic_slug']}: {result.get('note', 'see status.jsonl')}",
                  file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    sys.exit(_cli())
