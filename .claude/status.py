#!/usr/bin/env python3
"""Append one status line to <out>/status.jsonl.

This is the ONLY way any agent reports progress. One JSON object per line:

  {"ts":iso8601,"slug":str,"stage":"research|write|gates|links|eval|revise",
   "event":"start|end","iter":int,"score":int|null,
   "status":"running|done|needs_review|failed|stopped","note":str}

Rules the shape encodes:
- Agents always write status "running". ONLY the session lead writes a terminal
  line (done | needs_review | failed), and it is the last line for that topic.
- "stopped" is the ONE terminal status the lead never writes, and it is the
  reason the sentence above says "ONLY the lead" and still holds. A stop kills
  the session, so the lead is not there to report it; the backend
  (server.runner.run_topic) writes it on the cancellation path instead. A rule
  that depends on a dead process writing its own last line is a rule that never
  fires. It means the operator ended the run before the loop reached a verdict,
  and it means nothing else: not a failure (nothing broke) and not a summons
  (nobody is being asked anything). Conflating it with "failed" would report a
  human decision as an engine defect on every surface that counts one.
- A terminal line keeps the stage of the final step (normally "eval", or the
  stage that failed) with event "end". A "stopped" line keeps whatever stage was
  in flight when the cancel landed, so it can carry a stage whose "start" has no
  matching "end". Consumers detect terminal state from the STATUS field, never
  from the stage, which is what makes that safe.
- The eval "end" line carries the numeric score.
- Every line carries the iteration number, because a fresh writer on iteration 3
  has no memory of iterations 1 and 2.

CLI:
  python3 .claude/status.py --out <output_dir> --slug <slug> --stage eval \
      --event end --iter 2 --score 96 --status running --note "..."

Exits 2 on a bad stage, event, or status value.
"""
import argparse
import datetime
import json
import os
import sys

STAGES = ("research", "write", "gates", "links", "eval", "revise")
EVENTS = ("start", "end")
STATUSES = ("running", "done", "needs_review", "failed", "stopped")


def append_status(out_dir, slug, stage, event, iter, score=None, status="running", note=""):
    """Validate the enums, stamp ts, and append exactly one JSON line.

    Python callers (the runner, the mock's died-session handler) reuse this so
    every status line in existence goes through one code path. `iter` shadows
    the builtin on purpose: it matches the field name in the line shape.
    """
    if stage not in STAGES:
        raise ValueError(f"bad stage {stage!r}: must be one of {'|'.join(STAGES)}")
    if event not in EVENTS:
        raise ValueError(f"bad event {event!r}: must be one of {'|'.join(EVENTS)}")
    if status not in STATUSES:
        raise ValueError(f"bad status {status!r}: must be one of {'|'.join(STATUSES)}")

    line = {
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "slug": str(slug),
        "stage": stage,
        "event": event,
        "iter": int(iter),
        "score": None if score is None else int(score),
        "status": status,
        "note": str(note),
    }
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "status.jsonl"), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    return line


def main(argv=None):
    parser = argparse.ArgumentParser(description="Append one status line to <out>/status.jsonl")
    parser.add_argument("--out", required=True, help="output directory holding status.jsonl")
    parser.add_argument("--slug", required=True, help="topic slug")
    parser.add_argument("--stage", required=True, help="|".join(STAGES))
    parser.add_argument("--event", required=True, help="|".join(EVENTS))
    parser.add_argument("--iter", required=True, type=int, help="current iteration number")
    parser.add_argument("--score", type=int, default=None, help="numeric score, eval end lines only")
    parser.add_argument("--status", default="running", help="|".join(STATUSES))
    parser.add_argument("--note", default="", help="free-text note")
    args = parser.parse_args(argv)

    try:
        append_status(
            args.out, args.slug, args.stage, args.event, args.iter,
            score=args.score, status=args.status, note=args.note,
        )
    except ValueError as exc:
        print(f"status.py: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
