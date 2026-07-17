"""Auth for the engine API: Supabase Auth proxied server-side, tokens verified locally.

The frontend holds NO Supabase client and NO anon key. It talks only to this
engine, which proxies GoTrue with the secret key from server/.env, read through
db._load_cfg() and NEVER through os.environ: RULE 1 in db.py applies to this
module in full, and tests/env_check.py's canary covers it because nothing here
may touch the environment at all.

VERIFICATION IS LOCAL, not a GoTrue round trip per request. This project signs
access tokens with ES256 (probed against the live JWKS on 2026-07-18: one EC
P-256 signing key), so a request costs one signature check against a cached
JWKS, and GoTrue is only on the wire for login, refresh, and logout. The alg is
PINNED to what the project actually uses: accepting whatever the token header
claims is how alg-confusion downgrades happen. HS256 via SUPABASE_JWT_SECRET is
a FALLBACK ONLY for a project whose JWKS endpoint yields nothing usable (the
legacy shared-secret key model); it never competes with a live JWKS.

Identity (admin bit, org grants, per-brand overlay) is read over the service
connection through db.q and cached ~45s per user: six operators on one process,
so a plain dict with monotonic timestamps and a lock, the same shape as every
cache in db.py. The TTL is the revocation latency: pulling someone's grant takes
effect within a minute, which is the accepted cost of not paying three queries
per request.
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
import threading
import time
import urllib.error
import urllib.request

import jwt
from fastapi import Depends, Header, HTTPException, Query

from . import db

# Pinned to what the project's JWKS actually serves (see module docstring).
# A second entry appears here only when the project itself rotates to a new alg.
_JWKS_ALGS = ("ES256",)
_HS256_ALG = "HS256"

# Every claim check the token must survive. aud is 'authenticated' because that
# is what GoTrue stamps on a user session; a service or anon JWT does not carry
# it and must not pass as a user.
_AUDIENCE = "authenticated"

_IDENTITY_TTL_SECONDS = 45.0


class AuthError(Exception):
    """Any reason a token or a credential is not accepted. One class on purpose:
    the API answers every authentication failure identically, so distinguishing
    'expired' from 'bad signature' here would only build an oracle."""


# ---------------------------------------------------------------------------
# Config: through db._load_cfg() ONLY (RULE 1 in db.py)
# ---------------------------------------------------------------------------

def _cfg():
    cfg = db._load_cfg()
    url = (cfg.get("SUPABASE_URL") or "").rstrip("/")
    key = cfg.get("SUPABASE_SECRET_KEY") or ""
    if not (url and key):
        # Loud, never a silent open door: an engine without auth config must
        # refuse every authenticated request rather than wave them through.
        raise AuthError("SUPABASE_URL / SUPABASE_SECRET_KEY are not set in server/.env")
    return url, key


# ---------------------------------------------------------------------------
# JWKS cache: kid -> verification key
# ---------------------------------------------------------------------------
_JWKS: dict[str, object] = {}
_JWKS_LOCK = threading.Lock()
_JWKS_FETCHED_AT = 0.0
# A token with an unknown kid triggers a re-fetch (key rotation), but at most
# this often: a flood of garbage kids must not turn into a flood of fetches.
_JWKS_MIN_REFRESH_SECONDS = 60.0


def _fetch_jwks(url: str) -> dict[str, object]:
    req = urllib.request.Request(f"{url}/auth/v1/.well-known/jwks.json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise AuthError(f"JWKS fetch failed: {exc}") from exc
    keys: dict[str, object] = {}
    for entry in data.get("keys", []):
        kid = entry.get("kid")
        if not kid:
            continue
        try:
            keys[kid] = jwt.PyJWK(entry)
        except jwt.exceptions.PyJWKError:
            # An entry PyJWT cannot load (unsupported kty) is skipped, not fatal:
            # the signing key this project uses is the one that must load.
            continue
    return keys


def _signing_key(kid: str | None):
    """The cached key for this kid, re-fetching on rotation. None means the JWKS
    yielded nothing usable, which is the one state the HS256 fallback covers."""
    global _JWKS_FETCHED_AT
    url, _ = _cfg()
    with _JWKS_LOCK:
        if kid and kid in _JWKS:
            return _JWKS[kid]
        now = time.monotonic()
        if _JWKS and now - _JWKS_FETCHED_AT < _JWKS_MIN_REFRESH_SECONDS:
            # A live cache without this kid, refreshed recently: the kid is
            # garbage, not a rotation we have yet to see.
            raise AuthError(f"unknown signing key {kid!r}")
        _JWKS.update(_fetch_jwks(url))
        _JWKS_FETCHED_AT = time.monotonic()
        if kid and kid in _JWKS:
            return _JWKS[kid]
        if _JWKS:
            raise AuthError(f"unknown signing key {kid!r}")
        return None


def verify_token(token: str) -> dict:
    """Local verification: signature against the JWKS, exp, aud, sub required.
    Returns the claims. Raises AuthError on every failure, one message shape."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.exceptions.InvalidTokenError as exc:
        raise AuthError(f"malformed token: {exc}") from exc

    key = _signing_key(header.get("kid"))
    if key is not None:
        algs = list(_JWKS_ALGS)
    else:
        # JWKS yielded nothing usable: the legacy shared-secret model. Only then
        # does SUPABASE_JWT_SECRET verify, and only as HS256.
        secret = db._load_cfg().get("SUPABASE_JWT_SECRET") or ""
        if not secret:
            raise AuthError("JWKS is empty and SUPABASE_JWT_SECRET is not set")
        key, algs = secret, [_HS256_ALG]

    try:
        return jwt.decode(
            token, key=key, algorithms=algs, audience=_AUDIENCE,
            options={"require": ["exp", "sub"]},
        )
    except jwt.exceptions.InvalidTokenError as exc:
        raise AuthError(f"token rejected: {exc}") from exc


