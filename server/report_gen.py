"""Generate a brand's MONTHLY GEO performance report, in ONE SDK session.

One report per brand per CALENDAR month. A session runs the geo-site-report skill against the
brand's live domain: it pulls AI-mention counts, backlinks and referring domains from DataForSEO,
grounds findings with Firecrawl, writes report.json (which carries the dashboard-facing `metrics`
block), and renders a branded PDF beside it. This module is the plumbing; nothing about HOW a
report is built lives here. That is the skill plus server/prompts/site-report-generation.md.

It mirrors roadmap_gen.py deliberately, down to the in-memory job keyed by slug and the
validate-what-was-written step, because the two jobs have the same shape: one long session
driven by a prompt file, and a result nobody should trust until it has been re-read off disk.

THE RECORD is client_reports. After the session is validated, _commit lands the WORKING copy
(report json + pdf bytes) in the database; the disk copies under outputs/ stay behind as scratch.
The report is what the admin dashboard shows and what a PDF download serves. Sharing it with the
client (a separate act) copies this working row into the shared snapshot. Delete removes only the
working copy and never the shared snapshot, so a client keeps seeing the last report the operator
sent even after the operator deletes this month's to regenerate it.

The PDF is BEST-EFFORT. report.json is the deliverable the dashboard needs; the PDF is a
download. If the skill's build step could not render one (for example the operator has not run
`playwright install chromium`), the report still commits with a null pdf, and the download simply
is not offered. A missing browser costs the download, never the report.
"""
import asyncio
import json
import os
import re
from contextlib import aclosing
from datetime import datetime, timezone
from pathlib import Path

from . import clients as clients_mod
from . import db
from . import runner

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "site-report-generation.md"

# The skill walks Lighthouse, two scrapes plus digests, robots, an organic lookup, three
# model-list lookups, THIRTY AI-standing prompts (five prompts x three engines x two repeats,
# the skill's floor since the repeat rule landed: one sample per prompt is a coin flip and the
# presence rate is the headline number), the DataForSEO LLM-mention and backlinks lookups, then
# writes report.json and renders the PDF. That is dozens of tool calls, each a turn, before a
# single artifact is complete, so the cap is generous for the same reason roadmap_gen's is: a
# cap that ran out mid stage would spend the whole session to produce nothing.
MAX_TURNS = 170

# The one calendar-month format the whole feature parses and orders by as a plain string.
_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# ---------------------------------------------------------------------------
# Report generation jobs: one per client slug, in memory.
#
# Keyed by slug, exactly like roadmap_gen.GEN_JOBS, and for the same reason: two report sessions
# for one brand would race the same output dir and the same client_reports row. The key IS the
# concurrency rule, and one uvicorn worker means one process holds this dict.
# ---------------------------------------------------------------------------
REPORT_JOBS = {}


class ReportGenerationError(Exception):
    """The session could not run or could not be trusted. Carries the operator-facing text."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def current_month():
    """This month, YYYY-MM, from the engine clock. Generation always targets the current month:
    the metrics are measured now, so a report for a month that has already passed would carry
    today's numbers under a past label, which is a lie the app refuses to let an operator tell."""
    return datetime.now(timezone.utc).strftime("%Y-%m")


def valid_month(month):
    return bool(month and _MONTH_RE.match(month))


def get_job(client_slug):
    return REPORT_JOBS.get(client_slug)


def job_running(client_slug):
    job = REPORT_JOBS.get(client_slug)
    return job is not None and job["state"] == "running"


def clear_job(client_slug):
    """Drop a settled job once the operator has read or dismissed it. A running one is never
    cleared here: the session would keep going and land on a record nobody is holding."""
    job = REPORT_JOBS.get(client_slug)
    if job is not None and job["state"] != "running":
        del REPORT_JOBS[client_slug]


def report_dir(client_slug, month, root=None):
    """outputs/<slug>/reports/<month>/. Scratch: the record is client_reports."""
    return runner.client_output_dir(client_slug, root) / "reports" / month


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------

def working_report_exists(client_slug, month):
    """True when a WORKING report already occupies this brand+month. One report per month, so a
    regenerate must Delete first: this is the guard the generate route enforces with a 409."""
    cid = db.client_id(client_slug)
    if not cid:
        return False
    return db.q(
        "select report is not null from client_reports where client_id = %s and month = %s",
        (cid, month), fetch="val") is True


def _commit(client_slug, month, report, pdf_bytes, email):
    """Land the WORKING copy in client_reports, leaving any shared snapshot untouched.

    ON CONFLICT updates only the working columns, so a row that already carries a shared snapshot
    (a month deleted after it was shared, now being regenerated) keeps that snapshot while its
    working copy is refilled. The shared snapshot is the client's and no generation ever writes it.
    """
    cid = db.client_id(client_slug)
    if not cid:
        raise ReportGenerationError(
            f"unknown client {client_slug!r}: the generated report has no client record to land in")
    db.q(
        """insert into client_reports (client_id, month, report, pdf, generated_at, generated_by)
           values (%s, %s, %s::jsonb, %s, now(), %s)
           on conflict (client_id, month) do update set
             report = excluded.report,
             pdf = excluded.pdf,
             generated_at = excluded.generated_at,
             generated_by = excluded.generated_by""",
        (cid, month, json.dumps(report), pdf_bytes, email),
        fetch="none")


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

