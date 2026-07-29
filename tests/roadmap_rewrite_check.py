#!/usr/bin/env python3
"""Roadmap rewrite splice checks. Spawns NOTHING, calls NO model, touches NO real DB.

splice_sheet is the whole fixed-total contract in one pure function: the operator ticks rows,
one agent session writes replacements, and the engine splices them in ONLY when it got exactly
one complete new row per ticked row under the sheet's own header. Every refusal must leave the
sheet untouched, which for a pure function means raising before returning anything, and every
kept row must survive cell-for-cell, extras and quoted newlines included, because the kept rows
are the operator's own work and a rewrite has no licence to touch them.

  .venv/bin/python tests/roadmap_rewrite_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import roadmap  # noqa: E402
from server.roadmap_gen import GenerationError, rewrite_block, splice_sheet  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


HEADER = ("Content Topic,What the Piece Covers,Format,Search Intent,"
          "Target Prompts,Est. Monthly Volume")

# Row 2's prompts cell carries a QUOTED NEWLINE, the thing ad-hoc splitting corrupts, so the
# checks below prove the splice round-trips it. Row 3 is the one being replaced.
SHEET = (
    f"{HEADER}\n"
    'Topic One,Covers one,Explainer,Informational,"p1 | p2 | p3",100\n'
    'Topic Two,Covers two,Listicle,Commercial,"line one\nline two",\n'
    'Topic Three,Covers three,How-to,Commercial,"q1 | q2 | q3",50\n'
)

REPLACEMENT = (
    f"{HEADER}\n"
    'New Topic,New covers,Comparison,Commercial,"n1 | n2 | n3",200\n'
)


def parsed(text):
    return roadmap.parse_csv(text)


def refused(name, sheet, indices, replacement, expect=""):
    try:
        splice_sheet(sheet, indices, replacement)
    except (GenerationError, roadmap.BadUpload) as exc:
        check(name, expect in str(exc), f"raised, but message lacks {expect!r}: {exc}")
    else:
        check(name, False, "the splice was accepted")


print("splice: the happy path")
out = splice_sheet(SHEET, [2], REPLACEMENT)
rows = parsed(out)["rows"]
check("still three rows", len(rows) == 3, f"got {len(rows)}")
check("row 3 replaced", rows[2]["topic"] == "New Topic", rows[2]["topic"])
check("replacement prompts split", rows[2]["prompts"] == ["n1", "n2", "n3"],
      str(rows[2]["prompts"]))
check("kept row 1 intact", rows[0]["topic"] == "Topic One" and rows[0]["covers"] == "Covers one")
check("kept quoted newline survives", rows[1]["prompts"] == ["line one", "line two"],
      str(rows[1]["prompts"]))
check("kept extras survive by header",
      {"label": "Format", "value": "Listicle"} in rows[1]["extras"], str(rows[1]["extras"]))
check("replacement extras land", {"label": "Est. Monthly Volume", "value": "200"}
      in rows[2]["extras"], str(rows[2]["extras"]))
check("header unchanged", parsed(out)["columns"] == parsed(SHEET)["columns"])

print("splice: replacement order maps to sorted indices")
two = (
    f"{HEADER}\n"
    'First New,Covers a,Explainer,Informational,"a1 | a2 | a3",\n'
    'Second New,Covers b,Listicle,Commercial,"b1 | b2 | b3",\n'
)
# Indices arrive unsorted; the first file row must replace the LOWEST index.
out2 = splice_sheet(SHEET, [2, 0], two)
rows2 = parsed(out2)["rows"]
check("first file row replaces lowest index", rows2[0]["topic"] == "First New", rows2[0]["topic"])
check("second file row replaces next index", rows2[2]["topic"] == "Second New", rows2[2]["topic"])
check("middle row untouched", rows2[1]["topic"] == "Topic Two")

print("splice: every refusal is whole")
refused("count mismatch refused", SHEET, [0, 2], REPLACEMENT, expect="exactly one new row")
refused("header mismatch refused", SHEET, [2],
        'Topic,Scope,Format,Intent,Prompts,Volume\n'
        'New Topic,New covers,Comparison,Commercial,"n1 | n2 | n3",200\n',
        expect="header")
refused("incomplete replacement refused", SHEET, [2],
        f'{HEADER}\nNew Topic,,Comparison,Commercial,"n1 | n2 | n3",200\n',
        expect="incomplete")
refused("off-sheet index refused", SHEET, [7], REPLACEMENT, expect="not on the sheet")
refused("malformed replacement refused", SHEET, [2], "", expect="")

print("rewrite block: what the session is told")
payload = parsed(SHEET)
block = rewrite_block(2, payload, [2], "Go bottom-of-funnel.")
check("feedback is quoted verbatim", "Go bottom-of-funnel." in block)
check("rejected row named with 1-based number", 'Row 3: "Topic Three"' in block)
check("kept rows listed as exclusions", '"Topic One"' in block and '"Topic Two"' in block)
check("kept formats surface for the quota rule", "[Listicle]" in block)
check("exact count stated", "EXACTLY 1 data row" in block)
check("header contract quoted", HEADER in block)
empty = rewrite_block(2, payload, [2], "   ")
check("blank feedback stated, not dangling", "(none given" in empty)

print()
if FAILURES:
    print(f"{len(FAILURES)} of {CHECKS[0]} checks FAILED: {', '.join(FAILURES)}")
    sys.exit(1)
print(f"all {CHECKS[0]} checks passed")
