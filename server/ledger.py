"""The generated-blogs ledger: clients/<slug>/generated.csv.

WHAT THIS IS, and why it does not contradict "the app never writes back to the
CSV": that standing rule protects the OPERATOR's roadmap. Results and status
must never be written into the sheet they uploaded, and progress lives in
status.jsonl. The ledger is a separate artifact the app owns end to end. It is
created at onboarding, header-only, and appended to only by this module. A
future reader must not "fix" it away by folding it back into roadmap.csv.

Three artifacts, three jobs, do not conflate them:
- clients/<slug>/generated.csv  THE LEDGER: blogs that actually shipped.
- clients/<slug>/roadmap.csv    optional saved roadmap, full of topics NOT yet
                                generated. Treating it as the ledger would mark
                                every row red on day one.
- clients/<slug>/uploads/*.csv  the operator's input, archived byte for byte,
                                never mutated.
"""
import csv
import threading
from datetime import datetime, timezone
from pathlib import Path

from .roadmap import slugify

REPO_ROOT = Path(__file__).resolve().parent.parent

# No intent and no volume: they are not ingested from the CSV, so recording them
# would invent data the operator never gave us.
LEDGER_HEADER = ["topic", "topic_slug", "covers", "prompts", "score", "generated_at", "run_id"]

# Topics complete concurrently (five in flight), and two appends racing on the
# same file interleave into one corrupt line. One uvicorn worker means a plain
# module lock is sufficient.
_LOCK = threading.Lock()


def ledger_path(client_slug):
    return REPO_ROOT / "clients" / client_slug / "generated.csv"


def ensure_ledger(client_slug):
    """Create the header-only ledger if it is absent. Idempotent, so a client
    that predates this feature starts working with no migration step."""
    path = ledger_path(client_slug)
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        if path.exists():
            return path
        with open(path, "w", newline="", encoding="utf-8") as handle:
            csv.writer(handle).writerow(LEDGER_HEADER)
    return path


def read_ledger(client_slug):
    """Every ledger row as a dict. A missing file is an empty ledger, not an
    error: the check must work for a client onboarded before the ledger existed."""
    path = ledger_path(client_slug)
    if not path.is_file():
        return []
    # utf-8-sig: the file can come back through Excel on the operator's machine.
    with open(path, newline="", encoding="utf-8-sig") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def ledger_slugs(client_slug):
    """slug -> row, for O(1) dedupe against a whole selection.

    This is the raw ledger, including rows whose blog has since been deleted.
    Use live_slugs for the duplicate check.
    """
    entries = {}
    for row in read_ledger(client_slug):
        slug = (row.get("topic_slug") or slugify(row.get("topic", ""))).strip()
        if slug:
            entries[slug] = row
    return entries


def live_slugs(client_slug):
    """Ledger entries whose blog.md still exists on disk.

    The filesystem is the source of truth for what exists. An operator who
    deletes a blog folder in Finder means to regenerate that topic, so a stale
    ledger row must not keep blocking it forever. The row itself stays as an
    audit trail of what was generated and when; only its power to block is tied
    to the file surviving.
    """
    # Imported here, not at module scope: runner imports roadmap, which imports
    # this module, so a top-level import would close the cycle.
    from . import runner

    return {
        slug: row
        for slug, row in ledger_slugs(client_slug).items()
        if (runner.output_dir(client_slug, slug) / "blog.md").is_file()
    }


def append_row(client_slug, row):
    """Append ONE row. Append-only, never a rewrite: the ledger is history, and
    history that can be rewritten is not evidence a blog shipped."""
    ensure_ledger(client_slug)
    prompts = row.get("prompts") or []
    if isinstance(prompts, str):
        prompts = [prompts]
    record = [
        row.get("topic", ""),
        row.get("topic_slug") or slugify(row.get("topic", "")),
        row.get("covers", ""),
        # Newline-joined and left for csv to quote, matching the shape the
        # operator's own sheets use for prompts.
        "\n".join(prompts),
        row.get("score", "") if row.get("score") is not None else "",
        row.get("generated_at", ""),
        row.get("run_id", ""),
    ]
    with _LOCK:
        with open(ledger_path(client_slug), "a", newline="", encoding="utf-8") as handle:
            csv.writer(handle).writerow(record)
            handle.flush()
    return record


def record_success(client_slug, result, row, run_id):
    """Append a shipped blog. Returns True when a row was written.

    APPEND TIMING, ON SUCCESS ONLY: a row joins the ledger when its terminal
    status is exactly "done". needs_review and failed are NOT recorded, because
    a blog that did not ship does not exist, and recording it would strand the
    retry: the operator would re-upload the sheet, see the row red, and have no
    way to try again.
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
    if topic_slug in ledger_slugs(client_slug):
        return False

    row = row or {}
    append_row(client_slug, {
        "topic": row.get("topic", topic_slug),
        "topic_slug": topic_slug,
        "covers": row.get("covers", ""),
        "prompts": row.get("prompts", []),
        "score": result.get("score"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "run_id": run_id,
    })
    return True
