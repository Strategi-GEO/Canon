# geo-factory

A multi-client GEO blog factory wrapping the Claude Agent SDK. An operator opens the web
UI, picks a client, loads that client's roadmap CSV, ticks the rows they want, and hits
generate. The backend runs two blogs at a time by default (`GEO_CONCURRENCY`); each one is
researched, written, mechanically gated, link-verified, and scored by a hostile evaluator
until it hits the bar of 90, which is the only bar: at or above 90 it ships, below 90 it does
not.
Output is plain local .md files under `outputs/<slug>/`, committed back to the record and
previewed in the browser. The interface is the Next app under `dashboard/`, which talks to
this engine cross-origin and is the same codebase Vercel serves read-only to clients; the
single-file UI still served at `/` on port 8000 is the legacy one.

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
.venv/bin/python -m playwright install chromium   # PDF reports only, best effort
(cd dashboard && npm install)
```

You also need the **Claude Code CLI and Node** on the machine. The Python
`claude-agent-sdk` does not talk to the API directly: it spawns the `claude` CLI as a Node
subprocess, so any container image needs Node plus the CLI on PATH. The dashboard builds on
Node 20.18.1, which is what `engines.node` pins for Vercel; `npm test` inside `dashboard/`
needs Node 23.6.0 or newer, because those suites are TypeScript run straight through
`node --test` and an older Node dies on a parse error that reads like a broken repo.

**The runner does NOT pass its whole environment to that subprocess.** `db.agent_env()` in
`server/db.py` is an ALLOWLIST, and only the variables named on it cross into a session.
Anything else you export is invisible to every agent, deliberately: an `allowed_tools` list is
a skip-the-prompt list and not a sandbox, so a variable this process holds is a variable a
session can read. `tests/env_check.py` plants a canary secret and fails the build if either
half of that regresses.

### Billing warning: the CLI may spend a personal subscription

Because the SDK spawns the `claude` CLI, **whatever that CLI authenticates with is what
pays for a real run.** If the CLI on the machine is logged into a Claude subscription
rather than reading `ANTHROPIC_API_KEY`, every blog consumes that person's
subscription quota, and runs start failing when it is exhausted. A shared deployment
should set `ANTHROPIC_API_KEY` so usage is billed to the org's API account and not to
whoever happened to log the CLI in.

Start the app with `./run.sh` (the engine on 8000 and the Next dashboard on 3000 together)
or, for the engine alone, `scripts/dev-serve.sh`:

```
./run.sh
```

Open **http://localhost:3000**, sign in, pick a client, tick rows, generate, and watch the
live stages. Port 8000 is the engine API; it also serves a legacy single-file UI at `/`, but
`dashboard/` is the interface that is maintained, and every data route on 8000 needs a
signed-in identity (`server/auth.py`), so an anonymous poll of it answers 401. **Every client
runs the full agent chain and spends real Claude and MCP quota**, so leave a run alone until
it finishes.

### Where a variable goes, and why the two places are not interchangeable

- **`server/.env`** is parsed into a module-private dict by `server/db.py` and, as a rule,
  NEVER into `os.environ` (RULE 1 in that file). At startup `db.export_agent_credentials()`
  lifts out of that dict only the keys named in `AGENT_ENV_ALLOW`, because `.mcp.json`
  interpolates `${FIRECRAWL_API_KEY}` out of the CHILD environment and a key that stops in the
  private dict reaches no agent at all. A shell export always wins over the file.
- **A shell export** is the only way to set a knob that is neither on that allowlist nor read
  through `db.config_value`. Putting `GEO_STALL_TIMEOUT` in `server/.env` silently does
  nothing.

The "Set in" column below answers this per variable. `server/.env` also means "works in a
packaged desktop install", where there is no shell to export from.

### Engine credentials (`server/.env`)

| Variable | Required | Set in | What it does |
|---|---|---|---|
| `DATABASE_URL` | yes | `server/.env` | Postgres DSN for the psycopg pool. `db_configured()` keys off it, and without it the engine has no record at all. |
| `SUPABASE_URL` | yes | `server/.env` | Project URL. Auth (the GoTrue proxy) and Storage. |
| `SUPABASE_SECRET_KEY` | yes | `server/.env` | Service key. `server/auth.py` proxies login, refresh and logout with it. It never reaches a browser and never reaches an agent. |
| `SUPABASE_JWT_SECRET` | no | `server/.env` | HS256 fallback for a legacy shared-secret project only. It never competes with a live JWKS; ES256 against the cached JWKS is the normal path. |
| `RESEND_API_KEY` | no | `server/.env` | Admin email notifications. Absent, every send is a no-op that logs and nothing else breaks. |
| `RESEND_FROM` | no | `server/.env` | Sender address. It falls back to `Canon <onboarding@resend.dev>`, which Resend delivers ONLY to the address owning the account, so set it before anyone else expects mail. |

`DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are the three `install.sh` prompts
for, and `secrets_bootstrap.REQUIRED_KEYS` is the same three. They are also `_OWN_CREDENTIALS`
in `db.py`: `config_value()` raises rather than hand them to a caller outside that module, and
none of them is on the agent allowlist, so an agent session cannot read the database whatever
else it is given.

