"""Roadmap CSV parsing shared by the runner CLI and app.py.

Lives in its own module so server.runner and server.app can both import it
without a circular import. csv module only: cells contain commas and newlines
inside quotes, so ad-hoc splitting corrupts rows.

THE BINDING THREE ARE POSITIONAL AND FIXED: column 1 -> topic, column 2 ->
covers, column 5 -> prompts. Those three are the brief, and position is how they
are found.

Why position and not header detection for those three: the operator's sheets are
positionally stable and they upload a fresh one every run, so header text is
noise. Regex header detection and the operator override existed to guess at
varying headers; both are deleted.

EVERY OTHER COLUMN IS KEPT, PAIRED WITH ITS HEADER, and reaches the writer as
guidance: see _extras. This paragraph used to say the opposite, that Volume,
Intent and Status were "never stored, never passed on", and it was left standing
after the behaviour changed. A stale docstring on the module that OWNS the rule
is not a cosmetic problem: it is the first thing anyone reads before touching
this file, and it told them to delete the feature.

The extras are read BY HEADER, never by position, and the two rules coexist for
a reason. Position 3 is "Format" on a generated sheet and "Approx. Volume
(IN/mo)" on one of the operator's own, so a hardcoded "column 3 is the format"
once handed a writer ~1200 as its format. The brief is positional because the
operator's sheets guarantee it. Everything else is labelled because they do not.
"""
import csv
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import db

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
    """Raised when the client has no roadmap sheet in roadmap_sheets."""


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
    """Operator CSVs come out of Excel and Google Sheets, so BOMs are common.

    Order matters and every step earns its place. utf-8 first, so a normal file is never
    mojibake'd by a fallback that cannot fail. Then cp1252, because that is what Excel on Windows
    actually exports and it is the difference between reading "Bengaluru's best cafes" and
    reading "Bengaluru\\x92s best cafes": latin-1 maps 0x92 to a control character, cp1252 maps it
    to the curly apostrophe the operator typed. cp1252 leaves five bytes undefined, so latin-1
    stays last as the decoder that cannot fail, and its job is to keep a sheet readable rather
    than to be right about it.
    """
    for encoding in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw_bytes.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise BadUpload("the file is not readable as text (tried utf-8, cp1252 and latin-1)")


def _fetch_sheet(client_slug, month=None):
    """The single choke point every roadmap read goes through.

    Returns (raw_csv, filename, modified) for one of the client's roadmap_sheets
    rows, or raises RoadmapNotFound. `month` is the 1-based sequence label of the
    roadmap wanted. month=None means the CURRENT roadmap, which is the LATEST one
    added (max month): the blog run, the Create tab, revise and index_by_slug all
    mean this when they say "the roadmap", so lifting one brand to many months
    leaves every one of those readers pointing at the newest sheet, unchanged.

    raw_csv is the sheet TEXT: the write paths (save_upload, roadmap_gen's
    completion push) decode the operator's or the session's bytes ONCE with
    _decode on the way in, so every reader gets back exactly the text the parse
    that accepted the sheet saw. The old split, where the upload decoded leniently
    and the reads re-opened the file strictly as utf-8-sig, once accepted an Excel
    cp1252 export it could never read again; storing decoded text makes that
    mismatch unrepresentable.

    Tests monkeypatch this function to inject a sheet without a database row.
    """
    cid = db.client_id(client_slug)
    row = None
    if cid and month is None:
        row = db.q(
            """select raw_csv, filename, coalesce(modified, created_at)
               from roadmap_sheets where client_id = %s
               order by month desc limit 1""",
            (cid,), fetch="one")
    elif cid:
        row = db.q(
            """select raw_csv, filename, coalesce(modified, created_at)
               from roadmap_sheets where client_id = %s and month = %s""",
            (cid, month), fetch="one")
    if not row:
        where = "" if month is None else f" at month {month}"
        raise RoadmapNotFound(
            f"no roadmap sheet for client {client_slug!r} in roadmap_sheets{where}")
    return row[0], row[1], row[2]


def next_month(client_slug):
    """The month number a newly added roadmap gets: max existing + 1, or 1 when the brand has
    none. Gaps left by a delete are never reused, so Month 3 stays Month 3 after Month 2 is
    deleted and the next add is Month 4."""
    cid = db.client_id(client_slug)
    if not cid:
        return 1
    return db.q(
        "select coalesce(max(month), 0) + 1 from roadmap_sheets where client_id = %s",
        (cid,), fetch="val") or 1


