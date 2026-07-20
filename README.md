# geo-factory

A multi-client GEO blog factory wrapping the Claude Agent SDK. An operator opens the web
UI, picks a client, loads that client's roadmap CSV, ticks the rows they want, and hits
generate. The backend runs up to five blogs at a time; each one is researched, written,
mechanically gated, link-verified, and scored by a hostile evaluator until it hits 95.
Output is plain local .md files under `outputs/<slug>/`, which the app previews in
the browser. Six non-technical people share one deployment; the UI is a single HTML file
served by the same process at `/`.

The engine is brand-agnostic. `CLAUDE.md` in this repo is the engine contract (HOW a blog
is made); everything about WHO it is for lives under `clients/<slug>/`.

## Quickstart

```
cd geo-factory
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

You also need the **Claude Code CLI and Node** on the machine. The Python
`claude-agent-sdk` does not talk to the API directly: it spawns the `claude` CLI as a Node
subprocess, so any container image needs Node plus the CLI on PATH. The runner passes its
whole environment through to that subprocess for exactly this reason (PATH, auth vars, and
the MCP credentials `.mcp.json` interpolates must all survive).

### Billing warning: the CLI may spend a personal subscription

Because the SDK spawns the `claude` CLI, **whatever that CLI authenticates with is what
pays for a real run.** If the CLI on the machine is logged into a Claude subscription
rather than reading `ANTHROPIC_API_KEY`, every real blog consumes that person's
subscription quota, and runs start failing when it is exhausted. A shared deployment
should set `ANTHROPIC_API_KEY` so usage is billed to the org's API account and not to
whoever happened to log the CLI in. Mock mode and the `demo` client spend nothing either
way.

Start in mock mode first. It needs no API key and no MCP servers:

```
GEO_MOCK=1 .venv/bin/uvicorn server.app:app
```

Open http://127.0.0.1:8000, pick `demo`, tick rows, generate, and watch the live stages.
Everything it writes leads with "Demo content. Generated without research or API calls. Not
for publication."

Real mode needs these environment variables (names are exactly what `server/runner.py`
reads):

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | strongly recommended | Consumed by the `claude` CLI subprocess the SDK spawns. Without it the CLI falls back to its own login; see the billing warning above. |
| `GEO_MOCK` | no | `1` switches the whole server to mock mode. Env only; a request can never choose it. |
| `GEO_MODEL`, `GEO_MAX_TURNS`, `GEO_MAX_BUDGET_USD`, `GEO_RETRIES` | no | Model override, turn cap (default 250), per-session budget cap, died-session retries (default 1). |

Plus the MCP credentials for one of the two transports below.

### MCP transports: stdio (default) or HTTP

Firecrawl and DataForSEO reach the agents over MCP, and `runner._resolve_mcp_servers()`
picks the transport at dispatch:

1. **stdio, via `.mcp.json` (the default).** The repo ships a project-scoped `.mcp.json`
   declaring both servers as stdio commands (`npx -y firecrawl-mcp` and
   `npx -y dataforseo-mcp-server@latest`), so it needs `npx` on PATH. The runner passes
   `mcp_servers={}` and lets the CLI load that file, which works because the session sets
   `setting_sources=["project"]` and leaves `strict_mcp_config` at its default of `False`
   (setting it `True` would suppress the file). Credentials come from the environment:

   | Variable | Server |
   |---|---|
   | `FIRECRAWL_API_KEY` | firecrawl |
   | `DATAFORSEO_USERNAME` | dataforseo |
   | `DATAFORSEO_PASSWORD` | dataforseo |

   **`.mcp.json` holds no secrets.** Every credential in it is written as `${VAR_NAME}`
   interpolation, which the Claude Code CLI expands from the environment at spawn time.
   Never paste a literal key into it; `tests/config_check.py` greps the repo and fails if
   one appears.

2. **HTTP, via URL env vars.** Setting these takes precedence over `.mcp.json`:

   | Variable | Required | What it does |
   |---|---|---|
   | `FIRECRAWL_MCP_URL` | to select this transport | HTTP MCP endpoint for Firecrawl. |
   | `FIRECRAWL_MCP_AUTH` | if the server needs it | Sent verbatim as the `Authorization` header, so include the scheme (for example `Bearer ...`). |
   | `DATAFORSEO_MCP_URL` | with the above | HTTP MCP endpoint for DataForSEO. |
   | `DATAFORSEO_MCP_AUTH` | if the server needs it | Sent verbatim as the `Authorization` header. |

   Setting one URL without the other is a loud `RunnerConfigError`, not a half-configured
   session.

With neither transport available, a real run raises `RunnerConfigError` at dispatch naming
both options. That failure is deliberately loud: a session missing Firecrawl would not
notice and stop, it would invent sources. `runner.check_real_mode_ready()` reports the same
thing without spawning anything, so the API can refuse at submit time.

For debugging a single row without the web UI:

```
.venv/bin/python -m server.runner --client demo --row 0 --mock
```

Static config checks, which spawn no CLI and generate no blog:

```
.venv/bin/python tests/config_check.py
```

## RUN EXACTLY ONE UVICORN WORKER

**Never pass `--workers N` with N above 1.** The client lock (one client's queue at a
time) and the 5-topic semaphore are plain `asyncio` in-process primitives at the top of
`server/runner.py`. With N workers you get N independent copies of both, the concurrency
cap silently becomes 5N, and nothing in the logs tells you. The same applies to the
in-memory run registry that backs `/api/runs` and the SSE endpoint: a second worker holds
a second, disjoint registry. The app logs a warning about this at startup; the warning
cannot detect the misconfiguration, it can only remind you.

This is single-process by design. Scaling out is listed under "Not built yet" because it
would require moving both primitives and the registry out of process, and nothing here
does that.

## Blog states

Every blog is in exactly one state, and one function decides which:
`dashboard/src/lib/blog-state.ts`. The admin and the client are looking at the same article at
the same moment, so they see the same state through two vocabularies rather than two state
machines that could disagree. `dashboard/tests/blog-state.test.ts` is the specification,
executable: `cd dashboard && node --test tests/blog-state.test.ts`.

| State | Admin tag | Admin can | Client tag | Client can |
|---|---|---|---|---|
| `generating` | Generating | nothing | In progress | nothing |
| `has_questions` | Has questions | answer | Waiting on you | answer |
| `internal_review` | Internal review | edit, comment, send | not visible | nothing |
| `client_review` | With client | nothing | Ready to review | approve, suggest, reply |
| `changes_requested` | Changes requested | edit, comment, send again | With our team | reply |
| `approved` | Approved | **post to CMS only** | Approved | reply |
| `published` | Published | post again | Published | nothing |
| `failed` / `stopped` | Failed / Stopped | nothing | not visible | nothing |

Three things in that table are load-bearing:

**`needs_review` IS `has_questions`.** The engine contract defines it as exactly "this blog has
questions that are current, on disk and answerable", and `runner._enforce_terminal_status`
corrects a claimed `needs_review` with no live form back to `done` or `failed`. So the status
itself is the question signal, and nothing needs a second read to know an answer is owed.

**The admin has NO actions during `client_review`.** The client is reading the exact bytes
pinned by `sent_version_id`. An edit there changes the article underneath someone mid-review.

**`approved` is LOCKED, for everyone.** The approval stamp records that the client accepted
THOSE bytes, so an edit after it makes the record assert something the client never did.
Migration 013 enforces this with two triggers rather than a check in each writer, because the
five write paths into an article share no chokepoint and two of them are in Python. Replies are
exempt: they carry `parent_id`, change no bytes, and refusing them only buys silence.

There is no un-approve. A client who approves by mistake cannot be walked back from inside the
app, and neither can the team.

## Engine vs client

`CLAUDE.md` says HOW. `clients/<slug>/` says WHO. Onboarding a client is four files, never
a forked engine: two a human must read and approve (`client.md` and `canonical-facts.md`),
plus `gates.json` and `roadmap.csv`.

```
geo-factory/
  CLAUDE.md                 engine contract: pipeline, sourcing, structure; zero client facts
  .mcp.json                 project-scoped stdio MCP servers; ${VAR} interpolation, no secrets
  requirements.txt
  .claude/
    gates.py                mechanical gates: house rules merged with the client's gates.json
    status.py               the append helper; agents never hand-write status.jsonl lines
    skills/                 geo-research, geo-content-writer, geo-content-eval
  server/
    runner.py               dispatch, concurrency, retry; the ONLY place concurrency lives
    app.py                  FastAPI glue: submit-time validation, SSE tailer, output reader
    roadmap.py              CSV loading; headers detected by regex shape, operator can override
  web/
    index.html              the entire UI, one file, served at /
  tests/
    concurrency-proof.md    mock-mode evidence for the concurrency claims
    concurrency_check.py    the analysis script behind that proof
    config_check.py         static checks: MCP transport, SDK options, no secrets, demo is mock
    clean-draft.md, dirty-draft.md, frontend-check.py
  clients/
    demo/                   the demo org: always mock, precoded blogs, zero API calls
    vacation-village/
    <slug>/
      client.md             domain, market, industry reference (human approved)
      canonical-facts.md    binding facts, verified URLs, do-not-claim list (human approved)
      gates.json            word band, banned phrases, entity names, claim patterns, demo_mode
      roadmap.csv           read-only topic queue; the app never writes it back
      generated.csv         append-only ledger of shipped blogs; created at onboarding
      uploads/              archived roadmap uploads, kept verbatim, never mutated
  outputs/                  blog output, at the repo root and NOT under clients/, so
                            operators browse and prune it in one place in Finder
    <slug>/<topic-slug>/    blog.md, eval.md, dossier.md, status.jsonl, links-verified.txt
