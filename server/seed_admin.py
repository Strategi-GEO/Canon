#!/usr/bin/env python3
"""Seed one internal admin: create a Supabase Auth user, then grant admin.

    python -m server.seed_admin --email you@strategi.is
    python -m server.seed_admin --email you@strategi.is --password '...'   # non-interactive

Chicken-and-egg by design: no admin UI can exist until one admin does, so the
first admin is made here over the service connection, the same posture as the
private Storage bucket setup in supabase/migrate.py. Run it once per admin; it is
idempotent (re-running an existing email re-grants, never duplicates).

Reads SUPABASE_URL + SUPABASE_SECRET_KEY + DATABASE_URL from server/.env via the
db module. The secret key never leaves this process and is never printed. Prefer
the interactive prompt over --password so the password never lands in shell
history or the process argv (visible to `ps`).
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
import time
import urllib.error
import urllib.request

from . import db


_AUTH_ADMIN_ATTEMPTS = 6


def _auth_admin(method, path, payload=None):
    """Call the Supabase Auth Admin API with the service key. Returns parsed JSON.

    RETRIES A TRANSIENT bad_jwt, and that specific 403 is not a bad key. GoTrue sits behind
    several nodes, and after the project's move to ES256 (asymmetric) signing keys some of
    them intermittently reject a perfectly valid secret with
    403 {"error_code":"bad_jwt","msg":"...unrecognized JWT kid <nil> for algorithm ES256"}.
    The same request lands on a good node on the next try: proven live, where one org's user
    CREATE succeeded and the next failed on the identical key while every GET worked. A create
    that dies on that 403 strands a half-provisioned batch, so it is retried like the 5xx it
    behaves as, with the CMS client's backoff shape. A 403 that is NOT bad_jwt (a real
    permission problem) is returned at once: retrying it just makes the same mistake slower.
    """
    cfg = db._load_cfg()
    url = cfg.get("SUPABASE_URL", "").rstrip("/")
    key = cfg.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        sys.exit("SUPABASE_URL / SUPABASE_SECRET_KEY are not set in server/.env")
    data = json.dumps(payload).encode() if payload is not None else None

    for attempt in range(_AUTH_ADMIN_ATTEMPTS):
        req = urllib.request.Request(f"{url}{path}", method=method, data=data)
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("apikey", key)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")
            transient = exc.code >= 500 or (exc.code == 403 and "bad_jwt" in body)
            if transient and attempt < _AUTH_ADMIN_ATTEMPTS - 1:
                time.sleep(min(0.5 * (2 ** attempt), 8.0))
                continue
            return exc.code, body


def _lookup_user_id(email):
    status, body = _auth_admin("GET", "/auth/v1/admin/users?per_page=200")
    if status != 200 or not isinstance(body, dict):
        return None
    for user in (body.get("users") or []):
        if (user.get("email") or "").lower() == email.lower():
            return user.get("id")
    return None


def _create_auth_user(email, password):
    status, body = _auth_admin(
        "POST", "/auth/v1/admin/users",
        {"email": email, "password": password, "email_confirm": True})
    if status in (200, 201) and isinstance(body, dict):
        uid = body.get("id") or (body.get("user") or {}).get("id")
        if uid:
            return uid
    # An already-registered email is not fatal: find the id and grant anyway.
    text = body if isinstance(body, str) else json.dumps(body)
    if status in (409, 422) and ("registered" in text or "exists" in text):
        uid = _lookup_user_id(email)
        if uid:
            print(f"auth user already existed, reusing {uid}")
            return uid
    sys.exit(f"auth admin create failed: HTTP {status} {text[:300]}")


def main():
    ap = argparse.ArgumentParser(description="Create and grant one internal admin.")
    ap.add_argument("--email", required=True)
    ap.add_argument("--password", help="omit to be prompted (keeps it out of argv/history)")
    args = ap.parse_args()

    if not db.db_configured():
        sys.exit("DATABASE_URL is not set in server/.env; cannot reach the store.")

    password = args.password or getpass.getpass(f"Password for {args.email}: ")
    if len(password) < 8:
        sys.exit("password must be at least 8 characters")

    uid = _create_auth_user(args.email, password)
    db.q("""insert into app_admins (user_id, email) values (%s, %s)
            on conflict (user_id) do update set email = excluded.email""",
         (uid, args.email), fetch="none")
    print(f"admin granted: {args.email} ({uid})")


if __name__ == "__main__":
    main()
