# Starting Canon for the first time

This page covers the first launch: what Canon does while you wait, the coloured dot and its menu, and signing in. If Canon is not installed yet, start with [Installing Canon](install.md).

!!! danger "Nothing here is a rehearsal"
    Once Canon is running, every generation you start is real and spends quota from the Claude account this machine is logged into. There is no demo mode. Starting Canon costs nothing on its own; starting a blog does.

## Starting it

=== "Terminal install"

    Double-click **Start Canon (installed).command** in your `~/strategi-canon` folder.

    A Terminal window opens and prints each step as it happens, every line prefixed `[canon]`. When everything is up it opens the dashboard for you and prints the two addresses:

    ```
      Dashboard   http://localhost:3000
      Engine      http://127.0.0.1:8000
    ```

    If Chrome, Edge, Brave or Arc is installed, the dashboard opens in a plain window with no tabs and no address bar. Otherwise it opens as a normal browser tab.

    Leave that window open while you work. Closing it, or pressing Ctrl+C in it, stops Canon.

=== "Downloaded app"

    Open **Strategi Canon**: from Applications on macOS, from the Start menu or the desktop shortcut on Windows.

    No window opens. A coloured dot appears in the menu bar (macOS) or the system tray (Windows), and that dot is the whole interface. When it turns green, your browser opens the dashboard.

## What the first start is doing

The first start takes a minute or two longer than every later one. Canon builds its Python environment once, and the status line reads **Preparing Python environment...** while it does. Later starts skip it and take seconds.

The dashboard ships already built, so it comes up in a second or two with no compile step.

Canon also downloads a copy of Chromium during that first setup, which is what turns monthly reports into PDFs. If the download fails, setup carries on: reports still generate, without the PDF download.

## If Canon asks you to sign in

On the downloaded app, if there is no `.env` file for it to read, Canon asks for your Canon account details, the ones your admin created. It signs in and fetches its own keys, so there is no file for you to place.

On macOS you get two **Strategi Canon** dialogs in turn, one for the email and one for the password. On Windows you get one window headed **Sign in to Strategi Canon**, with **Email**, **Password**, **Cancel** and **Sign in**.

A few things can go wrong here, and each says so plainly:

| What it says | What to do |
|---|---|
| That email or password was not accepted | Retype them. You get another attempt, with the email you typed already filled in on macOS |
| Your account is signed in but is not an operator (admin), so it cannot fetch the engine keys | Ask an admin to grant your account, or ask them for a `.env` file instead |
| The engine keys have not been seeded in Supabase yet | Your admin has a setup step left to do. Send them that message |

If you cancel, Canon carries on and shows an amber dot for the missing `.env`. Nothing is broken and you can try again from the menu.

## The dot

The dot lives in the menu bar on macOS and the system tray on Windows. Canon checks itself every 10 seconds and recolours the dot when something changes.

| Dot | What it means | What to do |
|---|---|---|
| **Green** | Everything is running | Nothing. Work in the dashboard |
| **Amber** | Setup needs attention | Open the menu. Each problem is listed with its fix. Do the fix, then choose **Check again** |
| **Red** | The engine or the dashboard died, or stopped answering | Choose **Restart**. If it stays red, choose **Open logs** |

A process that has exited turns the dot red at the next check. A process that is still alive but slow to answer needs two failed checks in a row, so a single slow moment does not flip it.

The top line of the menu is always a status line you cannot click. These are the ones you will see:

- `Starting...`, `Checking setup...`, `Preparing Python environment...`, `Starting engine on :8000...`, `Preparing dashboard...`, `Starting dashboard on :3000...`
- `Engine running - :8000` when all is well
- `Setup needs attention: 2 problems`
- `Engine died - choose Restart`, `Dashboard died - choose Restart`, `Engine not responding - choose Restart`
- `Restarting...` after you choose **Restart**
- `Start failed: ...` followed by the reason
- `Applying update, restarting...` when an update you asked for is landing

## Every menu item

Open the menu by clicking the dot.

### When the dot is green or red

