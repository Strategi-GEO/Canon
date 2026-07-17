"""Generate a brand's roadmap from its live site, in ONE SDK session.

This is the other way a brand gets a roadmap. The first is an operator upload; this one hands
the whole job (read the site, pull demand data, pick the topics, write the sheet) to a single
agent session driven by server/prompts/roadmap-generation.md. The prompt is the strategy and
this module is the plumbing: nothing about how a roadmap is chosen lives in Python.

The SDK session is FILE-ONLY: it writes clients/<slug>/roadmap.csv (and its report lands
beside it) on local disk, exactly as before. The RECORD is roadmap_sheets: after the session
is validated, _push_sheet lands the sheet, its parsed rows and the report in the database in
one transaction, and the disk copies stay behind as scratch.

It reuses runner._resolve_mcp_servers and roadmap.parse_csv rather than duplicating either,
so there is exactly one definition of "MCP is configured" and one definition of "this CSV
parses" in the codebase.

The failure rule that shapes this module: a roadmap_sheets row makes roadmap.has_roadmap
true, which blocks both an upload and a retry of generation. So a sheet the engine cannot
read must NEVER reach the record, or it strands the brand with a roadmap no route will
replace and no parser will read. Validation below runs BEFORE the push, and it deletes the
unparseable scratch file too, so a later session cannot pick it up as its own output.
"""
import asyncio
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from . import clients as clients_mod
from . import db
from . import roadmap, runner

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "roadmap-generation.md"

# Generous on purpose, and far above describe.py's 12. This prompt walks seven stages: read the
# client's own files, map and scrape the site, pull competitor and demand data, pull the AI
# layer, score, architect, then write. That is dozens of tool calls before a single row exists,
# and each one costs a turn. A cap that ran out mid plan would not fail loudly: it would end
# the session with the roadmap half decided and no CSV written, and the operator would pay for
# the whole session to be told nothing was produced.
MAX_TURNS = 200

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


def start_job(client_slug, brand_url, piece_count, notes):
    """Start a generation in the background and return its job record immediately.

    The caller has already refused the duplicate, live-run and existing-roadmap cases, so this
    always starts.
    """
    job = {
        "client": client_slug,
        "state": "running",
        "started": _now(),
        "finished": None,
        "brand_url": brand_url,
        "piece_count": piece_count,
        "notes": notes,
        "report": None,
        "rows": None,
        "error": None,
        # Wire compatibility: readers of this job record still expect the key. The mock
        # execution path is removed, so the honest value is the literal False, always.
        "mock": False,
    }
    GEN_JOBS[client_slug] = job

    async def run():
        try:
            result = await generate_roadmap(client_slug, brand_url, piece_count, notes)
            # The report survives every outcome below. When the agent legitimately declines to
            # write a roadmap, because it could not read the site, the report IS the operator's
            # answer, and a job that reported only "no roadmap written" would throw away the
            # one thing they paid for.
            job["report"] = result["report"]
            job["mock"] = result["mock"]
            rows, error = _validate_written(client_slug)
            job["rows"] = rows
            job["error"] = error
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
                # this push. A push failure falls to the handlers below and fails the
                # job loudly: a roadmap that never reached the record was not produced.
                _push_sheet(client_slug)
            job["state"] = "failed" if error else "done"
        except GenerationError as exc:
            job["error"] = str(exc)
            job["state"] = "failed"
        except Exception as exc:
            # A bug here must never leave the job stuck on "running", which would strand the
            # operator's clock forever with no way to start another generation.
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["state"] = "failed"
        finally:
            job["finished"] = _now()

    # Held so the task is not garbage collected mid flight, and dropped when it settles.
    task = asyncio.create_task(run())
    job["_task"] = task
    task.add_done_callback(lambda _: job.pop("_task", None))
    return job


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

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


def build_prompt(client_slug, brand_url, piece_count, notes):
    """Read server/prompts/roadmap-generation.md and fill its {{...}} inputs.

    Kept a pure function of its inputs so the substitution can be proved without spawning a
    session. The unknown-placeholder check below is the point: an operator who adds a new
    {{TOKEN}} to the prompt and no substitution for it here would otherwise ship the literal
    braces to the agent, which reads as an instruction about a value nobody supplied.
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
        "ROADMAP_PATH": str(roadmap.roadmap_path(client_slug)),
        "RESOURCE_NOTE": resource_note(client_slug),
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


def read_report(client_slug):
    """The saved report as {"content", plus whatever the front matter recorded}, or None.

    Read from roadmap_sheets.report rather than from GEN_JOBS, so it answers the same in a
    fresh process a week later. That is the entire point of writing it down. The column lives
    on the sheet row because the report is the account of that exact sheet: deleting the
    roadmap takes its report with it, archived under the same stamp.
    """
    cid = db.client_id(client_slug)
    if not cid:
        return None
    text = db.q("select report from roadmap_sheets where client_id = %s",
                (cid,), fetch="val")
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
        "mock": meta.get("mock") == "true",
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
            f"mock: {str(bool(job.get('mock'))).lower()}",
            "---",
            "",
        ])
        report_path(client_slug).write_text(front + report + "\n", encoding="utf-8")
    except OSError:
        pass


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
    with db.tx() as cur:
        roadmap._write_sheet(cur, cid, raw_text, payload, report=report)


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def generate_roadmap(client_slug, brand_url, piece_count, notes):
    """One real session, always. Returns {"report": str, "mock": bool}, mock always False.

    It does not decide whether the run succeeded: the caller re-parses the file on disk. What
    an agent says it wrote and what it wrote are two different claims, and only one of them is
    checkable.
    """
    notes = str(notes or "")

    # A demo fixture never opens this session: a roadmap for a fake brand is real API spend
    # buying nothing, and the mock path that used to make it free is removed.
    if runner.is_demo_client(client_slug):
        raise GenerationError(runner.demo_refusal_detail(client_slug))

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
        # Second, on the choice: the shell earns its place. That run used jq to read DataForSEO's
        # deeply nested responses and python3 to check its own CSV against the output contract,
        # five columns, three prompts a row, no em dashes, before returning. That is the
        # difference between an agent claiming it verified the sheet and an agent that did, and
        # the sheet it produced passed every contract check on the first attempt. Taking the
        # shell away to satisfy a tidier tool list would buy nothing: a session that can Write
        # roadmap.csv can already do anything a shell could do to that file.
        allowed_tools=[
            "mcp__firecrawl", "mcp__dataforseo", "Read", "Write", "Glob", "Bash",
        ],
        mcp_servers=servers,
        max_turns=MAX_TURNS,
        model=os.environ.get("GEO_MODEL") or None,
        # The CLI subprocess needs PATH and every MCP credential named by ${VAR} in .mcp.json.
        # db.agent_env() is the allowlist of what may cross, exactly as runner.py does it;
        # the Supabase credentials are never on it.
        env=db.agent_env(),
    )

    text = ""
    try:
        async for message in query(prompt=build_prompt(client_slug, brand_url, piece_count, notes),
                                   options=options):
            found = _final_text(message)
            if found:
                # Keep the LAST text message. The prompt's Stage 7 says the agent's final
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
    return {"report": text, "mock": False}