def list_months(client_slug):
    """Every roadmap the brand holds, oldest month first, for the roadmap tab's month list.

    Each entry names the month, its display label ("Month N Roadmap"), the source filename, when
    it last changed, and how many ingestable rows it built. row_count comes from roadmap_rows so
    it agrees with what the brief reader sees, not with the raw preview which may hold a blank
    trailing row. A brand with no roadmap returns [], never an error: an empty list IS the empty
    state.
    """
    cid = db.client_id(client_slug)
    if not cid:
        return []
    rows = db.q(
        """select s.month, s.filename, coalesce(s.modified, s.created_at), count(r.id)
             from roadmap_sheets s
             left join roadmap_rows r on r.sheet_id = s.id
            where s.client_id = %s
            group by s.month, s.filename, s.modified, s.created_at
            order by s.month""",
        (cid,))
    return [
        {
            "month": month,
            "label": f"Month {month} Roadmap",
            "filename": filename,
            "modified": modified.astimezone(timezone.utc).isoformat(),
            "row_count": row_count,
        }
        for (month, filename, modified, row_count) in rows
    ]


def existing_topics(client_slug):
    """Every topic already planned across ALL of the brand's existing monthly roadmaps, oldest
    month first, de-duplicated by slug.

    This is the exclusion list a NEW month's generation is handed: a fresh research session knows
    nothing about what earlier months planned, because those topics live in this database and not
    on the site it reads, so without this it would re-propose the same obvious topics every month.
    De-duplicated by the same slugify the ledger keys on, so two slightly different retypings of
    one title collapse to one entry rather than reading as two distinct topics to avoid.
    """
    cid = db.client_id(client_slug)
    if not cid:
        return []
    rows = db.q(
        """select r.topic from roadmap_rows r
             join roadmap_sheets s on r.sheet_id = s.id
            where s.client_id = %s and btrim(r.topic) <> ''
            order by s.month, r.row_index""",
        (cid,))
    seen, out = set(), []
    for (topic,) in rows:
        key = slugify(topic)
        if key and key not in seen:
            seen.add(key)
            out.append(topic)
    return out


def _csv_rows(text):
    """The stored sheet text as raw CSV rows.

    newline="" keeps the newlines inside quoted target-prompts cells intact,
    exactly as the file read before it did.
    """
    return list(csv.reader(io.StringIO(text, newline="")))


def load_roadmap(client_slug, month=None):
    """Return the saved roadmap payload for one month: columns, rows, warnings.

    month=None is the CURRENT roadmap (the latest month), which is what every engine reader
    means by "the roadmap". roadmap_sheets holds an OPTIONAL saved roadmap per month. It is
    read-only input and full of topics that have not been generated. It is NOT the ledger: see
    server/ledger.py.
    """
    raw_csv, _filename, _modified = _fetch_sheet(client_slug, month)
    what = f"the roadmap sheet for client {client_slug!r}"
    return _parse_rows(_csv_rows(raw_csv), what)


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
    """The SCRATCH path a roadmap generation session writes to.

    This is no longer where the roadmap lives: roadmap_sheets is the record, and
    every reader goes through _fetch_sheet. The path survives because the SDK
    session is file-only: roadmap_gen substitutes it into the prompt, the agent
    writes it, and the completion path pushes the result into the record.
    """
    return REPO_ROOT / "clients" / client_slug / "roadmap.csv"


def has_roadmap(client_slug):
    cid = db.client_id(client_slug)
    if not cid:
        return False
    return bool(db.q(
        "select exists(select 1 from roadmap_sheets where client_id = %s)",
        (cid,), fetch="val"))


def _read_raw(client_slug):
    """The roadmap as raw CSV rows, header included, EVERY column intact.

    Deliberately not parse_csv. The parser keeps only columns 1, 2 and 5 because those are the
    only ones the engine reads, so a view built from parsed rows would silently hide the
    operator's other columns: their volume, their intent, their own status notes. Those columns
    are theirs, and the fact that the factory has no use for them does not mean the operator
    has none.
    """
    raw_csv, _filename, _modified = _fetch_sheet(client_slug)
    return _csv_rows(raw_csv)


