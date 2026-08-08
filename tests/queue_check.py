#!/usr/bin/env python3
"""ONE QUEUE FOR EVERY BLOG. Spawns NOTHING and calls NO model.

The engine has exactly one place a blog session waits: `runner.TOPIC_SEMAPHORE`. `GEO_CONCURRENCY`
blogs run and defaults to 2, the rest queue, and a waiter starts the instant a slot frees,
whichever door the blog came in by:

  - the Create tab's batch, and a retry, which are the same route with different row counts
  - the answer-driven revise a client's answers are owed
  - a repurpose (LinkedIn, Medium), which is a blog session by any other name

What this file pins is the property the queue exists FOR, which is not "there is a semaphore"
but "the doors share it". Every regression this change fixed was a door that had its own
answer: the revise took a repo-wide lock instead of a slot, so it was refused at the API rather
than queued, and a batch held that same lock across its whole gather, so a second submit waited
for twenty blogs rather than for one slot and a second brand could not use the four idle slots
the first brand's tail left behind.

Time is measured in SLOT OCCUPANCY, never in wall clock: each fake session records when it
entered and left, so the assertions are about overlap and ordering rather than about sleeps
being long enough on a loaded machine.

  .venv/bin/python tests/queue_check.py
"""
import asyncio
import json
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import repurpose, runner  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def _rows(n, prefix="topic"):
    return [{"topic": f"Topic {i}", "topic_slug": f"{prefix}-{i}", "index": i} for i in range(n)]


class _Roots:
    """Point every output root at a temp dir, stub the fact base, save every session seam.

    Identical in purpose to stop_check's, and deliberately a second copy rather than an import:
    that file's harness restores exactly the two seams its own tests patch, and this one patches
    a third (repurpose._sdk_session). Sharing it would make each suite's cleanup depend on the
    other suite's patch list, which is how a fake leaks into a neighbouring file and fails it
    somewhere unrelated.

    THE QUEUE ITSELF IS REPLACED PER TEST, which is not tidiness. An asyncio.Semaphore binds to
    the loop that first awaits it, so the module-level one carries both its loop and its held
    count from whichever test ran first; the second test then raises "bound to a different event
    loop" and, worse, would inherit a partly-drained cap and quietly assert against a queue of
    four. Every test gets a full five in its own loop. _FACTS_LOCKS is cleared for the same
    reason one level down.
    """

    def __enter__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = {
            "root": runner.OUTPUTS_ROOT,
            "facts": runner.has_canonical_facts,
            "facts_path": runner.canonical_facts_path,
            "session": runner._sdk_session,
            "revise": runner._sdk_revise_session,
            "repurpose": repurpose._sdk_session,
            "semaphore": runner.TOPIC_SEMAPHORE,
            "materialize_topic": runner._materialize_topic_scratch,
            "materialize_client": runner._materialize_client_scratch,
            "commit": runner._schedule_commit,
            "approved": runner._approved_refusal,
            "row": runner._row_for_topic,
        }
        runner.OUTPUTS_ROOT = Path(self.tmp.name)
        runner.TOPIC_SEMAPHORE = asyncio.Semaphore(5)
        runner._FACTS_LOCKS.clear()
        # The held-slot table, for the same reason the semaphore is replaced: it is module state
        # that outlives one test's loop, and a slot left behind by a previous test would be swept
        # by the next one's watchdog tick against a task from a dead loop.
        runner._SLOTS.clear()
        # THE RECORD IS OUT OF SCOPE HERE AND MUST ALSO BE OUT OF THE WAY. Both materialize
        # hooks and the commit reach Postgres, and they run INSIDE a held slot: on a machine
        # whose database is slow or absent they dominate the fake session entirely, so five
        # topics that should overlap trickle through one at a time and the peak reads 1 against
        # a queue that is working perfectly. Stubbed to no-ops, which is what they already are
        # for a brand the record does not know.
        runner._materialize_topic_scratch = lambda *a, **k: None
        runner._materialize_client_scratch = lambda *a, **k: None
        runner._schedule_commit = lambda *a, **k: None
        # The approved lock is the worst of them for this suite, because it is called
        # SYNCHRONOUSLY rather than through to_thread (deliberately: an await there would be a
        # cancellation point outside the arm that writes the terminal line). One indexed SELECT
        # on the event loop is nothing beside a real minutes-long session, and everything beside
        # a fake one: it turns the five acquires into five round trips in series.
        runner._approved_refusal = lambda *a, **k: None
        # revise_topic's roadmap lookup, synchronous inside the slot for the same reason.
        runner._row_for_topic = lambda *a, **k: None
        runner.has_canonical_facts = lambda slug, **k: True
        facts = Path(self.tmp.name) / "canonical-facts.md"
        facts.write_text("# reviewed sandbox fact base, no placeholder\n", encoding="utf-8")
        runner.canonical_facts_path = lambda slug, clients_root=None: facts
        return Path(self.tmp.name)

    def __exit__(self, *exc):
        runner.OUTPUTS_ROOT = self.saved["root"]
        runner.TOPIC_SEMAPHORE = self.saved["semaphore"]
        runner._FACTS_LOCKS.clear()
        runner._SLOTS.clear()
        runner.has_canonical_facts = self.saved["facts"]
        runner.canonical_facts_path = self.saved["facts_path"]
        runner._sdk_session = self.saved["session"]
        runner._sdk_revise_session = self.saved["revise"]
        repurpose._sdk_session = self.saved["repurpose"]
        runner._materialize_topic_scratch = self.saved["materialize_topic"]
        runner._materialize_client_scratch = self.saved["materialize_client"]
        runner._schedule_commit = self.saved["commit"]
        runner._approved_refusal = self.saved["approved"]
        runner._row_for_topic = self.saved["row"]
        self.tmp.cleanup()