def resource_note(client_slug):
    """One sentence naming what is in clients/<slug>/Resources/, mirroring roadmap_gen's. The
    report is grounded in the live site and DataForSEO, so resources are optional context, but a
    blank line reads to an agent as a value the server failed to send."""
    entries = clients_mod.list_resources(client_slug)
    if not entries:
        return ("This brand has no uploaded resources, so there is no knowledge base to read: "
                "build the report from the live site and the DataForSEO lookups alone.")
    named = ", ".join(entry["name"] for entry in entries)
    return (f"{len(entries)} resource file(s) are uploaded for this brand: {named}. They are "
            f"optional context for a performance report, not a required source.")


def build_prompt(client_slug, month):
    """Read server/prompts/site-report-generation.md and fill its {{...}} inputs. A pure function
    of its inputs so the substitution can be proved without spawning a session; the unknown
    placeholder check catches a token the prompt added and this function does not substitute."""
    template = PROMPT_PATH.read_text(encoding="utf-8")
    config = runner.load_client_config(client_slug)
    out = report_dir(client_slug, month)

    values = {
        "CLIENT_NAME": str(config.get("name") or client_slug),
        "CLIENT_SLUG": client_slug,
        "BRAND_URL": str(config.get("domain") or "").strip() or "(no domain recorded)",
        "INDUSTRY": str(config.get("industry") or "").strip() or "(not recorded)",
        "MONTH": month,
        "MONTH_LABEL": datetime.strptime(month, "%Y-%m").strftime("%B %Y"),
        "OUTPUT_DIR": str(out),
        "REPORT_JSON_PATH": str(out / "report.json"),
        "REPORT_PDF_PATH": str(out / "report.pdf"),
        "RESOURCE_NOTE": resource_note(client_slug),
    }

    unknown = sorted(set(_PLACEHOLDER.findall(template)) - set(values))
    if unknown:
        raise ReportGenerationError(
            f"{PROMPT_PATH} carries placeholder(s) this server does not substitute: "
            f"{', '.join(unknown)}. Add them to build_prompt or remove them from the prompt.")

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

def _read_metrics_engines(report):
    """The per-engine mention list, or None. The one field the dashboard cannot draw without."""
    metrics = report.get("metrics") if isinstance(report, dict) else None
    if not isinstance(metrics, dict):
        return None
    mentions = metrics.get("ai_mentions")
    if not isinstance(mentions, dict):
        return None
    by_engine = mentions.get("by_engine")
    if not isinstance(by_engine, list) or not by_engine:
        return None
    for e in by_engine:
        if not isinstance(e, dict) or not isinstance(e.get("value"), (int, float)):
            return None
    return by_engine


def _lighthouse_scores(report):
    """The Lighthouse category scores, or None. Real Google Lighthouse numbers the dashboard and
    the PDF both show, so a report with none is rejected rather than committed: the operator asked
    for Lighthouse on every report and an empty block is not one. A score may be an int, a 0-to-1
    float, or null (only-desktop-was-run leaves mobile null), so a single numeric field is enough
    to count a row as present."""
    lh = report.get("lighthouse") if isinstance(report, dict) else None
    if not isinstance(lh, dict):
        return None
    scores = lh.get("scores")
    if not isinstance(scores, list) or not scores:
        return None
    for s in scores:
        if not isinstance(s, dict) or not s.get("category"):
            return None
        if not isinstance(s.get("desktop"), (int, float)) and not isinstance(s.get("mobile"), (int, float)):
            return None
    return scores


def _nonempty_list(report, key):
    """A required audit array (modules, priority_fixes), or None when absent or empty."""
    value = report.get(key) if isinstance(report, dict) else None
    return value if isinstance(value, list) and value else None


