#!/usr/bin/env python3
"""Roadmap upload round-trip and the COLUMN CONTRACT. Spawns NOTHING, calls NO model, no real DB.

load_upload is a security control (re-read the stored bytes by upload_id, never trust the
browser's rows). It failed CLOSED on a VALID upload: it re-ran safe_filename on the upload_id,
which truncates to 80 chars, so an upload_id built from an already-stamped filename (a re-uploaded
archive) ran past 80, ".csv" was chopped to ".c", the DB match missed, and a good upload answered
400 "unknown upload_id". This pins the fix: the lookup uses the EXACT upload_id.

The contract test below pins the other half, which nothing pinned at all. The binding three are
read BY POSITION, so a column inserted anywhere before column 8 silently redirects the prompts
cell: every row keeps parsing, every run keeps starting, and the piece is written against whatever
text now sits at that index. Position is the mapping's strength and its whole exposure, so the
positions belong in a test rather than in a reviewer's memory.

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

    csv = (f"{','.join(roadmap.COLUMNS)}\n"
           "Solar inverters,Buyer guide,Guide,880,120,0.90,24,"
           "\"what is the best inverter | inverter price\",310,Commercial\n")
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


EXPECTED_COLUMNS = (
    "Content Topic",
    "What the Piece Covers",
    "Content Type",
    "Keyword Volume",
    "AI Search Volume",
    "Cost Per Click",
    "Keyword Difficulty",
    "Target Prompts",
    "Query Volume",
    "Query Intent",
)

# Spelled out here rather than built from roadmap.COLUMNS on purpose: a test that reads the
# constant it is checking agrees with any value that constant ever takes, which is the one thing
# this must not do. This literal is the contract, and the day the module drifts from it the
# diff has to touch this file and say so.
WELL_FORMED = (
    f"{','.join(EXPECTED_COLUMNS)}\n"
    'Weekend homes near Bengaluru,What a buyer compares and on what evidence,'
    'Comparison anchor,1900,140,1.20,31,'
    '"which weekend homes near bengaluru are worth it | how much does a plot cost | '
    'is a farmhouse a good investment",260,Commercial\n'
)

# Every column of the OLD six-column sheet, exactly as an operator still holds it. Refused on
# width, loudly, with the required width named.
OLD_SIX_COLUMN = (
    "Content Topic,What the Piece Covers,Format,Search Intent,Target Prompts,Est. Monthly Volume\n"
    'Weekend homes,What a buyer compares,Comparison anchor,Commercial,"p1 | p2 | p3",1900\n'
)

# THE ONE THE WIDTH CHECK CANNOT SEE: exactly the contract's width, laid out to the OLD
# six-column order and padded out with data points, so the prompts sit at column 5 and column 8
# holds a cost. It parses silently without the header guard, and every row's prompts are read out
# of the wrong cell.
OLD_ORDER_TEN_COLUMN = (
    "Content Topic,What the Piece Covers,Format,Search Intent,Target Prompts,"
    "Est. Monthly Volume,AI Search Volume,Cost Per Click,Keyword Difficulty,"
    "Query Intent\n"
    'Weekend homes,What a buyer compares,Comparison anchor,Commercial,"p1 | p2 | p3",'
    "1900,140,1.20,31,Commercial\n"
)

# The SAME failure arriving from the other direction, and the one a live machine actually holds:
# the superseded ELEVEN-column contract, which carried a prose Justification at column 4 and so
# pushed Target Prompts to column 9. It is WIDER than the contract, which the width check accepts
# by design, so the header guard is again the only thing between it and a run whose every piece
# answers whatever text sits at column 8.
PREVIOUS_ELEVEN_COLUMN = (
    "Content Topic,What the Piece Covers,Content Type,Justification,Keyword Volume,"
    "AI Search Volume,Cost Per Click,Keyword Difficulty,Target Prompts,Query Volume,"
    "Query Intent\n"
    'Weekend homes,What a buyer compares,Comparison anchor,Ranks nowhere yet,1900,140,1.20,31,'
    '"p1 | p2 | p3",260,Commercial\n'
)


def _raises_bad_upload(text):
    try:
        roadmap.parse_csv(text)
    except roadmap.BadUpload as exc:
        return str(exc)
    return ""


def test_the_column_contract():
    print("\ntest_the_column_contract")

    check("COLUMNS is exactly the ten headers, in order",
          tuple(roadmap.COLUMNS) == EXPECTED_COLUMNS, str(roadmap.COLUMNS))
    # The positions are the mapping. A column inserted before the prompts moves COL_PROMPTS off
    # Target Prompts, and these three lines are what makes that a failing test instead of a run.
    check("COL_TOPIC points at Content Topic",
          roadmap.COLUMNS[roadmap.COL_TOPIC] == "Content Topic", str(roadmap.COL_TOPIC))
    check("COL_COVERS points at What the Piece Covers",
          roadmap.COLUMNS[roadmap.COL_COVERS] == "What the Piece Covers", str(roadmap.COL_COVERS))
    check("COL_PROMPTS points at Target Prompts",
          roadmap.COLUMNS[roadmap.COL_PROMPTS] == "Target Prompts", str(roadmap.COL_PROMPTS))
    check("COL_PROMPTS is column 8, 0-indexed 7", roadmap.COL_PROMPTS == 7,
          str(roadmap.COL_PROMPTS))
    check("MIN_COLUMNS is the contract's own width",
          roadmap.MIN_COLUMNS == len(EXPECTED_COLUMNS) == 10, str(roadmap.MIN_COLUMNS))

    payload = roadmap.parse_csv(WELL_FORMED)
    rows = payload["rows"]
    check("a well-formed sheet builds one row", len(rows) == 1, str(len(rows)))
    row = rows[0]
    check("the topic comes from column 1",
          row["topic"] == "Weekend homes near Bengaluru", row["topic"])
    check("the scope comes from column 2",
          row["covers"] == "What a buyer compares and on what evidence", row["covers"])
    check("the three prompts split out of column 8", len(row["prompts"]) == 3, str(row["prompts"]))
    check("the first prompt is the prompts cell's, not a neighbour's",
          row["prompts"][0] == "which weekend homes near bengaluru are worth it",
          row["prompts"][0])
    check("the row is complete", row["complete"] and not row["missing"], str(row["missing"]))

    extras = {extra["label"]: extra["value"] for extra in row["extras"]}
    check("the other SEVEN columns all arrive as extras", len(row["extras"]) == 7, str(extras))
    # The data points specifically: they ARE the justification, there being no prose column
    # arguing about them, so a figure that never reaches the writer is a row with no case behind
    # it. Query Intent is here for a second reason: it is a live search-intent classification of
    # the row's PRIMARY target prompt, not an eyeball read of the prompt text, and the sheet's
    # commercial/topical mix is counted off it.
    check("Cost Per Click arrives under its own header",
          extras.get("Cost Per Click") == "1.20", str(extras))
    check("Query Intent arrives under its own header",
          extras.get("Query Intent") == "Commercial", str(extras))
    check("no extra is labelled with a binding header",
          not {"Content Topic", "What the Piece Covers", "Target Prompts"} & set(extras),
          str(extras))

    narrow = _raises_bad_upload(OLD_SIX_COLUMN)
    check("a six-column sheet written to the old contract is refused", bool(narrow))
    # The width AND the header row it must carry: an operator who cannot see the shape they need
    # has been told only that they are wrong. Asserted as two separate substrings rather than one
    # sentence, so rewording the prose does not fail the test but dropping the actionable half does.
    check("and the refusal names the required width",
          f"the roadmap contract is {roadmap.MIN_COLUMNS}" in narrow, narrow)
    check("and quotes the header row the sheet must carry",
          ", ".join(roadmap.COLUMNS) in narrow, narrow)
    # It lands in EngineErrorNote, a plain <p> that collapses newlines, so a message written in
    # paragraphs arrives at the operator as a run-on.
    check("and reads as one line, because the surface collapses newlines",
          "\n" not in narrow, repr(narrow))

    # THE MOST IMPORTANT ASSERTION HERE. This sheet is the right width, so nothing but the header
    # guard stands between it and a run whose every piece answers the wrong query.
    misordered = _raises_bad_upload(OLD_ORDER_TEN_COLUMN)
    check("a ten-column sheet in the OLD order is refused too", bool(misordered))
    check("and the refusal names the column that moved",
          "column 8 should be 'Target Prompts'" in misordered, misordered)

    superseded = _raises_bad_upload(PREVIOUS_ELEVEN_COLUMN)
    check("a sheet on the superseded eleven-column contract is refused", bool(superseded))
    check("and that refusal names the column that moved too",
          "column 8 should be 'Target Prompts'" in superseded, superseded)

    # Deliberate, and documented in _check_binding_headers: an upload with an empty leading row
    # has no header text to check, and refusing it here would make a sheet the splice path can
    # still rewrite into one nothing can read.
    blank_header = ",".join([""] * roadmap.MIN_COLUMNS) + "\n" + WELL_FORMED.split("\n", 1)[1]
    try:
        blank_rows = roadmap.parse_csv(blank_header)["rows"]
    except roadmap.BadUpload as exc:
        check("a wholly blank header row is not refused", False, str(exc))
    else:
        check("a wholly blank header row is not refused", True)
        check("and its row still parses by position",
              blank_rows[0]["topic"] == "Weekend homes near Bengaluru"
              and len(blank_rows[0]["prompts"]) == 3, str(blank_rows))


def main():
    print("roadmap_check: static checks only. No CLI spawned, no model called, no real DB.")
    for test in (test_load_upload_matches_the_exact_untruncated_upload_id,
                 test_missing_upload_still_fails_closed,
                 test_the_column_contract):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
