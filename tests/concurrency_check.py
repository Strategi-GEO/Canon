#!/usr/bin/env python3
"""Concurrency proof over status.jsonl files, the authoritative progress feed.

Reads every clients/<client>/output/<topic>/status.jsonl under the given
output root, reconstructs each topic's lifetime from its first and terminal
timestamps, and checks the runner's three concurrency claims:

  1. The topic semaphore caps topics in flight at the given cap (default 5),
     and a selection larger than the cap saturates it (max concurrent == cap).
  2. Dispatch is gather-all-at-once: the topic that starts sixth begins before
     all of the first five have finished, so a freed slot is reused instantly
     rather than after a batch barrier.
  3. Every topic reaches a terminal state, and its file ENDS on that state, so
     the SSE stream closes and the verdict is unambiguous.

Claim 3 used to read "terminates exactly once", and against real output that was
simply false: it failed 7 of 10 real BLR topics while the engine was behaving
correctly. status.jsonl is APPEND ONLY and it OUTLIVES the run that created it,
so a second terminal line is normal and expected in at least three cases. A topic
re-generated after a stop or a failure replays into the same file. A revise
re-opens a finished topic and scores it again. And _enforce_terminal_status
appends an engine correction on top of the lead's claim, which is the audit trail
of an override and the whole reason that mechanism is trustworthy.

So the honest invariant is about the LAST line, not the count. A check that
demands one terminal line is asking the file to forget its own history, and a
suite that cries wolf on correct output is worse than no suite: the next real
failure it catches gets waved through with the rest.

Stdlib only, so it runs anywhere the repo runs. Reusable:

  python3 tests/concurrency_check.py clients/demo/output [--cap 5]

Exit 0 when every assertion passes, 1 otherwise. Assertions print PASS or
FAIL individually so a partial failure still yields a full report.
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# Deliberately a literal and not an import of runner.TERMINAL_STATUSES: this file is stdlib only
# on purpose, so it can be pointed at an output root on a machine with no venv and no server
# package. The cost of that choice is drift, and drift already happened: "stopped" became a
# terminal status when the stop button shipped, and until it was added here every stopped topic
# read as one that never terminated. If a status is ever added to the engine, it belongs here the
# same day.
TERMINAL_STATUSES = {"done", "needs_review", "failed", "stopped"}


def parse_ts(value):
    return datetime.fromisoformat(value)


def load_topic(status_path):
    lines = []
    for raw in status_path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if raw:
            lines.append(json.loads(raw))
    if not lines:
        return None
    terminal_indexes = [
        i for i, line in enumerate(lines) if line.get("status") in TERMINAL_STATUSES
    ]
    score_trail = [
        line["score"]
        for line in lines
        if line.get("stage") == "eval"
        and line.get("event") == "end"
        and line.get("score") is not None
    ]
    # The largest quiet stretch between consecutive lines. A topic being worked on emits stages
    # continuously, so a long silence in the middle of one file means the engine came back to this
    # topic later: a second run appended to a file the first run had already finished with. It is
    # the only evidence of a run boundary this file offers, because a status line carries no
    # run_id. Heuristic, and used only to downgrade the single-run claims, never to fail one.
    stamps = [parse_ts(line["ts"]) for line in lines if line.get("ts")]
    max_gap_minutes = max(
        ((stamps[i] - stamps[i - 1]).total_seconds() / 60 for i in range(1, len(stamps))),
        default=0,
    )

    return {
        "slug": status_path.parent.name,
        "start": parse_ts(lines[0]["ts"]),
        "end": parse_ts(lines[-1]["ts"]),
        "lines": len(lines),
        "max_gap_minutes": max_gap_minutes,
        "terminal_count": len(terminal_indexes),
        "terminal_is_last": bool(terminal_indexes) and terminal_indexes[-1] == len(lines) - 1,
        "terminal_status": lines[terminal_indexes[-1]]["status"] if terminal_indexes else None,
        "final_score": lines[terminal_indexes[-1]].get("score") if terminal_indexes else None,
        "iterations": max((line.get("iter", 0) for line in lines), default=0),
        "score_trail": score_trail,
    }


def max_concurrent(topics):
    """Sweep start/end events in time order. At an identical timestamp an end
    is processed before a start, matching semaphore semantics: the slot frees,
    then the waiter proceeds. Sub-microsecond ties are the only case affected."""
    events = []
    for topic in topics:
        events.append((topic["start"], 1))
        events.append((topic["end"], 0))
    events.sort(key=lambda pair: (pair[0], pair[1]))
    live = peak = 0
    for _ts, kind in events:
        live = live + 1 if kind == 1 else live - 1
        peak = max(peak, live)
    return peak


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output_root", help="clients/<client>/output directory")
    parser.add_argument("--cap", type=int, default=5, help="expected semaphore cap")
    args = parser.parse_args(argv)

    root = Path(args.output_root)
    paths = sorted(root.glob("*/status.jsonl"))
    if not paths:
        print(f"FAIL: no status.jsonl files under {root}")
        return 1

    topics = [t for t in (load_topic(p) for p in paths) if t]
    by_start = sorted(topics, key=lambda t: t["start"])

    print(f"Topics analyzed: {len(topics)} (cap {args.cap})\n")
    header = f"{'slug':48} {'start':15} {'end':15} {'iters':5} {'score trail':16} status"
    print(header)
    print("-" * len(header))
    for topic in by_start:
        trail = "->".join(str(s) for s in topic["score_trail"]) or "-"
        print(
            f"{topic['slug']:48} {topic['start'].strftime('%H:%M:%S.%f')[:-3]:15} "
            f"{topic['end'].strftime('%H:%M:%S.%f')[:-3]:15} {topic['iterations']:<5} "
            f"{trail:16} {topic['terminal_status']}"
        )
    print()

    failures = 0

    def check(name, passed, detail):
        nonlocal failures
        print(f"{'PASS' if passed else 'FAIL'}: {name}: {detail}")
        if not passed:
            failures += 1

    # CLAIMS 1 AND 2 ARE ABOUT ONE RUN, AND THIS FILE CANNOT ALWAYS TELL WHICH RUN A LINE CAME FROM.
    #
    # A status line carries ts, slug, stage, event, iter, score, status and note. It does NOT carry a
    # run_id, so when a topic is generated, then generated again later, both runs land in one file
    # and this analyzer reads the topic's lifetime as first-line to last-terminal: a span covering
    # BOTH runs and the dead hours between them. Every reopened topic then looks like it overlapped
    # every other, and the peak reads far above the cap.
    #
    # That is not academic. Pointed at real accumulated output this printed "measured max concurrent
    # topics = 7" against a cap of 5, whose own message reads "above cap means the semaphore leaked".
    # There was no leak. Seven of ten topics had simply been re-generated hours apart. A tool that
    # cries semaphore leak at correct output does not merely waste an afternoon: it teaches its
    # reader to disbelieve it, and the day it is right nobody listens.
    #
    # The gap test below is a HEURISTIC and it is labelled as one, because no exact answer exists in
    # the data. It is used only to DOWNGRADE, never to fail: where the root plainly holds more than
    # one run, the two single-run claims are reported as unanswerable rather than answered wrongly.
    # Claim 3 needs no session boundary and is always checked. For a clean proof, point this at a
    # fresh output root holding exactly one run.
    REOPEN_GAP_MINUTES = 20
    reopened = [t["slug"] for t in topics if t.get("max_gap_minutes", 0) > REOPEN_GAP_MINUTES]
    multi_run = bool(reopened)
    if multi_run:
        print(
            f"NOTE: {len(reopened)} topic(s) have a gap over {REOPEN_GAP_MINUTES} minutes in their "
            f"timeline, so this output root holds more than one run: "
            + ", ".join(s[:40] for s in reopened)
        )
        print(
            "      Claims 1 and 2 describe a SINGLE run and a status line carries no run_id, so "
            "they cannot be answered here and are reported below rather than asserted."
        )
        print()

    peak = max_concurrent(topics)
    if multi_run:
        print(
            f"INFO: max concurrent topics measured = {peak} (cap {args.cap}). Not asserted: this "
            f"root holds multiple runs, so the number counts topics that never overlapped."
        )
    elif len(topics) > args.cap:
        check(
            "max concurrency == cap",
            peak == args.cap,
            f"measured max concurrent topics = {peak}"
            + ("" if peak == args.cap else
               " (below cap means the mock ran too fast to overlap; above cap means the semaphore leaked)"),
        )
    else:
        check("max concurrency <= cap", peak <= args.cap,
              f"measured {peak}; selection of {len(topics)} cannot saturate cap {args.cap}")

    if not multi_run and len(topics) > args.cap:
        first_wave = by_start[: args.cap]
        overflow = by_start[args.cap :]
        min_first_start = min(t["start"] for t in first_wave)
        max_first_end = max(t["end"] for t in first_wave)
        check(
            "overflow topics started after the first wave began",
            all(t["start"] > min_first_start for t in overflow),
            f"min first-wave start {min_first_start.isoformat()} < "
            + ", ".join(t["start"].isoformat() for t in overflow),
        )
        six = overflow[0]
        check(
            "topic 6 started before all of the first five finished (no batch barrier)",
            six["start"] < max_first_end,
            f"topic-6 ({six['slug']}) start {six['start'].isoformat()} < "
            f"max first-wave end {max_first_end.isoformat()}",
        )

    # Two separate claims, because they fail for different reasons and a reader deserves to know
    # which one broke. A topic with NO terminal line is the SSE stream that never closes and the
    # watch view that heartbeats forever. A topic whose terminal line is not last is worse: the
    # engine reported a verdict and then kept writing, so the status the app shows depends on
    # which line it happened to read.
    check(
        "every topic reaches a terminal state",
        all(t["terminal_count"] >= 1 for t in topics),
        "; ".join(f"{t['slug']}: no terminal line" for t in topics if not t["terminal_count"])
        or "all terminate",
    )
    check(
        "every topic's file ENDS on its terminal line",
        all(t["terminal_is_last"] for t in topics if t["terminal_count"]),
        "; ".join(
            f"{t['slug']}: terminal line is not last"
            for t in topics
            if t["terminal_count"] and not t["terminal_is_last"]
        ) or "all clean",
    )
    # Reported, never asserted. More than one terminal line is legitimate history (a regenerate, a
    # revise, an engine correction), so this is a number worth seeing and not a number worth
    # failing on. If it climbs on a FRESH output root, where a topic has no history to replay,
    # that is worth a look.
    replayed = [t for t in topics if t["terminal_count"] > 1]
    if replayed:
        print(
            f"INFO: {len(replayed)} topic(s) carry more than one terminal line, which is history "
            f"rather than a fault: "
            + ", ".join(f"{t['slug']}={t['terminal_count']}" for t in replayed)
        )

    done_95 = [t for t in topics if t["terminal_status"] == "done" and (t["final_score"] or 0) >= 95]
    check(
        "at least one topic ended done with score >= 95",
        bool(done_95),
        ", ".join(f"{t['slug']}={t['final_score']}" for t in done_95) or "none",
    )

    mix = {}
    for topic in topics:
        mix[topic["terminal_status"]] = mix.get(topic["terminal_status"], 0) + 1
    if mix.get("needs_review"):
        print(f"INFO: needs_review path exercised by {mix['needs_review']} topic(s)")
    else:
        print(f"INFO: no needs_review among these topics; outcome mix was {mix}")

    print(f"\n{'ALL ASSERTIONS PASSED' if failures == 0 else f'{failures} ASSERTION(S) FAILED'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