class Occupancy:
    """Who holds a slot right now, and what the peak was.

    A session enters, the count rises, it leaves, the count falls. `peak` is the only number the
    cap assertion needs and `order` is the only one the fairness assertion needs, so nothing here
    reads a clock: a test that asserted "five started within 50ms" would be asserting something
    about the machine it runs on.
    """

    def __init__(self):
        self.live = 0
        self.peak = 0
        self.order = []
        self.released = asyncio.Event()

    async def hold(self, label, until=None):
        self.live += 1
        self.peak = max(self.peak, self.live)
        self.order.append(label)
        try:
            await (until.wait() if until is not None else asyncio.sleep(0))
        finally:
            self.live -= 1
            self.released.set()


def _lead_wrote_done(out_dir, topic_slug):
    """What a real session lead does on its way out: one terminal line.

    Every fake below calls it, because run_topic RETRIES a session that returned without one
    (server/runner.py's attempt loop) and a retry runs the fake twice. That doubles the slot
    acquisitions and turns "eight blogs ran" into fourteen, which reads as a queue leak in a
    test whose whole subject is the queue.
    """
    runner._status_module().append_status(
        str(out_dir), topic_slug, stage="eval", event="end", iter=1, score=96,
        status="done", note="fake session")


def _terminal_statuses(client, slug):
    path = runner.output_dir(client, slug) / "status.jsonl"
    if not path.is_file():
        return []
    return [
        line["status"]
        for line in (json.loads(raw) for raw in path.read_text().splitlines() if raw.strip())
        if line.get("status") in runner.TERMINAL_STATUSES
    ]


def _seed_shipped_blog(client, slug):
    """A finished topic, which is the only kind a revise may be opened on."""
    out = runner.output_dir(client, slug)
    out.mkdir(parents=True, exist_ok=True)
    (out / "blog.md").write_text("the draft that scored 96", encoding="utf-8")
    (out / "eval.md").write_text("SCORE: 96\n", encoding="utf-8")
    runner._status_module().append_status(
        str(out), slug, stage="eval", event="end", iter=1, score=96, status="done", note="shipped")
    return out


# ---------------------------------------------------------------------------
# The cap, across every door
# ---------------------------------------------------------------------------