def _validate_written(client_slug, month):
    """Re-read report.json off disk. Returns (report_dict, pdf_bytes_or_None, error).

    report.json is the deliverable: it must exist, parse, and carry the metrics block the
    dashboard charts. The PDF is best-effort, so its absence is not an error, only a null.
    Anything unusable is left where it is (scratch under outputs/), since nothing downstream
    re-reads it: the record is the source of truth and an unvouched file never reaches it.
    """
    out = report_dir(client_slug, month)
    json_path = out / "report.json"
    if not json_path.is_file():
        return None, None, (
            f"the session wrote no report.json at {json_path}, so {client_slug} has no report "
            f"for {month}. Read the session's final message for what it found.")

    try:
        report = json.loads(json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, None, f"the session wrote a report.json this engine cannot read ({exc})"

    if _read_metrics_engines(report) is None:
        return None, None, (
            "the session wrote a report.json with no usable metrics block: it needs "
            "metrics.ai_mentions.by_engine with a value per engine, which is what the dashboard "
            "charts. Nothing was committed.")

    # The audit itself: real Lighthouse scores, the problems it found (modules), and the plan of
    # action (priority_fixes). The dashboard shows Lighthouse and the plan of action, the PDF
    # renders all three, and the operator asked that every report carry them. A metrics-only draft
    # is a thin report, so it is rejected here rather than committed and then discovered empty in
    # the download.
    if _lighthouse_scores(report) is None:
        return None, None, (
            "the session wrote a report.json with no Google Lighthouse scores: it needs "
            "lighthouse.scores from the real DataForSEO on_page_lighthouse pull, which both the "
            "dashboard and the PDF show. Nothing was committed.")
    if _nonempty_list(report, "modules") is None:
        return None, None, (
            "the session wrote a report.json with no module findings: it needs a non-empty "
            "modules array naming the problems the audit found. Nothing was committed.")
    if _nonempty_list(report, "priority_fixes") is None:
        return None, None, (
            "the session wrote a report.json with no plan of action: it needs a non-empty "
            "priority_fixes array (the ordered fixes with suggested solutions), which the "
            "dashboard and the PDF both render. Nothing was committed.")

    pdf_path = out / "report.pdf"
    pdf_bytes = None
    if pdf_path.is_file():
        try:
            data = pdf_path.read_bytes()
            if data[:4] == b"%PDF":
                pdf_bytes = data
        except OSError:
            pdf_bytes = None
    return report, pdf_bytes, None


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def generate_report(client_slug, month):
    """One real session, always. Returns {"summary": str}. Does not decide success: the caller
    re-reads report.json off disk, because what an agent says it wrote and what it wrote are two
    different claims and only one is checkable."""
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        raise ReportGenerationError(f"the Claude Agent SDK is unavailable ({exc})")

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    try:
        servers = runner._resolve_mcp_servers()
    except runner.RunnerConfigError as exc:
        # No Firecrawl and no DataForSEO means no way to measure a mention or a backlink, and the
        # agent would invent plausible numbers rather than fail. Refuse before a session opens,
        # exactly as the runner refuses a blog.
        raise ReportGenerationError(str(exc))

    report_dir(client_slug, month).mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(client_slug, month)
    budget = os.environ.get("GEO_MAX_BUDGET_USD")

    options = ClaudeAgentOptions(
        # Resolved from the repo so the CLI loads CLAUDE.md and the project MCP config, never
        # os.getcwd(): the server may be started from anywhere.
        cwd=str(runner.REPO_ROOT),
        # Required, or CLAUDE.md and the project .mcp.json never load, AND the geo-site-report
        # skill under .claude/skills/ is never discovered.
        setting_sources=["project"],
        permission_mode="acceptEdits",
        # Skill runs the geo-site-report skill; firecrawl/dataforseo are its data sources; Read,
        # Write, Bash cover its scripts (page_digest.py, build_report.py) and its output files.
        allowed_tools=[
            "mcp__firecrawl", "mcp__dataforseo", "Read", "Write", "Glob", "Bash", "Skill",
        ],
        mcp_servers=servers,
        max_turns=MAX_TURNS,
        max_budget_usd=float(budget) if budget else None,
        model=os.environ.get("GEO_MODEL") or None,
        env=db.agent_env(),
    )

    text = ""
    try:
        async with aclosing(query(prompt=prompt, options=options)) as session:
            async for message in session:
                found = _final_text(message)
                if found:
                    text = found
    except ClaudeSDKError as exc:
        raise ReportGenerationError(f"the report session died ({exc})")

    return {"summary": text or "The session returned no final message."}


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------

def start_job(client_slug, month, email):
    """Start a report generation in the background and return its job record immediately. The
    caller has already refused the duplicate, live-run and already-running cases, so this always
    starts."""
    job = {
        "client": client_slug,
        "month": month,
        "state": "running",
        "started": _now(),
        "finished": None,
        "summary": None,
        "error": None,
    }
    REPORT_JOBS[client_slug] = job

    async def run():
        try:
            result = await generate_report(client_slug, month)
            job["summary"] = result["summary"]
            report, pdf_bytes, error = _validate_written(client_slug, month)
            job["error"] = error
            if not error:
                # Committed while the job still reads "running", the same mutual-exclusion window
                # roadmap_gen documents: job_running and working_report_exists are the two halves
                # of one gate, and settling first would open a gap a concurrent generate could
                # land in. A commit failure falls to the handler below and fails the job loudly.
                _commit(client_slug, month, report, pdf_bytes, email)
                job["has_pdf"] = pdf_bytes is not None
            job["state"] = "failed" if error else "done"
        except ReportGenerationError as exc:
            job["error"] = str(exc)
            job["state"] = "failed"
        except Exception as exc:
            # A bug here must never strand the job on "running", which would freeze the operator's
            # clock and 409 every retry forever.
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["state"] = "failed"
        finally:
            job["finished"] = _now()

    task = asyncio.create_task(run())
    job["_task"] = task
    task.add_done_callback(lambda _: job.pop("_task", None))
    return job