```

**Preflight.** A client whose `canonical-facts.md` is missing or still contains the
literal token `PLACEHOLDER` refuses to run: the API returns 409 at submit time and
`runner.run_topic` raises before any SDK session spawns. Every blog inherits that file, so
an unreviewed one would silently poison the whole queue. Mock mode skips preflight, and so
does a `demo_mode` client, because neither reads the facts file at all.

**`generated.csv`** is an append-only ledger under each client, created at onboarding so no
client needs a migration step. It records **only blogs that shipped**, appended per topic as
that topic finishes (`run_batch`'s `on_topic_done` hook fires per topic, never at a barrier
at the end of the batch). It is a different artifact from the operator's roadmap and never
edits it.

**Uploads are archived, never mutated.** Every roadmap CSV an operator uploads is kept
verbatim under `clients/<slug>/uploads/`. The engine reads it and writes nothing back to it,
so the operator's file stays exactly the file they sent.

`roadmap.csv` columns are **positional**: column 1 is the topic, column 2 is what the piece
covers, column 5 is the target prompts. **Everything else is ignored**, including intent and
volume: it is not stored, not passed to any agent, and never reaches a model's context. The
first row is always treated as a header and skipped. There is no header detection and no
column override, because operator sheets are positionally stable and matching on header text
only invents ways to map the wrong column.

## The demo org

`clients/demo/` is the demo client, and it is **never a real client**. Its `gates.json`
carries one extra flag:

```json
{"demo_mode": true}
```

That single flag is the whole definition. `runner.is_demo_client()` reads it and
`runner.should_mock()` makes the topic mock, so:

- **The demo org is always mock, in every environment**, including a production deployment
  holding real credentials. It cannot spend an API call or a token, with or without
  `GEO_MOCK`, with or without `--mock`.
- Its blogs are **precoded**: deterministic from `md5(topic_slug)` and templated from the
  uploaded topic, covers text, and target prompts, so any CSV an operator uploads demos
  correctly. There is no fixed topic list.
- They are **saved to `clients/demo/output/<topic-slug>/blog.md` exactly like a real blog**,
  so the preview drawer, the status table, and the ledger all behave identically.
- Every demo artifact leads with the marker **"Demo content. Generated without research or
  API calls. Not for publication."** and its Sources section says plainly that it has none.
  A demo blog is realistic in shape but can never be mistaken for a researched one.
- `GET /api/clients` reports `"demo_mode": true` for it, so the UI labels it and an operator
  always knows which client is the demo.

Onboarding any other client is the normal, real procedure: the four files above, a
human-approved `canonical-facts.md` that passes preflight, and the full pipeline (research,
write, gates, links, eval). No client without `demo_mode` is affected by any of this.

## The pipeline per blog

One blog gets one SDK session, never one session per batch. Inside it a session lead
dispatches three subagents in sequence and never writes a word itself:

1. **Agent R (researcher)** reads the client files and produces the frozen dossier.
2. **Agent W (writer)** drafts from the dossier only, then loops
   `python3 .claude/gates.py` until it exits 0, then runs the link pass (Firecrawl-fetch
   every link not already in `links-verified.txt`, confirm the source carries the claim).
   Gates and links both finish BEFORE the eval.
3. **Agent E (evaluator)** is a hostile auditor seeing only `blog.md`, the rubric, and
   `canonical-facts.md`. It writes `eval.md` with `SCORE: NN` on its own line.

The lead branches on the numeric SCORE plus exactly one property of the operator's question
form. Below 95 it dispatches a fresh writer with only the dossier, the current draft, and the
fix list. **THREE conditions stop the loop, not two:** the 4-iteration cap, two consecutive
no-gain iterations, and a live Sourcing question on the form, which ends it at the iteration
it is filed. Sourcing is the one area no rewrite can close, since the writer has no authority
to invent a citation, so iterating past a Sourcing question spends budget rediscovering what
the evaluator already knew was terminal. A Sourcing FIX-LIST ITEM is a different artifact and
does NOT stop the loop: it routes to a bounded researcher top-up, because a machine can find a
source where only a person holds a fact.

**The first score at or above 95 is final and terminal WHEN NO CURRENT QUESTIONS ARE ON DISK.**
The evaluator is stateless and its score varies by several points on an identical draft, so a
confirmatory re-eval adds no rigor and can strand a passing blog. **Open questions hold a blog
at ANY score, and answering is a demand, never an offer:** a 96 with a live question is held,
not shipped, and the single answer-driven revise is the one licensed re-eval. Because gates and
the link pass run before the eval, the scored artifact IS the shipped artifact; the only thing
that touches the draft after the eval is an operator answer arriving.

Progress travels exclusively through `status.jsonl` in each topic's output dir. Each agent
appends its own lines via `.claude/status.py`; the lead appends only the terminal line
(`done`, `needs_review`, or `failed`). Line shape, exactly:

```
{"ts":iso8601,"slug":str,"stage":"research|write|gates|links|eval|revise","event":"start|end",
 "iter":int,"score":int|null,"status":"running|done|needs_review|failed","note":str}