**THERE IS NO `SUPABASE_ANON_KEY` HERE, AND THAT IS NOT AN OMISSION.** `server/auth.py`
`_gotrue_token` sends the SECRET key as the `apikey` header on every login, refresh and logout,
server-side only, and that is the whole reason the frontend needs a Supabase key of no kind:
the browser talks only to this engine, never to GoTrue. An anon key would be a fourth
credential to distribute that nothing would read. Two other surfaces DO use one and both are
their own tables below: the HOSTED dashboard, whose Route Handlers query Supabase directly
under RLS, and the desktop tray app, which signs an operator in before any secret is on the
machine.

### Model and engine knobs

| Variable | Default | Set in | What it does |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | unset | either | Consumed by the `claude` CLI subprocess the SDK spawns. Without it the CLI falls back to its own login; see the billing warning above. `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` are on the allowlist too, for a gateway or a token-authenticated CLI. |
| `GEO_MODEL` | CLI default | either | Model override for every agent session, blog and report alike. |
| `GEO_MAX_TURNS` | `250` | either | Per-session turn cap. |
| `GEO_MAX_BUDGET_USD` | unset | either | Per-session USD budget cap. |
| `GEO_RETRIES` | `1` | either | Retries for a session that DIED without writing a status line. Not revise iterations, which the contract caps at 4. |
| `GEO_DASHBOARD_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | either | Comma separated, and it REPLACES the default CORS list rather than adding to it. Set it whenever the dashboard is on another port, or its preflight is refused and every fetch plus the SSE run feed dies with nothing in the engine to turn. |
| `GEO_CONCURRENCY` | `2` | either | Blog sessions in flight repo-wide, whichever door opened them: a Create-tab batch, a retry, a repurpose, an answer-driven revise. It saves no tokens per blog; it changes what you OWN when the usage limit lands. At 5-wide a real run produced twelve half-finished blogs and zero shipped. At 2-wide the same quota buys a handful of FINISHED blogs and leaves the rest untouched, and an untouched topic retries clean where a half-done one does not. Read through `db.config_value` as well as `os.environ`, because `TOPIC_SEMAPHORE` is built at MODULE IMPORT, before the startup export runs. Floored at 1 (a 0 admits nobody, forever, silently); a garbage value falls back to 2 rather than refusing to boot. |
| `GEO_STALL_TIMEOUT` | `7200` (2 hours) | **shell only** | Seconds a slot may go without its `status.jsonl` growing before the watchdog cancels it and, two minutes later, reclaims the slot and writes the topic's terminal `failed` line. Floored at 300. A threshold shorter than a quota stall does not catch wedged sessions, it destroys rate-limited ones, and it does so to every brand at once. |
| `GEO_ANSWERS_PICKUP` | `0` | **shell only** | `1` turns on the hands-off sweep that dispatches the answer-driven revise a client portal's answers are owed, at startup and every five minutes. OFF by default because the primary path is the operator's own click, so a person chooses the moment this machine's quota is spent. |

`GEO_CONCURRENCY`, `GEO_STALL_TIMEOUT` and `GEO_ANSWERS_PICKUP` are not on `AGENT_ENV_ALLOW`
and are never handed to an agent. The other `GEO_*` knobs are on it, which is also what makes
them settable from `server/.env`.

### MCP transports: stdio (default) or HTTP

Firecrawl and DataForSEO reach the agents over MCP, and `runner._resolve_mcp_servers()`
picks the transport at dispatch:

1. **stdio, via `.mcp.json` (the default).** The repo ships a project-scoped `.mcp.json`
   declaring both servers as stdio commands at PINNED versions (`npx -y firecrawl-mcp@3.22.4`
   and `npx -y dataforseo-mcp-server@2.9.11`), so it needs `npx` on PATH. The runner passes
   `mcp_servers={}` and lets the CLI load that file, which works because the session sets
   `setting_sources=["project"]` and leaves `strict_mcp_config` at its default of `False`
   (setting it `True` would suppress the file). Credentials come from the environment:

   | Variable | Set in | Server |
   |---|---|---|
   | `FIRECRAWL_API_KEY` | either | firecrawl |
   | `FIRECRAWL_API_URL` | either | firecrawl, for a self-hosted instance |
   | `DATAFORSEO_USERNAME` | either | dataforseo |
   | `DATAFORSEO_PASSWORD` | either | dataforseo |

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
both options, and `runner._stdio_mcp_config_ok` refuses BEFORE a session opens rather than
after. That failure is deliberately loud: a session missing Firecrawl would not notice and
stop, it would invent sources. It also cannot be inferred from the repo, because `.mcp.json`
is checked in, so on a machine holding no key at all the file used to say the research tools
were available while every fetch came back 401. `runner.check_real_mode_ready()` reports the
same thing without spawning anything, so the API can refuse at submit time. A repurpose
session is exempt: it rewrites an already shipped blog and fetches nothing.

### Optional Analysis-tab tools

The monthly Analysis report merges up to six tools and degrades gracefully. An absent key is a
tool that simply is not there, and its scorecard renders "Not connected". Firecrawl and
DataForSEO are the floor and come from the section above; these three add the rest:

| Variable | Set in | Tool |
|---|---|---|
| `SEOGETS_API_KEY` | `server/.env` | SEO Gets, as a remote HTTP MCP server. The `sg_mcp_` key IS the bearer token (Settings, then API & MCP Keys) and needs a Core or Pro plan. |
| `CLARITY_API_KEY` | `server/.env` | Microsoft Clarity, via `@microsoft/clarity-mcp-server` over stdio. The Data.Export JWT is passed as a CLI arg, which is what that server expects. Limits are tight: about 10 requests a day, 3 days, 3 dimensions. |
| `BING_WEBMASTER_API_KEY` | `server/.env` | Bing Webmaster. There is no official MCP, so rather than run an unvetted community package the agent calls `https://ssl.bing.com/webmaster/api.svc/json` directly with this key. |

