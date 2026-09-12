#!/usr/bin/env python3
"""Static checks for the discovery question feature. Spawns no session, opens no database.

WHAT THIS GUARDS. Discovery adds a second question form to an app that already has one, and the
two are opposites: the evaluator's form HOLDS A BLOG at any score and is capped at 5, while these
hold nothing and run to 50. Every invariant below exists to keep that difference true in code
rather than only in a comment, because the failure mode is silent: wire a hold to this table and
a brand that ignores an optional form would stop shipping, with nothing in any log to say why.

Offline by construction, like config_check and portal_check: it reads source and SQL text. The
database half is exercised by hand against a live brand; what a CI runner can prove is that the
rules are still written down where the code can obey them.
"""
from __future__ import annotations

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

FAILED: list[str] = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{'' if ok else ': ' + detail}")
    if not ok:
        FAILED.append(name)


def section(title):
    print(f"\n{title}")


# ---------------------------------------------------------------------------
section("[1] The parser survives what a model actually emits")
# ---------------------------------------------------------------------------
from server import discovery  # noqa: E402  (path juggling first)


def code_only(text: str) -> str:
    """Strip docstrings and # comments, so PROSE ABOUT a rule cannot trip the rule.

    Section 2 scans for the names of things discovery must never touch, and that module's own
    docstring explains at length why it must never touch them. Without this, the checks fail on
    their own justification, which is the most annoying false positive there is.
    """
    text = re.sub(r'"{3}(?:.|\n)*?"{3}', "", text)
    text = re.sub(r"'{3}(?:.|\n)*?'{3}", "", text)
    return re.sub(r"#[^\n]*", "", text)

fenced = """```json
{"general":[{"theme":"Pricing","question":"What is the entry price?","why":"So we can state it."}],
 "personalized":[{"theme":"Awards","question":"Which award — and what year?","why":"Named awards are citable."}]}
```"""
parsed = discovery.parse_payload(fenced)
check("a ```json fence is stripped rather than refused",
      parsed["general"][0]["question"] == "What is the entry price?")
check("the American spelling 'personalized' is accepted",
      len(parsed["personalised"]) == 1,
      "half a paid session must not be thrown away over a z")
check("an em dash is repaired, not rejected",
      "—" not in parsed["personalised"][0]["question"]
      and "  " not in parsed["personalised"][0]["question"],
      f"got {parsed['personalised'][0]['question']!r}")

dupes = discovery.parse_payload(
    '{"general":[{"question":"Same question?"},{"question":"same QUESTION?"}],'
    ' "personalised":[{"question":"Same question?"}]}')
check("a question repeated across both sets is asked once",
      len(dupes["general"]) + len(dupes["personalised"]) == 1)

try:
    discovery.parse_payload('{"general":[],"personalised":[]}')
    check("an empty file is refused", False, "it parsed")
except discovery.DiscoveryError:
    check("an empty file is refused", True)

try:
    discovery.parse_payload("not json at all")
    check("unparseable text is refused", False, "it parsed")
except discovery.DiscoveryError:
    check("unparseable text is refused", True)

flood = '{"general":[' + ",".join(
    f'{{"question":"Question number {i}?"}}' for i in range(500)) + '],"personalised":[]}'
check("a session that emits hundreds is capped rather than trusted",
      len(discovery.parse_payload(flood)["general"]) == discovery.MAX_PER_KIND)

long_q = '{"general":[{"question":"' + ("x" * 4000) + '?"}],"personalised":[]}'
check("an overlong question is truncated to the column's width",
      len(discovery.parse_payload(long_q)["general"][0]["question"]) <= discovery.MAX_QUESTION)

# ---------------------------------------------------------------------------
section("[2] Discovery holds nothing, and cannot start to")
# ---------------------------------------------------------------------------
src = (REPO / "server" / "discovery.py").read_text(encoding="utf-8")
code = code_only(src)

# The one invariant that keeps a 50-question form defensible. status.py is how every terminal
# line in this engine is written; a discovery path that reached it could park a brand on
# needs_review for an OPTIONAL form, and the contract's own definition of that status ("questions
# that are current, on disk and answerable") would then be satisfied by a form nothing waits on.
check("discovery.py never writes a status line",
      "status.py" not in code and "status_events" not in code,
      "a hold wired to this table would strand a brand on an optional form")
