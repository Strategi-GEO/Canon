# Troubleshooting

Canon runs on your own machine: a small menu-bar app starts an engine and a dashboard, and your browser talks to them. So most problems are one of three things. The app has not started, the engine cannot reach something it needs, or the Claude account behind the writing has run out of room.

Start with the dot in the menu bar. It is the fastest thing on this page.

## The dot

| Dot | What it means | What to do |
| --- | --- | --- |
| **Green** | The engine and the dashboard are both healthy. | Nothing. |
| **Amber** | Setup needs attention. The engine has not started. | Open the menu. Every problem is listed with its fix under it. Do the fix, then choose **Check again**. |
| **Red** | The engine or the dashboard died, or stopped answering. | Choose **Restart**. If it goes red again, choose **Open logs** and read the end of `engine.log` or `dashboard.log`. |

When the dot is amber, the menu holds a line reading "Setup needs attention", the problems and their fixes, **Check again**, and **Quit**. That is deliberate: there is no dashboard to open yet. Once it is green the menu carries **Open dashboard**, **Restart**, **Check setup again**, **Open logs**, **Start at login** and **Quit**.

## Amber dot: what it can be

These are the checks that turn the dot amber. The menu names whichever one applies in plain English, and this table is what each one means.

| The menu says | What is wrong | Fix |
| --- | --- | --- |
| Python is too old, Canon needs 3.11 or newer | The Python on this machine predates what the engine needs | Install Python 3.11 or newer from python.org, then **Check again** |
| Python 3.11+ is not installed, and the engine's Python environment (.venv) does not exist yet | The packaged app needs a system Python once, to build its own environment | Install Python 3.11 or newer, then **Check again**. It is needed for the first start only |
| Node.js is not on PATH | The dashboard cannot run without it | Install Node 20 or newer from nodejs.org, pick the LTS installer, then **Check again** |
| npm is not on PATH | The Node install did not finish | Reinstall Node 20 or newer and **Check again** |
| The `claude` CLI is not on PATH | This is what pays for every generation | Install Claude Code, run `claude` once in a terminal and log in with your own account, then **Check again** |
| server/.env does not exist, could not be read, or is missing required keys | The file holding the database credentials is absent, unreadable or incomplete | Ask your admin for the current `server/.env`. Do not edit it by hand |
| No .env file found next to the app | You are running the single-app install and the file is not beside it | Put the `.env` your admin sent in the same folder as **Strategi Canon.app**, named `.env` or `canon.env`, then **Check again** |

!!! tip "Amber is not broken"
    Nothing is damaged when the dot is amber. The engine refused to start because something it needs is missing, which is the behaviour you want: the alternative is an engine that starts and fails halfway through a paid run.

## The engine is not reachable

The dashboard and the engine are two separate things, so the dashboard can load while the engine is down. When that happens you get a red card reading **Cannot reach the engine**, with the exact command to start it and a **Try again** button.

| Symptom | What it means | Fix |
| --- | --- | --- |
| **Cannot reach the engine** on a page that should list brands | The engine is not running, or it is running on a different port | Check the menu-bar dot. Green means it is up, so **Restart** from the menu. Amber means the fixes above apply |
| **The engine refused the request** | The engine is up and said no. The card carries its own sentence | Read the sentence on the card. It names what to fix |
| The topbar reads **Sessions unknown** | The engine did not answer the session list. Work already running is unaffected | Wait for the next poll. It re-reads every four seconds |
| Port already in use in the logs | A previous run left a server behind | **Restart** from the menu, which reclaims the ports. If it persists, reboot |

## The dashboard does not load

| Symptom | What it means | Fix |
| --- | --- | --- |
| The browser never opens on start | The dashboard did not become reachable in time | Check the dot. Red means it died; **Restart**. Otherwise open `http://localhost:3000/` by hand |
| The first start sits on "Preparing Python environment" for minutes | One-time setup building the engine's Python environment | Normal, once per install. Later starts take seconds |
| The dashboard page loads but every list is empty | Almost always the engine, not the dashboard | See the section above. An empty list with no error card is different from "cannot reach the engine" and means the brand genuinely has nothing |
| Login fails while the engine is clearly up | `server/.env` is stale, or your account was never provisioned | Ask your admin for the current `server/.env` and to confirm your account exists. Replace the file, then **Restart** |

## A run fails the moment you start it

A blog that goes from **Generating** to a failure inside a few seconds never reached the writing. There are four reasons, and the blog's own note on the queue row names which.

| The note says | What happened | What to do |
| --- | --- | --- |
| `session died in Ns having written no status line; not retried` | The session opened and died inside a minute, before it reached a single tool call. The usual cause is the Claude account's usage window being exhausted | Wait for the usage window to reset, then generate the topic again. Nothing was written, so nothing is lost |
| `the engine stopped opening blog sessions ...` | Two sessions in a row died that way, so the engine halted dispatch for every brand | Wait the fifteen minutes the note names, or retry sooner once any session runs. The topic is untouched on disk |
| `preflight failed ... canonical-facts.md is missing` or names PLACEHOLDER | The brand's fact base has not been built or reviewed | Build the fact base for that brand before generating. Every blog for the brand inherits it |
| The note names `FIRECRAWL_API_KEY`, `DATAFORSEO_USERNAME` or `DATAFORSEO_PASSWORD` | The research credentials are missing on this machine | See the next section |

