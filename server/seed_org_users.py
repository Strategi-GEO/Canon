#!/usr/bin/env python3
"""Provision portal logins: one Supabase Auth user per ORGANISATION, plus the local
credentials file the team keeps.

    python -m server.seed_org_users --all                 # every org, default role
    python -m server.seed_org_users --org blr-brewing     # one org
    python -m server.seed_org_users --all --rotate        # also reset existing passwords
    python -m server.seed_org_users --org blr-brewing --set-password   # set a CHOSEN password (prompted)

One login per org, not per person, because that is what the operator asked for: the org
slug becomes the username's local part (<org-slug>@<domain>), and the grant is an
org_members row, which fans out to every brand in the org through the org_membership view.
Every login this script makes is a CLIENT login with one power set: read their own org's
work, answer the evaluator's questions. The org_members.role column that backs this is an
internal storage detail (the stored value permits answering; the read-only value would
strand a client on a held blog they could never release), and it deliberately surfaces
NOWHERE: not in the credentials file, not in this script's output, not in any message a
person reads. There is exactly one kind of client login.

THE CREDENTIALS FILE (.env.portal-credentials at the repo root) is the point of this
script as much as the users are. It records every org login and the admin login in one
local-only place. The name starts with '.env.' DELIBERATELY: the root .gitignore already
ignores `.env` and `.env.*` unanchored, so this file can never be committed by reflex and
no .gitignore edit was needed to make that true. Passwords land in the file and NOWHERE
else: this script never prints one.

Passwords for users that already exist cannot be read back from GoTrue (nothing can), so a
re-run keeps whatever the file already records for them; --rotate is the explicit way to
mint new (random) ones, and --set-password sets a CHOSEN password for one org, prompted and
never on argv (so it stays out of shell history and ps). Only the password changes: the
username is the org login's derived email and is left alone. The admin section records app_admins emails; their passwords are held by
the operator and only recorded here if --record-admin-password is passed (prompted, never
argv).

Mechanics mirror server/seed_admin.py exactly (create-or-lookup, idempotent grant), and
the GoTrue admin helpers are imported from it rather than copied, so the two seeders
cannot drift.
"""
from __future__ import annotations

import argparse
import configparser
import getpass
import os
import secrets
import socket
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import db
from .seed_admin import _auth_admin, _create_auth_user, _lookup_user_id

REPO_ROOT = Path(__file__).resolve().parent.parent
CREDENTIALS_FILE = REPO_ROOT / ".env.portal-credentials"
DEFAULT_DOMAIN = "portal.strategi.is"
# The stored org_members.role for every client login. INTERNAL: this word never reaches a
# person. It is the answering-capable grant; the read-only alternative would strand a
# client on a held blog they could never release.
_CLIENT_ROLE = "commenter"

HEADER = """\
# Strategi Canon: portal credentials. LOCAL ONLY.
# This file is covered by the root .gitignore (`.env.*`) and must never be
# committed, screenshotted whole, or shared as one document. Share one org's
# block with that org and nothing more.
#
# Regenerate / update:  python -m server.seed_org_users --all
# Rotate passwords:     python -m server.seed_org_users --all --rotate
# Written {stamp} on {host}.

"""


def _gen_password() -> str:
    # 16 urlsafe chars ~ 96 bits. Friendly enough to type once, strong enough to keep.
    return secrets.token_urlsafe(12)


def _set_password(uid: str, password: str) -> None:
    status, body = _auth_admin(
        "PUT", f"/auth/v1/admin/users/{uid}", {"password": password})
    if status != 200:
        text = body if isinstance(body, str) else str(body)
        sys.exit(f"password rotate failed for {uid}: HTTP {status} {text[:300]}")


def _orgs() -> list[tuple[str, str]]:
    """Every org the portal can scope to: the org_membership view's distinct org set,
    which is exactly what /api/orgs derives (explicit orgs plus synthesized self-orgs,
    underscore fixtures excluded)."""
    rows = db.q(
        "select distinct org_slug, org_name from org_membership order by org_slug")
    return [(r[0], r[1]) for r in rows]


def _admins() -> list[str]:
    rows = db.q("select email from app_admins order by email")
    return [r[0] for r in rows]


def _read_existing(path: Path) -> configparser.ConfigParser:
    # interpolation=None: recorded passwords can carry '%', which the default parser
    # reads as interpolation syntax and rejects on access. Values are stored verbatim.
    parser = configparser.ConfigParser(interpolation=None)
    if path.is_file():
        try:
            parser.read(path, encoding="utf-8")
        except configparser.Error:
            # A hand-mangled file is not fatal: previous passwords are simply not
            # carried forward, and the operator can --rotate to mint fresh ones.
            print(f"warning: could not parse existing {path.name}; not carrying passwords forward")
    return parser


