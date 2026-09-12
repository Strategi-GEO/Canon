#!/usr/bin/env python3
"""Widen roadmaps stored under the OLD contract to the current ten-column one.

RUN ONCE, at the cutover. server/roadmap.py `load_roadmap` re-parses the stored raw_csv on
EVERY read, through the same `_parse_rows` that now enforces the ten-column width and the
binding-header guard. So an old sheet does not merely lack the new columns: it raises BadUpload
on every read, and the Create tab, blog generation, the portal roadmap view and index_by_slug
all go through that one function. Without this script the cutover bricks every existing brand.

The mapping is POSITIONAL, which is what makes it safe to do mechanically: the old contract read
the brief out of columns 1, 2 and 5, so where each field went is a fact about the file and not a
guess about its headers.

EVERY WIDTH THE OLD CONTRACT ACCEPTED IS WIDENED, not just the old house sheet's six. The old
rule was "at least 5 columns" with the brief at 1, 2 and 5, so 5, 7, 8 and 9 column sheets were
all legal uploads and real ones exist: a five-column clients/vacation-village/roadmap.csv is in
this repo's history. Widening only the exact six left every one of them un-widened and therefore
permanently unreadable after the cutover, which is the whole failure this script exists to
prevent, arriving at the brands it skipped. A sheet NARROWER than five never carried a brief at
all, so there is nothing to move and it is named in the summary instead.

Columns the old house contract never named are not dropped either. They keep their own header
text and land on the new sheet's spare data-point positions, so the operator's own labels reach
the writer exactly as they did before, and nothing goes missing quietly.

  .venv/bin/python scripts/widen_roadmaps.py            # dry run, writes nothing
  .venv/bin/python scripts/widen_roadmaps.py --apply
"""
import argparse
import csv
import io
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import db, roadmap  # noqa: E402

# The old house sheet, in order, and the only reason it is spelled out here: an old sheet whose
# header reads something else is an OPERATOR's own sheet, and its extras were labelled by those
# headers rather than by these. See _header.
OLD_COLUMNS = ("Content Topic", "What the Piece Covers", "Format", "Search Intent",
               "Target Prompts", "Est. Monthly Volume")
OLD_WIDTH = len(OLD_COLUMNS)

# The narrowest sheet the OLD contract accepted. It read the brief out of columns 1, 2 and 5, so
# five is exactly the width at which a sheet still carried one.
OLD_MIN_WIDTH = 5

# old 0-index -> new 0-index, computed off roadmap.COLUMNS rather than written out, because every
# one of these positions moved when the prose Justification column was removed and hardcoding them
# is how this file drifts from the contract it is migrating to. Format became Content Type, Search
# Intent became Query Intent, and Est. Monthly Volume became Keyword Volume (the Google MSV half of
# what it used to mean).
OLD_TO_NEW = {
    0: roadmap.COL_TOPIC,
    1: roadmap.COL_COVERS,
    2: roadmap.COLUMNS.index("Content Type"),
    3: roadmap.COLUMNS.index("Query Intent"),
    4: roadmap.COL_PROMPTS,
    5: roadmap.COLUMNS.index("Keyword Volume"),
}
BINDING = (roadmap.COL_TOPIC, roadmap.COL_COVERS, roadmap.COL_PROMPTS)

# Where a column the old house contract never named can go: every new position that is neither
# binding nor already the target of a rename. They are the live data-point columns, so a surplus
# column landing on one arrives under the OPERATOR'S OWN header, never under the house label that
# nominally sits there. That is the same slack _header relies on, and it is what makes parking a
# column here honest rather than a relabelling.
SPARE = tuple(position for position in range(roadmap.MIN_COLUMNS)
              if position not in BINDING and position not in set(OLD_TO_NEW.values()))


def _mapping(width):
    """old 0-index -> new 0-index for a sheet this wide, or None when it is too narrow.

    The renames above cover the old HOUSE sheet's six positions. Anything past them is a column
    the old contract never named, on a sheet the old contract still accepted, and it gets a spare
    position rather than the floor: dropping it would lose an operator's own column silently,
    which is the one outcome worse than refusing the sheet outright.
    """
    if width < OLD_MIN_WIDTH:
        return None
    mapping = dict(OLD_TO_NEW)
    surplus = [position for position in range(width) if position not in mapping]
    # Cannot fire under the current numbers, an old sheet being narrower than the new contract by
    # construction, so at most three columns compete for four spares. It is checked anyway because
    # the alternative to checking is dropping a column without saying so.
    if len(surplus) > len(SPARE):
        return None
    mapping.update(zip(surplus, SPARE))
    return mapping


