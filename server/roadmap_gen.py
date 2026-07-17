"""Generate clients/<slug>/roadmap.csv from the brand's live site, in ONE SDK session.

This is the other way a brand gets a roadmap. The first is an operator upload; this one hands
the whole job (read the site, pull demand data, pick the topics, write the sheet) to a single
agent session driven by server/prompts/roadmap-generation.md. The prompt is the strategy and
this module is the plumbing: nothing about how a roadmap is chosen lives in Python.

It reuses runner._resolve_mcp_servers, runner.should_mock and roadmap.load_roadmap rather than
duplicating any of them, so there is exactly one definition of "MCP is configured", one
definition of "this run is mock", and one definition of "this CSV parses" in the codebase.

The failure rule that shapes this module: a roadmap.csv on disk makes roadmap.has_roadmap
true, which blocks both an upload and a retry of generation. So a session that writes a sheet
the engine cannot read must leave NOTHING behind, or it strands the brand with a file no route
will accept and no parser will read. Validation below deletes what it cannot parse.
"""
import asyncio
import csv
import hashlib
import io
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

# The five-column contract from the prompt's OUTPUT CONTRACT section. Written here only by the
# mock path; a real session writes its own header. Columns 3 and 4 are read by a human and
# ignored by the engine, which reads 1, 2 and 5 by position (see roadmap.py).
CSV_COLUMNS = ("Content Topic", "What the Piece Covers", "Format", "Search Intent",
               "Target Prompts")

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
        "mock": runner.should_mock(client_slug),
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
            job["state"] = "failed" if error else "done"
            # Saved to disk BEFORE the job settles, and saved on failure too. The job dict lives
            # in this process's memory, so until this line ran, the report existed nowhere else:
            # a restart, and the operator lost the analysis they had paid a long real session
            # for while the CSV it explains sat on disk with no account of itself. The report is
            # frequently worth more than the sheet, because it carries what the agent CUT and
            # what it disputes, and none of that is recoverable by reading the rows.
            _save_report(client_slug, job)
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

    Parsed back out of the file rather than read from GEN_JOBS, so it answers the same in a
    fresh process a week later. That is the entire point of writing it down.
    """
    path = report_path(client_slug)
    if not path.is_file():
        return None

    text = path.read_text(encoding="utf-8")
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

    Three outcomes, and the third is why this function exists:

    1. It parses with rows: the roadmap is real, and the row count comes from re-parsing the
       file rather than from anything the agent said about it.
    2. No file: the prompt legitimately instructs the agent to write nothing and explain when
       it could not read the site, so this is a failure whose answer is the report.
    3. It parses to nothing, or not at all: DELETE IT. A broken roadmap.csv makes
       has_roadmap true, which blocks the upload route AND blocks a retry of generation, so it
       would strand the brand with a sheet no part of the engine can read. Failure has to leave
       the brand exactly as it found it.
    """
    path = roadmap.roadmap_path(client_slug)
    if not path.is_file():
        return None, (
            f"the session wrote no roadmap at {path}. Read the report: the prompt tells the "
            f"agent to write nothing and explain when it cannot read the brand's site."
        )

    try:
        payload = roadmap.load_roadmap(client_slug)
    except (roadmap.RoadmapNotFound, roadmap.BadUpload) as exc:
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


# ---------------------------------------------------------------------------
# Mock generation. Spends nothing: no Firecrawl, no DataForSEO, no model, no token.
# ---------------------------------------------------------------------------

_MOCK_THEMES = (
    "supplier selection",
    "pricing and budgets",
    "buyer shortlists",
    "category comparison",
    "a first purchase checklist",
    "vendor credibility",
    "use case fit",
    "switching costs",
)

_MOCK_FILLER_FORMATS = ("Buyer's guide", "Explainer", "Cost breakdown", "Comparison",
                        "How-to", "Listicle")


