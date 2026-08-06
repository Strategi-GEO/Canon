#!/usr/bin/env python3
"""The dead-session retry guard and the concurrency knob. Spawns NOTHING and calls NO model.

Two pieces of logic shipped with no runnable check, and both fail silently when they break, which
is the worst kind:

  1. runner.run_topic's RETRY GUARD. GEO_RETRIES fires on any session that ended without a
     terminal line, with no check on WHY it died. When the account's usage limit lands, every
     in-flight blog immediately opens a SECOND full SDK session against a dead account. Measured
     on 2026-08-05: a retry line at 15:29:57 and its failed line at 15:29:59, TWO SECONDS apart,
     19 retry lines across twelve topics inside a 106-second window. The guard skips the retry
     when the session wrote NO status line AND died faster than DEAD_SESSION_SECONDS. Both halves
     are required, so this pins both directions: a fast silent death is not retried, a fast death
     that WROTE lines still is.

  2. runner._concurrency(). TOPIC_SEMAPHORE is built at MODULE IMPORT, before the startup hook
     that exports server/.env, so the value is read through db.config_value as well as os.environ.
     A GEO_CONCURRENCY of 0 would build Semaphore(0) and block every blog forever with no error
     and no log, which is why it is floored at 1, and a typo must not stop the engine booting.

  .venv/bin/python tests/retry_guard_check.py
"""
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import runner  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}" + (f" ({detail})" if detail else ""))
        FAILURES.append(name)


def _status_lines(out_dir):
    path = Path(out_dir) / "status.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _run_topic_with(session_behaviour, retries="1"):
    """Drive the real run_topic with ONLY _sdk_session replaced, and return its status lines.

    Everything else is the shipped code path: the retry loop, the guard, the terminal-line check
    and _enforce_terminal_status all run for real. Preflight needs a reviewed canonical-facts.md,
    so lay a minimal one down rather than stubbing the check out.
    """
    root = Path(tempfile.mkdtemp())
    facts = root / "canonical-facts.md"
    facts.write_text("# Acme facts\nNothing unreviewed here.\n")

    out_root = root / "outputs"
    row = {"topic": "A Topic", "covers": "scope", "prompts": ["p1"], "extras": []}

    # run_topic hardcodes clients_root to REPO_ROOT/clients, and clients/*/ is gitignored, so a
    # test anchored on real operator data would pass only on the machine that happens to hold it.
    # Stub the ONE path function instead: preflight's rules (present, and no PLACEHOLDER token)
    # still run for real against the file above.
    original_session, original_facts = runner._sdk_session, runner.canonical_facts_path
    runner._sdk_session = session_behaviour
    runner.canonical_facts_path = lambda *a, **k: facts
    old_retries = os.environ.get("GEO_RETRIES")
    os.environ["GEO_RETRIES"] = retries
    try:
        asyncio.run(runner.run_topic("acme", row, run_dir_root=out_root))
    except Exception:
        pass  # run_topic re-raises on a failed topic; the trail is what this test reads
    finally:
        runner._sdk_session = original_session
        runner.canonical_facts_path = original_facts
        if old_retries is None:
            os.environ.pop("GEO_RETRIES", None)
        else:
            os.environ["GEO_RETRIES"] = old_retries

    return _status_lines(out_root / "acme" / "a-topic")


def test_a_fast_silent_death_is_not_retried():
    """The usage-limit case: no status line, back in milliseconds. One session, no retry."""
    calls = [0]

    async def dies_instantly(*args, **kwargs):
        calls[0] += 1

    lines = _run_topic_with(dies_instantly)
    retry_notes = [ln for ln in lines if "retry" in (ln.get("note") or "")]

    check("a fast silent death opens only ONE session", calls[0] == 1, f"{calls[0]} sessions")
    check("a fast silent death writes no retry line", not retry_notes,
          f"{[n['note'] for n in retry_notes]}")
    check("a fast silent death still gets exactly one terminal line",
          len([ln for ln in lines if ln.get("status") in runner.TERMINAL_STATUSES]) == 1)
    check("the terminal line names the symptom and not a cause",
          any("no status line" in (ln.get("note") or "") and "not retried" in (ln.get("note") or "")
              for ln in lines))
    check("the terminal status is failed",
          any(ln.get("status") == "failed" for ln in lines))