def _header(old_header, mapping):
    """The new header row, keeping an operator's OWN label on any extra that carried one.

    The binding three take the contract's names, because _check_binding_headers demands them
    verbatim. The other seven are the extras' labels, which the contract leaves deliberately
    loose, and that slack is what makes this migration honest for a sheet the operator wrote
    themselves. Their column 3 says "Est. Searches", not "Format", so stamping the house name on
    it would hand a writer `Content Type: ~10`: the same fabricated label, arriving by migration,
    that the positional mapping exists to prevent. Where the old header IS the old house name, the
    new house name replaces it, because that pair is the rename and not a relabelling.

    A SURPLUS column has no rename to inherit, so it always keeps what the operator called it. A
    surplus column with a BLANK header has no honest name at all, and the house label sitting at
    its new position would be a fabricated one, so it is named for where it came from instead.
    """
    header = list(roadmap.COLUMNS)
    for old_position, new_position in sorted(mapping.items()):
        if new_position in BINDING:
            continue
        found = old_header[old_position].strip() if old_position < len(old_header) else ""
        if old_position >= OLD_WIDTH:
            header[new_position] = found or f"Old column {old_position + 1}"
        elif found and found.casefold() != OLD_COLUMNS[old_position].casefold():
            header[new_position] = found
    return header


def widen(text):
    """Sheet text -> (status, payload, note). status: 'current' | 'widened' | 'unmapped'.

    Pure: no database, no disk. `payload` is the new CSV text when widened and "" when not, and
    `note` is the summary line: what this sheet did, or why nothing could be done with it. The
    note is returned rather than printed so the one function that decides is also the one that
    says, and a caller cannot describe a widening it did not perform.

    EVERY NEW CELL OUTSIDE THE MAP IS LEFT BLANK, and blank is the honest value. We never pulled
    an AI search volume, a cost per click or a keyword difficulty for these rows, so there is
    nothing to carry across. Those columns exist to hold a LIVE figure that argues the row to the
    client, so filling one with a plausible number, or with a copy of the volume next to it,
    would put a fabricated figure in the one place the contract promises a measured one. A blank
    cell is dropped by _extras rather than passed to the writer as an empty label, so the cost of
    honesty here is nothing at all.

    The binding three get the contract's own header names, because _check_binding_headers now
    refuses a sheet whose header says the brief sits elsewhere. The extras keep whatever the
    operator called them unless that was the old house name: see _header.

    Blank rows are kept as blank rows so every row's index is unchanged by the widening. Row
    indices are what the rewrite splice subscripts into, and shifting them silently would point a
    rewrite at the wrong row.
    """
    rows = roadmap._csv_rows(text)
    if not rows:
        return "unmapped", "", "it is empty: no header row and no data rows"

    width = max(len(row) for row in rows)
    # >=, not ==. The parser accepts a sheet WIDER than the contract, treating the surplus as more
    # labelled extras, so such a sheet is already current and widening it would be inventing a
    # problem. It still has to clear the header guard: a wide sheet in the old shape is refused by
    # the engine and is exactly what this script must report rather than guess at.
    if width >= roadmap.MIN_COLUMNS:
        try:
            roadmap._check_binding_headers([cell.strip() for cell in rows[0]], "the sheet")
        except roadmap.BadUpload as exc:
            return "unmapped", "", str(exc)
        return "current", text, "already on the contract, skipped"

    mapping = _mapping(width)
    if mapping is None:
        return "unmapped", "", (
            f"it is {width} column(s) wide and even the old contract needed {OLD_MIN_WIDTH}, "
            f"reading the brief out of columns 1, 2 and 5, so it never carried one this script "
            f"could move and where its fields sit is a guess this script does not make")

    out = [_header(rows[0], mapping)]
    for raw in rows[1:]:
        new = [""] * roadmap.MIN_COLUMNS
        for old_position, new_position in mapping.items():
            if old_position < len(raw):
                new[new_position] = raw[old_position]
        out.append(new)

    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows(out)
    moved = sorted(position for position in mapping if position >= OLD_WIDTH and position < width)
    extra = ""
    if moved:
        # Named individually, because these are the columns nobody planned a home for and an
        # operator reading the summary is the only person who can say whether they landed right.
        extra = (", carrying old column(s) " + ", ".join(str(position + 1) for position in moved)
                 + " onto spare positions under their own headers")
    return "widened", buf.getvalue(), f"widened from {width} column(s){extra}"