def test_the_cap_holds_across_every_door_at_once():
    """A batch, a revise and a repurpose submitted together never exceed five in flight.

    THE ASSERTION THAT MATTERS IS peak == 5 AND NOT peak <= 5. Under the old design the revise
    took a repo-wide lock rather than a slot, so it ran BESIDE a saturated queue and the true
    peak was six; a <= assertion would have passed on the bug for as long as the batch was small
    enough to leave the semaphore unsaturated.
    """
    async def scenario():
        with _Roots():
            seen = Occupancy()
            gate = asyncio.Event()

            async def batch_session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold(f"batch:{topic_slug}", until=gate)
                _lead_wrote_done(out_dir, topic_slug)

            async def revise_session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold(f"revise:{topic_slug}", until=gate)
                _lead_wrote_done(out_dir, topic_slug)

            async def repurpose_session(client_slug, source_topic_slug, channel, out_dir):
                (out_dir / "post.md").write_text("post", encoding="utf-8")
                await seen.hold(f"repurpose:{source_topic_slug}", until=gate)

            runner._sdk_session = batch_session
            runner._sdk_revise_session = revise_session
            repurpose._sdk_session = repurpose_session
            _seed_shipped_blog("brand", "answered")

            work = [
                asyncio.create_task(runner.run_batch("brand", _rows(6))),
                asyncio.create_task(runner.revise_topic("brand", "answered")),
                asyncio.create_task(repurpose.run_repurpose(
                    "brand", "answered", "linkedin", "body", run_id="rp")),
            ]
            # Long enough for every one of the eight to reach its acquire; the assertion is on
            # the peak, so an extra tick only makes a leak MORE visible, never less.
            await asyncio.sleep(0.2)
            holding = seen.live
            gate.set()
            await asyncio.gather(*work, return_exceptions=True)

            check("five blogs hold slots and the sixth waits, mixed doors included",
                  holding == 5, f"{holding} sessions were live at once")
            check("the peak never exceeds the cap over the whole run",
                  seen.peak == 5, f"peak was {seen.peak}")
            check("every submitted blog eventually ran",
                  len(seen.order) == 8, f"{len(seen.order)} of 8 ran: {seen.order}")

    asyncio.run(scenario())


def test_a_revise_takes_a_slot_rather_than_running_beside_the_queue():
    """The narrow version of the check above, so a failure names the door that broke.

    A revise dispatched against a SATURATED queue must not open a session at all until a slot
    frees. This is the whole reason the two revise routes may now queue instead of refusing:
    the 409 they used to raise was standing in for a slot the revise never took.
    """
    async def scenario():
        with _Roots():
            seen = Occupancy()
            gate = asyncio.Event()

            async def batch_session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold(f"batch:{topic_slug}", until=gate)
                _lead_wrote_done(out_dir, topic_slug)

            async def revise_session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold("revise", until=gate)
                _lead_wrote_done(out_dir, topic_slug)

            runner._sdk_session = batch_session
            runner._sdk_revise_session = revise_session
            _seed_shipped_blog("brand", "answered")

            batch = asyncio.create_task(runner.run_batch("brand", _rows(5)))
            await asyncio.sleep(0.1)
            revise = asyncio.create_task(runner.revise_topic("brand", "answered"))
            await asyncio.sleep(0.1)

            check("a revise behind a full queue opens no session",
                  "revise" not in seen.order, f"order was {seen.order}")
            gate.set()
            await asyncio.gather(batch, revise, return_exceptions=True)
            check("and it runs once slots free, rather than being dropped",
                  "revise" in seen.order, f"order was {seen.order}")

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# The granularity: one blog, not one batch
# ---------------------------------------------------------------------------