def test_a_death_that_wrote_lines_is_still_retried():
    """The other half of the guard: a session that got somewhere earns its retry."""
    calls = [0]

    async def writes_then_dies(client_slug, row, topic_slug, out_dir, prior_score=None):
        calls[0] += 1
        runner._status_module().append_status(
            str(out_dir), topic_slug, stage="research", event="start",
            iter=1, status="running", note="got as far as research",
        )

    lines = _run_topic_with(writes_then_dies)
    retry_notes = [ln for ln in lines if "retry" in (ln.get("note") or "")]

    check("a death that wrote lines IS retried", calls[0] == 2, f"{calls[0]} sessions")
    check("the retry is recorded on the trail", len(retry_notes) == 1,
          f"{len(retry_notes)} retry notes")
    check("a retried topic still ends with exactly one terminal line",
          len([ln for ln in lines if ln.get("status") in runner.TERMINAL_STATUSES]) == 1)


def test_the_guard_never_writes_a_second_terminal_line():
    """A session that reached a verdict is left alone, guard or no guard."""
    calls = [0]

    async def ships_immediately(client_slug, row, topic_slug, out_dir, prior_score=None):
        calls[0] += 1
        runner._status_module().append_status(
            str(out_dir), topic_slug, stage="eval", event="end",
            iter=1, score=94, status="done", note="shipped",
        )

    lines = _run_topic_with(ships_immediately)
    terminal = [ln for ln in lines if ln.get("status") in runner.TERMINAL_STATUSES]

    check("a session that reached a verdict is not retried", calls[0] == 1, f"{calls[0]} sessions")
    check("exactly one terminal line survives", len(terminal) == 1, f"{len(terminal)} terminal")
    check("and it is the verdict the lead wrote", terminal[-1].get("status") == "done")


def test_concurrency_is_floored_and_never_raises():
    """GEO_CONCURRENCY=0 would block every blog forever; a typo must not stop the engine booting.

    HERMETIC ON PURPOSE. _concurrency() falls back to db.config_value, which reads server/.env, so
    without this stub the "default is 2" check asserts what THIS MACHINE happens to be configured
    for and fails the moment an operator sets the knob. That is exactly the defect that makes
    facts_check.py unreproducible, and a test that only passes on one machine pins nothing.
    """
    from server import db

    old = os.environ.get("GEO_CONCURRENCY")
    original_cfg = db.config_value
    db.config_value = lambda name: "" if name == "GEO_CONCURRENCY" else original_cfg(name)
    try:
        cases = {"0": 1, "-3": 1, "": 2, "abc": 2, "4": 4, "1": 1}
        for raw, expected in cases.items():
            os.environ["GEO_CONCURRENCY"] = raw
            got = runner._concurrency()
            check(f"GEO_CONCURRENCY={raw!r} resolves to {expected}", got == expected, f"got {got}")
        os.environ.pop("GEO_CONCURRENCY", None)
        check("the default is 2", runner._concurrency() == 2, f"got {runner._concurrency()}")
    finally:
        db.config_value = original_cfg
        if old is None:
            os.environ.pop("GEO_CONCURRENCY", None)
        else:
            os.environ["GEO_CONCURRENCY"] = old


def main():
    print(__doc__.splitlines()[0])
    for test in (test_a_fast_silent_death_is_not_retried,
                 test_a_death_that_wrote_lines_is_still_retried,
                 test_the_guard_never_writes_a_second_terminal_line,
                 test_concurrency_is_floored_and_never_raises):
        print(f"\n{test.__name__}")
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
