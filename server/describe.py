"""Draft a brand description from a client's live homepage, in ONE short SDK session.

This is an onboarding step, not part of the blog pipeline. It runs once when a brand is added:
the brand carries no description field on the form, so this reads the live homepage and writes
the description straight to the record (see start_job). The operator does not review or edit it.
canonical-facts.md is a separate artifact and still gets drafted and approved by a human later.

Only a REAL draft is saved. If the session could not read the site (mock mode, or a homepage
that would not fetch), draft_description returns a placeholder with NO sources, and start_job
leaves the record untouched rather than saving an apology as the brand's description.

It reuses runner._resolve_mcp_servers and runner.check_real_mode_ready rather than
duplicating the transport logic, so there is exactly one definition of "MCP is configured"
in this codebase and this module cannot drift into a second, more permissive one.

It degrades honestly. Without Firecrawl there is nothing to read the site with, and an agent
with no fetch tool invents a plausible brand summary rather than failing, which is the exact
failure this whole engine is built to prevent. So no MCP returns a placeholder that SAYS it
was not generated from the live site, never a guess.
"""
import asyncio
import os
from datetime import datetime, timezone

from . import runner
from . import db

# Small on purpose. This is one scrape and one paragraph, so a session that has not finished
# in a few turns is looping, not working, and a runaway onboarding helper would spend the
# operator's quota on a field they are about to rewrite anyway.
MAX_TURNS = 12

# ---------------------------------------------------------------------------
# Draft jobs: one per client, in memory.
#
# A draft is a real Claude Code session against a live site and takes tens of seconds. It used
# to be awaited inside the POST, which made the browser the owner of the work: switching tabs
# was survivable, but a refresh or a closed tab aborted the request and threw away a result the
# operator had ALREADY PAID FOR, with the session still running server side to no purpose.
#
# The work belongs to the engine, exactly like a blog run. The browser only watches. So the
# POST starts a task and returns immediately, and the result waits here until it is collected.
# The operator can refresh, close the tab, come back in five minutes, and the draft is still
# here.
#
# Keyed by client slug, not by job id: a second draft for the same brand would spend quota to
# produce a rival answer for one field, so the key IS the concurrency rule. One uvicorn worker
# means one process holds this dict, same as runner.RUNS.
# ---------------------------------------------------------------------------
DRAFT_JOBS = {}


def _now():
    return datetime.now(timezone.utc).isoformat()


def get_job(client_slug):
    return DRAFT_JOBS.get(client_slug)


def job_running(client_slug):
    job = DRAFT_JOBS.get(client_slug)
    return job is not None and job["state"] == "running"


def clear_job(client_slug):
    """Drop a finished job once the operator has taken or dismissed it.

    Only the collected result is dropped. A running job is never cleared here: the task would
    keep going and land on a job record nobody is holding, so the operator would watch a
    spinner that could never resolve.
    """
    job = DRAFT_JOBS.get(client_slug)
    if job is not None and job["state"] != "running":
        del DRAFT_JOBS[client_slug]


def start_job(client_slug, name, domain):
    """Start a draft in the background and return its job record immediately.

    The caller has already refused the duplicate and live-run cases, so this always starts.
    """
    job = {
        "client": client_slug,
        "state": "running",
        "started": _now(),
        "finished": None,
        "description": None,
        "sources": [],
        "error": None,
    }
    DRAFT_JOBS[client_slug] = job

    async def run():
        try:
            result = await draft_description(name, domain)
            job["description"] = result["description"]
            job["sources"] = result["sources"]
            # Onboarding auto-generates the brand description and the operator never reviews or
            # edits it, so a REAL draft is written straight to the record here. "Real" means the
            # session actually read the live site, which is exactly `sources` being non-empty:
            # a placeholder (mock mode, or a homepage that could not be fetched) reports no
            # sources and its text names ITSELF as not-from-the-site, so saving it would make the
            # brand's description an apology. That is the precise failure this guard exists to
            # avoid. A local import breaks any load-order cycle; clients imports neither describe
            # nor app.
            if result["sources"]:
                from . import clients
                # to_thread, not a direct call: this runs inside a background task, and
                # update_client is a sync DB write plus a disk materialize, so calling it
                # straight would stall the event loop for every other request mid-write. The
                # sync-DAL convention across app.py is exactly this hop.
                await asyncio.to_thread(
                    clients.update_client, client_slug, description=result["description"])
            job["state"] = "done"
        except Exception as exc:
            # draft_description already turns every expected failure into a placeholder, so
            # reaching here means a bug rather than a bad site. It still must not leave the
            # job stuck on "running" forever, which would strand the operator's spinner.
            job["error"] = f"{type(exc).__name__}: {exc}"
            job["state"] = "failed"
        finally:
            job["finished"] = _now()

    # Held so the task is not garbage collected mid flight, and dropped when it settles.
    task = asyncio.create_task(run())
    job["_task"] = task
    task.add_done_callback(lambda _: job.pop("_task", None))
    return job


