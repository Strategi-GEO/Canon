"""Generate a brand's roadmap from its live site, in ONE SDK session.

This is the other way a brand gets a roadmap. The first is an operator upload; this one hands
the whole job (read the site, pull demand data, pick the topics, write the sheet) to a single
agent session driven by server/prompts/roadmap-generation.md. Nothing about how a roadmap is
chosen lives in Python, and it does not live in the prompt either any more: the prompt's first
instruction is to invoke the `roadmap-generation` SKILL, which owns the method, and what the
prompt keeps is the engine half (the client's own files, the earlier-month exclusions, the output
path and the column contract). This module is the plumbing under both. The one thing that changed
here for it is `Skill` on allowed_tools; see the note there for why leaving it off fails quietly.

The SDK session is FILE-ONLY: it writes clients/<slug>/roadmap.csv (and its report lands
beside it) on local disk, exactly as before. The RECORD is roadmap_sheets: after the session
is validated, _push_sheet lands the sheet, its parsed rows and the report in the database in
one transaction, and the disk copies stay behind as scratch.

It reuses runner._resolve_mcp_servers and roadmap.parse_csv rather than duplicating either,
so there is exactly one definition of "MCP is configured" and one definition of "this CSV
parses" in the codebase.

The failure rule that shapes this module: a sheet the engine cannot read must NEVER reach the
record. A brand now holds many monthly roadmaps and an add always files the next month, so an
unparseable sheet no longer strands the brand from replacing it, but it would still land a
Month N no reader can parse. Validation below runs BEFORE the push, and it deletes the
unparseable scratch file too, so a later session cannot pick it up as its own output.
"""
import asyncio
import csv
import io
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import clients as clients_mod
from . import db
from . import roadmap, runner

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "roadmap-generation.md"

# Generous on purpose, and far above describe.py's 12. The session reads the client's own files,
# maps and scrapes the site, pulls competitor and demand data, pulls the AI layer, scores,
# architects, then writes. That is dozens of tool calls before a single row exists, and each one
# costs a turn. A cap that ran out mid plan would not fail loudly: it would end the session with
# the roadmap half decided and no CSV written, and the operator would pay for the whole session
# to be told nothing was produced.
#
# It went from 200 to 300 when the roadmap-generation skill took over the method, and the two
# reasons are both PER ITEM rather than flat. The skill's step 1 scrapes EVERY published post
# instead of the three-to-five sample the old inline prompt took, because a cannibalisation gate
# that has seen half the archive duplicates the other half. Its step 5 then runs one
# firecrawl_search per proposed row. So the turn cost now scales with the client's archive and
# with PIECE_COUNT, and a 40-post archive at 10 pieces spends most of 200 before the data pull
# starts. Both are the right calls; the cap is what has to move to pay for them.
MAX_TURNS = 300

_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# ---------------------------------------------------------------------------
# Generation jobs: one per client slug, in memory.
#
# Keyed by slug and not by job id, exactly like describe.DRAFT_JOBS, and for a sharper reason
# than that one has: two generations for one brand would race to write the same roadmap.csv,
# and the loser's rows would vanish under the winner's with nobody told which sheet survived.
# The key IS the concurrency rule.
#
# A generation is a long session against live data, so the browser must never own it. The POST
# starts a task and returns in single digit milliseconds; the result waits here until it is
# collected. The operator can refresh, close the tab, come back later, and the job is still
# here. One uvicorn worker means one process holds this dict, same as runner.RUNS.
# ---------------------------------------------------------------------------
GEN_JOBS = {}

# ---------------------------------------------------------------------------
# Rewrite jobs: keyed by JOB ID, many per brand, in the same process memory.
#
# The slug key above is the generation's concurrency rule; rewrites deliberately do not share
# it, because the operator's loop is "reject rows 3 and 7, and while that runs, reject row 5
# with different feedback". Two rewrites for one brand are safe where two generations are not:
# each owns a DISJOINT set of rows (the route refuses an overlap), each session writes its own
# scratch file, and each splice lands one whole transaction against the sheet as it stands
# then, so disjoint splices commute. The one sheet-level race that remains is topical, not
# structural: two concurrent sessions cannot see each other's NEW topics, so they can in
# principle plan near-duplicates. The review loop itself is the mitigation, since a duplicate
# that lands is exactly what the operator rejects next round.
# ---------------------------------------------------------------------------
REWRITE_JOBS = {}


class GenerationError(Exception):
    """The session could not run or could not be trusted. Carries the operator-facing text."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def get_job(client_slug):
    return GEN_JOBS.get(client_slug)


def job_running(client_slug):
    job = GEN_JOBS.get(client_slug)
    return job is not None and job["state"] == "running"


def clear_job(client_slug):
    """Drop a settled job once the operator has read or dismissed it.

    Only a settled job goes. A running one is never cleared here: the task would keep going and
    land on a record nobody is holding, so the operator would watch a clock that could never
    resolve while a session quietly spent their quota.
    """
    job = GEN_JOBS.get(client_slug)
    if job is not None and job["state"] != "running":
        del GEN_JOBS[client_slug]


def list_rewrite_jobs(client_slug):
    """This brand's rewrite jobs, running and settled, oldest started first."""
    jobs = [job for job in REWRITE_JOBS.values() if job["client"] == client_slug]
    return sorted(jobs, key=lambda job: job["started"])


def rewrite_running(client_slug):
    return any(job["state"] == "running" for job in list_rewrite_jobs(client_slug))