def read_sheet(client_slug, month=None):
    """The roadmap CSV as a rectangle for preview: filename, modified, bytes, columns, rows.

    month=None is the current (latest) month; a month names one specific roadmap to preview.

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
    raw_csv, filename, modified = _fetch_sheet(client_slug, month)
    raw_rows = _csv_rows(raw_csv)

    width = max((len(row) for row in raw_rows), default=0)
    padded = [list(row) + [""] * (width - len(row)) for row in raw_rows]

    return {
        "filename": filename,
        "modified": modified.astimezone(timezone.utc).isoformat(),
        "bytes": len(raw_csv.encode("utf-8")),
        "columns": padded[0] if padded else [],
        "rows": padded[1:],
    }


def delete_roadmap(client_slug, month):
    """Archive ONE month's roadmap into roadmap_uploads, then remove that sheet. True when one
    was removed.

    `month` names which roadmap to delete: with a brand holding several, client_id alone no
    longer identifies one sheet. The gaps a delete leaves are never reused (see next_month).

    Only the roadmap_sheets row goes (its roadmap_rows cascade with it). The roadmap_uploads
    archive stays, because /generate re-parses a live run by upload_id and deleting the sheet
    under a run would strand it. The LEDGER (generated.csv) and every blog under outputs/ also
    stay: they are what the roadmap PRODUCED, not part of it, and a roadmap is replaced far
    more often than a brand's work should be destroyed. Deleting a roadmap must never be a way
    to lose a shipped blog.

    IT IS ARCHIVED FIRST, and that is not belt and braces. Delete is the ONLY route to a new
    roadmap: the app refuses an upload or a generation while one exists, so an operator who
    wants either must destroy what they have to get there. An earlier version of this function
    unlinked an irreplaceable file to satisfy that rule: an operator pressed delete to reach
    Generate, and their 25 topics existed nowhere else the moment the file went, because the
    archive holds sheets that were UPLOADED and a generated sheet was never in there. The
    deletion-archive row costs a few KB and makes the destructive step recoverable, so the
    rule stops depending on the operator having their own copy.

    The sheet text is archived verbatim rather than re-serialised: this is the record of what
    was deleted, and a round trip through a csv writer would quietly reformat the quoting and
    the newlines inside the target-prompts cell, making the restored sheet differ from the
    lost one. The generation report describes THIS sheet, so it is archived under the same
    stamp and goes with it: left on the record, it would explain a document that no longer
    exists. Archive and delete run in ONE transaction, so a failure leaves the sheet exactly
    as it was rather than deleted-but-unarchived.
    """
    cid = db.client_id(client_slug)
    if not cid:
        return False
    row = db.q(
        "select id, raw_csv, report from roadmap_sheets where client_id = %s and month = %s",
        (cid, month), fetch="one")
    if not row:
        return False
    sheet_id, raw_csv, report = row

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    with db.tx() as cur:
        # Named for what it is, so the archive does not read as another upload the operator made.
        cur.execute(
            """insert into roadmap_uploads (client_id, filename, raw)
               values (%s, %s, %s)""",
            (cid, f"{stamp}-deleted-roadmap.csv", raw_csv.encode("utf-8")))
        if report:
            cur.execute(
                """insert into roadmap_uploads (client_id, filename, raw)
                   values (%s, %s, %s)""",
                (cid, f"{stamp}-deleted-roadmap-report.md", report.encode("utf-8")))
        cur.execute("delete from roadmap_sheets where id = %s", (sheet_id,))

    # The disk copies are generation scratch, and they go with the sheet. Left behind, a stale
    # roadmap.csv would be picked up by the NEXT generation's validate step as though that
    # session had written it, silently resurrecting the sheet the operator just deleted.
    roadmap_path(client_slug).unlink(missing_ok=True)
    (REPO_ROOT / "clients" / client_slug / "roadmap-report.md").unlink(missing_ok=True)
    return True


def _write_sheet(cur, cid, raw_text, payload, report=None, month=1):
    """Upsert ONE month's roadmap_sheets row and rebuild its roadmap_rows, on an open
    transaction cursor.

    The ONE writer of the sheet record: save_upload and roadmap_gen's completion
    push both land here, so the stored rows are always the output of the same
    _build_rows parse that accepted the sheet, and the two routes cannot drift.
    Delete plus insert rather than a row-wise upsert, because the sheet is
    replaced whole: a leftover row from a longer previous sheet would be a row
    the operator deleted coming back.

    The conflict target is (client_id, month): an add lands a NEW month so it never conflicts,
    but the upsert stays so re-landing the same month (a retried push) replaces cleanly rather
    than raising.

    topic_slug is computed by this module's own slugify (already on the parsed
    rows), never re-derived in SQL; an empty slug is stored as NULL because an
    incomplete row may have no topic to slugify.
    """
    cur.execute(
        """insert into roadmap_sheets (client_id, month, filename, raw_csv, columns, modified, report)
           values (%s, %s, 'roadmap.csv', %s, %s::text[], now(), %s)
           on conflict (client_id, month) do update
             set filename = excluded.filename,
                 raw_csv  = excluded.raw_csv,
                 columns  = excluded.columns,
                 modified = excluded.modified,
                 report   = excluded.report
           returning id""",
        (cid, month, raw_text, payload["columns"], report))
    sheet_id = cur.fetchone()[0]
    cur.execute("delete from roadmap_rows where sheet_id = %s", (sheet_id,))
    for row in payload["rows"]:
        cur.execute(
            """insert into roadmap_rows
                 (sheet_id, client_id, row_index, topic, covers, prompts, extras, topic_slug)
               values (%s, %s, %s, %s, %s, %s::text[], %s::jsonb, %s)""",
            (sheet_id, cid, row["index"], row["topic"], row["covers"],
             row["prompts"], json.dumps(row["extras"]), row["topic_slug"] or None))
    return sheet_id


def save_upload(client_slug, filename, raw_bytes):
    """Validate an uploaded CSV, archive the bytes VERBATIM, and SAVE it as the roadmap.

    Two artifacts, deliberately:

    1. The roadmap_sheets row IS the brand's roadmap from now on. An earlier version of
       this function refused to persist an upload, on the reasoning that it was transient
       input for one submit and persisting it would "silently redefine the client". That
       reasoning is retired, and the code was worse than the argument: the UI offered a
       "Replace roadmap" button that replaced nothing, a refresh silently swapped the
       operator's sheet back to a saved one they had not chosen, and a run's row indices
       pointed into a different document than the one on screen. The upload IS the roadmap:
       that is what an operator means by uploading it, and the app refuses an upload while a
       roadmap exists, so redefining a brand takes a deliberate delete first and is never
       silent.

    2. The roadmap_uploads row is the archive, and it stays. /generate re-parses BY
       upload_id rather than trusting row content posted by a browser, which is an integrity
       property worth keeping: it is the reason a browser cannot smuggle rows into a run.
       The archived `raw` is the operator's ORIGINAL BYTES verbatim, never a
       re-serialisation: a round trip through a writer would quietly reformat quoting and
       newlines inside the target-prompts cell. The sheet's raw_csv is those bytes through
       _decode, once, so every later read gets the text this accepting parse saw.

    Archive, sheet and rows land in ONE transaction, and nothing is written until the parse
    succeeds, so a malformed CSV cannot destroy the roadmap the brand already had.
    """
    cid = db.client_id(client_slug)
    if not cid:
        raise BadUpload(f"unknown client {client_slug!r}")

    if not raw_bytes:
        raise BadUpload("the uploaded file is empty")
    if len(raw_bytes) > MAX_UPLOAD_BYTES:
        raise BadUpload(
            f"the uploaded file is {len(raw_bytes)} bytes; the roadmap limit is "
            f"{MAX_UPLOAD_BYTES} bytes")

    # Parse FIRST. Every refusal below happens before a single byte is written, so a bad sheet
    # leaves the brand exactly as it was.
    raw_text = _decode(raw_bytes)
    payload = parse_csv(raw_text)
    if not payload["rows"]:
        raise BadUpload("the CSV has a header row but no data rows")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    archive_name = f"{stamp}-{safe_filename(filename)}"
    if not archive_name.endswith(".csv"):
        archive_name += ".csv"

    # An upload always ADDS the next month rather than replacing: the old "one roadmap per brand"
    # refusal is gone, so a second upload is Month 2, not a 409.
    # ponytail: next_month is read then written outside a single lock, so two uploads racing for
    # one brand can pick the same number; the unique (client_id, month) constraint is the
    # backstop and the loser gets a loud error, not silent clobber. Add a per-brand advisory lock
    # only if concurrent uploads to one brand ever become real.
    month = next_month(client_slug)
    with db.tx() as cur:
        cur.execute(
            """insert into roadmap_uploads (client_id, filename, raw)
               values (%s, %s, %s)""",
            (cid, archive_name, raw_bytes))
        _write_sheet(cur, cid, raw_text, payload, month=month)

    return {
        "archived": f"roadmap_uploads/{client_slug}/{archive_name}",
        "upload_id": archive_name,
        "month": month,
        "rows": len(payload["rows"]),
        "columns": payload["columns"],
    }


def load_upload(client_slug, upload_id):
    """Re-parse a previously archived upload by id. Never trust a browser's rows.

    This is a SECURITY CONTROL and it FAILS CLOSED: no matching roadmap_uploads
    row means BadUpload, never a fallback to whatever rows the caller posted. A
    tampered browser payload must not be able to redirect a run.
    """
    # Look up by the EXACT upload_id. It is the archive_name save_upload generated and returned,
    # already sanitized when it was built, and it is used here ONLY as a parameterized query value,
    # never as a path. Do NOT re-run safe_filename on it: that truncates to 80 chars, so an
    # upload_id built from an already-stamped filename (a re-uploaded archive, e.g. a downloaded
    # roadmap) runs longer, and re-sanitizing chopped ".csv" to ".c" and missed the row with a
    # spurious "unknown upload_id". The query still FAILS CLOSED, matching only stored filenames, so
    # a crafted upload_id finds no row and falls to BadUpload exactly as before.
    cid = db.client_id(client_slug)
    raw = None
    if cid:
        raw = db.q(
            "select raw from roadmap_uploads where client_id = %s and filename = %s",
            (cid, upload_id), fetch="val")
    if raw is None:
        raise BadUpload(f"unknown upload_id {upload_id!r} for client {client_slug!r}")
    return parse_csv(_decode(bytes(raw)))


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