# ---------------------------------------------------------------------------
# Identity: who this user is to THIS app, cached ~45s
# ---------------------------------------------------------------------------

@dataclasses.dataclass(frozen=True)
class Identity:
    user_id: str
    email: str
    is_admin: bool
    # Non-admin only: the orgs this user can see, ({"slug","name"}, ...), and the
    # brand -> role map ('admin' | 'viewer' | 'commenter'). Both empty for an
    # admin, whose scope is everything and is never enumerated here.
    orgs: tuple = ()
    roles: dict = dataclasses.field(default_factory=dict)


_IDENTITY_CACHE: dict[str, tuple[float, Identity]] = {}
_IDENTITY_LOCK = threading.Lock()


def _load_identity(user_id: str, email: str) -> Identity:
    if db.q("select 1 from app_admins where user_id = %s", (user_id,), fetch="val"):
        return Identity(user_id=user_id, email=email, is_admin=True)

    # The org grant fans out to every live brand in the org through the same
    # org_membership view the schema derives /api/orgs from, so a brand moving
    # between orgs moves the user's access with it, for free.
    org_rows = db.q(
        """select om.org_slug, m.org_name, m.client_slug, om.role
           from org_members om
           join org_membership m on m.org_slug = om.org_slug
           where om.user_id = %s""",
        (user_id,))
    # The per-brand overlay. Applied second so its role WINS over the org role
    # for that one brand, which is what an overlay is for.
    member_rows = db.q(
        """select c.slug, cm.role, m.org_slug, m.org_name
           from client_members cm
           join clients c on c.id = cm.client_id and c.deleted_at is null
           left join org_membership m on m.client_id = c.id
           where cm.user_id = %s""",
        (user_id,))

    roles: dict[str, str] = {}
    orgs: dict[str, str] = {}
    for org_slug, org_name, client_slug, role in org_rows:
        roles[client_slug] = role
        orgs[org_slug] = org_name
    for client_slug, role, org_slug, org_name in member_rows:
        roles[client_slug] = role
        if org_slug:
            orgs[org_slug] = org_name
    return Identity(
        user_id=user_id, email=email, is_admin=False,
        orgs=tuple({"slug": slug, "name": name} for slug, name in sorted(orgs.items())),
        roles=roles,
    )


def identity_for(user_id: str, email: str) -> Identity:
    now = time.monotonic()
    with _IDENTITY_LOCK:
        hit = _IDENTITY_CACHE.get(user_id)
        if hit and now - hit[0] < _IDENTITY_TTL_SECONDS:
            return hit[1]
    identity = _load_identity(user_id, email)
    with _IDENTITY_LOCK:
        _IDENTITY_CACHE[user_id] = (time.monotonic(), identity)
    return identity


