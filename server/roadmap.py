"""Roadmap CSV parsing shared by the runner CLI and app.py.

Lives in its own module so server.runner and server.app can both import it
without a circular import. csv module only: cells contain commas and newlines
inside quotes, so ad-hoc splitting corrupts rows.

COLUMN MAPPING IS POSITIONAL AND FIXED: column 1 -> topic, column 2 -> covers,
column 5 -> prompts. Every other column is parsed past and dropped.

Why position and not header detection: the operator's sheets are positionally
stable and they upload a fresh one every run, so header text is noise. Regex
header detection and the operator override existed to guess at varying headers;
both are deleted. Only these three fields reach an agent's context, so Volume
(column 3), Intent (column 4) and Status (column 6) are never stored, never
passed on, and never shown as data. Do not reintroduce them "just in case".
"""
import csv
import io
import re
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# 0-indexed positions. The contract, in one place.
COL_TOPIC = 0
COL_COVERS = 1
COL_PROMPTS = 4
MIN_COLUMNS = COL_PROMPTS + 1  # a narrower file cannot carry prompts at all

REQUIRED_FIELDS = ("topic", "covers", "prompts")

# A roadmap is kilobytes. The cap is enforced at the HTTP boundary too; this
# constant is the shared definition of "too big to be a roadmap".
MAX_UPLOAD_BYTES = 2 * 1024 * 1024

_SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]")


class RoadmapNotFound(Exception):
    """Raised when clients/<slug>/roadmap.csv does not exist."""


class BadUpload(Exception):
    """Raised when an uploaded CSV cannot satisfy the positional mapping.

    Always carries a message naming what was actually wrong, because the
    operator sees it verbatim and "invalid CSV" tells them nothing.
    """


def slugify(text):
    """topic -> topic_slug: lowercase, runs of non-alphanumerics to one hyphen, trimmed.

    This is also the ledger dedupe key. Normalizing this hard is deliberate: the
    same title gets retyped slightly differently between uploads, and exact
    string matching would let those duplicates through.
    """
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")


def split_prompts(cell):
    """Prompts cell -> list. Splits on newlines AND on " | ", strips quotes and empties.

    The operator writes one prompt per line inside a single double-quoted cell,
    and each line is itself usually quoted. Both layers come off here so agents
    receive clean query strings.

    The pipe is the second separator because generated roadmaps use it: the
    generation prompt (server/prompts/roadmap-generation.md) specifies column 5
    as three prompts joined by " | ", and on newlines alone the whole cell parsed
    as ONE prompt. That is silent and total: the row keeps working, the piece is
    written against a single run-on query instead of three, and nothing reports
    it. Accepting both is strictly safer than accepting either alone, because a
    hand-written sheet cannot lose by it: a target prompt is a question a buyer
    types, and no such question contains " | ".
    """
    prompts = []
    for raw in str(cell or "").splitlines():
        for part in raw.split(" | "):
            line = part.strip().strip('"').strip()
            if line:
                prompts.append(line)
    return prompts


def _cell(raw_row, position):
    return raw_row[position].strip() if position < len(raw_row) else ""


def _extras(raw_row, columns):
    """Every column that is not 1, 2 or 5, paired with its own header. Blanks are dropped.

    The three binding fields are found BY POSITION and everything else is labelled BY ITS
    HEADER, and mixing those two mechanisms is the bug this function exists to prevent.
    Position 3 is "Format" on a generated sheet, "Approx. Volume (IN/mo)" on one operator sheet
    and "Est. Searches" on another, so a hardcoded "column 3 is the format" handed a writer
    ~1200 as its format. Header text is unreliable for finding the topic, which is why the
    mapping is positional; it is perfectly reliable for saying what a column the engine does
    not otherwise understand is CALLED, which is all this needs it for.

    A blank cell is dropped rather than passed as an empty label, because "Format:" with
    nothing after it tells a writer only that someone forgot to fill it in.
    """
    extras = []
    for position, value in enumerate(raw_row):
        if position in (COL_TOPIC, COL_COVERS, COL_PROMPTS):
            continue
        text = value.strip()
        if not text:
            continue
        label = columns[position].strip() if position < len(columns) else ""
        # A column with no header has no honest name, and inventing one ("Column 4") would put
        # a label in a writer's brief that appears nowhere in the operator's sheet.
        extras.append({"label": label or f"column {position + 1}", "value": text})
    return extras


