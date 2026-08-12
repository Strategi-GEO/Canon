#!/usr/bin/env python3
"""Stopping ONE topic: the queue table's per-row control. No DB, no model, no session.

DELETE /api/clients/<slug>/runs is unchanged and is still the right button for ending a brand's
work in one press. This is the other scope: the queue table lists topics one per row, so its row
control has to reach one row, and reaching it through the brand-wide stop would take four other
blogs down with it.

The two halves are DIFFERENT MECHANISMS and that is the whole reason this file exists:

  RUNNING  the topic holds a slot, _SLOTS has its task, and cancelling it is the same act the
           watchdog already performs on a wedged one.
  QUEUED   there is NO task. The topic is a coroutine inside its batch's task parked on
           TOPIC_SEMAPHORE.acquire(), and cancelling the batch would kill every sibling. So the
           queue carries a withdrawal set and topic_slot consults it.

What is pinned, in order of how badly each one bites:

  1. THE WITHDRAWAL IS CHECKED ON BOTH SIDES OF THE ACQUIRE. A topic can be admitted between the
     operator's press and the check, so a guard that only looked BEFORE would let a withdrawn
     topic run while the table showed it gone. This is the race the second check exists for and
     the one a reader is most likely to drop as redundant.
  2. A WITHDRAWN TOPIC DOES NOT CONSUME A SLOT. If it took one and then raised, the topic behind
     it would wait for nothing.
  3. AN UNKNOWN TOPIC IS None, not a cheerful success. The semaphore cannot enumerate its waiters,
     so the run registry answers "is this queued", and a topic no live run names is a 404.
  4. THE WITHDRAWAL IS CONSUMED. It must not persist and silently kill the next legitimate run of
     the same topic.

  .venv/bin/python tests/stop_topic_check.py
"""
import asyncio
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import runner  # noqa: E402

FAILED = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}{(': ' + detail) if detail else ''}")
        FAILED.append(label)


def reset():
    runner.RUNS.clear()
    runner._SLOTS.clear()
    runner._CANCELLED_TOPICS.clear()


def which_branch():
    """stop_topic's three answers, from the registry alone."""
    print("which branch stop_topic takes")
    reset()
    check("a topic nobody is running is None", runner.stop_topic("acme", "ghost") is None)

    runner.register_run("r1", "acme", [{"topic_slug": "t1"}, {"topic_slug": "t2"}])
    check("a topic a LIVE run names is queued", runner.stop_topic("acme", "t1") == "queued")
    check("and the withdrawal is recorded",
          ("acme", "t1") in runner._CANCELLED_TOPICS)
    check("another brand's identically named topic is None",
          runner.stop_topic("other", "t1") is None)

    runner.mark_run_stopped("r1")
    check("a topic whose run is no longer live is None",
          runner.stop_topic("acme", "t2") is None,
          "a settled run must not offer topics to stop")
    reset()


def withdrawn_before_acquire():
    """Withdrawn while the queue was long: never takes a slot at all."""
    print("withdrawn BEFORE the acquire")
    reset()

    async def go():
        with tempfile.TemporaryDirectory() as tmp:
            runner.withdraw_topic("acme", "t1")
            free_before = runner.TOPIC_SEMAPHORE._value
            raised = False
            try:
                async with runner.topic_slot("acme", "t1", Path(tmp)):
                    pass
            except runner.TopicWithdrawn:
                raised = True
            return raised, free_before, runner.TOPIC_SEMAPHORE._value

    raised, before, after = asyncio.run(go())
    check("topic_slot raises TopicWithdrawn", raised)
    check("and no slot was consumed", before == after, f"{before} -> {after}")
    check("and the withdrawal is spent, so a later run of the same topic is not killed",
          ("acme", "t1") not in runner._CANCELLED_TOPICS)
    reset()


def withdrawn_during_acquire():
    """THE RACE. The press lands while this topic is parked on the acquire, which is exactly where
    a queued topic spends its whole life. A guard that only checked before the acquire misses it."""
    print("withdrawn DURING the acquire (the race the second check is for)")
    reset()

    async def go():
        with tempfile.TemporaryDirectory() as tmp:
            # Drain the semaphore so the topic under test genuinely has to wait, which is the
            # only state in which the race is reachable.
            held = []
            while runner.TOPIC_SEMAPHORE._value > 0:
                await runner.TOPIC_SEMAPHORE.acquire()
                held.append(1)

            raised = {"v": False}

            async def waiter():
                try:
                    async with runner.topic_slot("acme", "t1", Path(tmp)):
                        pass
                except runner.TopicWithdrawn:
                    raised["v"] = True

            task = asyncio.create_task(waiter())
            # Let it reach the acquire and block there. It passed the FIRST check already.
            await asyncio.sleep(0.05)
            check("it is parked on the acquire, past the first check", not task.done())

            # The operator presses stop now, then a slot frees.
            runner.withdraw_topic("acme", "t1")
            for _ in held:
                runner.TOPIC_SEMAPHORE.release()
            await asyncio.wait_for(task, timeout=2)
            return raised["v"]

    caught = asyncio.run(go())
    check("the SECOND check catches it, so a withdrawn topic never starts", caught,
          "it acquired a slot and ran anyway")
    check("and the slot it briefly held was given straight back",
          runner.TOPIC_SEMAPHORE._value == runner._concurrency(),
          f"{runner.TOPIC_SEMAPHORE._value} free of {runner._concurrency()}")
    reset()


def running_topic_is_cancelled():
    """A topic holding a slot: its own task is cancelled, and only that one."""
    print("a RUNNING topic")
    reset()

    async def go():
        with tempfile.TemporaryDirectory() as tmp:
            started = asyncio.Event()
            cancelled = {"mine": False, "sibling": False}

            async def hold(topic, flag):
                async with runner.topic_slot("acme", topic, Path(tmp)):
                    started.set()
                    try:
                        await asyncio.sleep(30)
                    except asyncio.CancelledError:
                        cancelled[flag] = True
                        raise

            mine = asyncio.create_task(hold("t1", "mine"))
            sibling = asyncio.create_task(hold("t2", "sibling"))
            await asyncio.sleep(0.05)

            found = runner.find_slot("acme", "t1")
            verdict = runner.stop_topic("acme", "t1")
            await asyncio.sleep(0.05)
            # READ THE SIBLING BEFORE THE TEST TOUCHES IT. Asserting after the cleanup cancel
            # below would be asserting nothing at all: it is cancelled either way by then.
            sibling_survived = not cancelled["sibling"] and not sibling.done()

            sibling.cancel()
            for task in (mine, sibling):
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            return found is not None, verdict, cancelled, sibling_survived

    had_slot, verdict, cancelled, sibling_survived = asyncio.run(go())
    check("it is found in the slot registry", had_slot)
    check('stop_topic answers "running"', verdict == "running")
    check("its own task is cancelled", cancelled["mine"])
    check("AND ITS SIBLING IS STILL RUNNING: this is per topic, not per brand",
          sibling_survived,
          "stopping one topic took another one down with it")
    check("no withdrawal is recorded for a running topic",
          ("acme", "t1") not in runner._CANCELLED_TOPICS,
          "a cancel and a withdrawal are different acts and must not both fire")
    reset()


if __name__ == "__main__":
    which_branch()
    withdrawn_before_acquire()
    withdrawn_during_acquire()
    running_topic_is_cancelled()
    print()
    if FAILED:
        print(f"{len(FAILED)} check(s) failed")
        sys.exit(1)
    print("stop_topic_check passed")
