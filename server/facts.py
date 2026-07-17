"""Draft clients/<slug>/canonical-facts.md when a client has none, at generate time.

WHY THIS EXISTS
Preflight refuses a real blog when canonical-facts.md is missing or still carries the token
PLACEHOLDER, and onboarding deliberately does not create the file. So a newly onboarded
client can never generate. This module fills that gap as the FIRST step of a batch.

THE RISK THIS MODULE IS DESIGNED AROUND
A client's own website is MARKETING COPY. "Assured returns", "guaranteed appreciation" and
unsubstantiated superlatives live there. An agent that drafts canonical facts by reading the
site would launder those claims into the very file whose job is to FORBID them, and every
blog for that client would then inherit the laundered version as BINDING truth. So the
prompt below separates two things that look alike and are not: what the site SAYS (recorded
as the client's own claim) and what is VERIFIED (an entity name, a fetched URL, a plainly
stated spec). The do-not-claim section is seeded verbatim from the operator's never-claim.md
and is the operator's to author, never the agent's to soften.

The output is AGENT-DRAFTED and says so in its header. It is not human-approved, and it is
not a substitute for review: it is a reviewable starting point that unblocks the first run.

No concurrency primitive is added here beyond the one lock this module needs. The client
lock and the 5-topic semaphore live in runner.py and nowhere else.
"""
import asyncio
import os
from datetime import datetime, timezone
from pathlib import Path

from . import runner
from . import db

REPO_ROOT = Path(__file__).resolve().parent.parent

# One scrape-and-write session over a handful of pages. Higher than describe.py because this
# reads Resources/ and fetches several URLs; low enough that a looping session stops.
MAX_TURNS = 25

# The token preflight refuses on. A drafted file that contained it would block itself, so the
# draft must never carry it, and this module checks rather than trusts.
PLACEHOLDER_TOKEN = "PLACEHOLDER"

AGENT_DRAFTED_MARKER = "AGENT-DRAFTED, NOT HUMAN-APPROVED"

# The five topics of one batch all call ensure_canonical_facts, and run_batch dispatches them
# at once. Without this lock five callers would each see a missing file and each open a
# session, spending five times the quota to write the same file five times over, with the
# last writer winning at random. The lock makes it exactly one draft; the callers that queue
# behind it re-check the file and return created=False.
_DRAFT_LOCK = asyncio.Lock()


class FactsError(Exception):
    """Drafting failed. A client with no facts must fail loudly, never write blogs against
    nothing, so this propagates to the caller's failure path."""


def facts_path(client_slug, clients_root=None):
    root = Path(clients_root) if clients_root else REPO_ROOT / "clients"
    return root / client_slug / "canonical-facts.md"


def _read(path):
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def is_usable(path):
    """True when the file exists and is not a placeholder shell.

    A file containing PLACEHOLDER is treated as ABSENT, exactly as preflight treats it: it is
    an unreviewed stub that would refuse the run anyway, so drafting over it loses nothing.
    """
    if not path.is_file():
        return False
    text = _read(path)
    if not text.strip():
        return False
    return PLACEHOLDER_TOKEN not in text


def _resource_names(client_slug, clients_root=None):
    root = Path(clients_root) if clients_root else REPO_ROOT / "clients"
    resources = root / client_slug / "Resources"
    if not resources.is_dir():
        return []
    return sorted(path.name for path in resources.iterdir() if path.is_file())


def _client_inputs(client_slug, clients_root=None):
    root = Path(clients_root) if clients_root else REPO_ROOT / "clients"
    config = runner.load_client_config(client_slug, clients_root=root)
    return {
        "slug": client_slug,
        "name": config.get("name") or client_slug,
        "domain": config.get("domain") or "",
        "industry": config.get("industry") or "",
        "description": _read(root / client_slug / "description.md").strip(),
        "never_claim": _read(root / client_slug / "never-claim.md").strip(),
        "resources": _resource_names(client_slug, clients_root=root),
    }