def _build_rows(raw_rows, columns):
    """Rows from raw CSV rows, header already removed. Positional for the binding three."""
    rows = []
    for index, raw in enumerate(raw_rows):
        if not any(value.strip() for value in raw):
            continue
        topic = _cell(raw, COL_TOPIC)
        covers = _cell(raw, COL_COVERS)
        prompts = split_prompts(_cell(raw, COL_PROMPTS))

        missing = []
        if not topic:
            missing.append("topic")
        if not covers:
            missing.append("covers")
        if not prompts:
            missing.append("prompts")

        rows.append({
            "index": index,
            "topic": topic,
            "covers": covers,
            "prompts": prompts,
            "topic_slug": slugify(topic),
            "complete": not missing,
            "missing": missing,
            # Registered, not dropped. An extra is never part of `missing`: a sheet that planned
            # no Format is a sheet that planned no Format, and refusing to write the row over it
            # would make a column the engine invented into a blocker the operator never asked for.
            "extras": _extras(raw, columns),
        })
    return rows


def _parse_rows(raw_rows, source):
    """Shared parse: validate width, drop the header, build rows.

    The first row is ALWAYS the header. These sheets always have one, so
    sniffing for its presence would only invent a way to eat a real topic.
    """
    if not raw_rows:
        raise BadUpload(f"{source} is empty: it has no header row and no data rows")

    columns = [header.strip() for header in raw_rows[0]]
    width = max(len(row) for row in raw_rows)
    if width < MIN_COLUMNS:
        raise BadUpload(
            f"{source} has {width} column(s); at least {MIN_COLUMNS} are required "
            f"because the roadmap mapping reads column 1 (Content Topic), "
            f"column 2 (What the Piece Covers) and column 5 (Target Prompts)"
        )

    rows = _build_rows(raw_rows[1:], columns)
    return {"columns": columns, "rows": rows, "warnings": []}


def parse_csv(raw_text):
    """Parse roadmap CSV text -> {"columns", "rows", "warnings"}.

    "columns" is the raw header strings for DISPLAY ONLY, so the operator can
    see what was in their file. Nothing is mapped from them.
    """
    raw_rows = list(csv.reader(io.StringIO(raw_text)))
    return _parse_rows(raw_rows, "the CSV")


def _decode(raw_bytes):
    """Operator CSVs come out of Excel and Google Sheets, so BOMs are common."""
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise BadUpload("the file is not readable as text (tried utf-8 and latin-1)")


def load_roadmap(client_slug):
    """Return the saved roadmap payload for a client: columns, rows, warnings.

    clients/<slug>/roadmap.csv is an OPTIONAL saved roadmap shipped with a
    client. It is read-only input and full of topics that have not been
    generated. It is NOT the ledger: see server/ledger.py.
    """
    path = REPO_ROOT / "clients" / client_slug / "roadmap.csv"
    if not path.is_file():
        raise RoadmapNotFound(f"no roadmap.csv for client {client_slug!r} at {path}")

    with open(path, newline="", encoding="utf-8-sig") as handle:
        raw_rows = list(csv.reader(handle))
    return _parse_rows(raw_rows, f"roadmap.csv for client {client_slug!r}")


def index_by_slug(client_slug):
    """topic_slug -> its row index on the CURRENT sheet. {} when the client has no roadmap.

    This exists so a blog can say which roadmap row it came from. An operator with twenty blogs
    cannot hold twenty titles in their head, and neither can their client: "change blog six" is
    the question they actually ask, and until now nothing in the app could answer it, because a
    blog on disk knows its slug and its title and nothing about the sheet it came from.

    Joined by SLUG, never by position. The blogs list is a scan of the output directory in the
    directory's own order, and it holds blogs whose row was since deleted; the same reasoning
    that made roadmap-stats.ts abandon index matching applies here, and here it would be worse,
    because a wrong number is not a missing number. It is blog six pointing at row nine, which
    the operator would act on.

    The index is the one the CURRENT sheet holds, so re-uploading a reordered roadmap renumbers
    the blogs to match it. That is the intended behaviour: the number's whole job is to agree
    with the sheet in front of the operator, not to record history. The ledger is what records
    what happened, and it does not store an index at all.

    Zero based, exactly like RoadmapRow.index, because a second numbering convention for one row
    is how off-by-one bugs are born. Callers that DISPLAY it add one, as the preview's "#" column
    and engine-error.tsx both already do.
    """
    try:
        payload = load_roadmap(client_slug)
    except RoadmapNotFound:
        # Not an error. A client with no roadmap has blogs with no row to point at, and every
        # caller already has to handle the blog whose row was deleted anyway.
        return {}
    return {row["topic_slug"]: row["index"] for row in payload["rows"] if row.get("topic_slug")}