def test_a_second_brand_fills_slots_the_first_brand_is_not_using():
    """THE BATCH-GRANULARITY BUG, pinned. Two brands, three blogs each, one queue of five.

    Under the repo-wide lock the second brand's run could not start until the first brand's LAST
    blog finished, so three slots sat idle for the whole of the first batch. Under the shared
    queue five of the six run at once and the sixth takes the first free slot.
    """
    async def scenario():
        with _Roots():
            seen = Occupancy()
            gate = asyncio.Event()

            async def session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold(f"{client_slug}:{topic_slug}", until=gate)
                _lead_wrote_done(out_dir, topic_slug)

            runner._sdk_session = session
            first = asyncio.create_task(runner.run_batch("alpha", _rows(3, "a")))
            second = asyncio.create_task(runner.run_batch("beta", _rows(3, "b")))
            await asyncio.sleep(0.2)
            live_brands = {label.split(":")[0] for label in seen.order}
            holding = seen.live
            gate.set()
            await asyncio.gather(first, second, return_exceptions=True)

            check("both brands are working at once, not one batch then the other",
                  live_brands == {"alpha", "beta"}, f"brands in flight: {live_brands}")
            check("and together they fill the queue rather than half of it",
                  holding == 5, f"{holding} sessions were live at once")

    asyncio.run(scenario())


def test_the_sixth_blog_starts_when_a_slot_frees_not_when_the_batch_ends():
    """No batch barrier. The engine's oldest concurrency claim, still true through the change."""
    async def scenario():
        with _Roots():
            seen = Occupancy()
            gates = {row["topic_slug"]: asyncio.Event() for row in _rows(6)}

            async def session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold(topic_slug, until=gates[topic_slug])
                _lead_wrote_done(out_dir, topic_slug)

            runner._sdk_session = session
            batch = asyncio.create_task(runner.run_batch("brand", _rows(6)))
            await asyncio.sleep(0.1)
            started_first = list(seen.order)
            # Free exactly ONE slot. The other four sessions are still holding theirs.
            gates["topic-0"].set()
            await asyncio.sleep(0.1)
            sixth_started = len(seen.order) == 6 and seen.live == 5

            for event in gates.values():
                event.set()
            await asyncio.gather(batch, return_exceptions=True)

            check("exactly the first five start", len(started_first) == 5,
                  f"started {started_first}")
            check("the sixth starts on ONE freed slot, with four still held",
                  sixth_started, f"order {seen.order}, live {seen.live}")

    asyncio.run(scenario())


# ---------------------------------------------------------------------------
# What the operator is told while they wait
# ---------------------------------------------------------------------------

def test_a_run_whose_blogs_are_all_queued_reads_queued():
    """`state` answers "did the engine pick this up", and a queued run must not claim otherwise.

    This is the honesty rule the old design got for free from the lock: a run reported running
    the moment it took the lock, which was also the moment its first topic could start. With the
    lock gone the two moments came apart, so mark_running moved to the first SLOT (or the fact
    base build, which is this run's own work either way).
    """
    async def scenario():
        with _Roots():
            seen = Occupancy()
            gate = asyncio.Event()

            async def session(client_slug, row, topic_slug, out_dir, *a, **k):
                await seen.hold(topic_slug, until=gate)
                _lead_wrote_done(out_dir, topic_slug)

            runner._sdk_session = session
            runner.register_run("filler", "brand", [])
            filler = asyncio.create_task(
                runner.run_batch("brand", _rows(5), run_id="filler"))
            await asyncio.sleep(0.1)

            runner.register_run("waiting", "brand", [])
            waiter = asyncio.create_task(
                runner.run_batch("brand", _rows(1, "late"), run_id="waiting"))
            await asyncio.sleep(0.1)

            queued = runner.get_run("waiting")["state"]
            running = runner.get_run("filler")["state"]
            started_at = runner.get_run("filler")["started_running"]
            gate.set()
            await asyncio.gather(filler, waiter, return_exceptions=True)
            promoted = runner.get_run("waiting")["state"]

            check("a run with every blog still queued reports queued",
                  queued == "queued", f"reported {queued}")
            check("a run holding slots reports running", running == "running",
                  f"reported {running}")
            check("its start stamp is the FIRST slot, not the fifth",
                  started_at == runner.get_run("filler")["started_running"],
                  "started_running moved while the batch was working")
            check("and the waiter is promoted once it gets a slot",
                  promoted == "running", f"reported {promoted}")
            for run_id in ("filler", "waiting"):
                runner.RUNS.pop(run_id, None)

    asyncio.run(scenario())