Those three are injected into the ANALYSIS session alone (`server/analysis_gen.py`), never
written into `.mcp.json` and never handed to a blog session. Alongside them the allowlist
carries `GSC_MCP_URL`/`GSC_MCP_AUTH`, `GA4_MCP_URL`/`GA4_MCP_AUTH`, `BING_MCP_URL`/
`BING_MCP_AUTH`, `CLARITY_MCP_URL`/`CLARITY_MCP_AUTH` and `SEOGETS_MCP_URL`/`SEOGETS_MCP_AUTH`
for Search Console, GA4, Bing, Clarity and SEO Gets reached over HTTP MCP instead.
`tests/analysis_mcp_check.py` pins the wiring.

**NO PUBLISHING CREDENTIAL IS ON THE ALLOWLIST, and the omission is load-bearing.** A client's
WordPress application password lives in the `clients.site` DATABASE COLUMN, not in an
environment variable, and the push runs in this process in `server/cms/` long after every
agent has exited. Naming one on the allowlist would hand every research session the ability to
write to a client's live site and buy nothing in return.

### Dashboard (`dashboard/.env.local`)

The same codebase runs two ways: LOCAL talks to the FastAPI engine, HOSTED (Vercel,
read-only) answers from same-origin Route Handlers. See `dashboard/README-VERCEL.md`.