def rewrite_rows_in_flight(client_slug):
    """Row indices some running rewrite already owns. The route refuses an overlap, which is
    the whole reason concurrent rewrites are safe to allow at all."""
    taken = set()
    for job in list_rewrite_jobs(client_slug):
        if job["state"] == "running":
            taken.update(job["row_indices"])
    return taken


def clear_rewrite_job(client_slug, job_id):
    """Drop ONE settled rewrite job. True when one went; a running job is never cleared, for
    the same reason clear_job refuses one."""
    job = REWRITE_JOBS.get(job_id)
    if job is None or job["client"] != client_slug or job["state"] == "running":
        return False
    del REWRITE_JOBS[job_id]
    return True


def rewrite_scratch_path(client_slug, job_id):
    """Each rewrite session writes its OWN scratch file. The shared roadmap.csv scratch is the
    generation's, and two concurrent rewrites pointed at one path would clobber each other's
    output with nobody told which batch survived."""
    return runner.REPO_ROOT / "clients" / client_slug / f"roadmap-rewrite-{job_id}.csv"


def _new_job(client_slug, kind, brand_url, piece_count, notes):
    """The job record both kinds share. Registration is the CALLER's: a generation lives in
    GEN_JOBS under its slug, a rewrite in REWRITE_JOBS under its id, and this function knowing
    which would re-entangle the two concurrency rules the split exists to keep apart."""
    return {
        "client": client_slug,
        "kind": kind,
        "state": "running",
        "started": _now(),
        "finished": None,
        "brand_url": brand_url,
        "piece_count": piece_count,
        "notes": notes,
        "report": None,
        "rows": None,
        "error": None,
    }


def _spawn(job, work):
    """Run `work(job)` as a background task that can never leave the job stuck on "running".

    Shared by generation and rewrite because the guarantee is the point, not the plumbing: a
    job stranded on "running" is an operator's clock that never resolves and a brand that can
    never start another session. `work` sets job["rows"] / job["report"] and returns the error
    string or None; everything about settling lives here, once.
    """
    async def run():
        try:
            job["error"] = await work(job)
            job["state"] = "failed" if job["error"] else "done"
        except GenerationError as exc:
            job["error"] = str(exc)
            job["state"] = "failed"
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["state"] = "failed"
        finally:
            job["finished"] = _now()

    # Held so the task is not garbage collected mid flight, and dropped when it settles.
    task = asyncio.create_task(run())
    job["_task"] = task
    task.add_done_callback(lambda _: job.pop("_task", None))
    return job


def start_job(client_slug, brand_url, piece_count, notes):
    """Start a generation in the background and return its job record immediately.

    The caller has already refused the duplicate, live-run and existing-roadmap cases, so this
    always starts.
    """
    job = _new_job(client_slug, "generate", brand_url, piece_count, notes)
    GEN_JOBS[client_slug] = job

    async def work(job):
        result = await generate_roadmap(client_slug, brand_url, piece_count, notes)
        # The report survives every outcome below. When the agent legitimately declines to
        # write a roadmap, because it could not read the site, the report IS the operator's
        # answer, and a job that reported only "no roadmap written" would throw away the
        # one thing they paid for.
        job["report"] = result["report"]
        rows, error = _validate_written(client_slug)
        job["rows"] = rows
        # Saved to disk BEFORE the job settles, and saved on failure too. The job dict lives
        # in this process's memory, so until this line ran, the report existed nowhere else:
        # a restart, and the operator lost the analysis they had paid a long real session
        # for while the CSV it explains sat on disk with no account of itself. The report is
        # frequently worth more than the sheet, because it carries what the agent CUT and
        # what it disputes, and none of that is recoverable by reading the rows.
        _save_report(client_slug, job)
        if not error:
            # The push happens while the job still reads as "running", because
            # job_running and has_roadmap are the two halves of one mutual-exclusion
            # gate: settling the job first would open a window where neither half
            # holds and a concurrent upload could land, only to be clobbered by
            # this push. A push failure falls to _spawn's handlers and fails the
            # job loudly: a roadmap that never reached the record was not produced.
            _push_sheet(client_slug)
        return error

    return _spawn(job, work)


def start_rewrite_job(client_slug, brand_url, month, payload, row_indices, feedback):
    """Rewrite the ticked rows of one month's sheet, as its OWN job among many.

    Keyed by job id in REWRITE_JOBS, not by slug: the operator's loop is several batches in
    flight at once, each with its own rows and its own feedback. The route has already refused
    an overlap with every running batch, so this job owns its rows outright. `payload` is the
    parsed sheet the route already loaded, so the prompt block is built from the exact rows
    the operator ticked against.

    Each session writes its own scratch file and each splice re-reads the sheet as it stands
    at landing time, so a batch that lands second splices into the sheet the first already
    changed, and the first batch's new rows survive.
    """
    row_indices = sorted(row_indices)
    job = _new_job(client_slug, "rewrite", brand_url, len(row_indices), feedback)
    job_id = uuid.uuid4().hex[:8]
    job["id"] = job_id
    job["row_indices"] = row_indices
    REWRITE_JOBS[job_id] = job

    block = rewrite_block(month, payload, row_indices, feedback)
    scratch = rewrite_scratch_path(client_slug, job_id)

    async def work(job):
        result = await generate_roadmap(client_slug, brand_url, len(row_indices), feedback,
                                        rewrite_block=block, roadmap_path=scratch)
        job["report"] = result["report"]

        if not scratch.is_file():
            return (f"the session wrote no replacement rows at {scratch}. Read the report: "
                    f"the agent writes nothing and explains when it cannot plan honestly, "
                    f"and the roadmap is untouched.")
        try:
            replacement_text = roadmap._decode(scratch.read_bytes())
            _push_rewrite(client_slug, month, row_indices, replacement_text,
                          report=job["report"])
        except (roadmap.BadUpload, GenerationError) as exc:
            return f"the replacement rows were refused and the roadmap is untouched: {exc}"
        finally:
            # The per-job scratch has no life after the splice decides: landed rows live in
            # the record, refused ones live in the report, and a leftover file would only
            # litter clients/<slug>/ with one orphan per batch.
            scratch.unlink(missing_ok=True)
        job["rows"] = len(row_indices)
        return None

    return _spawn(job, work)


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