def _mock_rows(client_slug, brand_url, piece_count, notes):
    """piece_count rows, derived from a hash of the inputs so the same inputs give the same
    sheet. No random module anywhere: a mock whose output moved between runs would make every
    test of this path a coin flip.

    The structure mirrors the prompt's Stage 5 (one hub listicle, one comparison anchor, one
    FAQ entity, the rest commercial or informational) so the sheet exercises the same shapes a
    real one does. None of it is research, and every row says so in its own scope cell.
    """
    salt = bytes.fromhex(hashlib.md5(
        f"{client_slug}|{brand_url}|{piece_count}|{notes}".encode("utf-8")
    ).hexdigest())

    rows = []
    for position in range(piece_count):
        number = position + 1
        theme = _MOCK_THEMES[(salt[position % 16] + position) % len(_MOCK_THEMES)]

        if position == 0:
            fmt, intent = "Hub listicle", "Commercial"
        elif position == 1:
            fmt, intent = "Comparison anchor", "Commercial"
        elif number == piece_count and piece_count >= 3:
            fmt, intent = "FAQ (entity)", "Navigational"
        else:
            fmt = _MOCK_FILLER_FORMATS[(salt[(position + 5) % 16]) % len(_MOCK_FILLER_FORMATS)]
            intent = "Commercial" if salt[(position + 9) % 16] % 3 else "Informational"

        prompts = " | ".join((
            f"which companies should I shortlist for {theme}",
            f"how do the main options for {theme} compare",
            f"what should I check before committing to {theme}",
        ))
        rows.append([
            f"Mock row {number}: {theme} for {client_slug}",
            f"{runner.DEMO_MARKER} This cell is shaped like a real scope cell and carries no "
            f"research. A real row names what is in the piece, its angle, the proof it "
            f"carries, and the commercial through line to what {brand_url} sells.",
            fmt,
            intent,
            prompts,
        ])
    return rows


def _write_mock_csv(client_slug, rows):
    """Quote every field, exactly as the prompt's mechanics require, so the mock file and a
    real one round trip through the same parser identically."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    writer.writerows(rows)

    path = roadmap.roadmap_path(client_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(buffer.getvalue(), encoding="utf-8")
    return path


def _mock_report(client_slug, brand_url, piece_count, notes, path):
    """The honest non-answer. It leads with what it is, so an operator who skims cannot read
    this as a researched roadmap, and it names the mock switch so they know why they got it."""
    return (
        f"{runner.DEMO_MARKER}\n\n"
        f"This is MOCK output. No research ran behind it: no Firecrawl call, no DataForSEO "
        f"call, no model call, and no token spent. Nothing was read from {brand_url}, and "
        f"nothing here is a fact about a real brand.\n\n"
        f"The {piece_count} row(s) at {path} were assembled locally from a hash of the client "
        f"slug, the brand URL, the piece count, and the notes, so the same inputs always give "
        f"the same sheet. Their topics, formats, intents, and target prompts are filler in the "
        f"shape of the real five-column contract. They exist to exercise the plumbing, and "
        f"they must never be published or handed to a client.\n\n"
        f"Notes carried into this run: {notes.strip() or '(none given)'}\n\n"
        f"This run was mock because GEO_MOCK=1 is set or because {client_slug} is a demo_mode "
        f"client. A demo client is always mock, in every environment, so it can never spend an "
        f"API call. Run a real generation against a non-demo client with GEO_MOCK unset."
    )


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def generate_roadmap(client_slug, brand_url, piece_count, notes):
    """One session, or the local mock. Returns {"report": str, "mock": bool}.

    It does not decide whether the run succeeded: the caller re-parses the file on disk. What
    an agent says it wrote and what it wrote are two different claims, and only one of them is
    checkable.
    """
    notes = str(notes or "")

    if runner.should_mock(client_slug):
        # GEO_MOCK=1 or a demo_mode client. Both spend nothing, so no session opens here at
        # all: the CSV and the report are assembled locally, in process.
        path = _write_mock_csv(client_slug, _mock_rows(client_slug, brand_url, piece_count, notes))
        return {
            "report": _mock_report(client_slug, brand_url, piece_count, notes, path),
            "mock": True,
        }

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