def build_prompt(inputs, target_path):
    """The drafting prompt. Kept a pure function of its inputs so tests can assert the
    guardrails are present without spawning a session: a future edit that drops the
    never-claim seeding rule or the marketing-copy rule fails tests/facts_check.py."""
    never_claim = inputs["never_claim"] or "(the operator recorded no rules)"
    resources = "\n".join(f"- clients/{inputs['slug']}/Resources/{name}"
                          for name in inputs["resources"]) or "- (no resource files)"
    description = inputs["description"] or "(no description recorded)"
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")

    return f"""Draft the canonical facts file for one client. Write it to {target_path} and
nothing else.

Client name: {inputs['name']}
Client slug: {inputs['slug']}
Domain: {inputs['domain'] or '(no domain recorded)'}
Industry: {inputs['industry'] or '(not recorded)'}

Operator-owned description (context, never a citable source):
{description}

Operator-owned never-claim rules, VERBATIM:
{never_claim}

Resource files you may read:
{resources}

WHAT THIS FILE IS. canonical-facts.md is BINDING. Every blog for this client inherits it as
the source of truth for facts, verified URLs, and forbidden claims. A wrong line here becomes
a wrong line in every blog, so an unknown recorded as unknown is worth more than a guess that
reads well.

READ THIS BEFORE YOU FETCH ANYTHING. The client's own website is MARKETING COPY. It is where
"assured returns", "guaranteed appreciation", and unsubstantiated superlatives live. This
file's job is to CONSTRAIN that copy, not to repeat it.
NEVER copy a claim from the client's own marketing INTO the facts as if it were verified.
If the site says it, record it under a heading naming it the client's own claim, phrased as
"the client's own claim", never as fact.
The site is authoritative for entity names, URLs, and plainly stated specifications, and it is
authoritative for nothing else.

STEPS
1. Read clients/{inputs['slug']}/client.md and every listed resource file, for FACTS ONLY:
   entity names, verified URLs, plainly stated specifications.
2. firecrawl_map the client's real domain to find exact slugs, then firecrawl_scrape each page
   you intend to record, with formats: ['markdown'], onlyMainContent: true, waitFor: 6000.
   Every URL you record must have been FETCHED and returned 200. Never guess a slug, and never
   write a URL you did not fetch.
3. Write the file with these sections:
   - A header, exactly as specified below.
   - Entities: the permitted names for this client and what each one is.
   - Verified URLs: each URL you fetched, with what the page is and the fetch date.
   - Established facts: only plainly stated specifications, each with where it came from.
   - The client's own claims: anything the site asserts that no independent source confirms,
     each labelled the client's own claim.
   - Unknowns: what you could not establish. State uncertainty explicitly rather than
     inventing. An unknown is written as unknown.
   - Do not claim: the section specified below.

THE DO NOT CLAIM SECTION. Seed it VERBATIM with the operator's never-claim rules copied
exactly as written above, under a line naming them the operator's rules. Those lines are the
OPERATOR'S, not yours. You may never remove, reword, soften, narrow, or merge a line the
operator wrote. You MAY add house rules below them, in their own subsection:
- No returns, yield, ROI, appreciation, or "guaranteed" or "assured" language anywhere.
- No unsubstantiated superlatives: best, first, only, number one, leading.
- No possession, handover, or completion dates.
- Frame every client projection as the client's own guidance, never as independent fact.

THE HEADER. The file must start with exactly this, filling in nothing else:

# canonical-facts.md: {inputs['name']}

> {AGENT_DRAFTED_MARKER}. Drafted by an agent at {stamp} UTC by fetching
> {inputs['domain'] or 'the client domain'} and reading clients/{inputs['slug']}/Resources/.
> No human has reviewed it. Check the "The client's own claims" section FIRST: those lines
> came from the client's own marketing copy and none of them is verified.

HARD RULES
- Never write the token {PLACEHOLDER_TOKEN} anywhere in the file. Preflight refuses on that
  token, and a drafted file that blocks itself is useless.
- Never state a name, price, spec, approval, or URL from memory. You have no knowledge of this
  client beyond what you just fetched and read.
- Use no em dashes and no en dashes. Use commas or colons.
- Write the file with the Write tool, then reply with one line naming what you wrote.
"""


def _demo_facts(inputs):
    """A demo client is ALWAYS mock and must never spend an API call, so this file is
    assembled locally: no session, no fetch, no token. It says what it is."""
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return f"""# canonical-facts.md: {inputs['name']}

> Demo content. Generated without research or API calls. Not for publication.
> Written locally at {stamp} UTC for the demo client {inputs['slug']}, which is always mock.
> Nothing here was fetched and nothing here is a fact about a real brand.

## Entities
{inputs['name']}, the demo client. There is no real brand behind this slug.

## Verified URLs
None. This file was written without a single fetch, so there is no URL to record.

## Established facts
None. A real client's file lists only plainly stated specifications, each with its source.

## The client's own claims
None. A real client's file records the site's marketing assertions here, labelled as the
client's own claim and never as fact.

## Unknowns
Everything. This is a demo client, so there is nothing to establish.

## Do not claim
Operator rules:
{inputs['never_claim'] or '(the operator recorded no rules)'}

House rules:
- No returns, yield, ROI, appreciation, or guaranteed or assured language.
- No unsubstantiated superlatives: best, first, only, number one, leading.
- No possession, handover, or completion dates.
- Frame every client projection as the client's own guidance, never as independent fact.
"""


