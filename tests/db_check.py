#!/usr/bin/env python3
"""Retry semantics for server/db.q. Opens NO socket and needs NO database.

pool() is replaced by a fake whose cursor raises a scripted sequence of errors, so this pins
the one thing the Bug 1 retry must get right in BOTH directions: a connection-level
OperationalError is retried until a live connection answers, and a real query error
(ProgrammingError, IntegrityError) is raised at once and never retried. Getting the second
direction wrong would turn every genuine SQL bug into three silent retries and a slow 500.

  .venv/bin/python tests/db_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import psycopg  # noqa: E402
import psycopg_pool  # noqa: E402
from server import db  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    print(f"  {'PASS' if condition else 'FAIL'}  {name}" + (f": {detail}" if detail and not condition else ""))
    if not condition:
        FAILURES.append(name)


class _Shared:
    """One execute-call counter shared across a q() call's retries: attempt N raises plan[N]."""
    def __init__(self, plan):
        self.plan, self.i = plan, 0


class _Cur:
    description = [("c",)]

    def __init__(self, shared):
        self.shared = shared

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        s = self.shared
        exc = s.plan[s.i] if s.i < len(s.plan) else None
        s.i += 1
        if exc is not None:
            raise exc

    def fetchone(self):
        return (1,)

    def fetchall(self):
        return [(1,)]

    rowcount = 1


class _Conn:
    def __init__(self, shared):
        self.shared = shared

    def cursor(self):
        return _Cur(self.shared)


class _ConnCtx:
    def __init__(self, shared):
        self.shared = shared

    def __enter__(self):
        return _Conn(self.shared)

    def __exit__(self, *a):
        return False


class _Pool:
    def __init__(self, plan):
        self.shared = _Shared(plan)

    def connection(self):
        return _ConnCtx(self.shared)


def run(plan):
    """q('select 1', fetch='val') against a pool scripted with `plan`; returns (result, exc, attempts)."""
    fp = _Pool(plan)
    orig = db.pool
    db.pool = lambda: fp
    try:
        try:
            return db.q("select 1", fetch="val"), None, fp.shared.i
        except Exception as exc:  # noqa: BLE001
            return None, exc, fp.shared.i
    finally:
        db.pool = orig


def main():
    print("db_check: q() retry semantics, no socket opened.")
    db._DB_BACKOFF_BASE = 0.0  # keep the test instant; still exercises the sleep call

    op = psycopg.OperationalError

    # A transient connection death, then a live connection answers: retried, succeeds.
    result, exc, attempts = run([op("EADDRNOTAVAIL"), op("dropped"), None])
    check("two OperationalErrors then success returns the value", result == 1 and exc is None, str(exc))
    check("it took exactly three attempts (2 failed + 1 ok)", attempts == 3, f"attempts={attempts}")

    # First attempt already good: no retry, one attempt.
    result, exc, attempts = run([None])
    check("a healthy connection answers on the first attempt", result == 1 and attempts == 1, f"attempts={attempts}")

    # Every attempt dies: the OperationalError is re-raised after the cap, not swallowed.
    result, exc, attempts = run([op("down"), op("down"), op("down")])
    check("exhausting attempts re-raises OperationalError", isinstance(exc, op), type(exc).__name__)
    check("the cap is three attempts", attempts == 3, f"attempts={attempts}")

    # A REAL query bug is not a connection error: raised at once, never retried.
    result, exc, attempts = run([psycopg.ProgrammingError("syntax error at or near")])
    check("ProgrammingError raises immediately", isinstance(exc, psycopg.ProgrammingError), type(exc).__name__)
    check("a query bug is tried ONCE, not retried", attempts == 1, f"attempts={attempts}")

    # IntegrityError (constraint violation) is likewise a real error, not retried.
    result, exc, attempts = run([psycopg.IntegrityError("duplicate key")])
    check("IntegrityError is tried ONCE, not retried", isinstance(exc, psycopg.IntegrityError) and attempts == 1,
          f"attempts={attempts}")

    # POOL-LEVEL errors are OperationalError SUBCLASSES but must NOT be retried: they mean the
    # store is unreachable, and retrying stacks 30s pool-timeout waits and wedges the app during
    # the exact outage this change exists to survive. They must re-raise on the first attempt.
    for name in ("PoolTimeout", "PoolClosed", "TooManyRequests"):
        cls = getattr(psycopg_pool, name)
        check(f"{name} is an OperationalError subclass (else this test proves nothing)",
              issubclass(cls, psycopg.OperationalError))
        result, exc, attempts = run([cls("pool unreachable")])
        check(f"{name} re-raises immediately, NOT retried", isinstance(exc, cls) and attempts == 1,
              f"{type(exc).__name__} attempts={attempts}")

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("db_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