def scoped_slugs(identity: Identity) -> set[str] | None:
    """The brand slugs this identity may read: None means ALL (admin)."""
    if identity.is_admin:
        return None
    return set(identity.roles)


# ---------------------------------------------------------------------------
# FastAPI dependencies
# ---------------------------------------------------------------------------

def _bearer_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _unauthenticated() -> HTTPException:
    # One message for every failure mode, so the response never narrates which
    # check a probe got past.
    return HTTPException(status_code=401, detail="authentication required")


async def _authenticate(token: str | None) -> Identity:
    if not token:
        raise _unauthenticated()

    def resolve():
        claims = verify_token(token)
        return identity_for(str(claims["sub"]), str(claims.get("email") or ""))

    # to_thread because both halves can block: a cold JWKS fetch is a network
    # call and a cold identity is three queries, and neither belongs on the
    # event loop. This is the same sync-DAL-behind-to_thread posture db.py names.
    try:
        return await asyncio.to_thread(resolve)
    except AuthError:
        raise _unauthenticated()


async def require_user(authorization: str | None = Header(default=None)) -> Identity:
    """401 without a valid bearer token; the resolved Identity with one."""
    return await _authenticate(_bearer_token(authorization))


async def require_user_sse(
    authorization: str | None = Header(default=None),
    access_token: str | None = Query(default=None),
) -> Identity:
    """The SSE route's variant, and ONLY the SSE route's: EventSource cannot set
    headers, so ?access_token= is accepted there. The header wins when both are
    present, so a tampered query string cannot downgrade a real session."""
    return await _authenticate(_bearer_token(authorization) or access_token)


async def require_admin(user: Identity = Depends(require_user)) -> Identity:
    """The write gate. Every mutation and generation is admin-only, except the
    answers route, which does its own role check in app.py."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="admin access required")
    return user


# ---------------------------------------------------------------------------
# GoTrue proxies: login, refresh, logout. Sync (urllib, like db._storage);
# app.py wraps them in asyncio.to_thread.
# ---------------------------------------------------------------------------

def _gotrue_token(grant_type: str, payload: dict) -> dict:
    url, key = _cfg()
    req = urllib.request.Request(
        f"{url}/auth/v1/token?grant_type={grant_type}",
        method="POST", data=json.dumps(payload).encode())
    # The secret key rides as apikey, server-side only. This is the whole reason
    # the frontend needs no Supabase key of any kind.
    req.add_header("apikey", key)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raise AuthError(f"gotrue {grant_type} grant refused: HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        raise AuthError(f"gotrue unreachable: {exc}") from exc


def _session_payload(body: dict) -> dict:
    """EXACTLY the contract shape, nothing more: GoTrue's response carries fields
    (weak_password, full user metadata) the frontend has no business seeing."""
    user = body.get("user") or {}
    if not (body.get("access_token") and body.get("refresh_token")):
        raise AuthError("gotrue answered 200 without a session")
    return {
        "access_token": body["access_token"],
        "refresh_token": body["refresh_token"],
        "expires_in": body.get("expires_in"),
        "expires_at": body.get("expires_at"),
        "user": {"id": user.get("id"), "email": user.get("email")},
    }


def login(email: str, password: str) -> dict:
    return _session_payload(_gotrue_token("password", {
        "email": email, "password": password,
    }))


def refresh(refresh_token: str) -> dict:
    return _session_payload(_gotrue_token("refresh_token", {
        "refresh_token": refresh_token,
    }))


def logout(refresh_token: str) -> None:
    """Best effort, never raises. GoTrue revokes by ACCESS token, not refresh
    token, so the only server-side path in from a refresh token is to redeem it
    first and then revoke the session it belongs to. A refresh token that no
    longer redeems is a session already dead, which is the outcome logout wants."""
    try:
        body = _gotrue_token("refresh_token", {"refresh_token": refresh_token})
        access = body.get("access_token")
        if not access:
            return
        url, key = _cfg()
        req = urllib.request.Request(f"{url}/auth/v1/logout", method="POST", data=b"")
        req.add_header("apikey", key)
        req.add_header("Authorization", f"Bearer {access}")
        with urllib.request.urlopen(req, timeout=30):
            pass
    except (AuthError, urllib.error.URLError, urllib.error.HTTPError, OSError):
        return