async def _run_session(prompt, options):
    """The only place query() is called. A separate function so tests can monkeypatch the
    session seam and prove the demo path never reaches it."""
    from claude_agent_sdk import query

    async for _message in query(prompt=prompt, options=options):
        # Consume and discard: the artifact is the file on disk, not the transcript.
        pass


async def _draft_facts(inputs, path):
    """ONE SDK session that fetches the live site and writes the file."""
    ok, reason = runner.check_real_mode_ready()
    if not ok:
        # An agent with no fetch tool invents a plausible fact base rather than failing, and
        # this file is BINDING. Refuse instead.
        raise FactsError(
            f"cannot draft canonical-facts.md for {inputs['slug']}: {reason}"
        )
    if not inputs["domain"]:
        raise FactsError(
            f"cannot draft canonical-facts.md for {inputs['slug']}: the client has no domain "
            f"recorded, so there is no site to establish facts from"
        )

    try:
        from claude_agent_sdk import ClaudeAgentOptions
    except ImportError as exc:
        raise FactsError(f"the Claude Agent SDK is unavailable ({exc})")

    options = ClaudeAgentOptions(
        # Resolved from the repo, never os.getcwd(): the server may be started from anywhere
        # and CLAUDE.md must still load.
        cwd=str(runner.REPO_ROOT),
        setting_sources=["project"],
        permission_mode="acceptEdits",
        allowed_tools=["Read", "Write", "Glob", "Grep", "mcp__firecrawl"],
        mcp_servers=runner._resolve_mcp_servers(),
        max_turns=MAX_TURNS,
        model=os.environ.get("GEO_MODEL") or None,
        # Allowlisted, exactly as runner.py does it. See db.agent_env.
        env=db.agent_env(),
    )

    try:
        await _run_session(build_prompt(inputs, path), options)
    except FactsError:
        raise
    except Exception as exc:
        raise FactsError(
            f"the canonical-facts session for {inputs['slug']} died: {type(exc).__name__}: {exc}"
        )

    if not path.is_file():
        raise FactsError(
            f"the canonical-facts session for {inputs['slug']} wrote no file at {path}"
        )
    text = _read(path)
    if PLACEHOLDER_TOKEN in text:
        # Preflight refuses on this token, so a draft carrying it would block every blog for
        # this client. Fail here where the reason is legible.
        raise FactsError(
            f"the drafted canonical-facts.md for {inputs['slug']} contains the token "
            f"{PLACEHOLDER_TOKEN}, which preflight refuses on"
        )
    if AGENT_DRAFTED_MARKER not in text:
        raise FactsError(
            f"the drafted canonical-facts.md for {inputs['slug']} is missing its "
            f"{AGENT_DRAFTED_MARKER} header, so a reviewer could mistake it for approved"
        )


async def ensure_canonical_facts(client_slug, clients_root=None):
    """Make sure clients/<slug>/canonical-facts.md exists and is not a placeholder.

    Returns {"path": str, "created": bool, "reason": str}. Raises FactsError when a real
    client has no facts and none could be drafted: that client must fail loudly rather than
    write blogs against nothing.
    """
    path = facts_path(client_slug, clients_root)

    # NEVER overwrite a human-approved file. Vacation Village's is 16 KB of hard-won rules,
    # written by a human precisely because the site's own copy could not be trusted, and
    # replacing it with an agent's read of that same copy is the worst outcome this feature
    # has. So an existing, non-placeholder file wins over everything below, always.
    if is_usable(path):
        return {"path": str(path), "created": False,
                "reason": "canonical-facts.md already exists and is not a placeholder"}

    async with _DRAFT_LOCK:
        # Re-check inside the lock. The other four topics of a batch queue here while the
        # first one drafts, and they must find the finished file rather than draft it again.
        if is_usable(path):
            return {"path": str(path), "created": False,
                    "reason": "canonical-facts.md was drafted by a concurrent caller"}

        inputs = _client_inputs(client_slug, clients_root)

        # A demo client is ALWAYS mock and can never spend an API call or a token, so it gets
        # an honest local file with no session at all.
        if runner.is_demo_client(client_slug, clients_root=clients_root):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(_demo_facts(inputs), encoding="utf-8")
            return {"path": str(path), "created": True,
                    "reason": "demo client: local demo facts file written with no session"}

        path.parent.mkdir(parents=True, exist_ok=True)
        await _draft_facts(inputs, path)
        return {"path": str(path), "created": True,
                "reason": "agent-drafted canonical-facts.md from the live domain and "
                          "Resources/, not human-approved"}