def safe_filename(filename):
    """Untrusted browser-supplied name -> a name safe to join onto a path."""
    name = Path(str(filename or "")).name
    name = name.replace("/", "").replace("\\", "")
    name = _SAFE_FILENAME.sub("_", name).strip("._-")
    if not name:
        name = "upload"
    return name[:80]


def roadmap_path(client_slug):
    return REPO_ROOT / "clients" / client_slug / "roadmap.csv"


def has_roadmap(client_slug):
    return roadmap_path(client_slug).is_file()


def _read_raw(client_slug):
    """The roadmap as raw CSV rows, header included, EVERY column intact.

    Deliberately not parse_csv. The parser keeps only columns 1, 2 and 5 because those are the
    only ones the engine reads, so a view built from parsed rows would silently hide the
    operator's other columns: their volume, their intent, their own status notes. Those columns
    are theirs, and the fact that the factory has no use for them does not mean the operator
    has none.
    """
    path = roadmap_path(client_slug)
    if not path.is_file():
        raise RoadmapNotFound(f"no roadmap.csv for client {client_slug!r} at {path}")
    with open(path, newline="", encoding="utf-8-sig") as handle:
        return list(csv.reader(handle))


def read_sheet(client_slug):
    """The roadmap CSV as a rectangle for preview: filename, modified, bytes, columns, rows.

    This answers a question load_roadmap cannot: "what is actually in my sheet". load_roadmap
    reports the three columns the engine reads, which is the right answer for running a blog
    and the wrong one for an operator checking that the file they uploaded is the file they
    meant to upload.

    Padding to the sheet's maximum width happens here rather than in the browser because a
    ragged CSV is a property of the file, not of the display, and every consumer would
    otherwise have to rediscover the same fix. The header is padded on the same rule as the
    data: a sheet whose header row is shorter than its widest data row is common, and an
    unpadded header would misalign every column after the short point.
    """
    raw_rows = _read_raw(client_slug)
    path = roadmap_path(client_slug)
    stat = path.stat()

    width = max((len(row) for row in raw_rows), default=0)
    padded = [list(row) + [""] * (width - len(row)) for row in raw_rows]

    return {
        "filename": path.name,
        "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "bytes": stat.st_size,
        "columns": padded[0] if padded else [],
        "rows": padded[1:],
    }


def delete_roadmap(client_slug):
    """Archive the brand's roadmap into uploads/, then remove it. True when one was removed.

    Only roadmap.csv goes. The uploads/ archive stays, because /generate re-parses a live run
    by upload_id and deleting the sheet under a run would strand it. The LEDGER
    (generated.csv) and every blog under outputs/ also stay: they are what the roadmap
    PRODUCED, not part of it, and a roadmap is replaced far more often than a brand's work
    should be destroyed. Deleting a roadmap must never be a way to lose a shipped blog.

    IT IS ARCHIVED FIRST, and that is not belt and braces. Delete is the ONLY route to a new
    roadmap: the app refuses an upload or a generation while one exists, so an operator who
    wants either must destroy what they have to get there. This function used to unlink an
    irreplaceable file to satisfy that rule. An operator did exactly what the UI told them to,
    pressed delete to reach Generate, and their 25 topics existed nowhere else the moment the
    file went: uploads/ holds sheets that were UPLOADED, and a roadmap that was generated, or
    edited in place, was never in there. The archive costs a few KB and makes the destructive
    step recoverable, so the rule stops depending on the operator having their own copy.
    """
    path = roadmap_path(client_slug)
    if not path.is_file():
        return False

    uploads = REPO_ROOT / "clients" / client_slug / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    # Named for what it is, so the archive does not read as another upload the operator made.
    # The bytes are copied verbatim rather than re-serialised: this is the record of what was
    # deleted, and a round trip through a csv writer would quietly reformat the quoting and the
    # newlines inside the target-prompts cell, making the restored sheet differ from the lost one.
    (uploads / f"{stamp}-deleted-roadmap.csv").write_bytes(path.read_bytes())

    # The generation report describes THIS sheet: its row count, what the agent cut, what it
    # disputed. Left behind, it would sit against whatever roadmap came next and explain a
    # document that no longer exists, which is worse than no report at all. It is archived
    # under the same stamp as the sheet it belongs to, so the pair can be read back together.
    report = REPO_ROOT / "clients" / client_slug / "roadmap-report.md"
    if report.is_file():
        (uploads / f"{stamp}-deleted-roadmap-report.md").write_bytes(report.read_bytes())
        report.unlink()

    path.unlink()
    return True


