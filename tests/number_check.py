#!/usr/bin/env python3
"""The roadmap row number, which is the name every blog actually goes by.

Titles here run to a dozen words and half of them open with the same three, so nobody holds
twenty of them in their head and no client quotes one back. "Change blog six" is the question
that gets asked, and the number is the only thing in the app that can answer it. That makes the
number load bearing, and a number is worth exactly what its agreement with the sheet is worth.

What this pins:

  1. ONE ORIGIN. The number is the row's position on the CURRENT sheet, matched BY SLUG, so it
     survives a directory scan that returns blogs in its own order and holds blogs whose row was
     deleted. Matching by position instead would not merely mislabel: it would point blog 25 at
     row 1 confidently, and the operator would act on it.

  2. ONE CONVENTION. Every stored index is 0 based and every display adds one. The preview's "#"
     column, the create table, the library, the live run and engine-error all show index + 1, so
     a number read on one screen finds the same row on every other.

  3. THE BLANK ROW. The preview numbers the RAW csv rows while the engine numbers PARSED rows and
     drops the blanks. Those two could disagree the moment a sheet has an empty line in it, and an
     operator's CSV frequently does. They agree only because _build_rows enumerates before it
     skips, which is one word of code and nothing anywhere names it. This is that name.

  4. NO INVENTED NUMBER. A blog on no row reports None, never 0 and never a guess.

Reads two real sheets if they are present and mutates nothing.

  .venv/bin/python tests/number_check.py
"""
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import roadmap  # noqa: E402

FAILURES = []
CHECKS = [0]

HEADER = list(roadmap.COLUMNS)
BLANK = [""] * len(HEADER)


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def _row(topic, prompts="p1"):
    """One contract-shaped row. The prompts cell is column 8, so the row is built by position
    from the header rather than by counting commas."""
    row = list(BLANK)
    row[roadmap.COL_TOPIC] = topic
    row[roadmap.COL_COVERS] = f"covers {topic}"
    row[roadmap.COL_PROMPTS] = prompts
    row[2] = "Hub listicle"
    return row


def _preview_numbers(raw):
    """What roadmap-preview-dialog.tsx renders: raw data rows, numbered from 1.

    read_sheet returns padded[1:] and the dialog prints rowIndex + 1 over it, so this is that
    calculation and not a paraphrase of it.
    """
    return {index + 1: row[0] for index, row in enumerate(raw[1:])}


def _engine_numbers(raw):
    """What every other surface renders: RoadmapRow.index + 1."""
    parsed = roadmap._parse_rows(raw, "number_check")
    return {row["index"] + 1: row["topic"] for row in parsed["rows"]}


print("[1] The preview and the engine number the same row the same way")

plain = [HEADER, _row("Topic A"), _row("Topic B"), _row("Topic C")]
check(
    "a clean sheet numbers 1, 2, 3 on both sides",
    _preview_numbers(plain) == _engine_numbers(plain) == {1: "Topic A", 2: "Topic B", 3: "Topic C"},
    f"preview={_preview_numbers(plain)} engine={_engine_numbers(plain)}",
)

# THE ONE THAT COULD SILENTLY BREAK. _build_rows enumerates over the raw rows and `continue`s on a
# blank, so the blank CONSUMES its index rather than renumbering what follows. If it ever skipped
# without consuming, Topic C would be engine #3 and preview #4: same blog, two numbers, and the
# operator reading the preview would tick the wrong row on the create page.
blank_middle = [HEADER, _row("Topic A"), _row("Topic B"), list(BLANK), _row("Topic C")]
engine_blank = _engine_numbers(blank_middle)
preview_blank = _preview_numbers(blank_middle)
check(
    "a blank row consumes its number rather than renumbering the rows after it",
    engine_blank == {1: "Topic A", 2: "Topic B", 4: "Topic C"},
    f"engine={engine_blank}",
)
check(
    "so Topic C is row 4 on BOTH sides, not 4 on one and 3 on the other",
    preview_blank.get(4) == engine_blank.get(4) == "Topic C",
    f"preview#4={preview_blank.get(4)!r} engine#4={engine_blank.get(4)!r}",
)
check(
    "every number the engine reports names the same topic the preview shows",
    all(preview_blank.get(n) == t for n, t in engine_blank.items()),
    f"preview={preview_blank} engine={engine_blank}",
)