def _placeholder(name, domain, reason):
    """An honest non-answer. It names itself as not generated from the site, so an operator
    who saves it unread ships a visible gap rather than an invented claim."""
    site = domain or "the client domain"
    return {
        "description": (
            f"Not generated from the live site: {reason}. "
            f"No description was drafted for {name}, and nothing here was read from {site}. "
            f"Write the description by hand, or configure Firecrawl and try again."
        ),
        "sources": [],
    }


def _prompt(name, domain):
    return f"""Fetch this brand's homepage and write a plain description of it.

Brand name: {name}
Homepage: {domain}

Steps:
1. Call firecrawl_scrape on {domain} with formats: ['markdown'], onlyMainContent: true,
   waitFor: 6000. That is the ONLY fetch you make.
2. Write a 60 to 120 word description of what this brand is, what it sells, and to whom.

Rules:
- State ONLY what the site plainly says. If the site does not say who the buyer is, do not
  name a buyer.
- No marketing language and no superlatives: no best, first, only, leading, number one.
- No claims about returns, performance, growth, or results of any kind.
- Never state a fact from memory. You have no knowledge of this brand outside what you just
  fetched.
- If the page cannot be fetched, say exactly that and stop. Do not describe the brand from
  the domain name, and do not try another URL.

Return the description as your final message text and nothing else: no preamble, no heading,
no bullet list, no closing comment.
"""


def _final_text(message):
    """Pull plain text out of one SDK message, tolerating shapes across SDK versions."""
    parts = []
    for block in getattr(message, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


async def draft_description(name, domain):
    """One short session. Returns {"description": str, "sources": [str]}."""
    name = str(name or "").strip() or "this client"
    domain = str(domain or "").strip()

    if not domain:
        return _placeholder(name, domain, "the client has no domain recorded")

    ok, reason = runner.check_real_mode_ready()
    if not ok:
        return _placeholder(name, domain, reason)

    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        return _placeholder(name, domain, f"the Claude Agent SDK is unavailable ({exc})")

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    try:
        servers = runner._resolve_mcp_servers()
    except runner.RunnerConfigError as exc:
        return _placeholder(name, domain, str(exc))

    options = ClaudeAgentOptions(
        # Resolved from the repo, never os.getcwd(): the server may be started from
        # anywhere, and the CLI must still load the project MCP config.
        cwd=str(runner.REPO_ROOT),
        setting_sources=["project"],
        permission_mode="acceptEdits",
        # Firecrawl is all this session NEEDS: it reads one page and returns a paragraph.
        #
        # It is not all this session CAN do, and the difference matters. `allowed_tools` is the
        # skip-the-permission-prompt list, not a sandbox: a tool left off it is not blocked, and
        # with no human to approve it under acceptEdits it runs anyway. This comment used to
        # claim "no Write, no Edit, no Bash", which was never true. The enforcing option is
        # `disallowed_tools`, and this session does not use it.
        #
        # It is left permissive on purpose. Nothing here writes to the repo, the draft is
        # returned as text and saved by the caller, and a description that came back better for
        # a shell command is a description worth having. If that ever changes, deny the tools
        # rather than list around them.
        allowed_tools=["mcp__firecrawl"],
        mcp_servers=servers,
        max_turns=MAX_TURNS,
        model=os.environ.get("GEO_MODEL") or None,
        # The CLI subprocess needs PATH and every MCP credential named by ${VAR} in
        # .mcp.json. db.agent_env() is the allowlist of what may cross, exactly as
        # runner.py does it; the Supabase credentials are never on it.
        env=db.agent_env(),
    )

    text = ""
    try:
        async for message in query(prompt=_prompt(name, domain), options=options):
            found = _final_text(message)
            if found:
                # Keep the LAST text message: the final turn is the description, and an
                # earlier turn is the model narrating its scrape.
                text = found
    except ClaudeSDKError as exc:
        return _placeholder(name, domain, f"the description session died ({exc})")
    except Exception as exc:
        # An onboarding helper failing must never 500 the form the operator is filling in.
        return _placeholder(name, domain, f"{type(exc).__name__}: {exc}")

    if not text:
        return _placeholder(name, domain, "the session returned no text")

    # The homepage is the only URL this session is allowed to read, so it is the only source
    # there is to report. Parsing sources out of the model's prose would let it name a page
    # it never fetched.
    return {"description": text, "sources": [domain]}
