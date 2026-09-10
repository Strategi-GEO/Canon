"""Discovery questions: what the crawl could not learn, asked of the person who knows.

WHY THIS MODULE EXISTS. `canonical-facts.md` is built from the brand's uploaded documents and its
live site, and both record only what the brand has already WRITTEN DOWN. Neither reaches what it
simply knows. §9 of that file already lists "claims found but not confirmed" and nothing has ever
turned that section into a question for the one person who could settle it in ten seconds.

reviews/blr-brewing-kb-gap.md measures what that costs: 37 of 58 knowledge base subsections never
reached the fact base, 6 of 10 planned topics were exposed, and a fact that is real, held by the
client and unrecorded is INVISIBLE-BUT-FORBIDDEN. Agent R finds it, Agent W attributes it, Agent E
fails it on G7. This module moves that discovery to onboarding, where it costs one form.

THIS IS NOT THE EVALUATOR'S QUESTION FORM AND MUST NOT BECOME ONE. That form holds a blog at any
score, is capped at 5, and its answers are owed a revise. These questions HOLD NOTHING: no blog
waits on them, no terminal status turns on them, and a brand with every one unanswered generates
exactly as it does today. That difference is the whole reason a form of 20 to 50 is defensible
here and indefensible there, and it is why nothing in this module writes a status line.

THE ANSWERS ARE GUIDANCE, NEVER A CITATION. They rank with `canonical-facts.md`, exactly as the
contract already says an operator answer does, and exactly as the contract already says such an
answer is still not a source. `answers_markdown` renders them into a file agents read; a claim
needing a citation still needs a fetched source.

BILLING: `generate` opens ONE real SDK session and spends this machine's Claude quota, plus
Firecrawl credits for the crawl. It is never automatic. Every path into it is an operator press.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from contextlib import aclosing
from pathlib import Path

from . import db, facts_gen, runner

log = logging.getLogger("geo-factory")

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "discovery-questions.md"

# The agent writes here and this module reads it back. A file, not a returned blob, for the reason
# facts_gen states about its own output: what an agent SAYS it wrote and what it wrote are two
# different claims, and only one of them is checkable.
OUTPUT_NAME = "discovery-questions.json"

# The crawl is a subset of the fact base build's (map plus a page sweep, no targeted roadmap pass),
# so it needs fewer turns. High enough for a large site, low enough that a wandering session stops.
MAX_TURNS = 80

KINDS = ("general", "personalised")

# Ceilings, enforced on ingest rather than trusted from the model. The prompt asks for 20 to 50
# total; this is the backstop against a session that produces 300 and buries the operator.
MAX_PER_KIND = 60
MAX_QUESTION = 400
MAX_WHY = 400
MAX_THEME = 60

_PLACEHOLDER = re.compile(r"\{\{(\w+)\}\}")

# Same shape as facts_gen.FACTS_JOBS: one job per brand, in memory, because the dashboard polls
# for it and a second generation for one brand must be refused while the first is live.
JOBS: dict[str, dict] = {}


class DiscoveryError(RuntimeError):
    """Generation or ingest failed in a way the operator needs to read."""


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

def _now() -> float:
    return time.time()


def get_job(client_slug):
    return JOBS.get(client_slug)


def job_running(client_slug) -> bool:
    job = JOBS.get(client_slug)
    return bool(job and job.get("state") == "running")


def clear_job(client_slug) -> None:
    JOBS.pop(client_slug, None)


# ---------------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------------

def output_path(client_slug, clients_root=None) -> Path:
    root = Path(clients_root) if clients_root else runner.REPO_ROOT / "clients"
    return root / client_slug / OUTPUT_NAME


def build_prompt(client_slug) -> str:
    """Fill the prompt's {{...}} inputs. Pure, so substitution is provable without a session.

    The unknown-placeholder check is facts_gen's and exists for the same reason: a token added to
    the prompt with no substitution here ships literal braces to the agent, which reads as an
    instruction about a value nobody supplied.
    """
    template = PROMPT_PATH.read_text(encoding="utf-8")
    config = runner.load_client_config(client_slug)
    client_dir = runner.REPO_ROOT / "clients" / client_slug

    values = {
        "CLIENT_NAME": str(config.get("name") or client_slug),
        "CLIENT_SLUG": client_slug,
        "BRAND_URL": str(config.get("domain") or "").strip() or (
            "(no domain recorded for this brand, so STAGE 2 is a no-op. Build the questions from "
            "the uploaded resources and any existing canonical-facts.md alone, and ask fewer of "
            "them: with no site to read, a personalised question can only come from a document you "
            "actually opened. Never invent a site claim to ask about.)"
        ),
        "INDUSTRY": str(config.get("industry") or "").strip() or "(not recorded)",
        "CLIENT_DIR": str(client_dir),
        "OUTPUT_PATH": str(output_path(client_slug)),
        # Reused verbatim from the fact base build: the same folder, described the same way, so an
        # empty Resources/ reads as a settled decision in both prompts rather than a setup mistake
        # in one of them.
        "RESOURCE_NOTE": facts_gen.resource_note(client_slug),
    }

    unknown = sorted(set(_PLACEHOLDER.findall(template)) - set(values))
    if unknown:
        raise DiscoveryError(
            f"{PROMPT_PATH} carries placeholder(s) this server does not substitute: "
            f"{', '.join(unknown)}. Add them to build_prompt or remove them from the prompt."
        )
    for token, value in values.items():
        template = template.replace("{{" + token + "}}", value)
    return template


# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------

def _clean(value, limit) -> str:
    # The house bans both dashes everywhere, and these strings are shown to a CLIENT. Repairing
    # rather than rejecting: one stray dash in question 34 must not throw away the other 49.
    # The substitution runs BEFORE the whitespace collapse, so " word — word " lands as
    # "word, word" and not as "word ,  word".
    text = str(value or "").replace("—", ",").replace("–", ",")
    text = " ".join(text.split())
    # A dash sitting next to punctuation the writer already had leaves a doubled mark.
    text = re.sub(r"\s+,", ",", text)
    text = re.sub(r",{2,}", ",", text)
    return text[:limit].strip().strip(",").strip()


def parse_payload(raw: str) -> dict:
    """Validate the agent's JSON into {kind: [ {theme, question, why} ]}.

    Tolerant about the wrapper, strict about the contents. A model that fences its JSON in
    ```json has still produced the file the prompt asked for, and refusing that would discard a
    good session over punctuation. A model that produced no question text has not.
    """
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DiscoveryError(f"the questions file is not valid JSON ({exc})")
    if not isinstance(data, dict):
        raise DiscoveryError("the questions file must be a JSON object with general and personalised arrays")

    out: dict[str, list] = {}
    seen: set[str] = set()
    for kind in KINDS:
        items = data.get(kind)
        # 'personalized' is the American spelling and a model will reach for it. Accepting it here
        # costs one line; refusing it throws away half a paid session over a z.
        if items is None and kind == "personalised":
            items = data.get("personalized")
        if items is None:
            items = []
        if not isinstance(items, list):
            raise DiscoveryError(f"'{kind}' must be an array")
        rows = []
        for item in items:
            if not isinstance(item, dict):
                continue
            question = _clean(item.get("question"), MAX_QUESTION)
            if not question:
                continue
            # Two sessions can converge on the same obvious question across the two sets. The
            # client should see it once.
            key = question.lower()
            if key in seen:
                continue
            seen.add(key)
            rows.append({
                "theme": _clean(item.get("theme"), MAX_THEME),
                "question": question,
                "why": _clean(item.get("why"), MAX_WHY),
            })
            if len(rows) >= MAX_PER_KIND:
                break
        out[kind] = rows

    if not any(out.values()):
        raise DiscoveryError("the questions file carried no usable questions")
    return out


def ingest(client_slug, payload: dict, replace_drafts=True) -> int:
    """Write parsed questions in as DRAFTS. Returns how many landed.

    Drafts only, never sent: a model writing straight to a client is the one thing every other
    outward-facing surface in this app refuses, and the operator's review is the whole gate.

    replace_drafts clears the previous UNSENT set for this brand, so re-running generation gives a
    fresh form rather than a doubled one. SENT questions are never touched, because a client may
    already be part way through answering them and deleting a question under a saved answer
    destroys work a person did.
    """
    cid = _client_id(client_slug)
    if replace_drafts:
        db.q("delete from client_discovery_questions where client_id = %s and sent_at is null",
             (cid,), fetch="none")

    # Existing SENT questions are kept, so re-generation must not re-ask what the client can
    # already see on their form.
    already = {
        (row[0] or "").strip().lower()
        for row in (db.q("select question from client_discovery_questions where client_id = %s",
                         (cid,), fetch="all") or [])
    }

    landed = 0
    for kind in KINDS:
        order = 0
        for item in payload.get(kind, []):
            if item["question"].strip().lower() in already:
                continue
            db.q(
                """insert into client_discovery_questions
                       (client_id, kind, theme, question, why, sort_order)
                   values (%s, %s, %s, %s, %s, %s)""",
                (cid, kind, item["theme"], item["question"], item["why"], order),
                fetch="none",
            )
            order += 1
            landed += 1
    return landed


def _client_id(client_slug):
    row = db.q("select id from clients where slug = %s and deleted_at is null",
               (client_slug,), fetch="one")
    if not row:
        raise DiscoveryError(f"no brand named {client_slug}")
    return row[0]


# ---------------------------------------------------------------------------
# Reads and operator edits
# ---------------------------------------------------------------------------

def list_questions(client_slug) -> dict:
    """Everything this brand holds, drafts included. The operator's review view."""
    cid = _client_id(client_slug)
    rows = db.q(
        """select id, kind, theme, question, why, sort_order, sent_at,
                  answer, answered_at, answered_by
             from client_discovery_questions
            where client_id = %s
            order by kind, sort_order, created_at""",
        (cid,), fetch="all") or []
    items = [{
        "id": str(r[0]), "kind": r[1], "theme": r[2], "question": r[3], "why": r[4],
        "sort_order": r[5],
        "sent_at": r[6].isoformat() if r[6] else None,
        "answer": r[7],
        "answered_at": r[8].isoformat() if r[8] else None,
        "answered_by": r[9] or "",
    } for r in rows]
    # The job WITHOUT its private keys, and the filter belongs here rather than only in app.py's
    # _public_job. start_job stores the asyncio Task under "_task" so the module can cancel it,
    # and a Task has no __dict__, so handing the raw dict to FastAPI raises
    # "vars() argument must have __dict__ attribute" and the whole read 500s. That is exactly what
    # happened: the operator's browser could no longer see the generation it had just started, so
    # the page still read "No questions yet" and the obvious next move was to press Generate
    # again, which the route then correctly refused with a 409 that looked like the real fault.
    # Filtering at the source means every caller is safe, not only the routes that remember.
    job = get_job(client_slug)
    return {
        "questions": items,
        "draft": sum(1 for i in items if i["sent_at"] is None),
        "sent": sum(1 for i in items if i["sent_at"] is not None),
        "answered": sum(1 for i in items if i["answer"]),
        "job": None if job is None else {k: v for k, v in job.items() if not k.startswith("_")},
    }


def send(client_slug) -> int:
    """Release every draft to the client's portal. Returns how many were sent.

    One press releases the whole set rather than one question at a time: a client answering a form
    that grows under them cannot tell what is left, and the operator's review is of the SET.
    """
    cid = _client_id(client_slug)
    return db.q(
        "update client_discovery_questions set sent_at = now() "
        "where client_id = %s and sent_at is null",
        (cid,), fetch="none") or 0


def delete_question(client_slug, question_id) -> bool:
    """Drop one question. Allowed on a sent-but-unanswered question too: an operator who spots a
    bad question after sending should be able to withdraw it. An ANSWERED one is kept, because
    deleting it discards something a person actually wrote."""
    cid = _client_id(client_slug)
    return bool(db.q(
        "delete from client_discovery_questions "
        "where client_id = %s and id = %s and answer is null",
        (cid, question_id), fetch="none"))


def update_question(client_slug, question_id, question=None, why=None) -> bool:
    """Edit the wording before it goes out. Refused once answered: the client answered THOSE
    words, and rewriting the question afterwards makes the record assert a pairing that never
    happened."""
    sets, params = [], []
    if question is not None:
        cleaned = _clean(question, MAX_QUESTION)
        if not cleaned:
            raise DiscoveryError("a question cannot be blank")
        sets.append("question = %s")
        params.append(cleaned)
    if why is not None:
        sets.append("why = %s")
        params.append(_clean(why, MAX_WHY))
    if not sets:
        return False
    cid = _client_id(client_slug)
    return bool(db.q(
        f"update client_discovery_questions set {', '.join(sets)} "
        "where client_id = %s and id = %s and answer is null",
        (*params, cid, question_id), fetch="none"))


def clear(client_slug) -> int:
    """Delete every question for this brand, answers included. The operator's reset."""
    cid = _client_id(client_slug)
    return db.q("delete from client_discovery_questions where client_id = %s",
                (cid,), fetch="none") or 0


# ---------------------------------------------------------------------------
# What the agents read
# ---------------------------------------------------------------------------

def answers_markdown(client_slug) -> str:
    """Render the answered questions into the file every research and writer session reads.

    Returns '' when nothing is answered, and the caller writes that empty string, so the file
    always exists on disk. A file an agent is told to read by path and does not find is a turn
    spent hunting; an empty one is an answered question about whether there is anything there.

    THE PREAMBLE IS LOAD BEARING. Without it an agent reads a list of confident sentences and
    cites them, which is exactly the thing the contract forbids: an answer ranks with
    canonical-facts.md and is still NOT a source.
    """
    # Name off the RECORD, not runner.load_client_config: that reads client.md from disk, and
    # this function runs during materialize, which is the step that PUTS client.md there. On a
    # machine that has never materialised this brand the config read falls back to the slug, and
    # the file would head itself "Client answers: blr-brewing" for a brand called BLR Brewing.
    row = db.q("select id, name from clients where slug = %s and deleted_at is null",
               (client_slug,), fetch="one")
    if not row:
        raise DiscoveryError(f"no brand named {client_slug}")
    cid, name = row[0], (row[1] or client_slug)

    rows = db.q(
        """select kind, theme, question, answer, answered_at
             from client_discovery_questions
            where client_id = %s and answer is not null
            order by kind, sort_order, created_at""",
        (cid,), fetch="all") or []
    if not rows:
        return ""
    out = [
        f"# Client answers: {name}",
        "",
        "The brand answered these directly, in its own portal. They are CLIENT PROVIDED GUIDANCE and",
        "they rank with `canonical-facts.md`, above any internal document.",
        "",
        "**An answer is NOT a source and can never become a citation.** It can tell you that a claim",
        "is wrong, or that a figure is confirmed, and a claim that needs a citation still needs a",
        "fetched source. Where an answer contradicts `canonical-facts.md`, stop and flag it rather",
        "than picking a side.",
        "",
        "**An answer nobody gave is not a fact about the brand.** An unanswered question means only",
        "that nobody has answered it. Never read silence as a no.",
        "",
    ]
    last_theme = None
    for kind, theme, question, answer, answered_at in rows:
        label = theme or ("General" if kind == "general" else "About this brand")
        if label != last_theme:
            out.append(f"## {label}")
            out.append("")
            last_theme = label
        stamp = answered_at.strftime("%Y-%m-%d") if answered_at else ""
        out.append(f"**Q: {question}**")
        out.append("")
        out.append(f"A: {answer}" + (f"  _(answered {stamp})_" if stamp else ""))
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def answered_count(client_slug) -> int:
    cid = _client_id(client_slug)
    return db.q(
        "select count(*) from client_discovery_questions "
        "where client_id = %s and answer is not null",
        (cid,), fetch="val") or 0


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------

def _final_text(message) -> str:
    """The last assistant text block, exactly as facts_gen reads it."""
    blocks = getattr(message, "content", None)
    if not blocks:
        return ""
    parts = [getattr(b, "text", "") for b in blocks if getattr(b, "text", "")]
    return "\n".join(parts).strip()


async def generate(client_slug) -> dict:
    """One real session. Returns {"report", "landed"}. Spends real quota.

    Refuses without research credentials for the same reason facts_gen does: an agent with no
    Firecrawl cannot read the site, and it will invent plausible questions about a brand it never
    saw rather than fail. A client reading an invented question about their own website is worse
    than a client reading none.
    """
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        raise DiscoveryError(f"the Claude Agent SDK is unavailable ({exc})")
    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    try:
        servers = runner._resolve_mcp_servers()
    except runner.RunnerConfigError as exc:
        raise DiscoveryError(str(exc))

    # LAY THE CLIENT SCRATCH DOWN FIRST, exactly as run_batch does before its facts phase.
    #
    # STAGE 1 of this prompt reads client.md, canonical-facts.md, client-answers.md and every file
    # in Resources/, all BY PATH. Without this the session finds an empty or absent directory and
    # does what the prompt cannot stop it doing: writes general questions about an industry, having
    # read nothing about the brand. That failure is silent and looks like a thin site rather than a
    # missing step, which is the worst shape a bug in this module could take.
    #
    # Local import to avoid the cycle: sync renders these answers, so it imports this module.
    from . import sync
    try:
        await asyncio.to_thread(sync.materialize_client, client_slug)
    except LookupError:
        # A brand the record does not know. run_batch skips materialize for exactly this case to
        # keep test brands inert, and the same reasoning holds: build from whatever is on disk.
        log.info("discovery: %s is not in the record, generating from disk as it stands",
                 client_slug)
    except Exception as exc:  # noqa: BLE001
        raise DiscoveryError(
            f"clients/{client_slug} could not be materialized from the record, so the session "
            f"would have read nothing about this brand: {exc}"
        )

    prompt = build_prompt(client_slug)
    path = output_path(client_slug)
    path.parent.mkdir(parents=True, exist_ok=True)
    # A stale file from a previous run would be read back as this run's output if the session died
    # before writing. Clear it first so "no file" means "this session produced nothing".
    path.unlink(missing_ok=True)

    budget = os.environ.get("GEO_MAX_BUDGET_USD")
    options = ClaudeAgentOptions(
        cwd=str(runner.REPO_ROOT),
        setting_sources=["project"],
        permission_mode="acceptEdits",
        # Same set the fact base build gets, and Bash for the same stated reason: the prompt tells
        # the session to run pdftotext over the operator's uploads, and without a shell it would
        # infer their contents from filenames instead of reading them.
        allowed_tools=["mcp__firecrawl", "mcp__dataforseo", "Read", "Write", "Glob", "Bash"],
        mcp_servers=servers,
        max_turns=MAX_TURNS,
        max_budget_usd=float(budget) if budget else None,
        model=os.environ.get("GEO_MODEL") or None,
        env=db.agent_env(),
    )

    text = ""
    try:
        # aclosing, not a bare async for, for the reason facts_gen spells out: query() drives a
        # Node subprocess whose transport close lives in a finally, and on the cancellation path a
        # bare loop leaves that to garbage collection. An orphaned CLI keeps spending the
        # operator's own subscription after they pressed Stop.
        async with aclosing(query(prompt=prompt, options=options)) as session:
            async for message in session:
                found = _final_text(message)
                if found:
                    text = found
    except ClaudeSDKError as exc:
        raise DiscoveryError(f"the discovery session died ({exc})")

    if not path.is_file():
        raise DiscoveryError(
            "the session finished without writing the questions file. Its report was: "
            + (text[:400] or "(no final message)")
        )
    payload = parse_payload(path.read_text(encoding="utf-8"))
    landed = ingest(client_slug, payload)
    # The DB now holds them. Leaving the file would give a later reader a second, drifting copy of
    # something the record owns.
    path.unlink(missing_ok=True)

    return {
        "report": text or "The session returned no final message, so there is no report.",
        "landed": landed,
    }


async def _run_job(client_slug) -> None:
    """Run generation as a tracked background job, so the dashboard can poll it."""
    # Defensive read: start_job seeds the entry before creating this task, but a clear racing the
    # first await would otherwise turn a settled job into a KeyError inside the task, which
    # surfaces nowhere a person looks.
    started = (JOBS.get(client_slug) or {}).get("started", _now())
    try:
        result = await generate(client_slug)
        JOBS[client_slug] = {
            "state": "done", "slug": client_slug, "started": started, "finished": _now(),
            "report": result["report"], "landed": result["landed"], "error": "",
        }
    except asyncio.CancelledError:
        JOBS[client_slug] = {"state": "failed", "slug": client_slug, "started": started,
                             "finished": _now(), "report": "", "landed": 0,
                             "error": "the run was stopped"}
        raise
    except Exception as exc:  # noqa: BLE001 - the operator reads this string
        log.warning("discovery generation failed for %s: %s", client_slug, exc)
        JOBS[client_slug] = {"state": "failed", "slug": client_slug, "started": started,
                             "finished": _now(), "report": "", "landed": 0, "error": str(exc)}


def start_job(client_slug) -> dict:
    """Launch generation in the background and return the job at once.

    The ENGINE owns the work, never the browser, exactly as the roadmap and describe routes do
    it: this is a long SDK session the operator has already paid for, and awaiting it inside a
    request would let a refresh abort the record of a session that runs on regardless.

    The task handle is stored under a leading underscore because `_public_job` strips those, and
    an asyncio task is not serialisable.
    """
    JOBS[client_slug] = {"state": "running", "slug": client_slug, "started": _now(),
                         "finished": None, "report": "", "landed": 0, "error": ""}
    task = asyncio.create_task(_run_job(client_slug))
    JOBS[client_slug]["_task"] = task
    return JOBS[client_slug]
