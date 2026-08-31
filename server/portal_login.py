"""Provision ONE client portal login on demand, from the API rather than the CLI.

server/seed_org_users.py is the batch tool the team runs by hand; this is the single-org twin
the create-a-brand endpoint calls so a new organisation gets its login the instant it exists and
the admin sees the password ONCE. Both write to the same GoTrue users, the same org_members
grant, and the same `.env.portal-credentials` file, so a login minted here is identical to one
the CLI would mint and either tool can rotate it later.

Shared with seed_org_users on purpose: the credentials-file format, the default domain, the
client role and the password generator all come from there, so the two seeders can never write
the file two different ways. The GoTrue admin helpers come from seed_admin for the same reason.

The ONE thing this does that the CLI does not: it never calls sys.exit. The CLI is a process
that may die on a bad config; this runs inside a request handler that must not, so every failure
raises PortalLoginError, which the endpoint catches and turns into "created the brand, could not
mint the login" rather than a 500 or a dead worker. Provisioning is a SIDE EFFECT of creating a
brand, never the point of it: the brand is already written by the time this runs.
"""
from __future__ import annotations

import json

from . import clients as clients_mod
from . import db
from .seed_admin import _auth_admin, _lookup_user_id
from .seed_org_users import (
    CREDENTIALS_FILE,
    DEFAULT_DOMAIN,
    _CLIENT_ROLE,
    _gen_password,
    _read_existing,
    _write_file,
)


class PortalLoginError(Exception):
    """Provisioning could not complete. Carries operator-facing text; never a sys.exit."""


def config_ready() -> bool:
    """Whether the engine can reach the GoTrue Admin API at all. Checked before any call so
    _auth_admin's own sys.exit-on-missing-config branch is unreachable from the request path."""
    cfg = db._load_cfg()
    return bool(cfg.get("SUPABASE_URL") and cfg.get("SUPABASE_SECRET_KEY"))


def has_login(org_slug: str) -> bool:
    """True when this org already has a portal login. Adding a second brand to an org that
    already has one must NOT mint another: the one grant fans out to every brand in the org
    through the org_membership view, so a second login would be a duplicate nobody uses."""
    return db.q(
        "select 1 from org_members where org_slug = %s limit 1", (org_slug,), fetch="val"
    ) is not None


def _create_user(email: str, password: str) -> str:
    """Create the GoTrue user and return its id, raising instead of exiting. Mirrors
    seed_admin._create_auth_user, including adopting an already-registered email."""
    status, body = _auth_admin(
        "POST", "/auth/v1/admin/users",
        {"email": email, "password": password, "email_confirm": True})
    if status in (200, 201) and isinstance(body, dict):
        uid = body.get("id") or (body.get("user") or {}).get("id")
        if uid:
            return uid
    text = body if isinstance(body, str) else json.dumps(body)
    if status in (409, 422) and ("registered" in text or "exists" in text):
        uid = _lookup_user_id(email)
        if uid:
            return uid
    raise PortalLoginError(f"auth admin create failed: HTTP {status} {str(text)[:200]}")


def _record_credential(org_slug: str, name: str, email: str, password: str) -> None:
    """Add or replace ONE org's block in .env.portal-credentials, preserving every other block.

    The password is shown to the admin once and is otherwise unreadable (GoTrue never gives it
    back), so this file is the durable copy the team keeps. Written with the same _write_file as
    the CLI, so it lands 0600 and gitignored exactly the same way. This is a single-org merge of
    what seed_org_users.main does across all orgs: read what exists, replace this one, keep the
    rest, including the admin section this endpoint never touches.
    """
    existing = _read_existing(CREDENTIALS_FILE)

    admin_entries = []
    orgs: dict[str, dict] = {}
    for section in existing.sections():
        sec = existing[section]
        if section.startswith("admin:"):
            admin_entries.append({
                "email": sec.get("email", section[len("admin:"):]),
                "password": sec.get("password", "(held by operator)"),
            })
        elif section.startswith("org:"):
            slug = section[len("org:"):]
            orgs[slug] = {
                "slug": slug,
                "name": sec.get("name", slug),
                "email": sec.get("email", ""),
                "password": sec.get("password", ""),
            }

    orgs[org_slug] = {"slug": org_slug, "name": name, "email": email, "password": password}
    org_entries = sorted(orgs.values(), key=lambda e: e["slug"])
    _write_file(CREDENTIALS_FILE, admin_entries, org_entries)


def _remove_credential(org_slug: str) -> None:
    """Drop ONE org's block from .env.portal-credentials, preserving every other block.

    The mirror of _record_credential, and it reuses that function's read/rebuild shape rather
    than editing the file in place, so the admin section and every other org survive untouched
    and the file lands 0600 through the same _write_file. A block left behind after the GoTrue
    user is gone is worse than no block: it reads as a working login and is not one.
    """
    existing = _read_existing(CREDENTIALS_FILE)

    admin_entries = []
    org_entries = []
    for section in existing.sections():
        sec = existing[section]
        if section.startswith("admin:"):
            admin_entries.append({
                "email": sec.get("email", section[len("admin:"):]),
                "password": sec.get("password", "(held by operator)"),
            })
        elif section.startswith("org:"):
            slug = section[len("org:"):]
            if slug == org_slug:
                continue
            org_entries.append({
                "slug": slug,
                "name": sec.get("name", slug),
                "email": sec.get("email", ""),
                "password": sec.get("password", ""),
            })

    _write_file(CREDENTIALS_FILE, admin_entries, sorted(org_entries, key=lambda e: e["slug"]))


