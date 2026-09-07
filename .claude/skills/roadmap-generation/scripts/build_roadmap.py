#!/usr/bin/env python3
"""Validate roadmap rows against the house contract and write the deliverables.

The contract is TEN columns and this script is the only thing that proves a sheet meets it.
Hand-writing the CSV and eyeballing it is what this replaces: the checks below are the column
contract made mechanical, and they refuse to write anything if a single one fails.

Outputs:
  <csv-out>                        the engine's roadmap CSV, ten columns, the sheet of record
  <out-dir>/<client>-content-roadmap.xlsx   the client-facing deliverable, same columns, styled

The xlsx is BEST EFFORT: it needs openpyxl, and a machine without it still gets the validated
CSV, which is the artifact the engine actually reads. A missing spreadsheet costs a download.
A missing CSV costs the whole run, so the two are not allowed to fail together.

Errors print with row numbers and nothing is written. Warnings print and do not block.

Usage:
    python3 build_roadmap.py --rows rows.json --client acme --csv-out clients/acme/roadmap.csv
    python3 build_roadmap.py --rows rows.json --client acme --check-only
"""

import argparse
import csv
import json
import os
import re
import sys

# The house sheet, in order. Must equal server/roadmap.py COLUMNS: that module reads column 1,
# column 2 and column 8 BY POSITION, so a sheet written to a different order is read as though
# its columns were somewhere they are not. There is no header detection downstream to catch it,
# only a guard that refuses the sheet outright, which is why this list is duplicated here rather
# than assumed: this script is what stops the sheet ever being written wrong.
#
# There is no prose "Justification" column and there must not be one. The six data-point columns
# ARE the justification: a sentence explaining a number belongs next to the number it explains,
# and a column whose content is an argument about the other columns goes stale the moment any of
# them is re-pulled. The generation session's REPORT is where prose about the figures lives.
CONTRACT_COLUMNS = [
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
]

COL_PROMPTS = 7  # 0-indexed, and the one position a mistake here is silent downstream

INTENTS = {"Navigational", "Informational", "Commercial"}

# Loaded from assets/format-taxonomy.json beside this script. The list is only a fallback for a
# checkout missing the asset; the asset is the real one.
FALLBACK_TAXONOMY = [
    "FAQ (entity)", "Hub listicle", "Listicle", "Comparison anchor", "Comparison",
    "Explainer", "How-to", "Buyer's guide", "Cost breakdown", "Case study",
    "Data study", "Alternatives page", "Checklist", "Glossary", "PR outreach",
]

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUNDLED_TAXONOMY = os.path.join(SKILL_ROOT, "assets", "format-taxonomy.json")

# Every dash this house bans, in one place. The writer's gate script fails a draft on these
# later, so letting one into the roadmap plants a failure two stages downstream of here.
DASHES = "—–"


def load_taxonomy(path=None):
    for candidate in (path, BUNDLED_TAXONOMY):
        if candidate and os.path.exists(candidate):
            try:
                with open(candidate, encoding="utf-8") as fh:
                    data = json.load(fh)
                values = data.get("formats", data) if isinstance(data, dict) else data
                values = [v for v in values if isinstance(v, str)]
                if values:
                    return values, candidate
            except (OSError, json.JSONDecodeError):
                continue
    return FALLBACK_TAXONOMY, "bundled fallback"


def sentence_count(text):
    return len([s for s in re.split(r"[.!?]+(?:\s|$)", text.strip()) if s.strip()])