def test_every_queued_blog_still_reaches_a_terminal_line():
    """The queue may never strand a topic: a blog that waited and then ran must terminate, or
    its SSE stream never closes and the operator watches a dead session heartbeat forever."""
    async def scenario():
        with _Roots():
            async def session(client_slug, row, topic_slug, out_dir, *a, **k):
                await asyncio.sleep(0)
                _lead_wrote_done(out_dir, topic_slug)

            runner._sdk_session = session
            rows = _rows(9)
            await runner.run_batch("brand", rows)
            missing = [row["topic_slug"] for row in rows
                       if not _terminal_statuses("brand", row["topic_slug"])]
            check("all nine terminate, five in the first wave and four from the queue",
                  not missing, f"no terminal line for {missing}")

    asyncio.run(scenario())


def _only_slot():
    """The one held slot, by identity rather than by token: the token is a process-wide counter,
    so the second test to run would index a key the first test consumed."""
    return next(iter(runner._SLOTS.values()))


def test_a_wedged_session_gives_its_slot_back():
    """THE QUEUE CANNOT BE BRICKED BY A SESSION THAT STOPS RESPONDING.

    A slot used to be held by a coroutine, and a coroutine that never unwinds never releases:
    `async with` runs its exit on the cancel path like any other, but a task suspended inside
    asyncio.to_thread never RESUMES to take that path, because a thread cannot be cancelled. Two
    of those at the default width halted every brand in the repo until someone restarted the API,
    with no error and no log line, and a dashboard that read exactly like an idle engine.

    The wedge here swallows CancelledError in a loop, which is a faithful in-process stand-in: the
    engine asks it to stop, it does not stop, and the watchdog must not need its cooperation.
    Clocks are INJECTED rather than slept through, because a test that waited out a 45-minute
    stall window is a test nobody runs.
    """
    async def scenario():
        with _Roots() as root:
            # One slot, so the wedge is the whole engine and the queue behind it is provable.
            runner.TOPIC_SEMAPHORE = asyncio.Semaphore(1)
            out_dir = root / "brand" / "wedged"
            out_dir.mkdir(parents=True)
            (out_dir / "status.jsonl").write_text(
                json.dumps({"ts": "2026-08-08T00:00:00+00:00", "slug": "wedged",
                            "stage": "research", "event": "start", "iter": 1,
                            "status": "running", "note": ""}) + "\n", encoding="utf-8")

            stop = asyncio.Event()

            async def wedged():
                async with runner.topic_slot("brand", "wedged", out_dir):
                    while not stop.is_set():
                        try:
                            await stop.wait()
                        except asyncio.CancelledError:
                            pass  # exactly what a task stuck in a thread does

            held = asyncio.create_task(wedged())
            await asyncio.sleep(0)
            check("the wedged session holds the only slot",
                  runner.TOPIC_SEMAPHORE._value == 0 and len(runner._SLOTS) == 1)

            started = []

            async def waiter():
                async with runner.topic_slot("brand", "next", root / "brand" / "next"):
                    started.append(True)

            queued = asyncio.create_task(waiter())
            await asyncio.sleep(0)
            check("every other blog is queued behind it", not started)

            now, stall = time.time(), runner._stall_timeout()

            # A tick INSIDE the stall window must do nothing at all: a real session goes minutes
            # between stage lines, and a watchdog that cancelled on that would kill healthy blogs.
            runner._sweep_slots(now=now + stall - 1)
            check("a quiet blog inside the stall window is left alone",
                  len(runner._SLOTS) == 1 and _only_slot()["cancelled_at"] is None)

            # Past it: cancel first, and ONLY cancel. A cooperative session would end here.
            runner._sweep_slots(now=now + stall + 1)
            await asyncio.sleep(0)
            check("the first tick past the window cancels without taking the slot",
                  len(runner._SLOTS) == 1 and not started)

            # The cancel was ignored, so the slot is reclaimed out from under it.
            freed = runner._sweep_slots(now=now + stall + runner.SLOT_GRACE_SECONDS + 2)
            check("an ignored cancel costs the session its slot", len(freed) == 1)

            await asyncio.wait_for(queued, 2)
            check("the queued blog starts on the reclaimed slot", started == [True])

            lines = runner._read_status(out_dir)
            terminal = [l for l in lines if l.get("status") in runner.TERMINAL_STATUSES]
            check("the reclaimed topic gets its terminal line, so no stream hangs on it",
                  len(terminal) == 1 and terminal[0]["status"] == "failed",
                  f"terminal lines: {terminal}")

            # THE OVER-RELEASE GUARD. The holder eventually unwinds and its finally calls the same
            # release the watchdog already called. A second release would raise the cap for the
            # life of the process, which is the leak with its sign flipped.
            stop.set()
            await asyncio.wait_for(held, 2)
            check("the wedged holder's own release is a no-op, so the cap is not raised",
                  runner.TOPIC_SEMAPHORE._value == 1 and not runner._SLOTS,
                  f"value {runner.TOPIC_SEMAPHORE._value}, slots {runner._SLOTS}")

    asyncio.run(scenario())


