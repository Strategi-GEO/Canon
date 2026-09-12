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


HEADER = ("Content Topic,What the Piece Covers,Content Type,Keyword Volume,"
          "AI Search Volume,Cost Per Click,Keyword Difficulty,Target Prompts,Query Volume,"
          "Query Intent")

# Row 2's prompts cell carries a QUOTED NEWLINE, the thing ad-hoc splitting corrupts, so the
# checks below prove the splice round-trips it. Its blank data-point cells are the other case
# worth carrying: a sheet with no live figure for a column, which is a blank extra and never a
# missing field. Row 3 is the one being replaced.
SHEET = (
    f"{HEADER}\n"
    'Topic One,Covers one,Explainer,100,40,0.80,22,"p1 | p2 | p3",30,Informational\n'
    'Topic Two,Covers two,Listicle,,,,,"line one\nline two",,Commercial\n'
    'Topic Three,Covers three,How-to,50,20,0.40,15,"q1 | q2 | q3",12,Commercial\n'
)

REPLACEMENT = (
    f"{HEADER}\n"
    'New Topic,New covers,Comparison,200,80,1.20,30,"n1 | n2 | n3",60,Commercial\n'
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
      {"label": "Content Type", "value": "Listicle"} in rows[1]["extras"], str(rows[1]["extras"]))
check("replacement extras land", {"label": "Cost Per Click", "value": "1.20"}
      in rows[2]["extras"], str(rows[2]["extras"]))
check("header unchanged", parsed(out)["columns"] == parsed(SHEET)["columns"])

print("splice: replacement order maps to sorted indices")
two = (
    f"{HEADER}\n"
    'First New,Covers a,Explainer,,,,,"a1 | a2 | a3",,Informational\n'
    'Second New,Covers b,Listicle,,,,,"b1 | b2 | b3",,Commercial\n'
)
# Indices arrive unsorted; the first file row must replace the LOWEST index.
out2 = splice_sheet(SHEET, [2, 0], two)
rows2 = parsed(out2)["rows"]
check("first file row replaces lowest index", rows2[0]["topic"] == "First New", rows2[0]["topic"])
check("second file row replaces next index", rows2[2]["topic"] == "Second New", rows2[2]["topic"])
check("middle row untouched", rows2[1]["topic"] == "Topic Two")

print("splice: every refusal is whole")
refused("count mismatch refused", SHEET, [0, 2], REPLACEMENT, expect="exactly one new row")
# The binding three are named correctly here so the parser's own header guard lets it through:
# what is wrong is the EXTRAS' labels, which is exactly what the splice's header-equality rule
# exists for. Extras are labelled by the SHEET's header, so a replacement calling its data points
# something else would have them read under the operator's names.
refused("header mismatch refused", SHEET, [2],
        'Content Topic,What the Piece Covers,Type,Volume,AI Volume,CPC,Difficulty,'
        'Target Prompts,Query Volume,Intent\n'
        'New Topic,New covers,Comparison,200,80,1.20,30,"n1 | n2 | n3",60,Commercial\n',
        expect="header")
refused("incomplete replacement refused", SHEET, [2],
        f'{HEADER}\nNew Topic,,Comparison,200,80,1.20,30,"n1 | n2 | n3",60,Commercial\n',
        expect="incomplete")
refused("off-sheet index refused", SHEET, [7], REPLACEMENT, expect="not on the sheet")
refused("malformed replacement refused", SHEET, [2], "", expect="")

print("splice: a sheet with a BLANK header row is still rewritable")
# The homecanvas case: the operator's upload carried an empty first row, the parser read it as
# the header (row 1 ALWAYS is), and the header-equality refusal made the sheet impossible to
# rewrite: the agent cannot be asked to reproduce ",,,,,". Width is what gets checked instead,
# and the sheet's own blank header survives the splice, so the sheet stays exactly as the
# operator uploaded it.
BLANK_ROW = ",".join([""] * len(HEADER.split(",")))
BLANK_SHEET = f"{BLANK_ROW}\n" + SHEET
out3 = splice_sheet(BLANK_SHEET, [3], REPLACEMENT)
rows3 = parsed(out3)["rows"]
check("blank-header sheet splices under the standard header",
      rows3[3]["topic"] == "New Topic", rows3[3]["topic"])
check("blank header row survives the splice", out3.splitlines()[0] == BLANK_ROW,
      out3.splitlines()[0])
check("kept rows survive under a blank header", rows3[1]["topic"] == "Topic One")
# A WIDER replacement, not a narrower one: with the blank header at the contract's own width, a
# narrow file is refused by the parser before the splice sees it, so only an extra column can
# still reach the width branch this case is about.
refused("blank-header sheet still refuses a width mismatch", BLANK_SHEET, [3],
        f'{HEADER},Extra Column\n'
        'New Topic,New covers,How-to,200,80,1.20,30,"n1 | n2 | n3",60,Commercial,spare\n',
        expect="column count")

print("rewrite block: what the session is told")
payload = parsed(SHEET)
block = rewrite_block(2, payload, [2], "Go bottom-of-funnel.")
check("feedback is quoted verbatim", "Go bottom-of-funnel." in block)
check("rejected row named with 1-based number", 'Row 3: "Topic Three"' in block)
check("kept rows listed as exclusions", '"Topic One"' in block and '"Topic Two"' in block)
check("kept formats surface for the quota rule", "[Listicle]" in block)
check("exact count stated", "EXACTLY 1 data row" in block)
check("header contract quoted", HEADER in block)
check("row-scoped feedback mapping stated", "ONE note can carry instructions for SEVERAL rows" in block)
empty = rewrite_block(2, payload, [2], "   ")
check("blank feedback stated, not dangling", "(none given" in empty)

print("rewrite block: a blank-header sheet is told the truth about its header")
blank_payload = parsed(BLANK_SHEET)
blank_block = rewrite_block(1, blank_payload, [1], "Sharper angle.")
check("blank header named, not quoted", "header row is BLANK" in blank_block)
check("no blank header row quoted as a contract", BLANK_ROW not in blank_block)
check("width stated for the blank case", "10 column(s) wide" in blank_block)

print("rewrite block: a non-house header tells the session to write the CSV itself")
# build_roadmap.py stamps the HOUSE header and takes no flag for another, so on any sheet whose
# extra-column labels are the operator's own, running it produces a file splice_sheet refuses on
# header mismatch. That refusal lands AFTER a full research session, which is the expensive way
# to learn it, so the block has to say so up front. Any operator sheet is such a sheet, and so is
# every sheet widen_roadmaps.py migrated, because that script deliberately keeps their labels.
THEIRS = HEADER.replace("Content Type,", "Est. Searches,").replace(",Query Intent", ",Funnel Stage")
theirs_sheet = SHEET.replace(HEADER, THEIRS)
theirs_block = rewrite_block(2, parsed(theirs_sheet), [2], "Sharper angle.")
check("the non-house header is still quoted verbatim", THEIRS in theirs_block, theirs_block[-900:])
check("and the session is told build_roadmap.py cannot write this file",
      "`build_roadmap.py` cannot write this file" in theirs_block, theirs_block[-900:])

house_block = rewrite_block(2, payload, [2], "Sharper angle.")
check("a house-header sheet gets no such warning",
      "`build_roadmap.py` cannot write this file" not in house_block, house_block[-900:])

print()
if FAILURES:
    print(f"{len(FAILURES)} of {CHECKS[0]} checks FAILED: {', '.join(FAILURES)}")
    sys.exit(1)
print(f"all {CHECKS[0]} checks passed")