def _optional_mcp_servers():
    """Research MCP servers this machine has a key for, beyond the firecrawl+dataforseo floor.

    Same mechanism as `analysis_gen._optional_mcp_servers` and read through `db.config_value` for
    the same reason: RULE 1 keeps server/.env out of os.environ and out of agent_env, so an
    agent-facing MCP credential is routed into ONE session's mcp_servers rather than the
    environment. These MERGE with the project .mcp.json floor because strict_mcp_config stays
    False; they are never written into that file, so blog research, write and eval sessions do
    not spawn them.

    SEO GETS IS HERE AND CLARITY IS NOT, and the line between them is what the tool measures.
    SEO Gets reports striking-distance queries and query movement: the terms this brand ALREADY
    ranks just off the money, and what moved since last month. That is the single most direct
    "what should we publish next" signal any tool in this building produces, and it is the one
    input a roadmap could previously only approximate from competitor intersections. Clarity
    measures rage clicks, scroll depth and session recordings, which describe how a page behaves
    once someone is on it; a roadmap chooses which pages to write and cannot act on any of it, so
    attaching it would spend a tool budget on data with no decision behind it. Bing Webmaster is
    left out on a different ground: it has no MCP at all (analysis reaches it by REST through
    Bash), and its query data is the same shape SEO Gets already supplies here.

    An absent key means no server, which means the session simply does not have the tool. That is
    graceful degradation, not a failure: the skill is told what it has and plans from the rest.
    """
    servers = {}
    seogets = db.config_value("SEOGETS_API_KEY")
    if seogets:
        servers["seogets"] = {
            "type": "http",
            "url": "https://app.seogets.com/mcp",
            "headers": {"Authorization": f"Bearer {seogets}"},
        }
    return servers


def optional_tools_note(servers):
    """One paragraph naming the EXTRA research tools this session actually has.

    It exists for the reason `resource_note` exists: an agent told to use a tool that is not
    there either burns turns hunting for it or, worse, reports a finding it never measured. The
    floor (Firecrawl and DataForSEO) is named by the skill itself and is always present, because
    the runner refuses the session outright without it. Everything here is conditional, so the
    prompt has to say which way the condition fell for THIS run.
    """
    if "seogets" not in servers:
        return (
            "No optional research tools are connected for this run, so Firecrawl and DataForSEO "
            "are the whole of your evidence. Do not look for an SEO Gets tool and do not treat "
            "its absence as a fact about the brand."
        )
    return (
        "**SEO Gets is connected (`mcp__seogets__*`) and you should use it.** It reports this "
        "brand's own Search Console data, which is evidence no competitor-derived figure can "
        "replace: the STRIKING DISTANCE queries it already ranks just off the money, and the "
        "QUERY MOVEMENT since last month. Pull both before you write titles. A striking-distance "
        "query is the strongest row a roadmap can carry, because the brand has already proved it "
        "can rank for that ground and the piece is finishing a job rather than starting one, so "
        "say so in the report when a row comes from there. A brand SEO Gets holds no property "
        "for returns nothing, which is ordinary for a new client and is not an error: say the "
        "tool returned no data and plan from the rest."
    )


def resource_note(client_slug):
    """One sentence naming what is actually in clients/<slug>/Resources/.

    It lands inside the prompt's Stage 0 list item about resources, so it must never claim
    files exist when the folder is empty. An agent told to read a knowledge base that is not
    there either burns turns hunting for it or, worse, attributes something to a file it never
    opened. Sizes are named because they are the one hint available up front that a 4 MB PDF
    may be image-only and yield no text at all.
    """
    entries = clients_mod.list_resources(client_slug)
    if not entries:
        return (
            "This brand has no uploaded resources: the folder is empty or absent, so this "
            "resource step is a no-op. Do not look for files here and do not treat their "
            "absence as a fact about the brand."
        )
    named = ", ".join(f"{entry['name']} ({_human_size(entry['size'])})" for entry in entries)
    return (
        f"{len(entries)} file(s) are uploaded for this brand: {named}. Open each one. "
        f"A file that yields no extractable text is reported as unreadable, never guessed at."
    )


def _human_size(size):
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} bytes"


def existing_topics_block(client_slug):
    """The bullet list of topics earlier months already planned, for the prompt's exclusion block.

    A new month is generated by a session that researched the brand from scratch, so it would
    re-propose the same obvious topics every month unless it is told what is already taken. Those
    topics live in the database, not on the site the session reads, so the only way the agent can
    honour "every topic must be new" is to be handed the list here. An empty list is stated
    plainly as the brand's first roadmap rather than left blank, because a blank exclusion block
    reads as an instruction the agent failed to receive.
    """
    topics = roadmap.existing_topics(client_slug)
    if not topics:
        return ("(none: this is the brand's first roadmap, so there are no earlier-month topics "
                "to avoid. Plan freely.)")
    lines = "\n".join(f"- {topic}" for topic in topics)
    return (f"{len(topics)} topic(s) are ALREADY planned in this brand's earlier monthly "
            f"roadmaps. Every row you write must be a NEW topic, distinct from all of these:\n"
            f"{lines}")