# The lookbehind matters: this module's OWN output file is discovery-questions.json, and a bare
# substring test matches it and fails on the wrong file entirely.
check("discovery.py never touches the evaluator's question form",
      "review_notes" not in code
      and re.search(r"(?<![-\w])questions\.json", code) is None)
check("no terminal status word is written anywhere in it",
      "needs_review" not in code,
      "these questions are not a verdict about anything")

app_src = (REPO / "server" / "app.py").read_text(encoding="utf-8")
disco_routes = re.findall(r'@app\.(get|post|patch|delete)\("(/api/clients/\{slug\}/discovery[^"]*)"',
                          app_src)
check("every discovery route is brand scoped", all(r[1].startswith("/api/clients/{slug}/discovery")
                                                   for r in disco_routes))

# FastAPI matches in DECLARATION order, so a literal segment registered after a path parameter is
# unreachable: DELETE /discovery/generate would be read as "the question whose id is 'generate'".
paths = [p for _, p in disco_routes]
for literal in ("/api/clients/{slug}/discovery/generate", "/api/clients/{slug}/discovery/send"):
    param = "/api/clients/{slug}/discovery/{question_id}"
    if literal in paths and param in paths:
        check(f"{literal.rsplit('/', 1)[-1]!r} is declared before the {{question_id}} route",
              paths.index(literal) < paths.index(param),
              "FastAPI would match it as a question id")

# ---------------------------------------------------------------------------
section("[3] Draft until sent: the review gate")
# ---------------------------------------------------------------------------
mig = (REPO / "supabase" / "migrations" / "040_client_discovery.sql").read_text(encoding="utf-8")

read_fn = mig.split("function portal_discovery_questions")[1].split("$$;")[0]
check("the client READ filters on sent_at", "sent_at is not null" in read_fn,
      "an unreleased draft would reach the client")
check("the client READ is membership scoped",
      "auth_can_read_client_slug" in read_fn)

write_fn = mig.split("function portal_answer_discovery")[1].split("$$;")[0]
check("the client WRITE filters on sent_at", "q.sent_at is not null" in write_fn,
      "a draft nobody was asked could be answered")
check("the client WRITE is tenancy scoped by client_id",
      "q.client_id = v_cid" in write_fn,
      "a question id from another brand could be written across the boundary")
check("the client WRITE gates on role",
      "om.role in ('admin', 'commenter')" in write_fn)
check("the table has RLS on with authenticated revoked",
      "enable row level security" in mig
      and re.search(r"revoke all on client_discovery_questions from authenticated", mig) is not None)

# The real invariant is that ingest never SETS sent_at. It legitimately NAMES the column, to
# scope its replace to drafts, so "the word is absent" was the wrong shape of test.
# RAW source here, deliberately, not code_only: the statement being inspected LIVES IN a
# triple-quoted string, which is exactly what code_only strips. Stripping it made the regex match
# nothing and the check pass or fail on the wrong evidence.
ingest_body = src.split("def ingest")[1].split("\ndef ")[0]
insert_cols = re.search(r"insert into client_discovery_questions\s*\(([^)]*)\)", ingest_body)
check("ingest lands DRAFTS only",
      insert_cols is not None and "sent_at" not in insert_cols.group(1),
      "ingest must never set sent_at; send() is the operator's review gate")
check("ingest scopes its replace to drafts",
      "sent_at is null" in ingest_body,
      "replacing SENT rows would delete questions a client is part way through answering")

# ---------------------------------------------------------------------------
section("[3b] The job crosses the wire without its asyncio Task")
# ---------------------------------------------------------------------------
# THIS ONE SHIPPED BROKEN AND IS WORTH PINNING. start_job stores the running Task under "_task"
# so the module can cancel it. list_questions returned the job dict RAW, so FastAPI tried to
# encode a Task, raised "vars() argument must have __dict__ attribute", and the whole read 500d.
# The visible symptom was nothing to do with serialisation: the page could not see the generation
# it had just started, still said "No questions yet", and the operator pressed Generate again and
# got a 409 that looked like the real fault.
list_body = src.split("def list_questions")[1].split("\ndef ")[0]
check("list_questions strips private keys off the job",
      'startswith("_")' in list_body,
      "an asyncio Task on the wire 500s the whole read")