| Variable | Mode | What it does |
|---|---|---|
| `NEXT_PUBLIC_API_BASE` | local dev | The engine, `http://127.0.0.1:8000`. Use 127.0.0.1 and NOT localhost: `run.sh` binds uvicorn to IPv4 only while macOS resolves localhost to `::1` first, so the browser hits nothing and the dashboard renders "Cannot reach the engine" on a healthy engine. Left unset in development it defaults to localhost:8000. Deliberately UNSET on the hosted deployment. |
| `NEXT_PUBLIC_HOSTED_READONLY` | hosted | `true` hides every control that needs the live engine and keeps the base at `""`, so fetches hit the same-origin `/api` Route Handlers. |
| `SUPABASE_URL` | hosted | Server-side, for those Route Handlers only. |
| `SUPABASE_ANON_KEY` | hosted | The ANON (publishable) key, safe server-side here; RLS scopes every row. The SECRET key is never used anywhere in the dashboard. |
| `CANON_STANDALONE` | build | `1` before `next build` emits `.next/standalone/server.js`, so the packaged desktop app serves an already-compiled dashboard instead of running `next dev`. Off by default, so the Vercel build is unchanged. |

### Desktop tray app (`canon_app/`)

| Variable | Default | What it does |
|---|---|---|
| `CANON_SUPABASE_URL` | from `bootstrap.json` | Overrides the bundled sign-in endpoint, so a build can be pointed at another project without editing the committed file. |
| `CANON_SUPABASE_ANON_KEY` | from `bootstrap.json` | The matching PUBLIC anon key for that override. This is the one place an anon key is used: `secrets_bootstrap.password_login` signs the operator in with it BEFORE any secret exists on the machine, then fetches the real `server/.env`. A blank pair reads as "not configured" and the app falls back to the file path with no prompt. |
| `CANON_ENGINE_PORT` | `8000` | Engine port. For testing; the packaged app expects 8000. |
| `CANON_DASHBOARD_PORT` | `3000` | Dashboard port. For testing. |
| `CANON_NO_DASHBOARD` | unset | `1` runs the engine only, the same as the CLI's `--no-dashboard`. |
| `CANON_NO_BROWSER` | unset | `1` starts without opening a browser, the same as `--no-browser`. |

### Desktop build only (`canon_app/fetch_runtimes.py`)

The bundled runtimes are PINNED so a build is reproducible, and these three override the pins.
Bump them deliberately: a silent runtime bump is a silent change to what every recipient runs.

| Variable | Default | What it does |
|---|---|---|
| `NODE_VERSION` | `24.18.0` | The Node fetched into `build_assets/runtimes/node/`. |
| `PYTHON_VERSION` | `3.12.13` | The CPython fetched into `build_assets/runtimes/python/`. |
| `PBS_RELEASE` | `20260718` | The python-build-standalone release tag that CPython comes from. |

For debugging a single row without the web UI (this spends real quota like any other run):

```
.venv/bin/python -m server.runner --client <slug> --row 0
```