trailing = [HEADER, _row("Topic A"), list(BLANK), list(BLANK)]
check(
    "trailing blank rows add no numbers",
    _engine_numbers(trailing) == {1: "Topic A"},
    f"engine={_engine_numbers(trailing)}",
)


print()
print("[2] A sheet Excel exported is a sheet every read path can read")

# The upload path decodes with _decode (latin-1 fallback, so it accepts any bytes) and stores the
# decoded TEXT in roadmap_sheets.raw_csv, which every read path now consumes. Before that, the
# reads re-opened the operator's verbatim bytes with a strict utf-8-sig, so the app accepted a
# file it could never read again: one curly apostrophe out of Excel on Windows is byte 0x92, and
# it 500'd the sheet preview, 500'd the blogs library through this module's own index_by_slug,
# and failed every topic in a run when the fact base could not build. Nothing about it was the
# operator's fault and no message pointed at the cause.
#
# The injection goes through _fetch_sheet, the one choke point every roadmap read uses, and it
# carries EXACTLY what save_upload stores for these bytes: _decode(raw_bytes). So this still
# proves the same thing end to end, that a sheet Excel exported is a sheet every read path can
# read, without writing a row to the live database.

# 0x92 curly apostrophe, 0xe9 e-acute: an ordinary Excel-on-Windows export.
_EXCEL_BYTES = (
    ",".join(roadmap.COLUMNS).encode("ascii") + b"\r\n"
    b"Bengaluru\x92s best caf\xe9s,covers cafes,Hub listicle,Ranks nowhere,880,120,0.90,24,"
    b"where to get coffee,310,Commercial\r\n"
)
_ORIG_FETCH = roadmap._fetch_sheet


def _fake_fetch(client_slug, month=None):
    if client_slug != "winexcel":
        return _ORIG_FETCH(client_slug, month)
    return roadmap._decode(_EXCEL_BYTES), "roadmap.csv", datetime.now(timezone.utc)


roadmap._fetch_sheet = _fake_fetch
try:
    for name, call in (
        ("read_sheet (the preview)", lambda: roadmap.read_sheet("winexcel")),
        ("load_roadmap (the brief)", lambda: roadmap.load_roadmap("winexcel")),
        ("index_by_slug (the numbers)", lambda: roadmap.index_by_slug("winexcel")),
    ):
        try:
            call()
            check(f"a cp1252 sheet does not break {name}", True)
        except UnicodeDecodeError as exc:
            check(f"a cp1252 sheet does not break {name}", False, f"UnicodeDecodeError: {exc}")

    # The row is numbered and its text survives. NOT asserting the exact slug: slugify maps
    # non-ascii to a hyphen, so "cafés" becomes "caf-s", and pinning that here would couple this
    # check to a rule it is not about and fail the day slugify improves.
    _mapped = roadmap.index_by_slug("winexcel")
    check(
        "the row still gets its number",
        list(_mapped.values()) == [0],
        f"{_mapped}",
    )
    check(
        "and Excel's apostrophe reads as an apostrophe, not as a control character",
        roadmap.load_roadmap("winexcel")["rows"][0]["topic"] == "Bengaluru’s best cafés",
        repr(roadmap.load_roadmap("winexcel")["rows"][0]["topic"]),
    )
finally:
    roadmap._fetch_sheet = _ORIG_FETCH