# The route-level twin. app.py's _public_job does the same filtering for the dedicated job
# endpoints; both must hold, because either one alone leaves a path that serialises a Task.
job_route = app_src.split("async def api_discovery_job")[1].split("\n@app")[0]
check("the job route returns _public_job, never the raw dict",
      "_public_job(job)" in job_route)

# ---------------------------------------------------------------------------
section("[4] An answered question is frozen")
# ---------------------------------------------------------------------------
# The same rule an approved article follows: the client answered THOSE words, so rewriting the
# question afterwards makes the record assert a pairing that never happened, and deleting it
# discards something a person actually wrote.
for fn in ("delete_question", "update_question"):
    body = src.split(f"def {fn}")[1].split("\ndef ")[0]
    check(f"{fn} refuses an answered question", "answer is null" in body)

# ---------------------------------------------------------------------------
section("[5] The answers reach agents as GUIDANCE, never as a source")
# ---------------------------------------------------------------------------
body = src.split("def answers_markdown")[1].split("\ndef ")[0]
check("the rendered file says an answer is not a citation",
      "NOT a source" in body and "citation" in body,
      "an agent would cite these sentences")
check("the rendered file says silence is not a no",
      "Never read silence as a no" in body)
check("the rendered file ranks answers with canonical-facts.md",
      "canonical-facts.md" in body)

sync_src = (REPO / "server" / "sync.py").read_text(encoding="utf-8")
check("materialize_client always writes client-answers.md",
      'client-answers.md' in sync_src,
      "a prompt naming a file by path must find it, even empty")
check("a failure to render answers cannot take down a run",
      "could not render client answers" in sync_src)

facts_prompt = (REPO / "server" / "prompts" / "canonical-facts-generation.md").read_text(
    encoding="utf-8")
check("the fact base prompt reads client-answers.md",
      "client-answers.md" in facts_prompt)
check("the fact base prompt says an answer is not a source",
      "An answer is NOT a source" in facts_prompt)

disco_prompt = (REPO / "server" / "prompts" / "discovery-questions.md").read_text(encoding="utf-8")
check("the discovery prompt reads what was already answered",
      "client-answers.md" in disco_prompt,
      "re-asking an answered question teaches a client that answering changes nothing")
check("the discovery prompt bans both dashes in what a client will read",
      "No em dashes and no en dashes" in disco_prompt)

# ---------------------------------------------------------------------------

print("\n[7] The prompt points at the sections that actually hold client-answerable gaps")

PROMPT = (REPO / "server" / "prompts" / "discovery-questions.md").read_text()

# THE BUG THIS PINS. Every fact base on record carries TWO such sections: "§7 Known conflicts and
# their resolution", whose UNRESOLVED rows literally say "confirm with the client", and "§9
# UNVERIFIED: claims found but not confirmed". The prompt named §9 alone and never mentioned §7,
# and a real run against blr-brewing missed a recorded address conflict as a direct result. A form
# that skips §7 leaves a caveat every future blog for that brand inherits forever.
check("the prompt sends the agent to the conflicts section, not only the unverified one",
      "§7" in PROMPT and "§9" in PROMPT)
check("it names the UNRESOLVED rows as compulsory rather than optional",
      "UNRESOLVED" in PROMPT and "MUST ask" in PROMPT)
# Section numbers are consistent across every fact base today, but a prompt that trusts a NUMBER
# over a HEADING breaks silently the day one generator emits a different layout.
check("it tells the agent to trust the heading over the number",
      "over the section NUMBERS" in PROMPT or "not to trust these section NUMBERS" in PROMPT.lower()
      or "Do not trust these section NUMBERS" in PROMPT)

# The near-miss failure: asking about a topic when a blog has to cite a number. The prompt carries
# the real example, because the abstract rule alone is what produced the near-miss.
check("the prompt demands the SHAPE of fact a blog can cite, not the subject",
      "50 to 100 guests" in PROMPT and "seated AND standing" in PROMPT)

# Volume. An operator deleting 25 of 38 questions is the wrong person doing the editing.
check("the target set is small enough that the operator is not the editor",
      "12 to 25 questions" in PROMPT and "50 questions" not in PROMPT)
check("the compulsory rows are exempt from the ceiling",
      "however many that is" in PROMPT)

print()
if FAILED:
    print(f"FAILED: {', '.join(FAILED)}")
    sys.exit(1)
print("all discovery checks passed")
