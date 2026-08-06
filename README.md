# geo-factory

A multi-client GEO blog factory wrapping the Claude Agent SDK. An operator opens the web
UI, picks a client, loads that client's roadmap CSV, ticks the rows they want, and hits
generate. The backend runs two blogs at a time by default (`GEO_CONCURRENCY`); each one is
researched, written, mechanically gated, link-verified, and scored by a hostile evaluator
until it hits the bar of 90, which is the only bar: at or above 90 it ships, below 90 it does
not.
Output is plain local .md files under `outputs/<slug>/`, which the app previews in
the browser. Six non-technical people share one deployment; the UI is a single HTML file
served by the same process at `/`.

The engine is brand-agnostic. `CLAUDE.md` in this repo is the engine contract (HOW a blog
is made); everything about WHO it is for lives under `clients/<slug>/`.

---

## Just want to RUN Canon? Read [SETUP.md](SETUP.md)

If you are here to use the app rather than work on it, **[SETUP.md](SETUP.md) is the whole
guide** and this file is not for you. The short version, run once in a terminal:

```bash
brew install gh                                  # skip if you have it
gh auth login                                    # a browser window, one time
gh repo clone Strategi-GEO/Canon ~/strategi-canon
cd ~/strategi-canon && ./install.sh
```

`install.sh` downloads Canon's own copies of Node and Python, asks for the three database
values your admin sends you, and writes a double-clickable starter. Run it again any time to
update. After that you never need the terminal again: you start Canon by double-clicking it,
and a colored dot in the menu bar tells you whether it is running.

You also need the **Claude Code CLI, logged in with your own account**, because that is what
pays for generation. See the billing warning below, and Prerequisites in SETUP.md.

**Which file do I want?**

| File | Read it if you | Covers |
|---|---|---|
| **[SETUP.md](SETUP.md)** | want to run the app | install, the menu-bar dot, troubleshooting |
| **README.md** (this file) | are changing the code | architecture, the dev environment, internals |
| **[CLAUDE.md](CLAUDE.md)** | are changing how blogs are made | the engine contract |

---

## Quickstart (DEVELOPERS)

This is the from-source path, for working ON Canon. It is NOT how a teammate installs it:
`install.sh` above supersedes this and carries its own Node and Python, so it needs neither
of them already on the machine.

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
rather than reading `ANTHROPIC_API_KEY`, every blog consumes that person's
subscription quota, and runs start failing when it is exhausted. A shared deployment
should set `ANTHROPIC_API_KEY` so usage is billed to the org's API account and not to
whoever happened to log the CLI in.

Start the app with `./run.sh` (engine plus dashboard together) or, for just the server on
port 8000, `scripts/dev-serve.sh`:

```
./run.sh
```

Open http://127.0.0.1:8000, pick a client, tick rows, generate, and watch the live stages.
**Every client runs the full agent chain and spends real Claude and MCP quota**, so leave a
run alone until it finishes.

A run needs these environment variables (names are exactly what `server/runner.py`
reads):

| Variable | Required | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | strongly recommended | Consumed by the `claude` CLI subprocess the SDK spawns. Without it the CLI falls back to its own login; see the billing warning above. |
| `GEO_MODEL`, `GEO_MAX_TURNS`, `GEO_MAX_BUDGET_USD`, `GEO_RETRIES` | no | Model override, turn cap (default 250), per-session budget cap, died-session retries (default 1). |
| `GEO_CONCURRENCY` | no | Blog sessions in flight repo-wide, whichever door opened them (default 2). It saves no tokens per blog; it changes what you OWN when the usage limit lands. At 5-wide a real run produced twelve half-finished blogs and zero shipped. At 2-wide the same quota buys a handful of FINISHED blogs and leaves the rest untouched, and an untouched topic retries clean where a half-done one does not. |

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

For debugging a single row without the web UI (this spends real quota like any other run):

