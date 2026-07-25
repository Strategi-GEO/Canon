"""Generate clients/<slug>/canonical-facts.md in ONE SDK session, driven by a prompt file.

This is the file every blog inherits. Onboarding deliberately does not write it, and preflight
refuses a real run without it, so a newly onboarded brand cannot generate until this module has
run. runner.run_batch calls it once, before the first topic is dispatched, and waits: the fact
base is the writer's source of truth, so building it after a blog started would mean the blog was
already written against nothing.

It mirrors roadmap_gen.py deliberately, down to the job record and the validate-what-was-written
step, because the two jobs have the same shape: one durable job keyed by client slug, one session
driven by a prompt file that owns all the strategy, and a result nobody should trust until it has
been re-read off disk. Nothing about HOW a fact base is built lives in this module. That is
server/prompts/canonical-facts-generation.md.

The failure rule that shapes this module: a canonical-facts.md on disk is what preflight checks,
and preflight checks little else. So a session that writes a half-built fact base leaves a file
that passes preflight and poisons every blog behind it: a missing do-not-claim section forbids
nothing, and twenty drafts inherit that silence as permission. Validation below deletes what it
cannot vouch for, because a brand with no fact base fails loudly and a brand with a hollow one
does not fail at all.
"""
import asyncio
import csv
import os
import re
from contextlib import aclosing
from datetime import datetime, timezone
from pathlib import Path

from . import clients as clients_mod
from . import db
from . import roadmap
from . import runner
from . import sync

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "canonical-facts-generation.md"

# Generous, and for the same reason roadmap_gen's is: the prompt walks six stages before a line of
# the file exists. It reads client.md and gates.json, shells out to pdftotext for every uploaded
# PDF, maps the domain, scrapes every page carrying a fact, then pulls three separate DataForSEO
# lookups. That is dozens of tool calls, each costing a turn, and a cap that ran out mid stage
# would not fail loudly: it would end the session with the fact base half gathered, and the
# operator would pay for the whole session to be told nothing was written.
MAX_TURNS = 200

# What the file must carry before this module lets a blog run behind it. Each check below answers
# a specific way a session can look successful and leave something unusable.
MIN_BYTES = 500
REQUIRED_SECTIONS = ("## §6", "## §9")

# Preflight refuses on this token, which is how a human marks a fact base they are still working
# through. A generated file carrying it would block itself, so this module checks rather than
# trusts.
PLACEHOLDER_TOKEN = "PLACEHOLDER"

_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# ---------------------------------------------------------------------------
# Fact generation jobs: one per client slug, in memory.
#
# Keyed by slug, exactly like roadmap_gen.GEN_JOBS, and for the same reason: two sessions for one
# brand would race to write the same canonical-facts.md, and the loser's file would vanish under
# the winner's with nobody told which fact base survived. The key IS the concurrency rule.
#
# There is no POST that starts one of these. A blog run starts it and waits, so unlike a roadmap
# generation the operator never holds the clock for it directly: they watch the run, which reports
# phase "facts" until the file exists. The record still outlives the run, because the report on why
# a fact base failed is read after the run it killed has finished.
# ---------------------------------------------------------------------------
FACTS_JOBS = {}