def _write_file(path: Path, admin_lines: list[dict], org_lines: list[dict]) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    out = [HEADER.format(stamp=stamp, host=socket.gethostname())]
    for entry in admin_lines:
        out.append(f"[admin:{entry['email']}]\n")
        out.append(f"email = {entry['email']}\n")
        out.append(f"password = {entry['password']}\n\n")
    for entry in org_lines:
        out.append(f"[org:{entry['slug']}]\n")
        out.append(f"name = {entry['name']}\n")
        out.append(f"email = {entry['email']}\n")
        out.append(f"password = {entry['password']}\n\n")
    # Owner-only perms (0600) from the outset: the file holds every password, so it must
    # never be group/world readable, not even in the instant between write and chmod.
    # os.open honors the mode on CREATE; os.fchmod also pins it on the rewrite path, where
    # O_CREAT leaves an existing file's mode untouched. LOCAL ONLY, gitignored (see HEADER).
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        os.fchmod(fd, 0o600)
        fh.write("".join(out))


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Provision one portal login per organisation and record credentials locally.")
    scope = ap.add_mutually_exclusive_group(required=True)
    scope.add_argument("--all", action="store_true", help="every org the record knows")
    scope.add_argument("--org", help="one org slug")
    ap.add_argument("--domain", default=DEFAULT_DOMAIN,
                    help=f"email domain for org logins (default: {DEFAULT_DOMAIN})")
    ap.add_argument("--rotate", action="store_true",
                    help="reset passwords for logins that already exist")
    ap.add_argument("--set-password", action="store_true",
                    help="set a CHOSEN password for ONE org (prompts; requires --org)")
    ap.add_argument("--record-admin-password", action="store_true",
                    help="prompt for the admin password and record it in the file")
    args = ap.parse_args()

    if not db.db_configured():
        sys.exit("DATABASE_URL is not set in server/.env; cannot reach the store.")

    orgs = _orgs()
    if args.org:
        orgs = [o for o in orgs if o[0] == args.org]
        if not orgs:
            sys.exit(f"unknown org {args.org!r}: nothing in org_membership carries that slug")

    # --set-password is scoped to ONE org on purpose: one chosen password applied across every
    # org would give them all the same login, so it refuses --all. Prompt AFTER the org is
    # validated, so an unknown slug fails before anyone types a password, and read it here
    # (never from argv) so it stays out of shell history and ps, exactly like the admin one.
    chosen_password = None
    if args.set_password:
        if not args.org:
            sys.exit("--set-password requires --org: refusing to set one password for every org")
        chosen_password = getpass.getpass(f"New password for org {args.org!r}: ")
        if not chosen_password:
            sys.exit("--set-password: an empty password is refused")
        if getpass.getpass("Confirm new password: ") != chosen_password:
            sys.exit("--set-password: the two entries did not match")

    existing = _read_existing(CREDENTIALS_FILE)

    org_entries = []
    for slug, name in orgs:
        email = f"{slug}@{args.domain}"
        section = f"org:{slug}"
        prior = existing[section]["password"] if existing.has_option(section, "password") else None

        # Existence is checked FIRST, because it decides which password is true: a
        # create call that adopts an existing user leaves that user's old password in
        # force, and recording the fresh one we generated would write a lie into the
        # file. Four cases, each explicit:
        #   new user            -> create with a fresh password, record it
        #   exists + recorded   -> keep the recorded password (nothing changes)
        #   exists + unrecorded -> set a fresh password (the only way the file can be true)
        #   exists + --rotate   -> set a fresh password
        uid = _lookup_user_id(email)
        # --set-password forces the chosen password for this org; every other run mints a fresh
        # random one, except where an existing user's recorded password is kept (the four cases
        # below). A user that does not exist yet is created with whichever password is in force.
        password = chosen_password if args.set_password else _gen_password()
        password_changed = True
        if uid is None:
            uid = _create_auth_user(email, password)
        elif args.set_password:
            _set_password(uid, password)
        elif prior is not None and not args.rotate:
            password = prior
            password_changed = False
        else:
            _set_password(uid, password)

        db.q("""insert into org_members (org_slug, user_id, role) values (%s, %s, %s)
                on conflict (org_slug, user_id) do update set role = excluded.role""",
             (slug, uid, _CLIENT_ROLE), fetch="none")

        org_entries.append({
            "slug": slug, "name": name, "email": email, "password": password,
        })
        print(f"client login ready: {slug} ({email})"
              + ("" if password_changed else " [password unchanged]"))

    # Admin section: emails from app_admins; passwords only what the operator chooses to
    # record. An existing recorded admin password is carried forward.
    admin_entries = []
    for email in _admins():
        section = f"admin:{email}"
        prior = existing[section]["password"] if existing.has_option(section, "password") else None
        password = prior or "(held by operator)"
        if args.record_admin_password:
            typed = getpass.getpass(f"Password to record for admin {email} (empty keeps current): ")
            if typed:
                password = typed
        admin_entries.append({"email": email, "password": password})

    # --org runs must not drop the other orgs' recorded credentials: carry forward every
    # org section the file already has that this run did not touch.
    touched = {e["slug"] for e in org_entries}
    for section in existing.sections():
        if section.startswith("org:") and section[4:] not in touched:
            sec = existing[section]
            org_entries.append({
                "slug": section[4:],
                "name": sec.get("name", section[4:]),
                "email": sec.get("email", ""),
                "password": sec.get("password", ""),
            })
    org_entries.sort(key=lambda e: e["slug"])

    _write_file(CREDENTIALS_FILE, admin_entries, org_entries)
    print(f"credentials recorded in {CREDENTIALS_FILE.name} (local only, never committed)")


if __name__ == "__main__":
    main()