def save_upload(client_slug, filename, raw_bytes):
    """Validate an uploaded CSV, archive the bytes VERBATIM, and SAVE it as the roadmap.

    Two artifacts, deliberately:

    1. clients/<slug>/roadmap.csv IS the brand's roadmap from now on. An earlier version of
       this function refused to write it, on the reasoning that an upload was transient input
       for one submit and persisting it would "silently redefine the client". That reasoning
       is retired, and the code was worse than the argument: the UI offered a "Replace
       roadmap" button that replaced nothing, a refresh silently swapped the operator's sheet
       back to a saved one they had not chosen, and a run's row indices pointed into a
       different document than the one on screen. The upload IS the roadmap: that is what an
       operator means by uploading it, and the app now refuses an upload while a roadmap
       exists, so redefining a brand takes a deliberate delete first and is never silent.

    2. uploads/<stamp>-<name>.csv is the archive, and it stays. /generate re-parses BY
       upload_id rather than trusting row content posted by a browser, which is an integrity
       property worth keeping: it is the reason a browser cannot smuggle rows into a run.

    Nothing is written until the parse succeeds, so a malformed CSV cannot destroy the roadmap
    the brand already had.
    """
    client_dir = REPO_ROOT / "clients" / client_slug
    if not client_dir.is_dir():
        raise BadUpload(f"unknown client {client_slug!r}")

    if not raw_bytes:
        raise BadUpload("the uploaded file is empty")

    # Parse FIRST. Every refusal below happens before a single byte is written, so a bad sheet
    # leaves the brand exactly as it was.
    payload = parse_csv(_decode(raw_bytes))
    if not payload["rows"]:
        raise BadUpload("the CSV has a header row but no data rows")

    uploads = client_dir / "uploads"
    uploads.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    archive_name = f"{stamp}-{safe_filename(filename)}"
    if not archive_name.endswith(".csv"):
        archive_name += ".csv"
    archive = uploads / archive_name
    archive.write_bytes(raw_bytes)

    # The verbatim bytes, not a re-serialisation of the parse: the operator's file is the
    # record, and a round trip through a writer would quietly reformat quoting and newlines
    # inside the target-prompts cell.
    roadmap_path(client_slug).write_bytes(raw_bytes)

    return {
        "archived": str(archive.relative_to(REPO_ROOT)),
        "upload_id": archive.name,
        "rows": len(payload["rows"]),
        "columns": payload["columns"],
    }


def load_upload(client_slug, upload_id):
    """Re-parse a previously archived upload by id. Never trust a browser's rows."""
    name = safe_filename(upload_id)
    path = REPO_ROOT / "clients" / client_slug / "uploads" / name
    if not path.is_file():
        raise BadUpload(f"unknown upload_id {upload_id!r} for client {client_slug!r}")
    return parse_csv(_decode(path.read_bytes()))


def annotate_generated(client_slug, payload):
    """Stamp each row with its ledger state, so the UI can red-flag duplicates
    before the operator ever submits."""
    from . import ledger

    # live_slugs, not ledger_slugs: a blog the operator deleted on disk is gone,
    # so its row must not come back red and unselectable.
    shipped = ledger.live_slugs(client_slug)
    for row in payload["rows"]:
        entry = shipped.get(row["topic_slug"])
        row["already_generated"] = entry is not None
        row["ledger"] = None
        if entry is not None:
            score = entry.get("score")
            try:
                score = int(score)
            except (TypeError, ValueError):
                score = None
            row["ledger"] = {"score": score, "generated_at": entry.get("generated_at", "")}
    return payload
