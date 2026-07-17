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
  3. Every topic terminates exactly once, with the terminal line last in its
     file.

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

TERMINAL_STATUSES = {"done", "needs_review", "failed"}


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
    return {
        "slug": status_path.parent.name,
        "start": parse_ts(lines[0]["ts"]),
        "end": parse_ts(lines[-1]["ts"]),
        "lines": len(lines),
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

    peak = max_concurrent(topics)
    if len(topics) > args.cap:
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

    if len(topics) > args.cap:
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

    check(
        "every topic has exactly one terminal line, last in its file",
        all(t["terminal_count"] == 1 and t["terminal_is_last"] for t in topics),
        "; ".join(
            f"{t['slug']}: {t['terminal_count']} terminal, last={t['terminal_is_last']}"
            for t in topics
            if not (t["terminal_count"] == 1 and t["terminal_is_last"])
        ) or "all clean",
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
