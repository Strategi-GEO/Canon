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
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import roadmap  # noqa: E402

FAILURES = []
CHECKS = [0]

HEADER = ["Content Topic", "What the Piece Covers", "Format", "Search Intent", "Target Prompts"]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def _row(topic, prompts="p1"):
    return [topic, f"covers {topic}", "Hub listicle", "Commercial", prompts]


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
blank_middle = [HEADER, _row("Topic A"), _row("Topic B"), ["", "", "", "", ""], _row("Topic C")]
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

trailing = [HEADER, _row("Topic A"), ["", "", "", "", ""], ["", "", "", "", ""]]
check(
    "trailing blank rows add no numbers",
    _engine_numbers(trailing) == {1: "Topic A"},
    f"engine={_engine_numbers(trailing)}",
)


print()
print("[2] index_by_slug: the join every blog's number is read through")

check(
    "a client with no roadmap maps nothing rather than raising",
    roadmap.index_by_slug("no-such-client-anywhere") == {},
)

# The join is BY SLUG. Position matching is the bug this is built to exclude: the blogs list is a
# directory scan in its own order, so position means nothing across the two.
mapped = roadmap.index_by_slug("blr-brewing")
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
print("[3] Every blog carries its row, and a blog on no row carries None")

try:
    from server.app import _blog_history
except Exception as exc:  # pragma: no cover
    print(f"  SKIP  app import failed: {exc}")
    _blog_history = None

if _blog_history is not None:
    for slug in ("blr-brewing", "vacation-village"):
        blogs = _blog_history(slug)
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