```

If a session dies without a terminal line, the runner retries with a fresh session
(`GEO_RETRIES`, default 1), noting the retry in status.jsonl; when retries are spent it
writes the `failed` terminal line itself. The server tails these files and streams them to
the browser over SSE at `/api/runs/{run_id}/events`.

## Mock mode

`GEO_MOCK=1` fakes the agents, never the plumbing. No API key, no MCP servers, no SDK
sessions, but every status line is appended by running `.claude/status.py` as a real
subprocess, the SSE tailer reads real files, and the semaphore and client lock govern
dispatch exactly as in production. Each slug gets a deterministic plan derived from
`md5(topic_slug)`: about a third pass on iteration 1, most by 2 or 3, and a narrow band
hits the 4-iteration cap and terminates `needs_review`, so the amber path is testable.

This is the same path the `demo` client always takes. Mock mode is chosen when `GEO_MOCK=1`,
or `--mock` is passed, or the client sets `demo_mode` in its `gates.json`.

See `tests/concurrency-proof.md` for the recorded evidence: 7 topics against the cap of 5
measured max concurrency of exactly 5, and topic 6 started 60 ms after the first slot
freed, 3.3 seconds before the slowest first-wave topic finished, disproving any
batch-of-five barrier.

## Gates

Run by hand any time:

```
python3 .claude/gates.py --client <slug> outputs/<slug>/<topic-slug>/blog.md
```

HOUSE rules are hardcoded in `gates.py` and apply to every client: zero em or en dashes,
banned filler phrases, no hedging, no sentences opening with "And" or "But", paragraph
shape, active voice, entity clarity, and the default word band (1200 to 2000 target, hard
FAIL above 2500 or below 1200). CLIENT rules merge in from `clients/<slug>/gates.json`:
word band override, extra banned phrases, the client's entity names, passive whitelist,
and forbidden claim patterns. Quoted spans are exempt from the voice, entity, and
superlative gates (some clients require verbatim wording) but never from forbidden claim
patterns.

Exit codes are three-valued so the runner can tell a bad draft from a bad setup:

- `0` no FAILs (WARNs pass and ship this stage)
- `1` at least one gate FAILED, the draft is not clean
- `2` the run could not happen: missing or malformed `gates.json`, an uncompilable client
  regex, bad arguments, or an unreadable blog file

## Posting a blog to the Strategi CMS

An operator opens a finished blog in the Blogs library and presses **Post to CMS** in the
preview drawer. The blog is sent to `client.strategi.is` as a **draft** for a human to review.
It is never published and it never reaches the client: an editor approves it in the CMS.

Everything for this lives in `server/cms/` and hangs off that one button. No part of the
generation pipeline imports it, and deleting the directory plus the two `include_router`
lines in `app.py` removes the feature whole.

### Only finished blogs go

The engine refuses to post anything whose terminal status is not exactly `done`, and answers
409 with the state it found. A `needs_review` blog is never pushed. That refusal is in
`server/cms/gate.py` and it is the real guard: a CMS draft is directly approvable by an
editor, so the CMS cannot tell a vetted piece from an unvetted one. The button greying itself
out is a courtesy on top. Demo clients are refused outright, because a demo blog is templated
placeholder text and its "not for publication" marker is prose no CMS can read.

### The write key

One key per client org, read from the environment, server-side only. Never in `gates.json`:
that file is operator-visible and checked in, and a write credential in it is a credential in
the repo.

```
export STRATEGI_CMS_WRITE_KEY_BLR_BREWING=...        # one var per org, org slug uppercased
export STRATEGI_CMS_WRITE_KEY_VACATION_VILLAGE=...
export STRATEGI_CMS_URL=...                          # optional, to point at a staging CMS
```

The endpoint defaults to `https://client.strategi.is/api/v1/ingest` and needs no config. If
you override it, give the **full endpoint including `/api/v1/ingest`**, never a bare host:
the value is POSTed to verbatim, and `https://client.strategi.is` on its own 307s to
`/login`, so a host-only value would push a blog at the login page and never tell you.