def _land(cid, month, old_csv, new_text, payload, report):
    """Archive the pre-widen sheet, then rebuild the record, in ONE transaction.

    Same idiom as delete_roadmap and _push_rewrite: this destroys the only copy of the stored
    text, so the archive is what makes it recoverable, and a failure anywhere leaves the sheet
    exactly as it was. The rows are rebuilt by _write_sheet from the SAME parse that accepted the
    widened text, so the stored rows and the sheet can never drift.

    `report` is passed straight back because _write_sheet's upsert overwrites the column, and the
    generation report still describes these rows: nothing about the topics changed.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    with db.tx() as cur:
        cur.execute("insert into roadmap_uploads (client_id, filename, raw) values (%s, %s, %s)",
                    (cid, f"{stamp}-pre-widen.csv", old_csv.encode("utf-8")))
        roadmap._write_sheet(cur, cid, new_text, payload, report=report, month=month)


def _handle(name, text, apply_it, land):
    """One sheet: report a line, return a problem string or None. Never raises."""
    try:
        status, out, note = widen(text)
        if status == "current":
            print(f"  {name}: {note}")
            return None
        if status == "unmapped":
            print(f"  {name}: LEFT ALONE, {note}")
            return f"{name}: {note}"
        # Parse before writing anything, so a widening that produced an unreadable sheet costs
        # nothing. This is also the payload _write_sheet rebuilds the rows from.
        payload = roadmap.parse_csv(out)
        if apply_it:
            land(out, payload)
        print(f"  {name}: {note}, {len(payload['rows'])} row(s) parse")
        return None
    except Exception as exc:
        # One bad sheet must never stop the migration: the brands behind it still need widening.
        print(f"  {name}: LEFT ALONE, {exc}")
        return f"{name}: {exc}"


def _sheets(apply_it):
    print("roadmap_sheets:")
    if not db.db_configured():
        print("  no DATABASE_URL in server/.env, so the stored sheets were not read")
        return ["the stored sheets were never read: no DATABASE_URL"]
    problems = []
    for slug, cid, month, raw_csv, report in db.q(
            """select c.slug, s.client_id, s.month, s.raw_csv, s.report
                 from roadmap_sheets s join clients c on c.id = s.client_id
                where c.deleted_at is null
                order by c.slug, s.month"""):
        problems.append(_handle(
            f"{slug} month {month}", raw_csv, apply_it,
            lambda out, payload, cid=cid, month=month, raw_csv=raw_csv, report=report:
                _land(cid, month, raw_csv, out, payload, report)))
    return [problem for problem in problems if problem]


def _disk(apply_it):
    """The generation scratch files. roadmap_gen._validate_written re-parses this path, so a
    stale narrow one is refused as though the session had written it.

    roadmap-rewrite-*.csv is deliberately not matched: those hold one in-flight job's replacement
    rows, spliced back by _push_rewrite, and they are not a sheet.
    """
    print("\nclients/*/roadmap.csv:")
    problems = []
    for path in sorted((roadmap.REPO_ROOT / "clients").glob("*/roadmap.csv")):
        name = str(path.relative_to(roadmap.REPO_ROOT))
        try:
            text = roadmap._decode(path.read_bytes())
        except Exception as exc:
            # An unreadable file is one bad sheet like any other: the rest still need widening.
            print(f"  {name}: LEFT ALONE, {exc}")
            problems.append(f"{name}: {exc}")
            continue
        problems.append(_handle(
            name, text, apply_it,
            lambda out, payload, path=path: path.write_text(out, encoding="utf-8")))
    return [problem for problem in problems if problem]


def _selfcheck():
    """Every branch of widen(), against no database and no disk."""
    old = ('Content Topic,What the Piece Covers,Format,Search Intent,Target Prompts,'
           'Est. Monthly Volume\n'
           'Cafes in CP,"What it covers",Hub listicle,Commercial,"best cafes in CP\n'
           'where to sit in CP",1300\n')
    status, out, note = widen(old)
    assert status == "widened", status
    assert "from 6 column(s)" in note, note
    payload = roadmap.parse_csv(out)
    row = payload["rows"][0]
    assert row["topic"] == "Cafes in CP" and row["covers"] == "What it covers", row
    assert row["prompts"] == ["best cafes in CP", "where to sit in CP"], row["prompts"]
    assert {e["label"]: e["value"] for e in row["extras"]} == {
        "Content Type": "Hub listicle", "Query Intent": "Commercial",
        "Keyword Volume": "1300"}, row["extras"]
    # Blank is the honest value, so the columns nobody measured stay empty.
    assert payload["columns"][4:7] == ["AI Search Volume", "Cost Per Click",
                                       "Keyword Difficulty"], payload["columns"]
    assert all(not e["label"].startswith("AI Search") for e in row["extras"]), row["extras"]
    # Idempotent: a widened sheet is already on the contract, so a second run skips it.
    assert widen(out)[:2] == ("current", out)
    # An operator's own labels survive, or their volume would arrive labelled Content Type.
    _, theirs, _ = widen(old.replace("Format,Search Intent", "Est. Searches,Funnel Stage"))
    assert roadmap.parse_csv(theirs)["columns"][2] == "Est. Searches", theirs

    # THE WIDTHS THE OLD CONTRACT ACCEPTED AND THIS SCRIPT USED TO SKIP. Five columns is the
    # narrowest sheet that ever carried a brief, and vacation-village had one; its columns 3 and 4
    # are whatever the operator put there, and the renames still apply because those positions ARE
    # where the old house sheet kept Format and Search Intent.
    five = ('Content Topic,What the Piece Covers,Est. Searches,Funnel Stage,Target Prompts\n'
            'Cafes in CP,What it covers,~1200,Bottom,"best cafes in CP | where to sit"\n')
    status, out5, note5 = widen(five)
    assert status == "widened", (status, note5)
    row5 = roadmap.parse_csv(out5)["rows"][0]
    assert row5["prompts"] == ["best cafes in CP", "where to sit"], row5["prompts"]
    assert {e["label"]: e["value"] for e in row5["extras"]} == {
        "Est. Searches": "~1200", "Funnel Stage": "Bottom"}, row5["extras"]

    # Eight columns: the old brief still sits at 1, 2 and 5, and columns 7 and 8 are the
    # operator's own with no rename to inherit. Nothing may be dropped silently, so they land on
    # spare positions under their own headers and the note says which columns moved.
    eight = ('Content Topic,What the Piece Covers,Format,Search Intent,Target Prompts,'
             'Est. Monthly Volume,Owner,Due\n'
             'Cafes in CP,What it covers,Hub listicle,Commercial,"best cafes in CP",1300,'
             'Priya,March\n')
    status, out8, note8 = widen(eight)
    assert status == "widened", (status, note8)
    assert "old column(s) 7, 8" in note8, note8
    extras8 = {e["label"]: e["value"] for e in roadmap.parse_csv(out8)["rows"][0]["extras"]}
    assert extras8["Owner"] == "Priya" and extras8["Due"] == "March", extras8
    assert extras8["Keyword Volume"] == "1300", extras8
    # A surplus column with no header of its own is named for where it came from, never for the
    # house label that happens to sit at its new position.
    _, out_blank, _ = widen(eight.replace(",Owner,Due", ",,Due"))
    labels = [e["label"] for e in roadmap.parse_csv(out_blank)["rows"][0]["extras"]]
    assert "Old column 7" in labels, labels

    # Never guessed at: too narrow to have carried a brief, and a readable new width in the wrong
    # order.
    assert widen("a,b,c,d\n1,2,3,4\n")[0] == "unmapped"
    assert widen(",".join(OLD_COLUMNS + ("x", "y", "z", "w")) + "\n")[0] == "unmapped"
    assert widen("")[0] == "unmapped"
    print("selfcheck: ok")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="actually write; the default is a dry run that writes nothing")
    parser.add_argument("--selfcheck", action="store_true",
                        help="assert widen() over fixtures and exit; touches nothing")
    args = parser.parse_args()

    if args.selfcheck:
        return _selfcheck()

    print(f"{'APPLY' if args.apply else 'DRY RUN'}: widening to the "
          f"{roadmap.MIN_COLUMNS}-column contract\n")
    problems = _sheets(args.apply) + _disk(args.apply)

    if not problems:
        print("\nnothing left behind.")
        return 0
    print(f"\n{len(problems)} sheet(s) a human has to deal with:")
    for problem in problems:
        print(f"  {problem}")
    # Non-zero on the ones nobody could map, never on the ones already migrated, so a runner is
    # alerted by work outstanding and not by a clean re-run.
    return 1


if __name__ == "__main__":
    sys.exit(main())