| Item | What it does |
|---|---|
| The status line | Not clickable. What Canon is doing right now |
| **Claude account: you@example.com** | Not clickable. Which Claude account this machine is logged into, so you can see whose quota a generation will spend. It is missing if Canon cannot find a Claude login |
| **Open dashboard** | Opens `http://localhost:3000/` in your browser |
| **Restart** | Stops the engine and the dashboard, then starts them again. This is the fix for a red dot |
| **Check setup again** | Re-runs the setup checks. If nothing healthy is running, it does a full start instead |
| **Open logs** | Opens the log folder in Finder or File Explorer |
| **Start at login** | A tickbox. See below. It appears only on the downloaded app |
| **Quit** | Stops the engine and the dashboard, then closes Canon |

!!! warning "Restart and Quit stop a run in progress"
    Both take the engine down. A blog that was generating stops where it was. Its research and its draft stay on disk, so nothing is deleted, but the run does not resume by itself.

### When the dot is amber

The menu becomes a list of what is wrong. For each problem you get two lines: the problem, marked with a cross, and an indented **Fix:** line under it in plain English. Below the list there are two items only:

| Item | What it does |
|---|---|
| **Check again** | Re-runs the checks and starts Canon if they now pass |
| **Quit** | Closes Canon |

**Open dashboard**, **Restart**, **Open logs** and **Start at login** are not in the menu while the dot is amber. They come back once the problems are cleared.

The usual amber problems are the two prerequisites: the `claude` CLI is not installed or not logged in, or Canon cannot find a usable `.env`. On the downloaded app the `.env` fix reads "Put the .env file from your admin in the same folder as Strategi Canon.app (name it .env or canon.env), then choose Check again", because that is where yours belongs.

## Start at login

Tick **Start at login** in the menu to have Canon launch when you log in and stay running in the background, so the dashboard is ready the moment you open it. Untick it from the same menu.

The tickbox writes the login item and nothing else. It does not start a second copy of Canon there and then; it takes effect at your next login. On Windows the installer offers the same thing during setup, as **Start Strategi Canon automatically when I log in (recommended)**.

This item appears only on the downloaded app.

## Signing in to the dashboard

Your browser lands on a card headed **Welcome back**, with the line "Sign in with the account your administrator provisioned."

1. Type your work email in **Email**.
2. Type the password your admin sent in **Password**.
3. Press **Sign in**.

!!! info "Two different logins, and they do different jobs"
    Your **Claude** login pays for generation. Your **Canon** login identifies you in the dashboard. They are unrelated accounts, and the menu's **Claude account:** line is there so you can tell at a glance which Claude account is on the hook.

If sign-in fails, the page shows the reason in red under the fields. "Invalid email or password" means the account details were refused, so check them with your admin. "Cannot reach the engine" means the dashboard cannot see the engine, so check the dot.

Once you are in, [Your first blog](../guide/your-first-blog.md) is the next step.

## Where Canon keeps your work and its logs

=== "Terminal install"

    Everything lives inside the folder you cloned, `~/strategi-canon`. Finished blogs are plain Markdown files under `~/strategi-canon/outputs/`, one folder per brand and one folder per topic inside it.

=== "Downloaded app"

    The app keeps a working copy of Canon outside itself, because the app bundle is sealed and read-only.

    | What | macOS | Windows |
    |---|---|---|
    | Working copy, blogs included | `~/Library/Application Support/StrategiCanon/app` | `%LOCALAPPDATA%\StrategiCanon\app` |

    Finished blogs sit under `outputs/` inside that folder.

    !!! note "Deleting that folder costs time, not data"
        The record lives in the database. If the working folder goes missing, the app lays a fresh copy down on the next launch. An update keeps it, along with your keys.

Log files are in the same place on both routes, and the menu's **Open logs** takes you straight there:

| macOS | Windows |
|---|---|
| `~/Library/Logs/StrategiCanon` | `%LOCALAPPDATA%\StrategiCanon\logs` |

Three files: `tray.log` is the app itself, `engine.log` and `dashboard.log` are the two things it runs. No credential value is written to any of them, so they are safe to send to your admin.

## If something is still wrong

[Troubleshooting](../reference/troubleshooting.md) has the full list of symptoms and fixes.