def normalise_prompts(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [p.strip() for p in value.split("|") if p.strip()]
    return [str(p).strip() for p in value if str(p).strip()]


def normalise_int(value, field):
    """Return (int_or_None, error_or_None). Blank and 0 are DIFFERENT values.

    Zero is a real measurement: the term exists and nobody searches it, which is a finding. Blank
    means the call returned nothing, which is a different finding. Collapsing them would let a
    guess hide as a zero, and nobody downstream could tell the two apart afterwards.
    """
    if value is None or value == "":
        return None, None
    if isinstance(value, bool):
        return None, f"{field} must be a whole number or blank"
    if isinstance(value, int):
        return (value, None) if value >= 0 else (None, f"{field} cannot be negative")
    text = str(value).strip()
    if not text:
        return None, None
    if not re.fullmatch(r"\d+", text):
        return None, (
            f"{field} {value!r} is not a plain whole number. A tilde, a range, a 'k' or a "
            "comma means someone estimated it, so leave the cell blank instead."
        )
    return int(text), None


def normalise_money(value, field):
    """Cost per click is currency, so it is the one numeric column that carries decimals."""
    if value is None or value == "":
        return None, None
    if isinstance(value, bool):
        return None, f"{field} must be a number or blank"
    if isinstance(value, (int, float)):
        return (round(float(value), 2), None) if value >= 0 else (None, f"{field} cannot be negative")
    text = str(value).strip().lstrip("$₹£€").strip()
    if not text:
        return None, None
    if not re.fullmatch(r"\d+(\.\d{1,2})?", text):
        return None, (
            f"{field} {value!r} is not a plain number. Currency symbols, ranges and "
            "approximations all mean the figure was not pulled, so leave the cell blank."
        )
    return round(float(text), 2), None


def validate(rows, taxonomy):
    errors, warnings = [], []
    seen_topics = {}
    seen_primary = {}

    for i, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            errors.append(f"row {i}: not an object")
            continue

        topic = str(row.get("Content Topic", "")).strip()
        if not topic:
            errors.append(f"row {i}: Content Topic is empty")
        else:
            key = topic.lower()
            if key in seen_topics:
                errors.append(f"row {i}: duplicate Content Topic (also row {seen_topics[key]})")
            seen_topics[key] = i
            if re.search(r"\s\|\s*[A-Z]", topic):
                warnings.append(f"row {i}: Content Topic looks like a meta title (a '| Brand' suffix)")

        covers = str(row.get("What the Piece Covers", "")).strip()
        if not covers:
            errors.append(f"row {i}: What the Piece Covers is empty")
        else:
            n = sentence_count(covers)
            if not 2 <= n <= 4:
                warnings.append(f"row {i}: What the Piece Covers is {n} sentence(s); the contract expects 2 to 4")
            if re.match(r"^this (article|piece|post|guide) will", covers, re.I):
                warnings.append(f"row {i}: describe the piece, do not announce it")

        # Empty is the hard error; an unknown value only warns. The taxonomy asset says so
        # itself: `vertical_examples` lists Locality guide, Itinerary guide and Treatment guide
        # as legal DERIVED values, and the skill says the same. Rejecting them wrote nothing at
        # all and killed six Content Types already live in clients/. Telling a derived format
        # from an invented one needs the site scrape, which this script has never seen, so
        # non-empty is the only check it can honestly make.
        fmt = str(row.get("Content Type", "")).strip()
        if not fmt:
            errors.append(f"row {i}: Content Type is empty")
        elif fmt not in taxonomy:
            warnings.append(
                f"row {i}: Content Type {fmt!r} is not in the taxonomy, so it has to be a format "
                f"derived from what the scrape found and not an invented label")

        # Blank is legal and it is the honest value. The engine prompt's HARD RULE 2 forbids
        # inventing an intent, so a row whose dataforseo_labs_search_intent call returned no
        # classification leaves the cell empty. A non-blank value still has to be one of the
        # three: a fourth word is a classification nothing produced.
        intent = str(row.get("Query Intent", "")).strip()
        if intent and intent not in INTENTS:
            errors.append(
                f"row {i}: Query Intent {intent!r} must be one of {sorted(INTENTS)}, or blank "
                f"when no live call returned one")

        prompts = normalise_prompts(row.get("Target Prompts"))
        if len(prompts) != 3:
            errors.append(f"row {i}: Target Prompts has {len(prompts)}, the contract requires exactly 3")
        for p in prompts:
            if "|" in p:
                errors.append(f"row {i}: a target prompt contains a pipe, and the pipe is the delimiter")
        if len(prompts) == 3 and len({p.lower() for p in prompts}) < 3:
            errors.append(f"row {i}: target prompts are not distinct")
        # One piece owns one primary query. Two rows chasing the same one is cannibalisation the
        # roadmap created itself, which is the cheapest kind to catch and the most embarrassing
        # to ship.
        if prompts:
            primary = prompts[0].strip().lower()
            if primary in seen_primary:
                errors.append(f"row {i}: primary target prompt duplicates row {seen_primary[primary]}")
            seen_primary[primary] = i

        for field in ("Keyword Volume", "AI Search Volume", "Query Volume"):
            _, err = normalise_int(row.get(field), field)
            if err:
                errors.append(f"row {i}: {err}")

        _, err = normalise_money(row.get("Cost Per Click"), "Cost Per Click")
        if err:
            errors.append(f"row {i}: {err}")

        kd, err = normalise_int(row.get("Keyword Difficulty"), "Keyword Difficulty")
        if err:
            errors.append(f"row {i}: {err}")
        elif kd is not None and kd > 100:
            errors.append(f"row {i}: Keyword Difficulty {kd} is out of range; the scale is 0 to 100")

        # THE FIGURES ARE THE JUSTIFICATION, so a row with no live number anywhere argues
        # nothing for its slot. Sometimes legitimate (a thin category where DataForSEO returned
        # nothing), which is why it warns rather than blocks, and why the summary counts blanks.
        figures = [row.get(f) for f in ("Keyword Volume", "AI Search Volume", "Cost Per Click",
                                        "Keyword Difficulty", "Query Volume")]
        if not any(str(f).strip() for f in figures if f is not None):
            warnings.append(f"row {i}: every data point cell is blank, so nothing argues this row's slot")

        for field, value in row.items():
            if any(d in str(value) for d in DASHES):
                errors.append(f"row {i}: {field} contains an em or en dash; this house bans both")

    return errors, warnings


def slugify(name):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-") or "client"


def cells(row):
    """One row as the ten contract cells, in order. The single place order is decided."""
    ints = {f: normalise_int(row.get(f), f)[0]
            for f in ("Keyword Volume", "AI Search Volume", "Keyword Difficulty", "Query Volume")}
    cpc, _ = normalise_money(row.get("Cost Per Click"), "Cost Per Click")
    out = [
        str(row.get("Content Topic", "")).strip(),
        str(row.get("What the Piece Covers", "")).strip(),
        str(row.get("Content Type", "")).strip(),
        "" if ints["Keyword Volume"] is None else ints["Keyword Volume"],
        "" if ints["AI Search Volume"] is None else ints["AI Search Volume"],
        "" if cpc is None else f"{cpc:.2f}",
        "" if ints["Keyword Difficulty"] is None else ints["Keyword Difficulty"],
        " | ".join(normalise_prompts(row.get("Target Prompts"))),
        "" if ints["Query Volume"] is None else ints["Query Volume"],
        str(row.get("Query Intent", "")).strip(),
    ]
    assert len(out) == len(CONTRACT_COLUMNS), "cells() drifted from CONTRACT_COLUMNS"
    return out


def write_csv(rows, path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh, quoting=csv.QUOTE_ALL)
        writer.writerow(CONTRACT_COLUMNS)
        for row in rows:
            writer.writerow(cells(row))


def write_xlsx(rows, path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Content Roadmap"

    ws.append(CONTRACT_COLUMNS)
    for cell in ws[1]:
        cell.fill = PatternFill("solid", fgColor="1F2937")
        cell.font = Font(bold=True, color="FFFFFF", size=11)
        cell.alignment = Alignment(vertical="center", horizontal="left", wrap_text=True)
    ws.row_dimensions[1].height = 26

    for row in rows:
        # The prompts read as a list in a spreadsheet, so the pipes become newlines HERE and
        # nowhere else: the CSV keeps the pipes because that is what the engine splits on.
        values = cells(row)
        values[COL_PROMPTS] = "\n".join(normalise_prompts(row.get("Target Prompts")))
        ws.append(values)

    # One width per contract column. enumerate zips to the SHORTER list, so a column added
    # without a width here would silently leave the last column unstyled rather than fail.
    widths = [44, 62, 18, 15, 16, 13, 14, 52, 14, 15]
    assert len(widths) == len(CONTRACT_COLUMNS), "column widths drifted from CONTRACT_COLUMNS"
    for idx, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width

    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(CONTRACT_COLUMNS))}{ws.max_row}"
    wb.save(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rows", required=True, help="rows.json")
    ap.add_argument("--client", required=True, help="client slug, used in the xlsx filename")
    ap.add_argument("--csv-out", help="where the contract CSV goes. The engine supplies this.")
    ap.add_argument("--out-dir", help="where the xlsx goes. Omit to skip the xlsx.")
    ap.add_argument("--taxonomy", help="override the format taxonomy JSON")
    ap.add_argument("--check-only", action="store_true", help="validate without writing files")
    args = ap.parse_args()

    if not args.check_only and not args.csv_out:
        sys.exit("error: --csv-out is required unless --check-only. The engine reads the CSV "
                 "from one path and a file written anywhere else is a file it cannot see.")

    try:
        with open(args.rows, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"error: {exc}")

    rows = data.get("rows", data) if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        sys.exit("error: no rows found")

    taxonomy, taxonomy_source = load_taxonomy(args.taxonomy)
    errors, warnings = validate(rows, taxonomy)

    print(f"Rows: {len(rows)}   Columns: {len(CONTRACT_COLUMNS)}   Taxonomy: {taxonomy_source}")
    for w in warnings:
        print(f"  WARN  {w}")
    for e in errors:
        print(f"  ERROR {e}")
    if errors:
        sys.exit(f"\n{len(errors)} error(s). Nothing written.")

    # .get and not direct indexing, because a blank Query Intent is legal now and a row that
    # omits the key entirely is the honest shape for one. Blanks are counted as "blank" rather
    # than dropped: the split is how the sheet's commercial/topical mix is read, so a cell
    # nothing classified has to be visible in it.
    intents = {}
    for r in rows:
        key = str(r.get("Query Intent", "")).strip() or "blank"
        intents[key] = intents.get(key, 0) + 1
    blanks = {f: sum(1 for r in rows if not str(r.get(f, "")).strip())
              for f in ("Keyword Volume", "AI Search Volume", "Cost Per Click",
                        "Keyword Difficulty", "Query Volume")}

    print("\nContract clean. Intent split: " + ", ".join(f"{k} {v}" for k, v in sorted(intents.items())))
    print("Blank data cells: " + ", ".join(f"{k} {v}/{len(rows)}" for k, v in blanks.items()))

    if args.check_only:
        return

    write_csv(rows, args.csv_out)
    print(f"\nWrote {args.csv_out}")

    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)
        xlsx_path = os.path.join(args.out_dir, f"{slugify(args.client)}-content-roadmap.xlsx")
        try:
            write_xlsx(rows, xlsx_path)
            print(f"Wrote {xlsx_path}")
        except ImportError:
            # Deliberately not fatal, and deliberately loud. The CSV above is the sheet the
            # engine reads; the xlsx is the pretty copy. Failing the run over the pretty copy
            # would throw away a roadmap that is already correct and already written.
            print("NOTE: openpyxl is not installed, so no xlsx was written. The CSV above is "
                  "the sheet of record and the run is unaffected.")


if __name__ == "__main__":
    main()
