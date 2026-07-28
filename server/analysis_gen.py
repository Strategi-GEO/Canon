"""Generate a brand's MONTHLY ANALYSIS report, in ONE SDK session.

One analysis per brand per CALENDAR month. A session runs the geo-analysis-report skill, which
merges up to six tools (DataForSEO, SEO Gets, Google Search Console, Bing Webmaster, Google
Analytics, Microsoft Clarity) plus own LLM prompt-test runs into ONE normalized analysis.json (the
dashboard-facing dataset) and renders a branded PDF beside it. This module is the plumbing; nothing
about HOW an analysis is built lives here. That is the skill plus server/prompts/analysis-generation.md.

It mirrors report_gen.py deliberately, down to the in-memory job keyed by slug and the
validate-what-was-written step, because the two jobs have the same shape: one long session driven by
a prompt file, and a result nobody should trust until it has been re-read off disk.

THE RECORD is client_analyses. After the session is validated, _commit lands the WORKING copy
(analysis json + pdf bytes) in the database; the disk copies under outputs/ stay behind as scratch.

DEGRADATION is the design. DataForSEO and Firecrawl are the floor (always connected); the other four
tools may not be, and their MCPs simply are not resolved for the session, so their sections are
absent from analysis.json. A missing tool costs a section, never the whole report. The validator
requires only the floor: the scorecard, the prompt visibility matrix, and the tools table.

The PDF is BEST-EFFORT, exactly as in report_gen: analysis.json is the deliverable the dashboard
needs; the PDF is a download. A missing browser costs the download, never the report.
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

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "analysis-generation.md"

# The session probes six tools, runs the prompt visibility matrix (six engines x several prompts,
# each run at least twice), pulls Lighthouse, rankings, SERP features, GSC/Bing/GA4/Clarity/SEO Gets
# where connected, then writes analysis.json and renders the PDF. That is many dozens of tool calls,
# each a turn, before a single artifact is complete, so the cap is generous for the same reason
# report_gen's is: a cap that ran out mid stage would spend the whole session to produce nothing.
MAX_TURNS = 200

_MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# The MCP tool namespaces this session may call: the two floor tools plus the four optional
# analytics tools. A prefix that matches no connected server is harmless (no tools appear), which is
# exactly what makes degradation free. If you connect an analytics MCP under a different server name
# in .mcp.json, add its `mcp__<name>` prefix here.
ANALYSIS_TOOLS = [
    "mcp__firecrawl", "mcp__dataforseo",
    "mcp__gsc", "mcp__ga4", "mcp__bing", "mcp__clarity", "mcp__seogets",
    "Read", "Write", "Glob", "Bash", "Skill",
]


def _optional_mcp_servers():
    """Analysis-only MCP servers for the optional analytics tools, one entry per key CONFIGURED in
    server/.env. An absent key means no server, which means the tool simply is not there: that is the
    graceful degradation the schema expects, and its scorecard renders "Not connected" for it.

    These are handed to the ANALYSIS session alone (merged into its mcp_servers below), never written
    into .mcp.json, so the blog research, write and eval sessions never spawn them. strict_mcp_config
    stays False, so they MERGE with the project firecrawl+dataforseo floor rather than replacing it.

    The key is read through db.config_value, the sanctioned cross-module accessor, NOT os.environ:
    RULE 1 keeps server/.env out of os.environ and out of agent_env, and this routes the value into
    this one session's mcp_servers config instead, which is the whole point of these being agent-
    facing MCP credentials. Names match db.py AGENT_ENV_ALLOW.
    """
    servers = {}
    # SEO Gets: official remote HTTP MCP. The sg_mcp_ key IS the bearer token (Settings -> API & MCP
    # Keys), so it goes straight into the Authorization header. Needs a Core/Pro plan.
    seogets = db.config_value("SEOGETS_API_KEY")
    if seogets:
        servers["seogets"] = {
            "type": "http",
            "url": "https://app.seogets.com/mcp",
            "headers": {"Authorization": f"Bearer {seogets}"},
        }
    # Microsoft Clarity: official Microsoft stdio MCP (@microsoft/clarity-mcp-server). The Data.Export
    # JWT is passed as a CLI arg, which is what this server expects; it then appears in the child's
    # argv, a Microsoft design choice. API limits are tight (~10 req/day, <=3 days, <=3 dimensions).
    clarity = db.config_value("CLARITY_API_KEY")
    if clarity:
        servers["clarity"] = {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "@microsoft/clarity-mcp-server", f"--clarity_api_token={clarity}"],
        }
    return servers


def _optional_env():
    """Extra env for the analysis session ALONE, for an optional tool the agent reaches by raw HTTP
    instead of an MCP server. Bing Webmaster Tools has no official MCP, so rather than run an unvetted
    community npm package with the other keys in its environment, the agent calls the Bing REST API
    (https://ssl.bing.com/webmaster/api.svc/json) directly via Bash using this key. Injecting it here,
    not through agent_env, keeps it out of every OTHER session: RULE 1 keeps server/.env out of
    agent_env, and this puts the key in THIS analysis session's env only. Absent key -> nothing
    injected -> the skill probes, finds it unset, and marks Bing not connected. Names match
    db.py AGENT_ENV_ALLOW.
    """
    env = {}
    bing = db.config_value("BING_WEBMASTER_API_KEY")
    if bing:
        env["BING_WEBMASTER_API_KEY"] = bing
    return env


# ---------------------------------------------------------------------------
# Analysis jobs: one per client slug, in memory (twin of report_gen.REPORT_JOBS).
# ---------------------------------------------------------------------------
ANALYSIS_JOBS = {}


class AnalysisGenerationError(Exception):
    """The session could not run or could not be trusted. Carries the operator-facing text."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def current_month():
    """This month, YYYY-MM, from the engine clock. Generation always targets the current month:
    the metrics are measured now, so an analysis for a past month would carry today's numbers under
    a past label, which the app refuses to let an operator do."""
    return datetime.now(timezone.utc).strftime("%Y-%m")


def valid_month(month):
    return bool(month and _MONTH_RE.match(month))


def get_job(client_slug):
    return ANALYSIS_JOBS.get(client_slug)


def job_running(client_slug):
    job = ANALYSIS_JOBS.get(client_slug)
    return job is not None and job["state"] == "running"


def clear_job(client_slug):
    job = ANALYSIS_JOBS.get(client_slug)
    if job is not None and job["state"] != "running":
        del ANALYSIS_JOBS[client_slug]


def analysis_dir(client_slug, month, root=None):
    """outputs/<slug>/analysis/<month>/. Scratch: the record is client_analyses."""
    return runner.client_output_dir(client_slug, root) / "analysis" / month


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------

def working_analysis_exists(client_slug, month):
    """True when a WORKING analysis already occupies this brand+month. One per month, so a
    regenerate must Delete first: the guard the generate route enforces with a 409."""
    cid = db.client_id(client_slug)
    if not cid:
        return False
    return db.q(
        "select analysis is not null from client_analyses where client_id = %s and month = %s",
        (cid, month), fetch="val") is True


def _commit(client_slug, month, analysis, pdf_bytes, email):
    """Land the WORKING copy in client_analyses, leaving any shared snapshot untouched.

    ON CONFLICT updates only the working columns, so a row that already carries a shared snapshot
    keeps it while its working copy is refilled. Mirrors report_gen._commit exactly."""
    cid = db.client_id(client_slug)
    if not cid:
        raise AnalysisGenerationError(
            f"unknown client {client_slug!r}: the generated analysis has no client record to land in")
    db.q(
        """insert into client_analyses (client_id, month, analysis, pdf, generated_at, generated_by)
           values (%s, %s, %s::jsonb, %s, now(), %s)
           on conflict (client_id, month) do update set
             analysis = excluded.analysis,
             pdf = excluded.pdf,
             generated_at = excluded.generated_at,
             generated_by = excluded.generated_by""",
        (cid, month, json.dumps(analysis), pdf_bytes, email),
        fetch="none")


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

def resource_note(client_slug):
    entries = clients_mod.list_resources(client_slug)
    if not entries:
        return ("This brand has no uploaded resources, so there is no knowledge base to read: "
                "build the analysis from the connected tools alone.")
    named = ", ".join(entry["name"] for entry in entries)
    return (f"{len(entries)} resource file(s) are uploaded for this brand: {named}. They are "
            f"optional context for an analysis report, not a required source.")


def build_prompt(client_slug, month):
    """Read server/prompts/analysis-generation.md and fill its {{...}} inputs. Pure function of its
    inputs; the unknown-placeholder check catches a token the prompt added and this does not fill."""
    template = PROMPT_PATH.read_text(encoding="utf-8")
    config = runner.load_client_config(client_slug)
    out = analysis_dir(client_slug, month)

    values = {
        "CLIENT_NAME": str(config.get("name") or client_slug),
        "CLIENT_SLUG": client_slug,
        "BRAND_URL": str(config.get("domain") or "").strip() or "(no domain recorded)",
        "INDUSTRY": str(config.get("industry") or "").strip() or "(not recorded)",
        "MARKET": str(config.get("market") or "").strip() or "(not recorded)",
        "MONTH": month,
        "MONTH_LABEL": datetime.strptime(month, "%Y-%m").strftime("%B %Y"),
        "OUTPUT_DIR": str(out),
        "ANALYSIS_JSON_PATH": str(out / "analysis.json"),
        "ANALYSIS_PDF_PATH": str(out / "analysis.pdf"),
        "RESOURCE_NOTE": resource_note(client_slug),
    }

    unknown = sorted(set(_PLACEHOLDER.findall(template)) - set(values))
    if unknown:
        raise AnalysisGenerationError(
            f"{PROMPT_PATH} carries placeholder(s) this server does not substitute: "
            f"{', '.join(unknown)}. Add them to build_prompt or remove them from the prompt.")

    for token, value in values.items():
        template = template.replace("{{" + token + "}}", value)
    return template


def _final_text(message):
    parts = []
    for block in getattr(message, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


# ---------------------------------------------------------------------------
# Validation of what the session wrote (the floor only; missing tools are omitted, not errors)
# ---------------------------------------------------------------------------

def _prompt_matrix_ok(analysis):
    """The GEO centrepiece: engines and prompts both non-empty. Producible from the floor tools, so
    a report without it did not even run the moat and is rejected."""
    av = analysis.get("ai_visibility") if isinstance(analysis, dict) else None
    if not isinstance(av, dict):
        return False
    pm = av.get("prompt_matrix")
    if not isinstance(pm, dict):
        return False
    return bool(isinstance(pm.get("engines"), list) and pm["engines"]
                and isinstance(pm.get("prompts"), list) and pm["prompts"])


def _nonempty_list(analysis, key):
    value = analysis.get(key) if isinstance(analysis, dict) else None
    return value if isinstance(value, list) and value else None


def _validate_written(client_slug, month):
    """Re-read analysis.json off disk. Returns (analysis_dict, pdf_bytes_or_None, error).

    Requires only the FLOOR, because degradation is the design: a brand with only DataForSEO and
    Firecrawl connected still produces the scorecard, the prompt matrix, and the tools table, and
    that is a valid report. The PDF is best-effort, so its absence is a null, not an error."""
    out = analysis_dir(client_slug, month)
    json_path = out / "analysis.json"
    if not json_path.is_file():
        return None, None, (
            f"the session wrote no analysis.json at {json_path}, so {client_slug} has no analysis "
            f"for {month}. Read the session's final message for what it found.")

    try:
        analysis = json.loads(json_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return None, None, f"the session wrote an analysis.json this engine cannot read ({exc})"

    if not isinstance(analysis, dict) or not isinstance(analysis.get("client"), dict) \
            or not analysis.get("month") or not analysis.get("month_label"):
        return None, None, (
            "the session wrote an analysis.json missing its identity block: it needs client, month "
            "and month_label. Nothing was committed.")
    if _nonempty_list(analysis, "scorecard") is None:
        return None, None, (
            "the session wrote an analysis.json with no scorecard: it needs a non-empty scorecard "
            "array (the 15-second snapshot the dashboard leads with). Nothing was committed.")
    if not _prompt_matrix_ok(analysis):
        return None, None, (
            "the session wrote an analysis.json with no prompt visibility matrix: it needs "
            "ai_visibility.prompt_matrix with a non-empty engines array and a non-empty prompts "
            "array, which is the GEO centrepiece and always producible. Nothing was committed.")
    if _nonempty_list(analysis, "tools") is None:
        return None, None, (
            "the session wrote an analysis.json with no tools table: it needs a non-empty tools "
            "array naming which of the six tools were connected. Nothing was committed.")

    pdf_path = out / "analysis.pdf"
    pdf_bytes = None
    if pdf_path.is_file():
        try:
            data = pdf_path.read_bytes()
            if data[:4] == b"%PDF":
                pdf_bytes = data
        except OSError:
            pdf_bytes = None
    return analysis, pdf_bytes, None


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def generate_analysis(client_slug, month):
    """One real session, always. Returns {"summary": str}. Does not decide success: the caller
    re-reads analysis.json off disk."""
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        raise AnalysisGenerationError(f"the Claude Agent SDK is unavailable ({exc})")

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    try:
        # The floor: Firecrawl and DataForSEO must resolve, or there is no way to run the prompt
        # matrix or the rankings and the agent would invent them. The optional analytics MCPs are
        # merged in below; their absence degrades a section, it does not refuse the run.
        servers = runner._resolve_mcp_servers()
    except runner.RunnerConfigError as exc:
        raise AnalysisGenerationError(str(exc))
    # Analysis-only: add whichever optional analytics tools have a key in server/.env. This MERGES
    # with the floor (strict_mcp_config stays False), so firecrawl+dataforseo still load from the
    # project .mcp.json while these ride alongside for THIS session only. See _optional_mcp_servers.
    servers = {**servers, **_optional_mcp_servers()}

    analysis_dir(client_slug, month).mkdir(parents=True, exist_ok=True)
    prompt = build_prompt(client_slug, month)
    budget = os.environ.get("GEO_MAX_BUDGET_USD")

    options = ClaudeAgentOptions(
        cwd=str(runner.REPO_ROOT),
        setting_sources=["project"],
        permission_mode="acceptEdits",
        allowed_tools=ANALYSIS_TOOLS,
        mcp_servers=servers,
        max_turns=MAX_TURNS,
        max_budget_usd=float(budget) if budget else None,
        model=os.environ.get("GEO_MODEL") or None,
        env={**db.agent_env(), **_optional_env()},
    )

    text = ""
    try:
        async with aclosing(query(prompt=prompt, options=options)) as session:
            async for message in session:
                found = _final_text(message)
                if found:
                    text = found
    except ClaudeSDKError as exc:
        raise AnalysisGenerationError(f"the analysis session died ({exc})")

    return {"summary": text or "The session returned no final message."}


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------

def start_job(client_slug, month, email):
    """Start an analysis generation in the background and return its job record immediately."""
    job = {
        "client": client_slug,
        "month": month,
        "state": "running",
        "started": _now(),
        "finished": None,
        "summary": None,
        "error": None,
    }
    ANALYSIS_JOBS[client_slug] = job

    async def run():
        try:
            result = await generate_analysis(client_slug, month)
            job["summary"] = result["summary"]
            analysis, pdf_bytes, error = _validate_written(client_slug, month)
            job["error"] = error
            if not error:
                _commit(client_slug, month, analysis, pdf_bytes, email)
                job["has_pdf"] = pdf_bytes is not None
            job["state"] = "failed" if error else "done"
        except AnalysisGenerationError as exc:
            job["error"] = str(exc)
            job["state"] = "failed"
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["state"] = "failed"
        finally:
            job["finished"] = _now()

    task = asyncio.create_task(run())
    job["_task"] = task
    task.add_done_callback(lambda _: job.pop("_task", None))
    return job