```
```

**There is no shared fallback key, deliberately.** The CMS decides which org a draft belongs
to *from the key*, and the payload is forbidden from carrying `org_id`, so the key is the only
thing routing a draft anywhere. A single shared variable would answer for every org: set it to
BLR Brewing's key, press Post on a Vacation Village blog, and Vacation Village's content lands
in BLR Brewing's CMS. Nothing in the request names the intended org, so neither side can catch
it and the leak is silent. An org gets its own key or it gets a 503.

With no key set for an org, the endpoint answers 503 naming the exact variable it wanted. That
is a setup problem, not a CMS failure, and it says so.

A key is a per-org secret: a key pasted into a chat, a ticket, or a commit should be rotated
rather than reused.

### What lands in the CMS

The draft exactly as the evaluator scored it. `blog.md` is read off disk and sent byte for
byte minus its H1, which becomes the `title`. There is no second model pass: the transform in
`server/cms/payload.py` is pure and deterministic, so the blog that passed the eval is the
blog an editor opens. The TL;DR becomes the excerpt, the "Sources and References" section
becomes the citations array, and the ledger's target prompts become `target_queries`.

The byline, SEO fields, category and tag are built at push time and are **derived from the
draft, never written fresh**. None of them is stored in `blog.md`; the artifact on disk is
untouched by any of this.

