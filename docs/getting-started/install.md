# Installing Canon

Canon runs on your own computer. It starts two things locally, an engine and a dashboard, and then opens the dashboard for you. There is no shared server to connect to.

You install Canon once. After that you start it by double-clicking, like any other app.

!!! danger "Every generation spends real quota from your own Claude account"
    Canon has no demo mode and no test mode. Every blog it produces runs the full agent chain for real, using the Claude Code login on this machine, so it draws on your own Claude subscription. One blog is several agent sessions, and a batch of roadmap rows can use a large share of a personal plan's quota. Do not start generations you do not mean to pay for.

## What you need before you start

### 1. Claude Code, installed and logged in

Canon runs the `claude` command for every generation, and whichever account that command is logged into is the account that gets billed. Nobody can do this step for you: a shared login would be a shared bill.

1. Install Claude Code from <https://claude.com/claude-code>.
2. Open a terminal. On macOS that is Terminal, on Windows it is PowerShell.
3. Run `claude`.
4. Log in with **your own** account.
5. Type `/exit`.

That is the only time this step needs a terminal.

### 2. What your admin sends you

Which of these you get depends on how your deployment is set up:

- a `.env` file you place next to the app,
- a Canon account, an email address and a password, which the app uses to fetch its own keys the first time you open it,
- three values you type during the Terminal install: `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `DATABASE_URL`.

Your admin also creates your dashboard login. That is a separate account from your Claude account, and [Starting Canon](first-run.md) covers signing in with it.

!!! danger "Those values are secrets, and they are not scoped to you"
    They grant full access to every client's data. If one leaks, the only remedy is rotating it for everybody. Do not paste them into chat, a ticket, or anything else that keeps a history.

### What you do not need

Node and Python. Canon carries its own copies of both and uses them in preference to anything already on your machine, so there is nothing to install and no version to get wrong. Those two runtimes are most of the reason the download runs to a few hundred MB.

## Choose how to install

Two routes get you to the same working app. The Terminal route is the one to prefer on a Mac, because it skips a security warning entirely. Windows has one route: the installer.

=== "Terminal, three commands (macOS)"

    Open Terminal and paste these, one after the other:

    ```bash
    gh auth login                                    # a browser window, one time
    gh repo clone Strategi-GEO/Canon ~/strategi-canon
    cd ~/strategi-canon && ./install.sh
    ```

    If you do not have `gh`, install it first with `brew install gh`. If you cannot install it at all, clone with plain git instead and enter a GitHub token when asked:

    ```bash
    git clone https://github.com/Strategi-GEO/Canon.git ~/strategi-canon
    ```

    A GitHub password will not work for that; it has to be a token.

    `install.sh` then does the rest:

    - downloads Canon's own copies of Node and Python, about 280 MB, cached so a second run is fast,
    - asks for the three database values from your admin, and writes them to `server/.env` with permissions that let only your user account read the file,
    - creates a double-clickable starter called **Start Canon (installed).command** in the folder,
    - checks whether the `claude` CLI is installed and logged in, and tells you what is missing.

    The two secret values are hidden as you type them, and `SUPABASE_URL` is visible. If you leave any of the three blank, the file is not written and the script tells you to run it again when you have all three.

    !!! tip "Run it again any time to update"
        `cd ~/strategi-canon && ./install.sh` updates your copy. It never overwrites a `server/.env` that already exists, and it skips the update rather than pulling on top of local edits.

=== "Download, no Terminal"

    Prebuilt packages live on the repository's **Releases** page.

    **macOS.** Download `Strategi-Canon-macos.zip`. It contains one app. Unzip it and put **Strategi Canon.app** anywhere you like; Applications is fine.

    On first launch the app copies its working files to `~/Library/Application Support/StrategiCanon/app` and runs from there, so nothing else needs to sit beside it.

    **Windows.** Download `Strategi-Canon-windows-setup.exe` and run it. It installs for your user only, into `%LOCALAPPDATA%\Programs\Strategi Canon` with no admin prompt, and adds a Start menu entry. It offers three tickboxes along the way: **Create a desktop shortcut**, **Start Strategi Canon automatically when I log in (recommended)**, and at the end **Launch Strategi Canon now**.

    **If your admin sent you a `.env` file**, put it where the app will find it:

    | Platform | Where the file goes |
    |---|---|
    | macOS | The same folder as **Strategi Canon.app**, named `.env` or `canon.env` |
    | Windows | The folder the installer created, named `.env` or `canon.env` |

    Finder hides files whose name starts with a dot, so use the name `canon.env` if you want to be able to see it. Canon accepts either name.

    If your deployment uses account sign-in instead, you get no `.env` at all, and the app asks you to sign in the first time you open it.

### Why the Terminal route avoids a warning

macOS marks any file that arrives through a browser and refuses to open it until you go and approve it, and it does that even when nothing is wrong. Files that arrive through `git` are not marked that way, so the three commands above skip the whole detour. Three commands once, instead of a security warning on every machine.

## The first-launch warning

The app is not signed with a paid certificate, so both operating systems warn about it the first time. Nothing is wrong with the app, and you see this once per machine, not once per launch.

=== "macOS"

    Double-clicking may say the app cannot be opened.

    1. Right-click (or Control-click) **Strategi Canon.app**.
    2. Choose **Open**.
    3. Choose **Open** again in the dialog that appears.

    If it still refuses, or says the app is damaged, open **System Settings > Privacy & Security**, scroll to the bottom, and choose **Open Anyway**.

    As a last resort, this clears the download marker:

    ```bash
    xattr -dr com.apple.quarantine "Strategi Canon.app"
    ```

=== "Windows"

    A blue "Windows protected your PC" screen may appear.

    1. Click **More info**.
    2. Click **Run anyway**.

## Where the app itself lives

| How you installed | Where it goes |
|---|---|
| Terminal, three commands | `~/strategi-canon`, with **Start Canon (installed).command** inside it |
| macOS download | Wherever you put **Strategi Canon.app**, plus a working copy at `~/Library/Application Support/StrategiCanon/app` |
| Windows installer | `%LOCALAPPDATA%\Programs\Strategi Canon`, plus a Start menu entry |

[Starting Canon](first-run.md) covers where your finished blogs and the log files end up.

## Updating later

=== "Terminal install"

    ```bash
    cd ~/strategi-canon && ./install.sh
    ```

    Safe to run as often as you like. Every step checks whether it is already done.

=== "Downloaded app"

    Open **Settings** at the bottom of the sidebar in the dashboard. It shows the version running on this computer, and an **Update now** button when a newer release exists. The update downloads only the changed code, tens of MB rather than the whole app, keeps your keys and your work, and applies when Canon restarts itself a few seconds later.

    While a blog is generating, the button is disabled and the panel says "A blog is generating. You can update once it finishes." Finish the run, then update.

## Next

[Starting Canon for the first time](first-run.md).