# Order, not just tolerance. utf-8 must win so a normal file is never mojibake'd by a fallback that
# cannot fail, and cp1252 must beat latin-1 so Excel's 0x92 reads as the apostrophe the operator
# typed rather than as a control character.
check(
    "utf-8 is preferred over every fallback",
    roadmap._decode("Bengaluru’s cafés".encode("utf-8")) == "Bengaluru’s cafés",
)
check(
    "cp1252 beats latin-1, so Excel's apostrophe survives",
    roadmap._decode("Bengaluru’s cafés".encode("cp1252")) == "Bengaluru’s cafés",
    repr(roadmap._decode("Bengaluru’s cafés".encode("cp1252"))),
)
check(
    "latin-1 still catches the bytes cp1252 leaves undefined",
    roadmap._decode(b"a\x81b") == "a\x81b",
)
check(
    "a utf-8 BOM is stripped rather than read as a character",
    roadmap._decode(b"\xef\xbb\xbfContent Topic") == "Content Topic",
)


print()
print("[3] index_by_slug: the join every blog's number is read through")

check(
    "a client with no roadmap maps nothing rather than raising",
    roadmap.index_by_slug("no-such-client-anywhere") == {},
)

# The join is BY SLUG. Position matching is the bug this is built to exclude: the blogs list is a
# directory scan in its own order, so position means nothing across the two.
#
# BadUpload is caught the same way an absent roadmap is, and it is a real state on a real machine:
# a brand whose stored sheet was written to an older contract is refused by the ten-column one, so
# there is no sheet to join against and these checks have nothing to say. index_by_slug does NOT
# catch it (it catches only RoadmapNotFound), so this is the caller's problem to name.
try:
    mapped = roadmap.index_by_slug("blr-brewing")
except roadmap.BadUpload as exc:
    mapped = {}
    print(f"  SKIP  blr-brewing's stored sheet is not on the current contract: {exc.args[0][:90]}")
if mapped:
    check(
        "a real sheet maps every row to a 0 based index",
        sorted(mapped.values()) == list(range(len(mapped))),
        f"indices={sorted(mapped.values())}",
    )
    check(
        "the map is keyed by slug, not by position",
        all(isinstance(key, str) and key for key in mapped),
    )
    check(
        "no slug is mapped twice, so no number is ambiguous",
        len(set(mapped)) == len(mapped),
    )
else:
    print("  SKIP  blr-brewing has no roadmap on this machine")


print()
print("[4] Every blog carries its row, and a blog on no row carries None")

try:
    from server.app import _blog_history
except Exception as exc:  # pragma: no cover
    print(f"  SKIP  app import failed: {exc}")
    _blog_history = None

if _blog_history is not None:
    for slug in ("blr-brewing", "vacation-village"):
        try:
            blogs = _blog_history(slug)
        except roadmap.BadUpload as exc:
            # Same state as above, reached through the app rather than the module: _blog_history
            # calls index_by_slug and does not guard it either, so a pre-contract sheet takes the
            # whole blogs list down with it.
            print(f"  SKIP  {slug}: {exc.args[0][:90]}")
            continue
        if not blogs:
            print(f"  SKIP  {slug} has no blogs on this machine")
            continue

        check(
            f"{slug}: every blog reports roadmap_index, present or explicitly absent",
            all("roadmap_index" in blog for blog in blogs),
        )
        # None, never 0. Zero is row one, so a falsy coercion anywhere in this chain would file
        # every rowless blog as the first row of the sheet.
        check(
            f"{slug}: roadmap_index is an int or None, never a placeholder",
            all(
                blog["roadmap_index"] is None or isinstance(blog["roadmap_index"], int)
                for blog in blogs
            ),
        )
        numbered = [b for b in blogs if b["roadmap_index"] is not None]
        check(
            f"{slug}: no two blogs claim the same row",
            len({b["roadmap_index"] for b in numbered}) == len(numbered),
        )
        # The number must name THIS blog's row, which is only true if the join used the slug.
        sheet = roadmap.index_by_slug(slug)
        check(
            f"{slug}: every number agrees with the sheet, matched by slug",
            all(sheet.get(b["topic_slug"]) == b["roadmap_index"] for b in numbered),
        )


print()
if FAILURES:
    print(f"{len(FAILURES)} of {CHECKS[0]} checks FAILED")
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)
print(f"{CHECKS[0]}/{CHECKS[0]} checks passed")
print("number_check OK")