| Field | Where it comes from |
|---|---|
| `author_name` | `payload.AUTHOR_NAME`, currently **Prasanna Kumar** |
| `meta_title` | The H1, cut at its colon seam or truncated to ~60 chars on a word boundary |
| `meta_description` | The TL;DR, whole sentences only, targeting ~155 chars |
| `category_name` | The client's industry, through a **closed map** (`INDUSTRY_CATEGORIES`) |
| `tags` | One tag: the brand's display name |
| `meta_*` for a draft with no TL;DR | Omitted. No guess. |

**Why none of these is a model call**, which is the obvious "improvement" and is wrong: a meta
description is published, client-facing copy. Every other client-facing word this engine ships
passed `gates.py` (no superlatives, no banned phrases) and a hostile evaluator against
`canonical-facts.md` (no ROI language, no unapproved claims). *Nothing downstream of the
evaluator inspects a payload field.* So a model writing that field at push time is the one path
in this factory that puts unvetted prose in front of a client: "Bangalore's best microbrewery",
or a yield claim on a real-estate blog, would reach the CMS with no gate having seen it.
Deriving from the H1 and TL;DR inherits all of that vetting, because those already passed it.

Model-written **tags** fail for a second reason on top: get-or-create with no read endpoint
means a model emitting "Microbreweries" one run and "Microbrewery" the next creates two
permanent tags nobody chose.