def _user_email(uid: str) -> str:
    """One GoTrue user's email, or "" when it cannot be read. Never raises: this is read to
    DECIDE whether a delete is safe, and an unreadable answer must fail closed, not loudly."""
    status, body = _auth_admin("GET", f"/auth/v1/admin/users/{uid}")
    if status != 200 or not isinstance(body, dict):
        return ""
    return str(body.get("email") or "")


def deprovision_one(org_slug: str, domain: str = DEFAULT_DOMAIN) -> dict:
    """Revoke the portal login of an org being deleted: the grant, the GoTrue user, the block.

    Returns {"revoked": int, "deleted_user": bool, "kept": [email, ...]}.

    THE GoTrue DELETE IS GUARDED BY THE EMAIL, and the guard is the whole safety of this
    function. org_members holds a user_id and nothing that says whose account it is, so a row
    could name a real person an admin had granted by hand, or the admin's own account. Only a
    user whose email is exactly the address provision_one mints, <org-slug>@<domain>, is a login
    this engine created FOR this org and can therefore destroy with it. Anything else keeps its
    account and only loses the grant, and is reported in `kept` so the caller can say so.
    A user id whose email cannot be read is treated as somebody else's and kept.

    ORDER MATTERS: the grant goes first. That revocation is the part that actually protects the
    deleted org's data, so it must not be skipped because a later GoTrue call failed. Everything
    after it is best effort for the same reason, and a failure to reach GoTrue leaves a dead
    account behind, never a live grant.
    """
    rows = db.q("select user_id from org_members where org_slug = %s", (org_slug,),
                fetch="all") or []
    uids = [str(row[0]) for row in rows]
    db.q("delete from org_members where org_slug = %s", (org_slug,), fetch="none")

    deleted_user = False
    kept: list[str] = []
    if config_ready():
        minted = f"{org_slug}@{domain}".lower()
        for uid in uids:
            email = _user_email(uid)
            if email.lower() != minted:
                kept.append(email or uid)
                continue
            status, _ = _auth_admin("DELETE", f"/auth/v1/admin/users/{uid}")
            # 404 counts: the account is gone, which is the state this call is for.
            if status in (200, 204, 404):
                deleted_user = True
    else:
        kept.extend(uids)

    _remove_credential(org_slug)
    return {"revoked": len(uids), "deleted_user": deleted_user, "kept": kept}


def provision_one(org_slug: str, org_name: str, domain: str = DEFAULT_DOMAIN) -> dict:
    """Mint (or adopt) the portal login for one org and record its credentials.

    Returns {"email", "password", "created"}. `password` is the fresh password when this call
    minted the user, and None when it adopted a GoTrue user that already existed (nothing can
    read an existing user's password back, so there is none to return or record). `created`
    says which happened. Raises PortalLoginError on any failure; the caller keeps the brand.
    """
    if not config_ready():
        raise PortalLoginError(
            "SUPABASE_URL / SUPABASE_SECRET_KEY are not configured, so no portal login can be "
            "minted. Run `python -m server.seed_org_users --org <slug>` once they are set.")

    # A GRANT IS THE MOMENT A COLLISION STOPS BEING INERT, so it is refused here rather than
    # left to the write guards. `org_membership` derives org_slug as
    # COALESCE(orgs.slug, clients.slug), so a slug that is both an org and a self-org brand
    # resolves to one string and this one grant would read both tenants. Two Python guards and
    # two constraint triggers already forbid that state being CREATED; none of them can reach a
    # collision already in the record, which is the case this catches.
    #
    # BEFORE THE GoTrue CALL, so a refusal leaves no user behind. The brand is already written by
    # the time this runs (provisioning is a side effect of creating one), so the caller keeps the
    # brand and reports that the login could not be minted, which is the honest outcome: better a
    # brand with no login than one login two clients share.
    try:
        clients_mod.refuse_grant_on_collision(org_slug)
    except clients_mod.InvalidClient as refused:
        raise PortalLoginError(str(refused)) from refused

    email = f"{org_slug}@{domain}"
    uid = _lookup_user_id(email)
    password = None
    created = False
    if uid is None:
        password = _gen_password()
        uid = _create_user(email, password)
        created = True

    db.q("""insert into org_members (org_slug, user_id, role) values (%s, %s, %s)
            on conflict (org_slug, user_id) do update set role = excluded.role""",
         (org_slug, uid, _CLIENT_ROLE), fetch="none")

    # Only record when we actually hold a password: an adopted user's block, if any, is already
    # in the file from whenever it was first minted, and overwriting it with a blank would erase
    # the one copy the team has.
    if password is not None:
        _record_credential(org_slug, org_name, email, password)

    return {"email": email, "password": password, "created": created}
