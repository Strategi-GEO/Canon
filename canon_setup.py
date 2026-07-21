#!/usr/bin/env python3
"""Strategi Canon one-time setup.

Run this ONCE after unzipping, before the first launch. It does the two things
the package cannot do for you and nothing else:

  1. Writes server/.env, the one file the engine needs and the release cannot
     ship, because it holds the database and Supabase keys and those must never
     travel inside a downloadable zip.
  2. Checks that the `claude` CLI is installed and logged in, because that login
     is what pays for generation out of YOUR OWN subscription and what carries
     the Firecrawl and DataForSEO research connections. Nothing here can log in
     for you: a shared login would be a shared bill.

Everything else the app needs, Node and Python, is already bundled in the
package. There is nothing to install.

WHY THIS IS SEPARATE FROM THE LAUNCHER. The launcher runs when you double-click
the app, which on macOS has no terminal attached and so cannot ask you anything.
This is the one terminal step, run once. It never sends a key anywhere: it only
writes them to server/.env on this machine, readable by you alone.

Pure standard library, same file on macOS and Windows, matching launcher.py.
"""
from __future__ import annotations

import getpass
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
ENV_PATH = REPO_ROOT / "server" / ".env"

# The keys the engine hard-requires, in the order it is least error prone to
# paste them: the long DSN first while attention is fresh. These are exactly
# launcher.py's ENV_FILE_KEYS; keep the two in step.
REQUIRED_KEYS = ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY")


def prompt_value(name: str) -> str:
    """Read one required value, hidden as it is typed.

    getpass hides the input. A database URL is not a password, but it CONTAINS
    one, and a Supabase secret key is a secret outright, so hiding all three is
    the safer default and spares the person a shoulder-surfing worry while they
    paste. Re-ask on blank rather than writing a half file the launcher will
    reject later with a less obvious message.
    """
    while True:
        value = getpass.getpass(f"  {name}: ").strip()
        if value:
            return value
        print("  (that cannot be blank, try again)")


def check_claude() -> None:
    """Report the Claude Code state. Never fatal: server/.env is still worth
    writing even on a machine where the login is not done yet."""
    claude = shutil.which("claude") or shutil.which("claude.cmd")
    if not claude:
        print("[!]  claude CLI not found.")
        print("     Install Claude Code from https://claude.com/claude-code, then run")
        print("     `claude` once and log in with YOUR OWN account. That login pays for")
        print("     generation and carries the Firecrawl and DataForSEO connections.")
        return
    print(f"[ok] claude CLI found: {claude}")
    if (Path.home() / ".claude.json").exists():
        print("[ok] a Claude login exists on this machine")
    else:
        print("[!]  no Claude login yet: run `claude`, log in, then type /exit")


def write_env(values: dict[str, str]) -> None:
    """Write server/.env owner-readable only, with the mode set BEFORE any bytes
    land so the secrets are never briefly world readable on disk.

    On Windows the mode argument is ignored by the OS, and a per-user file is not
    world readable there by default, so this is correct on both without a branch.
    """
    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(ENV_PATH), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for key in REQUIRED_KEYS:
            handle.write(f"{key}={values[key]}\n")
    try:
        os.chmod(ENV_PATH, 0o600)
    except OSError:
        pass


def main() -> int:
    print("Strategi Canon setup")
    print("====================")
    print()
    check_claude()
    print()

    if ENV_PATH.exists():
        print(f"server/.env already exists at:\n  {ENV_PATH}")
        answer = input("Overwrite it with new values? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("Left the existing server/.env untouched. Setup done.")
            return 0
        print()

    print("Paste the three values your admin gave you. Input is hidden as you type.")
    print()
    values = {key: prompt_value(key) for key in REQUIRED_KEYS}
    write_env(values)

    print()
    print(f"[ok] wrote {ENV_PATH}")
    print("     (readable only by you)")
    print()
    print("That is the whole of setup. Firecrawl and DataForSEO come from your")
    print("Claude Code login, so there is nothing to configure for them here.")
    print()
    print("Next: make sure `claude` is logged in (see above), then start Canon by")
    print("double-clicking the starter in this folder.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nSetup cancelled. Nothing was written unless it says so above.")
        raise SystemExit(130)