def _format_of(row):
    """The row's Content Type extra, if the sheet planned one. Labels are the sheet's own headers.

    Both spellings are accepted because both are on real sheets: the house header is "Content
    Type" since the contract grew past six columns, and every roadmap generated before that
    calls the same column "Format". Reading only the new name would silently empty the kept-rows
    list in the rewrite block, which is what the structural quotas are counted against, so
    a rewrite of an older sheet would be told it may plan a second hub listicle.
    """
    for extra in row.get("extras", []):
        if extra.get("label", "").strip().lower() in ("content type", "format"):
            return extra.get("value", "").strip()
    return ""


def rewrite_block(month, payload, row_indices, feedback):
    """The ENGINE block that turns the generation prompt into a rewrite of the ticked rows.

    One placeholder in the one prompt file, empty on a fresh generation, because a second
    prompt file would fork the whole strategy and drift within a month. The block overrides
    only what a rewrite changes: the output is N replacement rows instead of a full sheet,
    the operator's feedback is binding, and the kept rows join the hard exclusions.
    """
    wanted = set(row_indices)
    rejected = [row for row in payload["rows"] if row["index"] in wanted]
    kept = [row for row in payload["rows"] if row["index"] not in wanted]
    n = len(rejected)

    rejected_lines = "\n".join(
        # A colon, not an em dash. This block is the brief the session reads, and that same
        # session is told a few paragraphs later that the house bans em and en dashes and that
        # build_roadmap.py refuses a row carrying one. Handing it the banned character inside
        # its own instructions is a small contradiction with a real cost: the rejected topics
        # are the text it is most likely to echo back into a replacement row.
        f'- Row {row["index"] + 1}: "{row["topic"]}": {row["covers"] or "(no scope given)"}'
        for row in rejected)
    kept_lines = "\n".join(
        f'- {f"[{_format_of(row)}] " if _format_of(row) else ""}"{row["topic"]}"'
        for row in kept) or "(none: every row of this sheet was rejected)"

    # A sheet whose header row is blank (an upload with an empty leading row) has no header
    # text to quote, and quoting ",,,,," reads as a mistake rather than an instruction: the
    # first live rewrite against such a sheet followed the OUTPUT CONTRACT's named header
    # instead and was refused for it. So the contract the agent is given matches the one the
    # splice actually enforces there: width alone.
    if any(cell.strip() for cell in payload["columns"]):
        # build_roadmap.py stamps the HOUSE header and takes no flag for another, so on a sheet
        # whose labels are the operator's own it writes a file splice_sheet refuses outright. The
        # session learns that only after a full research pass, which is the most expensive way
        # there is to discover a header mismatch, so the block says it before the session starts.
        # Every sheet widen_roadmaps.py migrated is one of these too: that script deliberately
        # keeps an operator's own extra labels rather than stamping house names over them.
        house = (
            ""
            if [cell.strip() for cell in payload["columns"]] == list(roadmap.COLUMNS)
            else ("\n\n**This sheet's header is NOT the house header, so `build_roadmap.py` "
                  "cannot write this file: it only ever stamps the house header and takes no "
                  "flag for another one. Write the CSV yourself, under the header quoted above, "
                  "cell for cell. Use `build_roadmap.py --check-only` to validate your rows if "
                  "you like; a sheet it WRITES here is refused by the engine and the whole "
                  "session is wasted.**")
        )
        header_contract = (
            "**Header contract: row 1 of your file must be EXACTLY the current sheet's "
            "header, and your columns must match it:**\n\n"
            "```\n"
            f"{_csv_line(payload['columns'])}\n"
            "```"
            f"{house}"
        )
    else:
        width = len(payload["columns"])
        header_contract = (
            f"**Header contract: this sheet's own header row is BLANK ({width} empty "
            f"cells), so there is no header text to reproduce. Write the OUTPUT CONTRACT's "
            f"standard header as row 1 of your file, and make every row EXACTLY {width} "
            f"column(s) wide: the engine keeps the sheet's own header and checks only that "
            f"your column count matches.**"
        )

    return f"""
---

## THIS SESSION IS A REWRITE, NOT A FRESH ROADMAP (ENGINE)

The brand's Month {month} roadmap already exists and is KEPT. The operator reviewed it and
rejected {n} of its rows. Your job is to replace ONLY those rows: research and plan {n} new
topics, then write a CSV containing the header row plus EXACTLY {n} data rows to the output
path. The engine splices your rows into the existing sheet; a file with more or fewer data rows
than {n} is refused whole and the roadmap is left untouched. If you genuinely cannot find {n}
topics that clear the gates, write NO file and explain why in your report, exactly as the
failure handling below says; a partial file is refused, not spliced short.

**The operator's feedback on the rejected rows is BINDING.** It overrides this prompt's
defaults exactly as NOTES does, and it is the reason this session exists. Feedback:

> {feedback.strip() or "(none given: the operator rejected these rows without a note, so plan stronger replacements by this prompt's own standards)"}

**ONE note can carry instructions for SEVERAL rows, and every one of them is binding.** Where
the feedback names a row ("Row 3: ...") it means the row with that number in the list below,
the same numbering the operator saw on the sheet; where it names a topic, it means the
rejected row carrying that topic. Apply each row-scoped instruction to THAT row's replacement
and every unscoped instruction to ALL of them. No instruction in the feedback is optional, and
none may be traded off against another row's: a replacement that satisfies its own instruction
by ignoring a general one has failed the brief.

**Rejected rows, in order. Your first output row replaces the first row listed here, your
second the second, and so on:**
{rejected_lines}

**Kept rows. These are a HARD exclusion exactly like the earlier-months block, and your new
topics must not duplicate or substantially overlap them OR the rejected topics above:**
{kept_lines}

**The structural quotas count across the WHOLE sheet, kept rows included.** They live in
`.claude/skills/roadmap-generation/assets/format-taxonomy.json` under `structural_quotas`, which
the skill reads: exactly one hub listicle, one comparison anchor, one FAQ (entity). The kept
rows' formats are listed above: never plan a second hub listicle, comparison anchor or FAQ
(entity) where a kept row already holds one. The intent mix likewise describes the whole
sheet, so weigh what the kept rows already cover rather than reproducing the full ratio
inside {n} rows.

{header_contract}

Everything else in this prompt applies unchanged: read the client's own files first, verify
against the live site, pull real demand data, and apply every gate to every replacement row.
"""