def test_progress_keeps_a_long_blog_alive_forever():
    """A BLOG IS JUDGED ON MOVEMENT, NEVER ON WALL CLOCK, and that is why this is not a timeout.

    The obvious fix was a cap on session duration. It punishes the common case (a real blog runs
    for tens of minutes and a pillar longer) to catch the rare one, and against the actual wedge
    it does not even work, because asyncio.wait_for awaits the cancellation it just requested. The
    signal used instead is the topic's own append-only status feed: while it grows, the session is
    alive, for as long as it likes.
    """
    async def scenario():
        with _Roots() as root:
            runner.TOPIC_SEMAPHORE = asyncio.Semaphore(1)
            out_dir = root / "brand" / "slow"
            out_dir.mkdir(parents=True)
            feed = out_dir / "status.jsonl"
            feed.write_text("", encoding="utf-8")

            stop = asyncio.Event()

            async def slow():
                async with runner.topic_slot("brand", "slow", out_dir):
                    await stop.wait()

            task = asyncio.create_task(slow())
            await asyncio.sleep(0)

            now, stall = time.time(), runner._stall_timeout()
            # Five stall windows of elapsed time, with one line written per window. Under a
            # duration cap this blog is long dead; here it is simply working.
            for step in range(1, 6):
                with feed.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({"ts": "2026-08-08T00:00:00+00:00", "slug": "slow",
                                             "stage": "write", "event": "start", "iter": step,
                                             "status": "running", "note": ""}) + "\n")
                runner._sweep_slots(now=now + step * (stall - 1))

            check("a session that keeps writing is never cancelled, however long it runs",
                  len(runner._SLOTS) == 1 and _only_slot()["cancelled_at"] is None)

            state = runner.queue_state()
            check("the queue reports who holds the slot and how long since it moved",
                  state["in_use"] == 1 and state["slots"][0]["topic_slug"] == "slow"
                  and state["slots"][0]["cancelled"] is False,
                  json.dumps(state))

            stop.set()
            await asyncio.wait_for(task, 2)
            check("and it gives the slot back on its own", runner.TOPIC_SEMAPHORE._value == 1)

    asyncio.run(scenario())


TESTS = [
    test_the_cap_holds_across_every_door_at_once,
    test_a_revise_takes_a_slot_rather_than_running_beside_the_queue,
    test_a_second_brand_fills_slots_the_first_brand_is_not_using,
    test_the_sixth_blog_starts_when_a_slot_frees_not_when_the_batch_ends,
    test_a_run_whose_blogs_are_all_queued_reads_queued,
    test_every_queued_blog_still_reaches_a_terminal_line,
    test_a_wedged_session_gives_its_slot_back,
    test_progress_keeps_a_long_blog_alive_forever,
]


def main():
    for test in TESTS:
        print(f"\n{test.__name__}")
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("queue_check FAILED: " + "; ".join(FAILURES))
        return 1
    print("queue_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