Static checks, which spawn no CLI and generate no blog:

```
.venv/bin/python tests/config_check.py    # transport, SDK options, field names still on the SDK
.venv/bin/python tests/env_check.py       # the allowlist, and a canary secret that must not cross
(cd dashboard && npm test)                # the TypeScript suites, Node >= 23.6.0
```

## RUN EXACTLY ONE UVICORN WORKER

**Never pass `--workers N` with N above 1.** `TOPIC_SEMAPHORE` (the `GEO_CONCURRENCY` blog
queue), the per-client `facts_lock`, and the slot watchdog are plain `asyncio` in-process
primitives at the top of `server/runner.py`. With N workers you get N independent copies of
each, the concurrency cap silently becomes N times `GEO_CONCURRENCY`, two runs for one brand
can build `canonical-facts.md` at the same time, and nothing in the logs tells you. The same
applies to the in-memory run registry that backs `/api/runs`, `/api/queue` and the SSE
endpoint: a second worker holds a second, disjoint registry. The app logs a warning about
this at startup; the warning cannot detect the misconfiguration, it can only remind you.

This is single-process by design. Scaling out is listed under "Not built yet" because it
would require moving those primitives and the registry out of process, and nothing here
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
| `approved` | Approved | **publish only** | Approved | reply |
| `published` | Published | publish again, unpublish | Published | nothing |
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
    roadmap.py              CSV loading; the brief by position, every other column by header
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

`roadmap.csv` is ten columns and three of them are **positional**: column 1 is the topic,
column 2 is what the piece covers, column 8 is the target prompts. **Every other column is
registered, not ignored.** The content type, the query intent and the justification figures are
stored, shown, and handed to the writer as labelled guidance under the header the sheet gave
them, because the sheet plans real instructions about the shape and framing of the piece. Query
Intent is a live search-intent classification of the row's PRIMARY target prompt, not an eyeball
read of a cell holding three prompts of differing intent. None of them is ever a fact the draft
may cite. There is no prose `Justification` column: the figures ARE the justification, because a
sentence explaining a number belongs beside the number it explains, and a column whose content
argues about the other columns goes stale the moment any of them is re-pulled. The first row is
always treated as a header and skipped. There is no header detection and no column override
deciding WHICH column is the topic, because operator sheets are positionally stable and matching
on header text only invents ways to map the wrong column. The headers of the binding three are
read once as a GUARD: a ten-wide sheet laid out to an older contract is exactly the right width
and would otherwise parse in silence, so the upload is refused unless columns 1, 2 and 8 read
`Content Topic`, `What the Piece Covers` and `Target Prompts`.

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
that ends between 80 and 89 is BELOW BAR:** it resolves terminal `failed` like any other sub-90 run
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

## Where a brand's blogs publish

Every brand publishes to **its own website**, connected in **Settings → Blog destination**.
WordPress is the one platform with a driver today.

A brand with **no website connected** has the Post control disabled, with the reason on hover:
connect the client's website first. There is no fallback destination and nothing publishes
anywhere by default. Before migration 035 an unconfigured brand silently posted to the Strategi
CMS, which made "nobody set this up" a state nothing could name; migration 038 removed that
destination entirely and cleared every brand that was still on it, so an empty destination is
now simply a brand nobody has set up.

Shopify, Squarespace, Wix and Webflow are **detected and named as unconnectable** rather than
half-offered. Each runs a real blog Canon cannot post to, and saying so at setup is the
difference between an operator knowing and an operator promising a client something that cannot
be built.

### Connecting a client's WordPress

Ask the client for three things:

1. **The link to their blog page**, or to any one of their existing articles.
2. **A WordPress username** with Editor or Administrator access.
3. **An Application Password** for that user: *Users → Profile → Application Passwords → type
   `Canon` → Add New*. It is shown once. Their site must be on https, or WordPress does not
   offer the panel at all.