class FactsGenerationError(Exception):
    """The session could not run or could not be trusted. Carries the operator-facing text."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def get_job(client_slug):
    return FACTS_JOBS.get(client_slug)


def job_running(client_slug):
    job = FACTS_JOBS.get(client_slug)
    return job is not None and job["state"] == "running"


def clear_job(client_slug):
    """Drop a settled job once the operator has read or dismissed it.

    Only a settled job goes. A running one is never cleared here: the session would keep going and
    land on a record nobody is holding, while the blog run that started it still waits on a fact
    base no job explains.
    """
    job = FACTS_JOBS.get(client_slug)
    if job is not None and job["state"] != "running":
        del FACTS_JOBS[client_slug]


def facts_path(client_slug, clients_root=None):
    """Delegated to runner, which owns the one definition of this path. See
    runner.canonical_facts_path: preflight, this module and the run_batch hook must never be able
    to disagree about which file they are talking about."""
    return runner.canonical_facts_path(client_slug, clients_root)


def has_facts(client_slug, clients_root=None):
    """Does the file exist at all. Deliberately not "is it any good".

    The PLACEHOLDER case is NOT handled here, and that omission is the rule. A file carrying that
    token is a human's work in progress: generating over it would destroy their review, and this
    module has no way to tell a half-reviewed file from a finished one. So a placeholder file reads
    as present here, generation is skipped, and preflight refuses the run exactly as it does today.
    Missing is the only state this feature fills in.
    """
    return facts_path(client_slug, clients_root).is_file()


# ---------------------------------------------------------------------------
# The prompt
# ---------------------------------------------------------------------------

def resource_note(client_slug):
    """What is actually in clients/<slug>/Resources/, for the prompt's Stage 1.

    The prompt calls the uploaded resources the PRIMARY reference, so this note must never claim
    files exist when the folder is empty: an agent told to read a knowledge base that is not there
    either burns turns hunting for it or attributes something to a file it never opened, and this
    is the one file where an invented attribution becomes binding on twenty blogs.

    The empty branch also says the operator CHOSE to proceed without resources, because the UI
    makes that an explicit decision: it warns about the empty folder and offers both an upload
    button and a proceed anyway button. Without that sentence the agent reads an empty folder as a
    setup mistake and hunts for the files. With it, the absence is a settled fact about the run.

    Sizes are named because they are the one hint available up front that a 4 MB PDF may be image
    only and yield no text at all.
    """
    entries = clients_mod.list_resources(client_slug)
    if not entries:
        return (
            "RESOURCES: none. No files are uploaded for this brand: the folder "
            f"clients/{client_slug}/Resources/ is empty or absent. The operator was warned about "
            "this and chose to proceed without them, so this is a settled fact about the run and "
            "not a setup mistake. Do not look for files, do not ask for them, and do not treat "
            "their absence as a fact about the brand. STAGE 1 is a no-op: build this file from the "
            "live site (STAGE 2) and the research tools (STAGE 3). If there is also no live site to "
            "map, follow the section 'WHEN THERE ARE NO UPLOADED RESOURCES AND NO LIVE SITE' and "
            "research the brand from the open web with Firecrawl search and DataForSEO. Say plainly "
            "in §8 that no client materials were available."
        )
    named = ", ".join(f"{entry['name']} ({_human_size(entry['size'])})" for entry in entries)
    return (
        f"RESOURCES: {len(entries)} file(s) are uploaded for this brand: {named}. They live in "
        f"clients/{client_slug}/Resources/. Open every one of them. A file that yields no "
        f"extractable text is reported as unreadable in §8 and attributed nothing, never guessed "
        f"at from its filename."
    )


def roadmap_digest(client_slug):
    """What this brand's roadmap plans to write, for the prompt's Stage 2 targeted pass.

    The fact base exists to serve the roadmap, and until this function existed it was built
    blind to it. That is not a theoretical gap. One live brand's fact base ran a general site
    sweep, recorded its outlet list, and shipped. Blog 7 on its roadmap was about family
    friendly venues and non-drinkers, so it needed the zero-alcohol menu, and that page was
    never fetched because nothing told the fact base the page would matter. The writer may not
    invent a fact and the evaluator may not accept one the fact base does not hold, so the
    session had no way to recover: it just failed the proper-noun gate on a menu that exists,
    is published, and was one scrape away.

    This is the DEMAND SIGNAL, not the brief. Each row's number, its topic, and the prompts it
    must be cited for is enough to tell the session which pages to go and fetch. The row's scope
    and its extras are deliberately left out: the fact base is not being written from the
    roadmap, it is being pointed at the pages the roadmap will need, and a full brief here would
    invite a session to record facts because a blog wants them rather than because a page
    carries them.

    A missing sheet is NOT an error. Onboarding writes a client before it writes a roadmap, and
    a brand may generate its fact base first, so this is an ordinary state and it gets a sentence
    saying so. The same reasoning as resource_note's empty branch: never send a blank, send a
    sentence saying why it is blank, because an agent handed an empty value reads it as something
    the server failed to send and goes hunting for it.
    """
    try:
        payload = roadmap.load_roadmap(client_slug)
    except roadmap.RoadmapNotFound:
        return (
            "ROADMAP: none. This brand has no roadmap.csv yet, so there is no list of planned "
            "blogs to aim at. This is normal and it is not a setup mistake: a brand can be "
            "onboarded and its fact base built before its roadmap is uploaded or generated. "
            "(no roadmap yet: sweep broadly.) Run STAGE 2's general sweep and skip the targeted "
            "pass, because there is nothing to target. Cover the site widely rather than deeply, "
            "since any page you skip is a page some future blog may need."
        )
    except (roadmap.BadUpload, UnicodeDecodeError, csv.Error) as exc:
        # A roadmap that exists but will not parse must not take the fact base down with it. The
        # sheet is context here, not the brief, and a brand whose fact base refused to build over
        # an unreadable CSV would be a brand that cannot generate anything at all until the
        # operator fixes a file this session does not read, does not write and cannot repair.
        #
        # ALL THREE ARMS ARE LOAD-BEARING, and BadUpload alone was the bug. The upload path and
        # the read path disagree about encodings: save_upload decodes through roadmap._decode,
        # whose latin-1 fallback accepts ANY byte sequence, then writes the operator's bytes to
        # roadmap.csv verbatim; load_roadmap re-opens that same file strictly, as utf-8-sig. So a
        # sheet exported from Excel on Windows carrying one cp1252 byte, a curly apostrophe in
        # "Bengaluru's best cafes" is enough, uploads clean and is reported as accepted, then
        # raises UnicodeDecodeError here. That is not a BadUpload and it is not caught by name:
        # it escaped to ensure_facts's generic handler, came back as FactsGenerationError, and
        # failed EVERY topic in the run with "canonical-facts.md could not be built". A brand
        # taken down by the one file this branch exists to survive. csv.Error is the same shape,
        # a file that opens and will not parse, and it is caught here for the same reason rather
        # than left to be discovered the same way.
        #
        # Caught here rather than fixed in load_roadmap deliberately. Loosening that read to
        # latin-1 would make it accept mojibake and hand a run topics with a garbled title, and
        # the encoding mismatch is a real defect the operator should see reported against their
        # upload, not silently absorbed. This branch only declines to die of it.
        return (
            f"ROADMAP: unreadable. clients/{client_slug}/roadmap.csv exists but does not parse "
            f"({exc}). Treat this exactly as no roadmap: run STAGE 2's general sweep, skip the "
            f"targeted pass, and sweep broadly. Do not guess at what the sheet meant to say, and "
            f"do not report this as a fact about the brand: it is a file the operator will fix."
        )

    rows = [row for row in (payload.get("rows") or []) if row.get("topic")]
    if not rows:
        return (
            f"ROADMAP: empty. clients/{client_slug}/roadmap.csv parses but plans no topics. "
            f"(no roadmap yet: sweep broadly.) Run STAGE 2's general sweep and skip the targeted "
            f"pass, because there is nothing to target."
        )

    lines = [
        f"ROADMAP: {len(rows)} blog(s) are planned for this brand. This is what the fact base has "
        f"to be able to support. Every fact one of these blogs needs and this file lacks is a hard "
        f"gate failure in a session that cannot fix it. Read STAGE 2's targeted pass.",
        "",
    ]
    for row in rows:
        # index + 1 is the house numbering convention: RoadmapRow.index is 0 based and every
        # caller that DISPLAYS it adds one, so the operator, the preview's "#" column and this
        # digest all say "blog 7" about the same row.
        lines.append(f"{row['index'] + 1}. {row['topic']}")
        prompts = row.get("prompts") or []
        if prompts:
            lines.append("   cited for: " + " | ".join(prompts))
        else:
            lines.append("   cited for: (no target prompts recorded on this row)")
    return "\n".join(lines)


def _human_size(size):
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{size / 1024:.0f} KB"
    return f"{size} bytes"


def build_prompt(client_slug):
    """Read server/prompts/canonical-facts-generation.md and fill its {{...}} inputs.

    Kept a pure function of its input so the substitution can be proved without spawning a session.
    The unknown-placeholder check below is the point: an operator who adds a new {{TOKEN}} to the
    prompt and no substitution for it here would otherwise ship the literal braces to the agent,
    which reads as an instruction about a value nobody supplied.
    """
    template = PROMPT_PATH.read_text(encoding="utf-8")
    config = runner.load_client_config(client_slug)
    client_dir = runner.REPO_ROOT / "clients" / client_slug

    values = {
        "CLIENT_NAME": str(config.get("name") or client_slug),
        "CLIENT_SLUG": client_slug,
        # A brand with no recorded domain still gets a fact base. When it HAS uploaded resources,
        # those are the primary reference and the file rests on them. When it has neither domain nor
        # resources, the file rests on open-web research instead, and the empty branch points the
        # agent there rather than at a dead end. Saying so plainly beats an empty value: the
        # prompt's STAGE 2 tells the agent to map and scrape this URL, and a blank there reads as a
        # value the server failed to send rather than a site that does not exist. §3 records only
        # URLs it fetched, so an empty §3 is a truthful outcome for such a brand, not a broken one.
        "BRAND_URL": str(config.get("domain") or "").strip() or (
            "(no domain recorded for this brand: there is no site to map or scrape, so STAGE 2 is a "
            "no-op and §3 records no URLs. Build from the uploaded resources where there are any; "
            "where there are none either, follow the section 'WHEN THERE ARE NO UPLOADED RESOURCES "
            "AND NO LIVE SITE' and build from open-web research with Firecrawl search and "
            "DataForSEO. Say so in §8.)"
        ),
        "INDUSTRY": str(config.get("industry") or "").strip() or "(not recorded)",
        "CLIENT_DIR": str(client_dir),
        "OUTPUT_PATH": str(facts_path(client_slug)),
        "RESOURCE_NOTE": resource_note(client_slug),
        # The roadmap the fact base has to serve. See roadmap_digest: this is what turns STAGE 2's
        # second pass from "fetch whatever looks important" into "fetch the page blog 7 needs".
        "ROADMAP_DIGEST": roadmap_digest(client_slug),
    }

    unknown = sorted(set(_PLACEHOLDER.findall(template)) - set(values))
    if unknown:
        raise FactsGenerationError(
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
    """Beside canonical-facts.md, because it is the account of that exact file."""
    return runner.REPO_ROOT / "clients" / client_slug / "canonical-facts-report.md"


def _save_report(client_slug, job):
    """Write the report beside the fact base. Never raises: it must not fail a settled job.

    The job dict lives in this process's memory, so until this line ran the report existed nowhere
    else: a restart, and the operator lost the account of a file that is now binding on every blog
    they publish. The report carries what the session could NOT verify, which resources were
    unreadable, and which entries it wants a human to check, and none of that is recoverable by
    reading the fact base itself. It is saved on failure too, because a failed generation's report
    is the operator's only explanation of why their run died.

    A crash here would flip a generation that actually succeeded to failed, and send an operator to
    regenerate a file already on disk. A missing report is a small loss; a fabricated failure is not.
    """
    report = (job.get("report") or "").strip()
    if not report:
        return
    try:
        front = "\n".join([
            "---",
            f"generated: {job.get('finished') or _now()}",
            f"client: {client_slug}",
            f"run_id: {job.get('run_id') or ''}",
            f"state: {job.get('state') or ''}",
            "---",
            "",
        ])
        report_path(client_slug).write_text(front + report + "\n", encoding="utf-8")
    except OSError:
        pass


def _validate_written(client_slug):
    """Re-read the file the session claims to have written. Returns an error string, or None.

    Stricter than roadmap_gen's equivalent, and deliberately so. A broken roadmap.csv is caught by
    a parser the moment anyone reads it. Nothing parses canonical-facts.md: preflight checks that
    it exists and that a human has not left PLACEHOLDER in it, then every writer treats whatever is
    there as true. So the only place a hollow fact base gets caught is here.

    Four ways a session can look successful and leave something unusable:

    1. No file. The report is the operator's answer for why.
    2. It carries PLACEHOLDER. Preflight refuses on that token, so the file would block every blog
       for this client while looking finished.
    3. It is a stub. Under MIN_BYTES is not a fact base, it is an apology or a header.
    4. It is missing §6 or §9. A missing §6 means NOTHING is forbidden, and preflight would happily
       pass the file and let twenty blogs inherit the silence as permission. A missing §9 means the
       session claimed a completeness no single pass earns, with the unverified claims folded
       invisibly into the verified ones.

    2, 3 and 4 DELETE the file. A half-built fact base is worse than none: none fails loudly at
    preflight, this one passes and poisons everything behind it. Failure has to leave the brand
    exactly as it found it.
    """
    path = facts_path(client_slug)
    if not path.is_file():
        return (
            f"the session wrote no canonical-facts.md at {path}, so {client_slug} still has no "
            f"fact base. Read the report for what the session found."
        )

    text = path.read_text(encoding="utf-8")
    problems = []
    if PLACEHOLDER_TOKEN in text:
        problems.append(
            f"it contains the token {PLACEHOLDER_TOKEN}, which preflight refuses on"
        )
    if len(text.encode("utf-8")) < MIN_BYTES:
        problems.append(
            f"it is {len(text.encode('utf-8'))} bytes, under the {MIN_BYTES} byte floor, so it is "
            f"a stub rather than a fact base"
        )
    missing = [name for name in REQUIRED_SECTIONS if name not in text]
    if missing:
        problems.append(
            f"it is missing the required section(s) {', '.join(missing)}: §6 is the do-not-claim "
            f"list and §9 is the unverified list, and a fact base without them forbids nothing "
            f"and claims a completeness no session earns"
        )

    if not problems:
        return None

    path.unlink(missing_ok=True)
    return (
        f"the session wrote a canonical-facts.md this engine will not run behind, so it was "
        f"deleted and {client_slug} still has no fact base: " + "; ".join(problems)
    )


def _discard_unvouched(client_slug):
    """Run the validation above for its deletion only, discarding its verdict.

    A session writes canonical-facts.md as it goes and can die AFTER writing a hollow one, so the
    failure paths need the same unlink the success path gets: nothing downstream re-reads the file
    (preflight checks existence and PLACEHOLDER, the run_batch barrier checks existence), so a
    half-built file left behind is never regenerated and every blog inherits its silence. The
    verdict is dropped because the operator's answer to a dead session is why it died, not that the
    wreckage was also hollow, and the caller already holds that message. Errors are swallowed for
    the same reason: this runs while an exception is being handled, and a second one raised from
    here would replace the real cause.
    """
    try:
        _validate_written(client_slug)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# The session
# ---------------------------------------------------------------------------

async def generate_facts(client_slug):
    """One real session, always. Returns {"report": str}.

    It does not decide whether the run succeeded: the caller re-reads the file on disk. What an
    agent says it wrote and what it wrote are two different claims, and only one of them is
    checkable.
    """
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        raise FactsGenerationError(f"the Claude Agent SDK is unavailable ({exc})")

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    try:
        servers = runner._resolve_mcp_servers()
    except runner.RunnerConfigError as exc:
        # An agent with no Firecrawl and no DataForSEO cannot fetch a page or confirm a name, and
        # it will invent a plausible fact base rather than fail. That file would then be BINDING.
        # Refuse here, before a session opens, exactly as the runner refuses a blog.
        raise FactsGenerationError(str(exc))

    prompt = build_prompt(client_slug)

    # The per-session spend cap README documents as GEO_MAX_BUDGET_USD has to reach this session as
    # well as the blog sessions runner._session_options builds, and this is the session it matters
    # most for: MAX_TURNS is 200 and the prompt spends them on domain scrapes and DataForSEO
    # lookups. An operator who capped their spend would otherwise have every blog honor the cap
    # while the heaviest session of the run, the one that opens before the first topic is
    # dispatched, ran with no cap at all.
    budget = os.environ.get("GEO_MAX_BUDGET_USD")

    options = ClaudeAgentOptions(
        # Resolved from the repo, never os.getcwd(): the server may be started from anywhere, and
        # the CLI must still load the project MCP config.
        cwd=str(runner.REPO_ROOT),
        setting_sources=["project"],
        permission_mode="acceptEdits",
        # Firecrawl and DataForSEO are Stages 2 and 3; Read and Glob are Stage 1, where the session
        # reads client.md, gates.json and Resources/; Write is the file itself.
        #
        # BASH IS GRANTED DELIBERATELY, and read this before removing it.
        #
        # First, on the mechanism: `allowed_tools` is NOT a sandbox. It is the list that skips the
        # permission prompt. A tool left off it is not blocked, and under acceptEdits with no human
        # to ask, it simply runs. The real deny list is `disallowed_tools`, and nothing here is on it.
        #
        # Second, on the choice: the prompt tells the agent to run pdftotext on the uploaded PDFs,
        # and those brochures are the PRIMARY reference for this file. Without a shell the session
        # cannot read the operator's own uploads at all: it would either skip them silently or
        # infer their contents from their filenames, which the prompt forbids and which is exactly
        # the invention this file must never contain.
        allowed_tools=[
            "mcp__firecrawl", "mcp__dataforseo", "Read", "Write", "Glob", "Bash",
        ],
        mcp_servers=servers,
        max_turns=MAX_TURNS,
        max_budget_usd=float(budget) if budget else None,
        model=os.environ.get("GEO_MODEL") or None,
        # The CLI subprocess needs PATH and every MCP credential named by ${VAR} in .mcp.json.
        # db.agent_env() is the allowlist of what may cross, exactly as runner.py does it;
        # the Supabase credentials are never on it.
        env=db.agent_env(),
    )

    text = ""
    # aclosing, rather than a bare `async for`, for the reason runner._sdk_session spells out and
    # this session makes worse. query() is an async generator driving a Node subprocess, and the
    # transport close lives in its finally; on the cancellation path a plain `async for` leaves
    # that finally to whenever the generator is collected, which is not a guarantee of anything.
    # The orphaned CLI child keeps its MCP servers and keeps spending the operator's PERSONAL
    # subscription quota after they pressed Stop, and this particular child holds Write on
    # canonical-facts.md, so it can also go on writing the file the stop path is trying to discard.
    # A session someone already cancelled must not still be billing them, let alone still typing.
    try:
        async with aclosing(query(prompt=prompt, options=options)) as session:
            async for message in session:
                found = _final_text(message)
                if found:
                    # Keep the LAST text message. The prompt's closing line says the agent's final
                    # message IS the report; an earlier one is the model narrating a scrape.
                    text = found
    except ClaudeSDKError as exc:
        raise FactsGenerationError(f"the canonical facts session died ({exc})")

    if not text:
        # The file may still be on disk and may still validate, so this is not fatal by itself.
        # Say plainly that the report is missing rather than inventing a summary of a session
        # nobody watched.
        text = ("The session returned no final message, so there is no report. Read "
                "canonical-facts.md itself, and check §8 and §9 first, before trusting it.")
    return {"report": text}


async def ensure_facts(client_slug, run_id=None):
    """Build the fact base and WAIT for it. Raises FactsGenerationError when it cannot.

    The awaited entry point, and the only one: there is no POST that starts a generation, because a
    button and a blog run would be two ways to do the same thing and the two could disagree about
    which fact base a run is using. runner.run_batch calls this before it dispatches a topic.

    Raising is the contract. A caller that swallowed this would dispatch blogs against a client
    with no fact base, which is the exact silent poisoning preflight exists to prevent.
    """
    job = {
        "client": client_slug,
        "state": "running",
        "started": _now(),
        "finished": None,
        "report": None,
        "error": None,
        # The blog run that triggered this, so the UI can tie the two together. A fact base is
        # never built on its own account: something was trying to write a blog.
        "run_id": run_id,
    }
    FACTS_JOBS[client_slug] = job

    try:
        result = await generate_facts(client_slug)
        # The report survives every outcome below. When a session legitimately declines to write a
        # fact base, because it could not read the site or the resources, the report IS the
        # operator's answer, and a job reporting only "no file written" would throw away the one
        # thing they paid for.
        job["report"] = result["report"]
        job["error"] = _validate_written(client_slug)
        if not job["error"]:
            # SUCCESS PATH ONLY, and the placement is the contract. The record must carry
            # the facts every future materialize lays down, so a validated file is committed
            # here, after _validate_written vouched for it. A cancelled build never reaches
            # this line (CancelledError lands in the arm below, which discards the unvouched
            # file and re-raises), and a failed validation already deleted the file, so
            # canonical_facts in the record stays NULL on every path that produced no fact
            # base: the stop contract holds because this line is unreachable from a stop.
            # A commit failure falls to the generic handler below and fails the job loudly,
            # because facts that never reached the record were not built.
            sync.commit_client_facts(client_slug)
        job["state"] = "failed" if job["error"] else "done"
    except asyncio.CancelledError:
        # THE OPERATOR STOPPED THE BRAND MID-BUILD, and without this arm the stop poisons every
        # blog the brand will ever have. CancelledError is a BaseException, so NEITHER handler
        # below sees it, and both of the things they do are things a stop needs done.
        #
        # _discard_unvouched is the one that matters. This session holds Write from its first turn
        # and authors canonical-facts.md AS IT GOES, so a stop lands on a file that is real, is on
        # disk, and has §1 through §5 but no §6 and no §9. Nothing here is rolled back by leaving
        # it: the next Generate asks only `has_canonical_facts`, which is a bare is_file(), so the
        # build is SKIPPED and never runs again; run_topic's preflight checks existence and the
        # PLACEHOLDER token, neither of which a truncated file trips. So every blog for the brand
        # is written against a fact base whose do-not-claim list does not exist. It forbids
        # nothing, and twenty drafts inherit the silence as permission. That is the exact outcome
        # _validate_written and _discard_unvouched were both written to prevent, and a stop is the
        # one path that walked around them. Failure has to leave the brand as it found it, and a
        # stop is no exception: the operator gets a brand with no fact base, which fails loudly
        # the next time they press Generate, rather than a hollow one that never fails at all.
        #
        # DELETING NOTHING ELSE. This is the discard of an unvouched half-file this module already
        # owns, not a stop deleting an operator's work: no dossier, draft or status line is touched
        # here, and a fact base that VALIDATES is never discarded by this path.
        #
        # The state assignment is not bookkeeping either. Skipping it leaves the job on "running"
        # for the life of the process, so job_running answers True forever, the clock in the UI
        # never stops, and api_clear_facts_generation 409s permanently: the operator cannot even
        # clear the record of the thing they stopped. "failed" is the honest state, because no
        # fact base was produced, and the error line says who ended it and why nothing is on disk.
        _discard_unvouched(client_slug)
        job["error"] = (
            "the operator stopped this brand while canonical-facts.md was being built, so no "
            "fact base was written. Nothing partial was kept: a half-built fact base passes "
            "preflight and silently poisons every blog behind it. Press Generate to build it "
            "again from the start."
        )
        job["state"] = "failed"
        # NEVER swallow a cancellation. run_batch is awaiting this, and a normal return here would
        # tell it the fact base is ready and let it dispatch twenty topics into a stop.
        raise
    except FactsGenerationError as exc:
        # The session had Write from its first turn, so a death here says nothing about whether a
        # file is on disk: validation has to run on the way out too, or the one outcome this module
        # exists to prevent is the one a crash produces. Failure leaves the brand as it found it.
        _discard_unvouched(client_slug)
        job["error"] = str(exc)
        job["state"] = "failed"
    except Exception as exc:
        # A bug here must never leave the job stuck on "running", which would strand the run
        # waiting on a fact base that is not coming. It must not leave an unvouched file behind
        # either, for the reason the branch above gives.
        _discard_unvouched(client_slug)
        job["error"] = f"{type(exc).__name__}: {exc}"
        job["state"] = "failed"
    finally:
        job["finished"] = _now()
        # Saved BEFORE the job settles for the caller, and saved on failure too. See _save_report.
        _save_report(client_slug, job)

    if job["error"]:
        raise FactsGenerationError(job["error"])
    return job


# ---------------------------------------------------------------------------
# CLI: prove the prompt substitutes without spawning anything.
#
#   python3 -m server.facts_gen --client blr-brewing
#
# Read only. It builds the prompt and prints it. No session, no job, no file.
# ---------------------------------------------------------------------------

def _cli(argv=None):
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m server.facts_gen",
        description="Print the canonical-facts prompt for a client. Starts nothing.",
    )
    parser.add_argument("--client", required=True, help="client slug under clients/")
    args = parser.parse_args(argv)
    print(build_prompt(args.client))
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
