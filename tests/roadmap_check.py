#!/usr/bin/env python3
"""Roadmap upload round-trip. Spawns NOTHING, calls NO model, touches NO real DB.

load_upload is a security control (re-read the stored bytes by upload_id, never trust the
browser's rows). It failed CLOSED on a VALID upload: it re-ran safe_filename on the upload_id,
which truncates to 80 chars, so an upload_id built from an already-stamped filename (a re-uploaded
archive) ran past 80, ".csv" was chopped to ".c", the DB match missed, and a good upload answered
400 "unknown upload_id". This pins the fix: the lookup uses the EXACT upload_id.

  .venv/bin/python tests/roadmap_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import roadmap  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def test_load_upload_matches_the_exact_untruncated_upload_id():
    print("\ntest_load_upload_matches_the_exact_untruncated_upload_id")
    # The real id from the failure: a re-uploaded, already-stamped file, so it carries two stamps.
    uid = "20260726T182402096209-20260717T054634151173-BLR_Brewing_Month2_Content_Roadmap.csv"
    check("the id is longer than safe_filename's 80-char cap", len(uid) > 80, str(len(uid)))
    check("re-running safe_filename would truncate it (the bug)", roadmap.safe_filename(uid) != uid)

    csv = ("Content Topic,What the Piece Covers,Format,Search Intent,Target Prompts\n"
           "Solar inverters,Buyer guide,Guide,Informational,\"what is the best inverter | inverter price\"\n")
    captured = {}
    original = (roadmap.db.client_id, roadmap.db.q)
    roadmap.db.client_id = lambda slug: "cid-1"

    def fake_q(sql, params, fetch=None):
        captured["filename"] = params[1]  # (client_id, filename)
        return csv.encode("utf-8")

    roadmap.db.q = fake_q
    try:
        payload = roadmap.load_upload("blr-brewing", uid)
    finally:
        roadmap.db.client_id, roadmap.db.q = original

    check("load_upload queries the EXACT upload_id, not a truncated one",
          captured.get("filename") == uid, repr(captured.get("filename")))
    check("the stored CSV round-trips back to parsed rows", bool(payload.get("rows")))


def test_missing_upload_still_fails_closed():
    print("\ntest_missing_upload_still_fails_closed")
    original = (roadmap.db.client_id, roadmap.db.q)
    roadmap.db.client_id = lambda slug: "cid-1"
    roadmap.db.q = lambda sql, params, fetch=None: None  # no matching row
    raised = None
    try:
        roadmap.load_upload("blr-brewing", "does-not-exist.csv")
    except roadmap.BadUpload as exc:
        raised = exc
    finally:
        roadmap.db.client_id, roadmap.db.q = original
    check("a non-matching upload_id still raises BadUpload (fails closed)", raised is not None)


def main():
    print("roadmap_check: static checks only. No CLI spawned, no model called, no real DB.")
    for test in (test_load_upload_matches_the_exact_untruncated_upload_id,
                 test_missing_upload_still_fails_closed):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
