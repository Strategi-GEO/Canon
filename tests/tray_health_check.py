#!/usr/bin/env python3
"""Tray health classification (Bug 2) and the translocation guard (Bug 9). Opens no socket.

Pins the two pieces of new tray logic that a wiring mistake would hide:
  - _health_target maps a poll to running / degraded / dead. The degraded branch is the whole
    point of Bug 2 (engine up, DB down); getting it to collapse into 'dead' or 'running' would
    silently undo the feature.
  - _engine_healthy classifies the ?deep=1 body, including the older-engine (no 'db' key) case.
  - is_translocated's substring test, so the macOS Gatekeeper guard fires on the mount path.

urllib.request.urlopen is monkeypatched, so no engine and no network are needed.

  .venv/bin/python tests/tray_health_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "canon_app"))

import tray  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition):
    CHECKS[0] += 1
    print(f"  {'PASS' if condition else 'FAIL'}  {name}")
    if not condition:
        FAILURES.append(name)


class _FakeResp:
    def __init__(self, status, body):
        self.status = status
        self._body = body.encode() if isinstance(body, str) else body

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_self():
    """The minimum _engine_healthy reaches through: a launcher.engine_health_url and a port."""
    class _L:
        @staticmethod
        def engine_health_url(port):
            return f"http://127.0.0.1:{port}/api/health"
    obj = tray.CanonTray.__new__(tray.CanonTray)
    obj.launcher = _L()
    obj.engine_port = 8000
    return obj


def with_urlopen(resp_or_exc):
    orig = tray.urllib.request.urlopen
    def fake(url, timeout=None):
        # The deep probe must be the URL asked for.
        assert url.endswith("/api/health?deep=1"), url
        if isinstance(resp_or_exc, Exception):
            raise resp_or_exc
        return resp_or_exc
    tray.urllib.request.urlopen = fake
    return orig


def main():
    print("tray_health_check: classification + translocation, no socket opened.")
    T = tray.CanonTray

    # _health_target: the pure classification, every combination that matters.
    check("engine ok + dash ok -> running", T._health_target("ok", True) == "running")
    check("engine ok + dash DOWN -> dead", T._health_target("ok", False) == "dead")
    check("engine degraded + dash ok -> degraded", T._health_target("degraded", True) == "degraded")
    check("engine degraded + dash DOWN -> dead (dashboard is down)", T._health_target("degraded", False) == "dead")
    check("engine down + dash ok -> dead", T._health_target("down", True) == "dead")
    check("engine down + dash down -> dead", T._health_target("down", False) == "dead")

    # _engine_healthy: parse the ?deep=1 body into the tri-state.
    obj = _fake_self()
    for body, expected in [
        ('{"ok": true, "db": true}', "ok"),
        ('{"ok": true, "db": false}', "degraded"),
        ('{"ok": true}', "ok"),          # older engine, no db key: process is up, call it ok
    ]:
        orig = with_urlopen(_FakeResp(200, body))
        try:
            got = obj._engine_healthy()
        finally:
            tray.urllib.request.urlopen = orig
        check(f"deep body {body} -> {expected}", got == expected)

    # A non-2xx answer, and an unreachable engine, are both 'down'.
    orig = with_urlopen(_FakeResp(503, '{"ok": true, "db": false}'))
    try:
        check("HTTP 503 -> down", obj._engine_healthy() == "down")
    finally:
        tray.urllib.request.urlopen = orig
    orig = with_urlopen(OSError("connection refused"))
    try:
        check("unreachable engine -> down", obj._engine_healthy() == "down")
    finally:
        tray.urllib.request.urlopen = orig

    # is_translocated substring logic.
    check("a translocated mount path is detected",
          tray._looks_translocated("/private/var/folders/x/AppTranslocation/ABC/d/Strategi Canon.app/Contents/MacOS/Strategi Canon"))
    check("a normal /Applications path is not translocated",
          not tray._looks_translocated("/Applications/Strategi Canon.app/Contents/MacOS/Strategi Canon"))

    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("tray_health_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
