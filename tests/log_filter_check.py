#!/usr/bin/env python3
"""The uvicorn.access health-line filter (Bug 7). Imports the app, logs nothing, opens no socket.

Pins BOTH directions of the filter, because getting the second one wrong is how a real failure
goes missing: a successful /api/health poll (plain or ?deep=1) is dropped, but a /api/health that
ever answers non-2xx/3xx, and every other path, is KEPT. Records are built with uvicorn's
documented access args (client, method, full_path, http_version, status), so this does not depend
on uvicorn internals.

  .venv/bin/python tests/log_filter_check.py
"""
import logging
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server.app import _HealthAccessFilter  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition):
    CHECKS[0] += 1
    print(f"  {'PASS' if condition else 'FAIL'}  {name}")
    if not condition:
        FAILURES.append(name)


def record(method, full_path, status):
    r = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0,
                          '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:0", method, full_path, "1.1", status), None)
    return r


def main():
    print("log_filter_check: uvicorn.access health filter, no socket opened.")
    f = _HealthAccessFilter()

    # Dropped: a successful health poll, plain and deep.
    check("200 /api/health is dropped", f.filter(record("GET", "/api/health", 200)) is False)
    check("200 /api/health?deep=1 is dropped", f.filter(record("GET", "/api/health?deep=1", 200)) is False)
    check("304 /api/health is dropped (3xx counts as success)", f.filter(record("GET", "/api/health", 304)) is False)

    # Kept: a health check that actually failed must stay visible.
    check("500 /api/health is KEPT", f.filter(record("GET", "/api/health", 500)) is True)
    check("503 /api/health?deep=1 is KEPT", f.filter(record("GET", "/api/health?deep=1", 503)) is True)

    # Kept: every other path, including one that merely contains the string.
    check("200 /api/clients is KEPT", f.filter(record("GET", "/api/clients", 200)) is True)
    check("a path that only contains /api/health as a substring is KEPT",
          f.filter(record("GET", "/api/healthcheck", 200)) is True)
    check("200 /api/health-report is KEPT (not the health route)",
          f.filter(record("GET", "/api/health-report", 200)) is True)

    # Fail-open: an unexpected record shape is never dropped and never crashes the logger.
    weird = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 0, "plain message", None, None)
    check("a record with no args tuple is KEPT (fail-open)", f.filter(weird) is True)
    check("status as a string still classifies correctly",
          f.filter(record("GET", "/api/health", "200")) is False)

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("log_filter_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
