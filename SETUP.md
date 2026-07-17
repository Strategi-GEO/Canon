# Strategi Canon: Setup

Strategi Canon runs entirely on your own machine: a Python engine on
`127.0.0.1:8000`, a web dashboard on `localhost:3000`, and your browser opened
to the dashboard. You start it from a small menu-bar app (macOS) / system-tray
app (Windows) called **Strategi Canon**: no terminal, no commands.

> **Billing, stated plainly:** Strategi Canon has no mock or demo-safe mode.
> Every blog generation is real. The engine runs the `claude` CLI using the
> Claude Code login on YOUR machine, so **every generation spends real quota
> from your own Claude subscription**. One blog is several agent sessions.
> Do not start generations you do not mean to pay for.

## The short version

1. Get the **Canon folder** from your admin (or clone the repo), with the
   `server/.env` file they send placed inside its `server/` folder.
2. Put **Strategi Canon.app** (macOS) or the **Strategi Canon** folder with
   **Strategi Canon.exe** (Windows) inside that Canon folder, if your admin
   did not ship it there already.
3. Double-click **Strategi Canon.app** / **Strategi Canon.exe**.
4. A colored dot appears in the menu bar / system tray. When it turns
   **green**, your browser opens the dashboard: sign in with the dashboard
   account your admin provisioned.

The dot is the whole interface:

| Dot | Meaning |
|---|---|
| **Green** | Everything is running. The menu has "Open dashboard", "Restart", "Open logs", "Quit". |
| **Amber** | Setup needs attention. Open the menu: it lists each problem with its fix in plain English. Fix it, then choose "Check again". |
| **Red** | The engine or dashboard died. Choose "Restart". If it stays red, "Open logs" shows why. |

The first start is slow (it builds the engine's Python environment and runs
`npm install` once). Later starts take seconds. Quit from the menu when you
are done; that stops the engine and the dashboard too.

### First-launch warnings (the app is unsigned)

- **macOS Gatekeeper:** double-clicking may say the app "cannot be opened".
  The first time only: **right-click (or Control-click) the app, choose
  Open, then Open again** in the dialog. After that it opens normally.
- **Windows SmartScreen:** a blue "Windows protected your PC" screen may
  appear. Click **More info**, then **Run anyway**. First time only.

## Prerequisites (one-time, before first launch)

1. **Claude Code, logged in.** This is what pays for generations. Install it
   from <https://claude.com/claude-code>, open a terminal (macOS: Terminal;
   Windows: PowerShell), run `claude`, log in with **your own** account, then
   type `/exit`. You never need the terminal again after this.
2. **Node 20+** from <https://nodejs.org/> (LTS installer). The dashboard
   runs on it, and the engine spawns Node-based tools.
3. **Python 3.11+** from <https://www.python.org/downloads/>. The packaged
   app carries its own Python for the app itself, but the engine's
   environment on your machine is built with your installed Python the first
   time. (Windows: tick "Add python.exe to PATH" in the installer.)
4. **From your admin:** the Canon folder (or repo URL) and the `server/.env`
   file, which goes inside the folder's `server/` directory. Firecrawl and
   DataForSEO research keys usually arrive automatically with your Claude
   Code MCP setup; if not, the admin gives you three values to set as
   environment variables (`FIRECRAWL_API_KEY`, `DATAFORSEO_USERNAME`,
   `DATAFORSEO_PASSWORD`).

If any of these is missing, the dot simply turns **amber** and the menu tells
you which one and how to fix it. Nothing breaks.

## Signing in

Use the dashboard account the admin provisioned for you (your work email and
the password they sent). This login is separate from your Claude account: the
Claude login pays for generations, the dashboard login identifies you in the
app. The menu also shows which Claude account this machine is logged in to,
as "Claude account: you@company.com".

## Troubleshooting

| Symptom | What it means | Fix |
|---|---|---|
| **Amber dot** | A prerequisite is missing (Node, Claude CLI, Python, or `server/.env`) | Open the menu: each problem is listed with its fix. Do the fix, then choose "Check again" |
| **Red dot** | The engine or dashboard crashed | Choose "Restart". Still red? "Open logs" and read the end of `engine.log` or `dashboard.log`, or send them to the admin |
| macOS says the app "cannot be opened" or is "damaged" | Gatekeeper blocking an unsigned app | Right-click the app > Open > Open (first time only). If it persists: `xattr -dr com.apple.quarantine "Strategi Canon.app"` in Terminal |
| Windows "protected your PC" screen | SmartScreen on an unsigned exe | More info > Run anyway (first time only) |
| App opens then nothing happens, no dot | The app could not find the Canon folder | Keep the app inside the Canon folder (next to `launcher.py`), or pick the folder when the chooser appears |
| Engine is up but dashboard login fails | `server/.env` is missing/stale, or your dashboard user was never provisioned | Ask the admin for the current `server/.env` and confirm they created your account. Replace the file, then "Restart" |
| Blogs will not generate, viewing works | Firecrawl / DataForSEO keys were found nowhere | Have the admin set up the MCP servers in your Claude Code, or set the three variables from Prerequisites step 4, then "Restart" |
| First start sits for minutes | One-time setup: pip and npm downloading dependencies | Normal. Later starts skip both |
| Port already in use messages in logs | A previous run left a server behind | The launcher reclaims its ports automatically on start; "Restart" is usually enough. Otherwise reboot |

Logs live in `~/Library/Logs/StrategiCanon` (macOS) or
`%LOCALAPPDATA%\StrategiCanon\logs` (Windows); the menu's "Open logs" opens
that folder. `tray.log` is the app itself, `engine.log` and `dashboard.log`
are the two things it runs. No credentials ever appear in them.

## Appendix: terminal fallback (the v1 CLI)

The tray app wraps `launcher.py`, which still works standalone if you prefer
a terminal or need to debug:

- **macOS:** double-click `Start Canon.command` in the Canon folder, or run
  `python3 launcher.py`.
- **Windows:** double-click `Start Canon.bat`, or run `py -3 launcher.py`.

It prints every step, opens the browser when ready, and Ctrl+C stops
everything. Flags for tests and unusual setups: `--engine-port N`,
`--dashboard-port N`, `--no-dashboard` (engine only), `--no-browser`. Run
`python3 launcher.py --help` for details. The tray app and the CLI use the
same engine room, so anything the amber menu reports, the CLI reports too,
as `[canon]` lines in the terminal.