def _csv_line(cells):
    """One row as a CSV line, for quoting the sheet's header verbatim in the prompt."""
    out = io.StringIO()
    csv.writer(out, lineterminator="").writerow(cells)
    return out.getvalue()


def build_prompt(client_slug, brand_url, piece_count, notes, rewrite_block="",
                 roadmap_path=None):
    """Read server/prompts/roadmap-generation.md and fill its {{...}} inputs.

    Kept a pure function of its inputs so the substitution can be proved without spawning a
    session. The unknown-placeholder check below is the point: an operator who adds a new
    {{TOKEN}} to the prompt and no substitution for it here would otherwise ship the literal
    braces to the agent, which reads as an instruction about a value nobody supplied.

    `roadmap_path` overrides where the session is told to write. A generation writes the
    shared scratch; each rewrite writes its own per-job file, because two concurrent rewrite
    sessions pointed at one path would clobber each other's output.
    """
    template = PROMPT_PATH.read_text(encoding="utf-8")
    client_dir = runner.REPO_ROOT / "clients" / client_slug

    values = {
        "BRAND_URL": str(brand_url),
        "PIECE_COUNT": str(piece_count),
        # An empty NOTES would leave the prompt's "NOTES:" label dangling, and a label with
        # nothing after it reads as a value the agent failed to receive rather than one the
        # operator chose not to give.
        "NOTES": str(notes).strip() or "(none given)",
        "CLIENT_DIR": str(client_dir),
        "ROADMAP_PATH": str(roadmap_path or roadmap.roadmap_path(client_slug)),
        "RESOURCE_NOTE": resource_note(client_slug),
        "EXISTING_TOPICS": existing_topics_block(client_slug),
        # Which OPTIONAL research tools this run actually has. Computed from the same function
        # that attaches them, so the prompt can never claim a tool the session was not given.
        "OPTIONAL_TOOLS": optional_tools_note(_optional_mcp_servers()),
        # "" on a fresh generation, so the substituted prompt is byte-for-byte what it was
        # before rewrites existed. Non-empty only when start_rewrite_job built the block.
        "REWRITE_BLOCK": rewrite_block,
    }

    unknown = sorted(set(_PLACEHOLDER.findall(template)) - set(values))
    if unknown:
        raise GenerationError(
            f"{PROMPT_PATH} carries placeholder(s) this server does not substitute: "
            f"{', '.join(unknown)}. Add them to build_prompt or remove them from the prompt."
        )

    for token, value in values.items():
        template = template.replace("{{" + token + "}}", value)
    return template