**Per-piece topic tags are deliberately not sent.** No honest source exists: the industry
describes the client rather than the piece, the roadmap's `Format` ("Hub listicle") is internal
jargon and does not survive to push time anyway, and `entity_names` holds legal entities like
"ALPL 3 LLP" that have no business becoming public tags. The brand tag is sent because it is
true by construction and earns its keep in a multi-brand org: Acme Group holds `acme-north` and
`acme-south`, so one CMS receives both brands' drafts and the tag is what separates them.

Two CMS behaviours shape all of the above, and neither is in the ingest spec:

- **`author_name` is match-only and fails silently.** A name matching no author in the org is
  not an error: the CMS quietly uses the org's default author. A typo in `AUTHOR_NAME`
  therefore fails invisibly. If a draft lands under the wrong byline, fix the constant.
- **`category_name` and `tags` are get-or-create, with no read endpoint.** An unrecognised
  value is CREATED in the client's CMS and nothing can list what already exists. Both are
  emitted from closed vocabularies for exactly that reason: a naive `.title()` on an industry
  slug would permanently create "Technology Saas" in a real client's taxonomy.

Posting is idempotent. `source_run_id` is `uuid5(NAMESPACE, "<client_slug>/<topic_slug>")`, so
re-posting a blog updates its existing draft instead of making a second one. The brand prefix
is deliberate: two brands in one org sharing a topic slug would otherwise derive the same id
and overwrite each other. **Never change `payload.NAMESPACE`.** Every id shifts if it moves,
orphaning every draft a reviewer is already holding; `tests/cms_check.py` pins the value.

If an editor has already moved a post past draft, the CMS keeps their version and reports
`skipped`. That is a success, not something to retry.

```
.venv/bin/python tests/cms_check.py     # offline, sends nothing over the network
```

## Not built yet

Honest list, verified against the code as of 2026-07-16:

- **No auth.** No login, no tokens, no user identity anywhere in `app.py`. Six trusted
  operators behind whatever network boundary you put in front of it. There is no CORS
  middleware on purpose (same-origin UI), but that is not authentication.
- **No persistence of the run registry.** `runner.RUNS` is an in-memory dict. The
  status.jsonl files survive a restart; the run list and its SSE endpoints do not, so
  `/api/runs/{id}/events` 404s for runs started before the restart even though every line
  they wrote is still on disk.
- **No retry UI.** Died-session retries are automatic (`GEO_RETRIES`) and visible only as
  note lines in status.jsonl. There is no button to retry a failed or needs_review topic;
  you resubmit the row.
- **No run cancellation.** Once a batch is accepted there is no endpoint to stop it.
- **No CSV write-back, BY DESIGN.** The roadmap is read-only input; progress and terminal
  status live in the output dirs, never in the CSV.
- **No multi-worker or multi-host scaling, BY DESIGN.** See the single-worker warning.
- **Real-mode run not validated end to end yet** at the time of writing. Mock mode has
  been, with recorded evidence in `tests/concurrency-proof.md`, and the demo client's
  always-mock path has been. The real path (SDK sessions, live MCP servers, live Firecrawl
  and DataForSEO) is written, preflighted, and statically checked by
  `tests/config_check.py`, but no real blog has been generated. `config_check.py` verifies
  the transport resolves, the options the SDK gets are the intended ones, and every field
  name still exists on the installed SDK; it cannot verify the credentials work.
- **One-client-at-a-time is asserted, not proven over HTTP.** `CLIENT_LOCK` wraps the
  whole batch in `runner.run_batch`, so interleaving is structurally impossible in one
  process, but the proof file records that a two-client HTTP run was out of scope.
- **The output endpoint serves exactly five filenames** (`blog.md`, `eval.md`,
  `dossier.md`, `status.jsonl`, `links-verified.txt`). Anything else, including the
  `NEEDS_REVIEW` marker file, is a 404; the marker's information reaches the UI through
  the terminal status instead.