Never ask for their WordPress password, their hosting or cPanel login, or FTP details. None of
them is needed.

Paste those into the card, press **Detect** (which reads what platform the page runs on), then
**Connect**. The engine makes five GETs and no writes, so it is safe to press repeatedly:

- the page itself, which declares the site's REST root
- `wp/v2/users/me?context=edit`, which proves the credential AND that their host did not strip
  the `Authorization` header (the single most common real failure, and the error names the
  one-line `.htaccess` fix so it can be forwarded)
- an article off that page, whose `Link: rel="alternate"` header **names the post type their
  blog actually renders from**
- `wp/v2/types`, which refuses a page type or one WordPress will not show on the front end
- one existing article under `context=edit`, whose `meta` keys say **which SEO plugin's fields
  the site will actually accept from us**

That third step is why this is not just "post to `/wp/v2/posts`". Plenty of client themes
render their blog from a custom post type (`insights`, `news`), and posting to `posts` there
does not fail: WordPress answers 201, the record stores an id, the UI says published, and the
article sits in a section nobody renders. It is the only invisible failure in the pipeline, so
the type is read from the site rather than assumed. A brand-new site with nothing published
falls back to `posts` and says it is unverified.

### The SEO title and description

A client's site sets its `<title>` and meta description from whichever SEO plugin it runs, so an
article published without them takes the theme's fallback: the H1 verbatim, and usually no
description at all. Canon fills them where it can.

**Writability is proven at connect time, never assumed.** WordPress accepts a meta key over REST
only where something registered it with `show_in_rest`, and having the plugin installed does not
mean anything did: Yoast's keys are protected and unregistered on a default install, so posting
them is silently dropped and the article publishes looking fine with no SEO title on it. So
connect reads one existing article back with `context=edit` and takes the keys the site's own
schema returns. Four plugins are recognised:

| Plugin | Keys |
|---|---|
| Yoast SEO | `_yoast_wpseo_title`, `_yoast_wpseo_metadesc` |
| Rank Math | `rank_math_title`, `rank_math_description` |
| SEOPress | `_seopress_titles_title`, `_seopress_titles_desc` |
| The SEO Framework | `_genesis_title`, `_genesis_description` |

Both keys of a pair or neither: a half-filled SEO record reads to whoever audits the site as
somebody having started and stopped. **AIOSEO is deliberately absent** because it keeps its
fields in its own database table rather than in post meta, so there is nothing here to write and
a site running it resolves nothing rather than being lied to. A site with no writable pair
publishes without SEO fields, exactly as every push did before this existed.

The settings card and the Post button name the plugin they found, so whether a published article
carries our title is visible without viewing the source of a live page.

**A field somebody already filled in on their side is never overwritten.** On a first push the
post is new and the pair is sent unconditionally. On an update the engine reads what the post
holds and fills only what is empty, which is the same rule it keeps for the body: replacing a
title an editor typed would silently discard a person's editorial decision. A post whose meta
cannot be read is one the engine cannot prove is empty, so it writes nothing.

### Posting

Press **Publish** on an approved blog. One HTTP call, no discovery: the post type, the section
and the SEO keys were all pinned at connect time. The article's real URL comes back in the same
response and is stored, so the blog then shows **Published on acme.com 3 days ago** and a **View
on acme.com** link.

Pressing again updates the same article rather than making a second one. If somebody edited it
on their site after our last push, the engine **declines to overwrite** and reports it.

### Only finished, approved blogs go

Two refusals stand in front of the button, both in `server/cms/gate.py`, and both are server
side. The disabled button is a courtesy; these are the guard, and they hold against a stale tab,
a replayed request and a hand-rolled curl.

- **`done`, exactly.** Anything else answers 409 naming the state it found. A `needs_review`
  blog is never published. A `failed` blog the operator has READ can go, by being promoted first
  on their authority (the trail then reads "failed at 87, then a person published it"), and the
  one thing that promotion cannot waive is a draft no evaluator ever scored.