def _final_text(message):
    """Pull plain text out of one SDK message, tolerating shapes across SDK versions."""
    parts = []
    for block in getattr(message, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


# ---------------------------------------------------------------------------
# Validation of what the session wrote
# ---------------------------------------------------------------------------

def report_path(client_slug):
    """Beside roadmap.csv, because it is the account of that exact sheet."""
    return runner.REPO_ROOT / "clients" / client_slug / "roadmap-report.md"


def read_report(client_slug, month=None):
    """The saved report as {"content", plus whatever the front matter recorded}, or None.

    month=None reads the current (latest) month's report; a month names one specific sheet's
    report. Read from roadmap_sheets.report rather than from GEN_JOBS, so it answers the same in
    a fresh process a week later. That is the entire point of writing it down. The column lives
    on the sheet row because the report is the account of that exact sheet: deleting the
    roadmap takes its report with it, archived under the same stamp.
    """
    cid = db.client_id(client_slug)
    if not cid:
        return None
    if month is None:
        text = db.q("select report from roadmap_sheets where client_id = %s "
                    "order by month desc limit 1", (cid,), fetch="val")
    else:
        text = db.q("select report from roadmap_sheets where client_id = %s and month = %s",
                    (cid, month), fetch="val")
    if text is None:
        return None
    meta = {}
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                key, sep, value = line.partition(":")
                if sep:
                    meta[key.strip()] = value.strip()
            body = text[end + 5:]

    return {
        "content": body.strip(),
        "generated": meta.get("generated"),
        "brand_url": meta.get("brand_url"),
        "piece_count": _int_or_none(meta.get("piece_count")),
        "rows": _int_or_none(meta.get("rows")),
        "notes": meta.get("notes"),
    }


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _save_report(client_slug, job):
    """Write the report beside the sheet. Never raises: it must not fail a settled job.

    A crash here would flip a generation that actually succeeded to "failed" and, worse, send
    an operator to regenerate a roadmap that is already sitting on disk, paying for the whole
    session a second time. A missing report is a small loss; a fabricated failure is not.
    """
    report = (job.get("report") or "").strip()
    if not report:
        return
    try:
        front = "\n".join([
            "---",
            f"generated: {job.get('finished') or _now()}",
            f"brand_url: {job.get('brand_url', '')}",
            f"piece_count: {job.get('piece_count', '')}",
            f"rows: {job.get('rows')}",
            f"notes: {job.get('notes') or '(none given)'}",
            "---",
            "",
        ])
        report_path(client_slug).write_text(front + report + "\n", encoding="utf-8")
    except OSError:
        pass


def _exact_contract_error(columns):
    """The generated sheet must be the house ten columns EXACTLY. Returns a message, or None.

    THIS IS STRICTER THAN THE UPLOAD PARSER, DELIBERATELY, AND THE ASYMMETRY IS THE POINT.
    `roadmap.parse_csv` checks the width and the three BINDING headers and leaves the other seven
    labels alone, because an operator's own sheet is theirs: they may call the demand figure
    "Est. Searches" and the engine hands the writer the header they typed. That leniency is
    correct for a file a person uploaded and wrong for a file THIS ENGINE just wrote. Here we
    control the writer, so "close enough" has no reason to exist: a generated sheet headed
    `Format` and `MSV` would parse, land, and quietly teach the next operator that those are the
    column names, and an eleventh column would ride into every writer's brief as guidance nobody
    planned.

    It is checked HERE rather than in the parser for that same reason: moving it into
    `roadmap.parse_csv` would apply it to uploads too and refuse the operator sheets the
    labelled-extras rule exists to accept.

    Case-insensitive on the label text and exact on the ORDER and the COUNT. Case is the one
    thing a spreadsheet round trip changes on its own; order and count are what the positional
    mapping rests on.
    """
    want = [c.casefold() for c in roadmap.COLUMNS]
    got = [c.strip().casefold() for c in columns]
    if got == want:
        return None
    if len(got) != len(want):
        return (f"it has {len(got)} column(s) and the contract is exactly {len(want)}: "
                f"{', '.join(roadmap.COLUMNS)}")
    wrong = [f"column {i + 1} should be {roadmap.COLUMNS[i]!r} but reads {columns[i].strip()!r}"
             for i, (a, b) in enumerate(zip(got, want)) if a != b]
    return f"its header does not match the contract: {'; '.join(wrong)}"


def _validate_written(client_slug):
    """Parse the file the session claims to have written. Returns (rows, error).

    Parsed straight off the DISK file, deliberately not through roadmap.load_roadmap: that
    reads the roadmap_sheets record, and the whole point of this step is to decide whether
    the session's file EARNS a push into that record. Same decode, same parser, so "this CSV
    parses" means the same thing here as it does on the upload route.

    Three outcomes, and the third is why this function exists:

    1. It parses with rows: the roadmap is real, and the row count comes from re-parsing the
       file rather than from anything the agent said about it.
    2. No file: the prompt legitimately instructs the agent to write nothing and explain when
       it could not read the site, so this is a failure whose answer is the report.
    3. It parses to nothing, or not at all: DELETE IT and push nothing. A broken sheet in the
       record would make has_roadmap true, which blocks the upload route AND blocks a retry of
       generation, stranding the brand with a roadmap no part of the engine can read; a broken
       file left on disk would be read by the NEXT session's validation as its own output.
       Failure has to leave the brand exactly as it found it.
    """
    path = roadmap.roadmap_path(client_slug)
    if not path.is_file():
        return None, (
            f"the session wrote no roadmap at {path}. Read the report: the prompt tells the "
            f"agent to write nothing and explain when it cannot read the brand's site."
        )

    try:
        payload = roadmap.parse_csv(roadmap._decode(path.read_bytes()))
    except roadmap.BadUpload as exc:
        path.unlink(missing_ok=True)
        return None, (
            f"the session wrote a roadmap the engine cannot read, so it was deleted and the "
            f"brand still has no roadmap: {exc}"
        )

    rows = len(payload["rows"])
    if not rows:
        path.unlink(missing_ok=True)
        return None, (
            "the session wrote a roadmap with a header row and no data rows, so it was "
            "deleted and the brand still has no roadmap"
        )

    # Every sheet Canon GENERATES is the house ten, exactly. build_roadmap.py writes that order
    # for the session, so reaching this branch means the session hand-wrote the CSV instead of
    # running the script the prompt mandates, and the sheet it produced is not the one the
    # operator was promised.
    contract = _exact_contract_error(payload["columns"])
    if contract:
        path.unlink(missing_ok=True)
        return None, (
            f"the session wrote a roadmap that is not the house column contract, so it was "
            f"deleted and the brand still has no roadmap: {contract}. Run "
            f"build_roadmap.py rather than writing the CSV by hand; it writes the order."
        )
    return rows, None


def _push_sheet(client_slug):
    """Land the sheet the session left on disk, its parsed rows and its report in the record.

    ONE transaction, through roadmap._write_sheet, the same writer the upload route uses, so
    a generated sheet and an uploaded one obey identical row-build rules and a reader can
    never see a sheet whose rows describe a different document. The disk copies stay behind
    as scratch. Runs only after _validate_written passed, so nothing unvouched is pushed.
    """
    path = roadmap.roadmap_path(client_slug)
    raw_text = roadmap._decode(path.read_bytes())
    payload = roadmap.parse_csv(raw_text)

    report = None
    rpath = report_path(client_slug)
    if rpath.is_file():
        report = rpath.read_text(encoding="utf-8")

    cid = db.client_id(client_slug)
    if not cid:
        raise GenerationError(
            f"unknown client {client_slug!r}: the generated roadmap has no client record "
            f"to land in")
    # A generation ADDS the next month, exactly like an upload: the "one roadmap per brand"
    # refusal is gone, so generating a second sheet files it as Month 2.
    month = roadmap.next_month(client_slug)
    with db.tx() as cur:
        roadmap._write_sheet(cur, cid, raw_text, payload, report=report, month=month)


def splice_sheet(sheet_text, row_indices, replacement_text):
    """Replace the sheet's rows at `row_indices` with the replacement CSV's rows. Pure.

    Returns the new sheet text, or raises GenerationError refusing the WHOLE splice: a
    partial splice would land a sheet nobody wrote. The refusals are the contract the
    rewrite prompt states, checked here where nothing can argue with them:

    - The replacement header must equal the sheet's header, verbatim after trimming. This is
      what keeps the extras honest: extras are labelled by the SHEET's header, so a
      replacement laid out differently would have its Format read as the operator's volume
      column, which is the exact bug the by-header rule exists to prevent.
    - Exactly one replacement row per rejected index. The total is fixed by design: the
      operator chose the count once, at generation, and a rewrite may only swap rows.
    - Every replacement row complete. An incomplete replacement is the agent failing the
      brief, not a sheet state to store.

    Replacement rows map to sorted indices in file order: the first row replaces the lowest
    rejected index. Kept rows pass through cell-for-cell; the whole sheet is re-serialised by
    the csv module, which may requote cells but never changes what any of them parse to.
    """
    sheet_rows = roadmap._csv_rows(sheet_text)
    repl_raw = roadmap._csv_rows(replacement_text)
    repl = roadmap.parse_csv(replacement_text)  # BadUpload on a malformed file

    sheet_header = [cell.strip() for cell in sheet_rows[0]]
    repl_header = [cell.strip() for cell in repl_raw[0]] if repl_raw else []
    if any(sheet_header):
        if repl_header != sheet_header:
            raise GenerationError(
                f"the replacement header {repl_header!r} does not match the sheet's header "
                f"{sheet_header!r}, so the columns cannot be trusted to line up")
    elif len(repl_header) != len(sheet_header):
        # A sheet whose first row is blank (an operator upload with an empty leading row: the
        # parser reads row 1 as the header, ALWAYS) has no header text to hold a replacement
        # against, and refusing on the mismatch made such a sheet impossible to rewrite at
        # all. Width is the one thing still checkable, and it is what the positional mapping
        # actually needs; the output keeps the sheet's own blank header row regardless, so the
        # sheet stays exactly as degenerate as the operator uploaded it, no more and no less.
        raise GenerationError(
            f"the sheet's header row is blank, so the splice checks column count alone: the "
            f"sheet is {len(sheet_header)} column(s) wide and the replacement is "
            f"{len(repl_header)}")

    row_indices = sorted(row_indices)
    if len(repl["rows"]) != len(row_indices):
        raise GenerationError(
            f"{len(row_indices)} row(s) were rejected but the session wrote "
            f"{len(repl['rows'])} replacement(s); the total is fixed, so the splice needs "
            f"exactly one new row per rejected row")

    incomplete = [row for row in repl["rows"] if not row["complete"]]
    if incomplete:
        names = ", ".join(f"row {row['index'] + 1} missing {'/'.join(row['missing'])}"
                          for row in incomplete)
        raise GenerationError(f"replacement rows are incomplete: {names}")

    data = sheet_rows[1:]
    for target, row in zip(row_indices, repl["rows"]):
        if not 0 <= target < len(data):
            raise GenerationError(
                f"rejected row index {target} is not on the sheet, which has "
                f"{len(data)} data row(s)")
        # row["index"] is the parse's position in the replacement file, counting any blank
        # lines the csv module saw, so it is the right subscript into the RAW rows.
        data[target] = repl_raw[1:][row["index"]]

    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows([sheet_rows[0]] + data)
    return out.getvalue()


def _push_rewrite(client_slug, month, row_indices, replacement_text, report=None):
    """Splice the session's replacement rows into Month `month` and land it, one transaction.

    The PRE-REWRITE sheet and its report are archived first, under one stamp, exactly as
    delete_roadmap archives: the rewrite destroys rows the operator may want back, and the
    archive is what makes that destruction recoverable. Splice validation runs before any
    write, so a refused splice leaves the record byte-for-byte untouched.

    `report` is the session's own account, passed IN rather than read from the shared
    roadmap-report.md on disk: concurrent rewrite batches would clobber each other in that
    file, and each batch's report must describe its own splice. It lands on the sheet row, so
    the record's report is always the latest batch's and the older ones sit in the archive.

    The splice runs against the sheet AS IT STANDS NOW, re-read inside this push rather than
    captured at submit, which is what lets a second batch land after a first without undoing
    it: batch two's kept rows include batch one's new topics.
    """
    cid = db.client_id(client_slug)
    if not cid:
        raise GenerationError(f"unknown client {client_slug!r}: the rewrite has no record to land in")
    row = db.q("select raw_csv, report from roadmap_sheets where client_id = %s and month = %s",
               (cid, month), fetch="one")
    if not row:
        raise GenerationError(
            f"{client_slug!r} no longer has a Month {month} roadmap; it was deleted while "
            f"the rewrite ran, so there is nothing to splice into")
    old_csv, old_report = row

    new_text = splice_sheet(old_csv, row_indices, replacement_text)
    payload = roadmap.parse_csv(new_text)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
    with db.tx() as cur:
        cur.execute("insert into roadmap_uploads (client_id, filename, raw) values (%s, %s, %s)",
                    (cid, f"{stamp}-pre-rewrite.csv", old_csv.encode("utf-8")))
        if old_report:
            cur.execute(
                "insert into roadmap_uploads (client_id, filename, raw) values (%s, %s, %s)",
                (cid, f"{stamp}-pre-rewrite-report.md", old_report.encode("utf-8")))
        roadmap._write_sheet(cur, cid, new_text, payload, report=report, month=month)

    # The scratch on disk becomes the FULL spliced sheet, replacing the N-row session output:
    # the invariant everywhere else is that this path holds the latest full sheet, and a
    # partial file left here would be read by the next session's validation as its own output.
    roadmap.roadmap_path(client_slug).write_text(new_text, encoding="utf-8")


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def generate_roadmap(client_slug, brand_url, piece_count, notes, rewrite_block="",
                           roadmap_path=None):
    """One real session, always. Returns {"report": str}.

    It does not decide whether the run succeeded: the caller re-parses the file on disk. What
    an agent says it wrote and what it wrote are two different claims, and only one of them is
    checkable.
    """
    notes = str(notes or "")

    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        raise GenerationError(f"the Claude Agent SDK is unavailable ({exc})")

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    try:
        servers = runner._resolve_mcp_servers()
    except runner.RunnerConfigError as exc:
        # An agent with no Firecrawl and no DataForSEO cannot read the site or pull a single
        # volume, and it will invent a plausible roadmap rather than fail. Refuse here, before
        # a session opens, exactly as the runner refuses a blog.
        raise GenerationError(str(exc))

    options = ClaudeAgentOptions(
        # Resolved from the repo, never os.getcwd(): the server may be started from anywhere,
        # and the CLI must still load the project MCP config.
        cwd=str(runner.REPO_ROOT),
        setting_sources=["project"],
        permission_mode="acceptEdits",
        # Firecrawl and DataForSEO are the research; Read and Glob are Stage 0, where this
        # session reads the client's own client.md, canonical-facts.md and Resources/; Write is
        # the CSV. That file access is why this session carries tools describe.py's does not.
        #
        # BASH IS GRANTED DELIBERATELY, and read this before removing it.
        #
        # First, on the mechanism: `allowed_tools` is NOT a sandbox. It is the list that skips
        # the permission prompt. A tool left off it is not blocked, and under acceptEdits with
        # no human to ask, it simply runs. This list said no Bash and the first real generation
        # used Bash nine times, so the restriction only ever existed in this comment. The real
        # deny list is `disallowed_tools`, and nothing here is on it.
        #
        # Second, on the choice: the shell earns its place, and it earns it harder now than it
        # did. That first run used jq to read DataForSEO's deeply nested responses and python3 to
        # check its own CSV against the output contract before returning, which is the difference
        # between an agent claiming it verified the sheet and an agent that did. The skill then
        # made both of those the documented path rather than a good habit: check_overlap.py IS
        # the cannibalisation gate and build_roadmap.py IS what writes the sheet, so without a
        # shell the session cannot run its own gate and cannot produce its own deliverable.
        # Taking it away to satisfy a tidier tool list would buy nothing anyway: a session that
        # can Write roadmap.csv can already do anything a shell could do to that file.
        #
        # SKILL IS ON THE LIST BECAUSE THE STRATEGY LIVES IN ONE. The prompt's first instruction
        # is to invoke `roadmap-generation`, which carries the site read, the data pull, the
        # cannibalisation gate and the column contract; the prompt keeps only the engine half.
        # Leave Skill off and the session is told to run something it will be prompted for and
        # nobody is there to answer, so it proceeds without the method and writes a roadmap from
        # whatever the prompt still happens to say. `setting_sources=["project"]` above is the
        # other half of this: it is what makes .claude/skills/ visible at all.
        allowed_tools=[
            "mcp__firecrawl", "mcp__dataforseo", "mcp__seogets",
            "Read", "Write", "Glob", "Bash", "Skill",
        ],
        # The project floor MERGED with whatever optional research MCP this machine holds a key
        # for. strict_mcp_config stays False, so .mcp.json's firecrawl and dataforseo still load
        # and these ride alongside for THIS session only. `mcp__seogets` is named above even on a
        # machine with no key: allowed_tools is a permission list, not a manifest, so naming a
        # server that did not spawn costs nothing, while leaving it off a machine that DID spawn
        # it would put the session in front of a prompt no operator is there to answer.
        mcp_servers={**servers, **_optional_mcp_servers()},
        max_turns=MAX_TURNS,
        model=os.environ.get("GEO_MODEL") or None,
        # The CLI subprocess needs PATH and every MCP credential named by ${VAR} in .mcp.json.
        # db.agent_env() is the allowlist of what may cross, exactly as runner.py does it;
        # the Supabase credentials are never on it.
        env=db.agent_env(),
    )

    text = ""
    try:
        async for message in query(prompt=build_prompt(client_slug, brand_url, piece_count,
                                                       notes, rewrite_block=rewrite_block,
                                                       roadmap_path=roadmap_path),
                                   options=options):
            found = _final_text(message)
            if found:
                # Keep the LAST text message. The prompt's VERIFY THEN REPORT block says the final
                # message IS the report; an earlier one is the model narrating a scrape.
                text = found
    except ClaudeSDKError as exc:
        raise GenerationError(f"the roadmap generation session died ({exc})")

    if not text:
        # The CSV may still be on disk and may still parse, so this is not fatal by itself.
        # Say plainly that the report is missing rather than inventing a summary of a session
        # nobody watched.
        text = ("The session returned no final message, so there is no report. Read the CSV "
                "itself before trusting it.")
    return {"report": text}