```
.venv/bin/python -m server.runner --client <slug> --row 0
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
    concurrency-proof.md    recorded evidence for the concurrency claims
    concurrency_check.py    the analysis script behind that proof
    config_check.py         static checks: MCP transport, SDK options, no secrets
    clean-draft.md, dirty-draft.md, frontend-check.py
  clients/
    vacation-village/
    <slug>/
      client.md             domain, market, industry reference (human approved)
      canonical-facts.md    binding facts, verified URLs, do-not-claim list (human approved)
      gates.json            word band, banned phrases, entity names, claim patterns
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
an unreviewed one would silently poison the whole queue.

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

Onboarding a client is the normal, real procedure: the four files above, a human-approved
`canonical-facts.md` that passes preflight, and the full pipeline (research, write, gates,
links, eval). Every client runs that full chain and spends real quota.

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
form. Below 90 it dispatches a fresh writer with only the dossier, the current draft, and the
fix list. **THREE conditions stop the loop, not two:** the 4-iteration cap, two consecutive
no-gain iterations, and a live Sourcing question on the form, which ends it at the iteration
it is filed. Sourcing is the one area no rewrite can close, since the writer has no authority
to invent a citation, so iterating past a Sourcing question spends budget rediscovering what
the evaluator already knew was terminal. A Sourcing FIX-LIST ITEM is a different artifact and
does NOT stop the loop: it routes to a bounded researcher top-up, because a machine can find a
source where only a person holds a fact.

**ONE NUMBER, IT IS 90, AND THE BAND IS BINARY:** the first score at or above it ends the loop at
once, and it is final and terminal WHEN NO CURRENT QUESTIONS ARE ON DISK. Below 90 the blog does
not ship. There is no middle band and no second threshold, and nothing in the engine compares a
score against any other number. A hard-gate failure is a REJECT whatever the graded score. **95 is
not an attainable score and 90 is:** the rubric normalises as `round(weighted_total / 90 * 100)`
over 14 integer-scored dimensions weighted to 30, so 85/90 lands on 94 and 86/90 lands on 96,
skipping 95 entirely, while 90 sits exactly on 81/90.

The bar used to be a single 95, which stopped being reachable. 95 was attainable before C4 and D2
raised the weight total from 25 to 30: `tests/concurrency-proof.md` records six topics ending done
at 95, 95, 96, 97, 98 and 98 under
the old 75-point maximum, so what broke the bar was holding the percentage constant through that
change. A real 12-blog run afterwards produced trajectories of 72 to 89 to 88, 84 to 84 to 87, 79
to 80, 82 and 73, with ZERO of the twelve ever reaching 95, so every blog was guaranteed to burn
all four iterations and end failed, which is where the account's usage limit went in two hours.
Under a bar of 90 the best of them, 89, is one point short and does not ship on its own. **A draft
that ends between 85 and 89 is BELOW BAR:** it resolves terminal `failed` like any other sub-90 run
and reaches a client only when the operator presses send, which is a statement about who decides
and not a second threshold. The dashboard labels that range "Below bar" so a near miss reads
differently from an outright failure, over a terminal status that is `failed` in both cases. The evaluator is stateless and its score varies by several points on an identical
draft, so a confirmatory re-eval adds no rigor and can strand a passing blog. **Open questions hold a blog
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
writes the `failed` terminal line itself. **A session that wrote NO status line AND died
faster than `runner.DEAD_SESSION_SECONDS` is NOT retried**, and gets its `failed` line at once
with a note saying so. Both conditions are required: a slow death with no lines can be a
genuine crash worth retrying, and a fast death that did write lines got somewhere. The guard
exists because the retry arm used to fire on any dead session with no check on why it died, so
when the account's usage limit landed every in-flight blog opened a second full SDK session
against a dead account and burned its turn budget failing again, measured as a retry line at
15:29:57 and its failed line at 15:29:59, with 19 retry lines written across twelve topics inside
a 106-second window, seven of which had produced no status line at all. The
server tails these files and streams them to the browser over SSE at
`/api/runs/{run_id}/events`.

## Concurrency evidence

See `tests/concurrency-proof.md` for the recorded evidence that the semaphore and client
lock behave as claimed: 7 topics against the cap of 5 measured max concurrency of exactly 5,
and topic 6 started 60 ms after the first slot freed, 3.3 seconds before the slowest
first-wave topic finished, disproving any batch-of-five barrier. That run was recorded when
the cap was hardcoded at 5; the cap is now `GEO_CONCURRENCY` and defaults to 2, and what the
evidence establishes is how the semaphore behaves at whatever cap it holds.

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
out is a courtesy on top.

### The write key

One key per client org, server-side only. Never in `gates.json`: that file is
operator-visible and checked in, and a write credential in it is a credential in the repo.

**There are two places to put a key, and `server/.env` is the one that works everywhere.**
Add one line per org, no `export` keyword, and restart the engine:

```
STRATEGI_CMS_WRITE_KEY_BLR_BREWING=...        # one line per org, org slug uppercased
STRATEGI_CMS_WRITE_KEY_VACATION_VILLAGE=...   # hyphens in the slug become underscores
```

The other place is the process environment, which still wins over the file:

```
export STRATEGI_CMS_WRITE_KEY_BLR_BREWING=...        # same variable name
export STRATEGI_CMS_URL=...                          # optional, to point at a staging CMS
```

**Prefer the file unless you know why you are exporting.** An exported variable reaches the
engine only when the engine was started from that same shell, which covers a terminal and
covers `Start Canon.command` because a login shell sources your profile. It does NOT cover
the tray app opened from Finder: macOS GUI apps read no shell profile, so on the packaged
distribution an `export` line in `.zshrc` reaches the engine never. `server/.env` is read on
every launch path.

The exported variable wins where both exist, matching how `server/db.py` resolves its own
three credentials. A var you exported into this process is a deliberate act aimed at this
process; a file on disk is ambient, and letting a stale line in it override the key you just
set is the harder of the two failures to diagnose.

A key kept in `server/.env` is **less** exposed than an exported one, not more. `server/db.py`
parses that file into a private dict and never into `os.environ`, and `agent_env()` builds
every Claude subprocess environment by filtering `os.environ`, so a key in the file cannot
reach an agent session at all. The `STRATEGI_CMS_WRITE_KEY_` prefix is deliberately absent
from `AGENT_ENV_ALLOW`: a write key files drafts into a client's live CMS, the push happens in
the server process long after every agent has exited, and no research or drafting session has
any use for one.

The endpoint defaults to `https://client.strategi.is/api/v1/ingest` and needs no config. If
you override it, give the **full endpoint including `/api/v1/ingest`**, never a bare host:
the value is POSTed to verbatim, and `https://client.strategi.is` on its own 307s to
`/login`, so a host-only value would push a blog at the login page and never tell you.

