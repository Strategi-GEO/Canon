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

Open Terminal once, paste three commands, and you are done. After this you
never need the Terminal again: you start Canon by double-clicking, like any app.

```bash
gh auth login                                    # a browser window, one time
gh repo clone Strategi-GEO/Canon ~/strategi-canon
cd ~/strategi-canon && ./install.sh
```

`install.sh` does the rest: it downloads Canon's own copies of Node and Python,
asks for the three database values your admin sends you, and creates a
double-clickable starter. Run it again any time to update.

Then, one time, install **Claude Code** and log in with your own account (see
Prerequisites below). That is what pays for generation.

Finally, double-click **Start Canon (installed).command** in the folder. A
colored dot appears in the menu bar. When it turns **green**, your browser opens
the dashboard: sign in with the account your admin provisioned.

> **Why the Terminal, briefly.** macOS blocks apps downloaded through a browser
> until you go and approve them in System Settings, and it does that even when
> nothing is wrong. Files that arrive through `git` are not flagged that way, so
> installing like this skips the whole detour. Three commands once, instead of a
> security warning on every machine.

If you have no `gh`, install it with `brew install gh`, or clone with plain
`git clone https://github.com/Strategi-GEO/Canon.git ~/strategi-canon` and enter
a GitHub token when asked.

### If you cannot use the Terminal at all

There are prebuilt zips on the repository's **Releases** page
(`Strategi-Canon-macos.zip`, about 330 MB). Unzip it, put the `server/.env` file
your admin sends you into the folder's `server/` directory, and open
**Strategi Canon.app** inside. macOS will refuse the first launch; open
**System Settings > Privacy & Security**, scroll to the bottom, and choose
**Open Anyway**. That is needed once per machine, not once per launch.

The installer route above avoids that step entirely, which is why it is the one
this guide leads with.

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
2. **From your admin:** the Canon folder (or repo URL) and the `server/.env`
   file, which goes inside the folder's `server/` directory. Firecrawl and
   DataForSEO research keys usually arrive automatically with your Claude
   Code MCP setup; if not, the admin gives you three values to set as
   environment variables (`FIRECRAWL_API_KEY`, `DATAFORSEO_USERNAME`,
   `DATAFORSEO_PASSWORD`).

That is the whole list. **You do not need to install Node or Python.** The app
carries its own copies of both and uses them in preference to anything already
on your machine, so there is nothing to install, nothing to keep updated, and
no version to get wrong. This is also why the download is large (around 300 MB):
those two runtimes are most of it.

If either prerequisite is missing, the dot simply turns **amber** and the menu
tells you which one and how to fix it. Nothing breaks.

## Signing in

Use the dashboard account the admin provisioned for you (your work email and
the password they sent). This login is separate from your Claude account: the
Claude login pays for generations, the dashboard login identifies you in the
app. The menu also shows which Claude account this machine is logged in to,
as "Claude account: you@company.com".

## Troubleshooting

| Symptom | What it means | Fix |
|---|---|---|
| **Amber dot** | A prerequisite is missing (Claude CLI or `server/.env`) | Open the menu: each problem is listed with its fix. Do the fix, then choose "Check again" |
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

This fallback is the one path that **does** need Node and Python installed on
your machine, because it runs outside the app and so cannot reach the runtimes
bundled inside it. If you are using the tray app, ignore this appendix.

It prints every step, opens the browser when ready, and Ctrl+C stops
everything. Flags for tests and unusual setups: `--engine-port N`,
`--dashboard-port N`, `--no-dashboard` (engine only), `--no-browser`. Run
`python3 launcher.py --help` for details. The tray app and the CLI use the
same engine room, so anything the amber menu reports, the CLI reports too,
as `[canon]` lines in the terminal.
