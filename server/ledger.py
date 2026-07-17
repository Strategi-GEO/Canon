"""The generated-blogs ledger: the ledger_entries table in Supabase Postgres.

WHAT THIS IS, and why it does not contradict "the app never writes back to the
CSV": that standing rule protects the OPERATOR's roadmap. Results and status
must never be written into the sheet they uploaded, and progress lives in
status_events. The ledger is a separate artifact the app owns end to end,
append-only in spirit: rows are inserted when a blog ships and never updated.
A future reader must not "fix" it away by folding it back into the roadmap.

Three artifacts, three jobs, do not conflate them:
- ledger_entries              THE LEDGER: blogs that actually shipped.
- roadmap_sheets/roadmap_rows the saved roadmap, full of topics NOT yet
                              generated. Treating it as the ledger would mark
                              every row red on day one.
- roadmap_uploads             the operator's input, archived byte for byte,
                              never mutated.

Row shape: every function here returns the exact dict shape the CSV-era ledger
produced, because the callers (app.py history and /ledger, roadmap.py
annotate_generated, cms/gate.py) still consume it. That means every field is a
STRING: prompts newline-joined into one cell, score as "96" or "", generated_at
as an ISO 8601 string, and a NULL run_id as "". csv.DictReader never returned
anything but strings, and the readers' int(score) try/excepts rely on it.
"""
from datetime import datetime, timezone

from . import db
from .roadmap import slugify

_COLUMNS = "topic, topic_slug, covers, prompts, score, generated_at, run_id"


def _shape(record):
    """One SQL tuple -> the dict a csv.DictReader row used to be."""
    topic, topic_slug, covers, prompts, score, generated_at, run_id = record
    return {
        "topic": topic or "",
        "topic_slug": topic_slug or "",
        "covers": covers or "",
        # The DB column is text[]; the CSV stored one newline-joined cell, and
        # cms/payload._clean_queries still splits on newlines. Join on read.
        "prompts": "\n".join(prompts or []),
        "score": "" if score is None else str(score),
        "generated_at": generated_at.isoformat() if generated_at else "",
        "run_id": run_id or "",
    }


def _keyed(rows):
    """slug -> row, for O(1) dedupe against a whole selection."""
    entries = {}
    for row in rows:
        slug = (row.get("topic_slug") or slugify(row.get("topic", ""))).strip()
        if slug:
            entries[slug] = row
    return entries


def read_ledger(client_slug):
    """Every ledger row as a dict, oldest first (generated_at ascending, the
    same chronology the append-only CSV gave). An unknown client is an empty
    ledger, not an error: the check must work for a client onboarded before the
    ledger existed."""
    cid = db.client_id(client_slug)
    if not cid:
        return []
    records = db.q(
        f"select {_COLUMNS} from ledger_entries "
        "where client_id = %s order by generated_at",
        (cid,))
    return [_shape(record) for record in records]


def ledger_slugs(client_slug):
    """slug -> row, for O(1) dedupe against a whole selection.

    This is the raw ledger, including rows whose blog has since been deleted.
    Use live_slugs for the duplicate check.
    """
    return _keyed(read_ledger(client_slug))


def live_slugs(client_slug):
    """Ledger entries whose topic still exists in the record with at least one
    blog version.

    The record is the source of truth for what exists. Under the CSV ledger
    this was "blog.md still on disk", and a Finder delete was how an operator
    re-freed a topic for regeneration; that contract is replaced. Deleting the
    topic in the record (topics.deleted_at) is what unblocks regeneration now.
    The ledger row itself stays as an audit trail of what was generated and
    when; only its power to block is tied to the topic surviving in the record.
    """
    cid = db.client_id(client_slug)
    if not cid:
        return {}
    records = db.q(
        f"""select {_COLUMNS} from ledger_entries le
            where le.client_id = %s
              and exists (
                select 1 from topics t
                where t.client_id = le.client_id
                  and t.slug = le.topic_slug
                  and t.deleted_at is null
                  and exists (select 1 from blog_versions v
                              where v.topic_id = t.id))
            order by le.generated_at""",
        (cid,))
    return _keyed(_shape(record) for record in records)


def append_row(client_slug, row):
    """Insert ONE row. Insert-only, never an update: the ledger is history, and
    history that can be rewritten is not evidence a blog shipped. Returns the
    new row's id, or None when the UNIQUE (client_id, topic_slug) constraint
    already holds a row for this slug: first write wins, so a regenerated topic
    never updates its score or generated_at, exactly as the append-only CSV
    behaved."""
    cid = db.client_id(client_slug)
    if not cid:
        raise LookupError(f"unknown client {client_slug!r}")
    prompts = row.get("prompts") or []
    if isinstance(prompts, str):
        prompts = [prompts]
    score = row.get("score")
    if score == "":
        score = None
    return db.q(
        """insert into ledger_entries
             (client_id, topic_slug, topic, covers, prompts, score,
              generated_at, run_id)
           values (%s, %s, %s, %s, %s, %s, %s, %s)
           on conflict (client_id, topic_slug) do nothing
           returning id""",
        (cid,
         row.get("topic_slug") or slugify(row.get("topic", "")),
         row.get("topic", "") or "",
         row.get("covers", "") or "",
         prompts,
         score,
         row.get("generated_at") or datetime.now(timezone.utc),
         # TEXT, never cast to uuid: live rows carry the literal 'retro-fix'.
         row.get("run_id") or None),
        fetch="val")


def record_success(client_slug, result, row, run_id):
    """Insert a shipped blog. Returns True when a row was written.

    APPEND TIMING, ON SUCCESS ONLY: a row joins the ledger when its terminal
    status is exactly "done". needs_review and failed are NOT recorded, because
    a blog that did not ship does not exist, and recording it would strand the
    retry: the operator would re-upload the sheet, see the row red, and have no
    way to try again.

    THE UNIQUE CONSTRAINT IS THE DEDUPE. The CSV code checked membership, then
    appended under a lock, and the check sat outside the lock, so two
    concurrent ships of one slug could both see "absent" and both append. That
    racy pre-check is deleted, not fixed: ON CONFLICT (client_id, topic_slug)
    DO NOTHING makes the database refuse the second write atomically, and the
    absent RETURNING id is how this function knows it lost. First write wins.
    """
    if not result or result.get("status") != "done":
        return False

    topic_slug = (
        result.get("topic_slug")
        or (row or {}).get("topic_slug")
        or slugify((row or {}).get("topic", ""))
    )
    if not topic_slug:
        return False

    row = row or {}
    inserted = append_row(client_slug, {
        "topic": row.get("topic", topic_slug),
        "topic_slug": topic_slug,
        "covers": row.get("covers", ""),
        "prompts": row.get("prompts", []),
        "score": result.get("score"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "run_id": run_id,
    })
    return inserted is not None