**There is no shared fallback key, deliberately.** The CMS decides which org a draft belongs
to *from the key*, and the payload is forbidden from carrying `org_id`, so the key is the only
thing routing a draft anywhere. A single shared variable would answer for every org: set it to
BLR Brewing's key, press Post on a Vacation Village blog, and Vacation Village's content lands
in BLR Brewing's CMS. Nothing in the request names the intended org, so neither side can catch
it and the leak is silent. An org gets its own key or it gets a 503.

With no key set for an org, the endpoint answers 503 naming the exact variable it wanted. That
is a setup problem, not a CMS failure, and it says so. Put the variable it names into
`server/.env` as a `NAME=value` line and restart the engine. Both places are checked before
that 503 is raised, and both are checked for that org's variable alone, so a second place to
look is never a second chance to answer with a neighbour's key.

`server/cms/client.py` carries `missing_key_detail(org_slug)`, which returns that sentence
plus the file to put the variable in and the reason an `export` is not enough on the packaged
app. The endpoint should raise its 503 with that string rather than composing its own.

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

Honest list, verified against the code as of 2026-08-05:

- **No auth.** No login, no tokens, no user identity anywhere in `app.py`. Six trusted
  operators behind whatever network boundary you put in front of it. There is no CORS
  middleware on purpose (same-origin UI), but that is not authentication.
- **No persistence of the run registry.** `runner.RUNS` is an in-memory dict. The
  status.jsonl files survive a restart; the run list and its SSE endpoints do not, so
  `/api/runs/{id}/events` 404s for runs started before the restart even though every line
  they wrote is still on disk.
- ~~**No retry UI.**~~ FIXED. A failed topic carries a "Retry this topic" link to the Create
  tab with the row pre-ticked (`components/blogs/blog-stage.tsx`), and beside it the same
  Send to client button every other blog gets: there is ONE release door at every score, and
  it promotes a failed topic on the way. Died-session retries remain automatic and note-only
  (`GEO_RETRIES`).
- ~~**No run cancellation.**~~ FIXED. `DELETE /api/clients/{slug}/runs` (`api_stop_client_runs`)
  stops every live run for one brand at once, behind a confirm dialog
  (`components/session/stop-session-dialog.tsx`). Finished blogs keep their terminal line;
  in-flight ones are discarded, and nothing on disk is deleted.
- **No CSV write-back, BY DESIGN.** The roadmap is read-only input; progress and terminal
  status live in the output dirs, never in the CSV.
- **No multi-worker or multi-host scaling, BY DESIGN.** See the single-worker warning.
- **Real-mode run not validated end to end yet** at the time of writing. The concurrency
  plumbing has recorded evidence in `tests/concurrency-proof.md`. The real path (SDK
  sessions, live MCP servers, live Firecrawl and DataForSEO) is written, preflighted, and
  statically checked by `tests/config_check.py`, but no real blog has been generated.
  `config_check.py` verifies
  the transport resolves, the options the SDK gets are the intended ones, and every field
  name still exists on the installed SDK; it cannot verify the credentials work.
- **The queue is `GEO_CONCURRENCY` BLOGS, not one session, and brands DO interleave.**
  `TOPIC_SEMAPHORE` in `runner.py` is the single gate every blog session passes: a Create-tab
  batch, a retry, an answer-driven revise and a repurpose each take one slot, so two brands can
  be writing at once as long as the cap allows. `tests/queue_check.py` proves the cap, the
  mixed doors and the no-batch-barrier claim in-process. The older one-client-at-a-time note in
  `tests/concurrency-proof.md` describes the repo-wide lock this replaced.
- **The output endpoint serves exactly five filenames** (`blog.md`, `eval.md`,
  `dossier.md`, `status.jsonl`, `links-verified.txt`). Anything else, including the
  `NEEDS_REVIEW` marker file, is a 404; the marker's information reaches the UI through
  the terminal status instead.