- **The client's own approval.** A push puts the article live on their public domain, which is
  the final release, and the thing that authorises a final release here is the client saying so
  in the portal. This used to be scoped to a website destination, because a Strategi CMS push
  filed a draft an editor of ours reviewed and released nothing to anybody. There is no such
  destination now, so approval sits on every publish there is.

### What lands on the site

The draft exactly as the evaluator scored it. The committed body is read off the record and
converted to HTML byte for byte minus its H1, which becomes the `title`. There is no second
model pass over the article: the transform in `server/cms/payload.py` is pure and deterministic,
so the blog that passed the eval is the blog a reader opens. The TL;DR becomes the excerpt.

- **The byline is theirs.** The article lands under the WordPress user whose application
  password connected the site. `author` is deliberately never sent.
- **The section is pinned.** Connect reads the categories off the exemplar article, so new
  articles join the section the operator pointed at. This matters on a
  `/%category%/%postname%/` site, where the category IS the URL: send nothing and the article
  files under the site default, away from every other article. An article found stranded
  entirely outside the pinned section is moved back; one that merely also carries the client's
  own extra category is left alone.
- **Tags are not sent.** WordPress takes taxonomy as term IDs rather than names, and creating
  terms on a client's site is a write nobody asked for.
- **The SEO title and description** go where the plugin accepts them, as above. They are written
  by a short model session at push time from the finished draft, screened through `gates.py`'s
  own banned-phrase and superlative lists before they are accepted, and they fall back to the
  H1 and TL;DR on every failure path, so a slow or absent model costs a push its polish and
  never the push.

**Re-post safety is answered from the record**, not from an idempotency key: a client's
WordPress has no such concept. `topics.cms_post_id` holds the id of the article on their site
and `published_to` holds which destination issued it, and `remote_article` answers only when the
two agree. That second half is load-bearing: one id cannot say which system issued it, so a
Strategi CMS id handed to a brand that has since connected WordPress would PATCH an unrelated
`wp/v2` post of that number. Mismatched, the lookup answers nothing and the push CREATES, which
is the truth.

```
.venv/bin/python tests/site_check.py       # offline, sends nothing over the network
.venv/bin/python tests/cms_check.py        # the payload builder and its guards
.venv/bin/python tests/unpublish_check.py  # the retraction
.venv/bin/python tests/wp_category_check.py
```


## Not built yet

Honest list, verified against the code as of 2026-09-01:

- ~~**No auth.**~~ FIXED. `server/auth.py` proxies Supabase Auth server-side and verifies
  access tokens LOCALLY (ES256 against the cached project JWKS, so a request costs one
  signature check and not a GoTrue round trip). Every data route takes `require_user` or
  `require_admin`, identity carries an admin bit plus org and per-brand grants cached about
  45 seconds, and a non-admin sees only the brands their grants name. CORS is configured too:
  the dashboard is cross-origin now, and `GEO_DASHBOARD_ORIGINS` sets the allowed list.
  `tests/auth_check.py` and `tests/org_grant_check.py` pin it.
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
- ~~**Real-mode run not validated end to end.**~~ FIXED, and the evidence is on disk: 65
  blogs under `outputs/` carry a real `blog.md`, 64 of them a scored `eval.md`. What that
  proved is written up in the two engine-quota notes in `CLAUDE.md`: the 95 bar was
  arithmetically unreachable, a 12-blog run at 5-wide exhausted the account in two hours and
  shipped nothing, and the bar, the writer's rubric read, and `GEO_CONCURRENCY` all changed
  because of it. `tests/config_check.py` still runs first and spawns nothing: it verifies the
  transport resolves, that the options the SDK gets are the intended ones, and that every
  field name still exists on the installed SDK. It cannot verify the credentials work.
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