!!! danger "The usage limit is about your Claude subscription, not a Canon bill"
    Canon has no billing of its own. Every generation runs the `claude` CLI against the Claude account **this machine** is logged in to, so a run that dies on a usage limit means that account's window is spent. Canon cannot see how much is left and cannot tell you when it resets. It only sees sessions dying instantly, which is exactly why it stops after two rather than after twelve.

    Nothing is charged twice for a topic that died this way: it wrote nothing and it retries clean.

## Research keys are missing

Canon refuses a run outright on a machine with no Firecrawl or DataForSEO credentials, before a session opens. This is not something you can work around, and the refusal is the point.

The reason is worth knowing. Those keys are what let the engine fetch pages. Without them every fetch comes back rejected, and a writer with no working fetch tool does not fail, it invents sources. The check exists because the config file that declares those servers ships inside Canon, so its presence used to say "the research tools are available" on a machine holding no key at all.

The three names are `FIRECRAWL_API_KEY`, `DATAFORSEO_USERNAME` and `DATAFORSEO_PASSWORD`. Signing in to Canon writes them into `server/.env` from the shared store your admin seeded, so a missing key usually means that store was never seeded for your deployment. Ask your admin, then **Restart** from the menu.

!!! warning "Do not put them in your shell profile"
    An `export` line works if you start Canon from a terminal and stops working the moment you start it by double-clicking, because apps opened from Finder do not read shell profiles. The `.env` file works both ways.

## A blog is stuck on Generating

First, check whether it is actually stuck. Expand the row in the **Queue** table and read the stage clock. `research` legitimately sits still for minutes: sources are being fetched and read in full. The total elapsed cannot tell you whether a blog is wedged, and the stage clock can.

| Symptom | What it means | What to do |
| --- | --- | --- |
| The stage clock keeps climbing but the stage keeps changing | It is working | Leave it |
| One stage has not changed in a long time, and neither has anything else on the engine | Everything went quiet at once, which is what a usage limit or a sleeping machine looks like | Wait. Canon tolerates two hours of silence before it treats a blog as wedged, precisely so a rate limit does not destroy a recoverable run |
| The blog ends **Did not finish** with a note about the engine reclaiming its queue slot | The session stopped responding and ignored a cancel, so the engine took the slot back to unblock every other brand | Generate the topic again. Nothing was deleted |
| The whole queue reads queued and nothing is running | Either the engine halted dispatch after two dead sessions, or the engine restarted | Check the dot, then check the notes on the failed rows |
| A blog was mid-run when you restarted Canon | The list of live runs lives in the engine's memory and does not survive a restart, so the topic stops reading as **Generating** and falls back to whatever its own status feed last recorded | The files on disk are intact. Refresh the page and read the blog's status; generate it again if it never reached a verdict |

!!! note "The engine can end a blog on its own"
    Canon treats a blog as healthy for as long as it keeps writing progress lines, however long the whole session takes. It only intervenes when a blog writes nothing at all for two hours. That number is set by how long a Claude usage window can stall a session, not by how long a stage takes, so it is deliberately generous.

## Posting is refused

The post button reads **Post to CMS** on a brand that files drafts with our own editors, and **Post to WordPress** on a brand that publishes to its own website. Either way, these are the refusals it can come back with.

| The message says | What it means | Fix |
| --- | --- | --- |
| No CMS write key configured | This machine's engine has no write key at all. One shared key posts for every organisation | Add the line `STRATEGI_CMS_WRITE_KEY=<key>` to `server/.env`, then **Restart**. Ask your admin for the key |
| No blog destination is set for *brand* | Nobody has chosen where this brand's blogs publish | Choose it in **Settings**, under **Blog destination**, then post again |
| *topic* is `needs_review`, not done | The evaluator asked a question and the blog is held until it is answered | Answer the questions. There is no dismiss |
| *topic* has not been approved by the client yet | The brand publishes to the client's own website, and posting there is the final release | Wait for the client to approve it in their portal. Posting to the Strategi CMS does not need approval, because a CMS draft is reviewed by an editor before it goes anywhere. See [Publishing a blog](../guide/publishing.md) |

## Reading the logs

The menu's **Open logs** opens the folder. On macOS it is `~/Library/Logs/StrategiCanon`, on Windows `%LOCALAPPDATA%\StrategiCanon\logs`.

| File | What is in it |
| --- | --- |
| `tray.log` | The menu-bar app itself: what it checked, what it started, what it decided |
| `engine.log` | The engine. This is where a halted dispatch, a reclaimed slot, or a refused run explains itself |
| `dashboard.log` | The dashboard server |

No credential value is ever written to any of them, so they are safe to send to your admin whole.
