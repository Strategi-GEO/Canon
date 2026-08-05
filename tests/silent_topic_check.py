#!/usr/bin/env python3
"""A SETTLED RUN LEAVES NO SILENT TOPIC, and a settled run's stream always closes.

Spawns NOTHING, calls NO model, touches NO real DB.

The bug: the SSE closer waits for every topic's tail to SEE a terminal status and never consults
the run record, so one topic that wrote no line at all kept a finished run's stream open forever.
Its row read "queued" with nothing running, on a run that had ended, and there was no door out of
that state: no timeout, and no way to retry a row the surface still believed was in flight. Only
the CANCEL path swept for silent topics; a run that died any other way above the gather left them
that way.

  .venv/bin/python tests/silent_topic_check.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import app, runner  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def read_lines(out_dir):
    path = out_dir / "status.jsonl"
    if not path.is_file():
        return []
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def test_a_silent_topic_gets_its_failed_line():
    print("\ntest_a_silent_topic_gets_its_failed_line")
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp) / "silent-topic"
        out_dir.mkdir()
        wrote = runner._fail_line_if_unterminated(
            "brand", "silent-topic", out_dir, 0, "the run ended before this topic reached a verdict")
        check("a line is written", wrote)
        lines = read_lines(out_dir)
        check("exactly one line", len(lines) == 1, str(lines))
        check("it is terminal failed", lines and lines[0]["status"] == "failed", str(lines))
        check("the event is end, so a tail reads it as terminal",
              lines and lines[0]["event"] == "end", str(lines))


def test_a_topic_that_already_shipped_is_never_demoted():
    print("\ntest_a_topic_that_already_shipped_is_never_demoted")
    # The guard the stop sweep already carries: status.jsonl is append-only and every surface
    # reads the LAST terminal line, so an unguarded append here demotes a blog that shipped.
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp) / "shipped"
        out_dir.mkdir()
        runner._status_module().append_status(str(out_dir), "shipped", stage="eval", event="end",
                             iter=1, score=96, status="done", note="ships")
        wrote = runner._fail_line_if_unterminated("brand", "shipped", out_dir, 0, "swept")
        check("nothing is written over a done topic", not wrote)
        lines = read_lines(out_dir)
        check("the done line still stands alone", len(lines) == 1 and lines[0]["status"] == "done",
              str(lines))


def test_the_stream_closes_when_the_run_settles_even_with_a_silent_topic():
    print("\ntest_the_stream_closes_when_the_run_settles_even_with_a_silent_topic")

    async def run():
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            loud = runner.output_dir("brand", "loud-topic", root=root)
            loud.mkdir(parents=True)
            silent = runner.output_dir("brand", "silent-topic", root=root)
            silent.mkdir(parents=True)
            runner._status_module().append_status(str(loud), "loud-topic", stage="eval", event="end",
                                 iter=1, score=96, status="done", note="ships")

            original = runner.output_dir
            runner.output_dir = lambda c, t, root=None: original(c, t, root=Path(tmp))
            try:
                run_record = {
                    "run_id": "r1", "client": "brand", "live": True,
                    "topics": [{"topic_slug": "loud-topic", "tail_offset": 0},
                               {"topic_slug": "silent-topic", "tail_offset": 0}],
                }
                stream = app._event_stream(run_record)
                frames = []
                # Two polls while live: the silent tail never turns terminal, so the old closer
                # could not fire and this loop would run forever without the settle check.
                for _ in range(2):
                    frames.append(await anext(stream))
                check("the loud topic's line is streamed",
                      any("loud-topic" in f for f in frames), str(frames))

                run_record["live"] = False  # finish_run's effect, whatever ended the run
                closing = None
                for _ in range(4):
                    frame = await anext(stream, None)
                    if frame is None or frame.startswith("event: run"):
                        closing = frame
                        break
                check("the stream closes once the run settles", closing is not None)
                check("the closing frame reports the run not live",
                      closing is not None and '"live": false' in closing, str(closing))
                check("the generator is exhausted after closing",
                      await anext(stream, None) is None)
            finally:
                runner.output_dir = original

    asyncio.run(run())


def main():
    print("silent_topic_check: static checks only. No CLI spawned, no model called.")
    for test in (test_a_silent_topic_gets_its_failed_line,
                 test_a_topic_that_already_shipped_is_never_demoted,
                 test_the_stream_closes_when_the_run_settles_even_with_a_silent_topic):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
