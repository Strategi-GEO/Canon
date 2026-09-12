"""FastAPI layer over server.runner and server.roadmap.

Pure glue: parsing lives in roadmap.py, dispatch and concurrency live in
runner.py. This module owns HTTP validation at the boundary (a bad row must
fail at submit time, never twenty minutes into a run), the SSE tailer over
status.jsonl files, and the whitelisted output-file reader.

WHERE READS GO since the Supabase rewire: the record (Postgres, through db.py
and the rewired modules) answers every route for a SETTLED topic or client,
and the SCRATCH tree under outputs/ answers only while a LIVE run holds the
topic, because agents write scratch and the runner commits it to the record at
the terminal line. Each site that makes that choice says so in one sentence.

Run with ONE uvicorn worker. The client lock and topic semaphore in runner.py
are in-process primitives, so --workers N silently multiplies the cap to 5N.
"""
# CA CERTIFICATES, BEFORE ANY HTTPS. The desktop app ships a portable Python with no CA bundle
# wired into OpenSSL's default paths, so every urllib HTTPS call (GoTrue login/JWKS in auth.py,
# Supabase Storage in db.py, app updates in app_update.py) fails CERTIFICATE_VERIFY_FAILED.
# certifi is always installed (httpx depends on it); point OpenSSL at it unless an operator set
# SSL_CERT_FILE themselves. setdefault, so a corporate/system bundle a deployment exports still
# wins. Must run before the `from . import ... auth ...` below, which is why it is at the very top.
import os as _os
try:
    import certifi as _certifi
    _os.environ.setdefault("SSL_CERT_FILE", _certifi.where())
except Exception:  # noqa: BLE001 (no certifi = fall back to the platform default, never crash boot)
    pass

import asyncio
import json
import logging
import mimetypes
import os
import re
import shutil
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, JSONResponse, PlainTextResponse,
                               StreamingResponse)
from pydantic import BaseModel

from . import analysis_gen, auth, blog_edit, blog_upload, client_answers, db, describe, discovery, docx_export, facts_gen, ledger, notify, portal_login, report_gen, repurpose, roadmap, roadmap_gen, runner, sync
# Aliased: many channel routes take a `channel` path param that would shadow the bare module.
from . import channel as channel_mod
# Aliased for the same reason clients is: "questions" is the natural name for the list of
# questions inside a handler, and the shadowing bug that causes is silent.
from . import questions as questions_mod
# Aliased: "clients" is the natural name for a list of clients inside a handler, and the
# shadowing bug that causes is silent.
from . import clients as clients_mod
# The CMS push. A self-contained package hanging off one operator action, so it attaches
# here as a router and nowhere else: no pipeline module imports it, and deleting
# server/cms/ plus these two lines removes the feature whole.
from .cms import router as cms_router
from .cms import routes as cms_routes  # for the after-publish hook (channel auto-repurpose)
# The blog-destination routes below. cms/ stays deletable whole: these four endpoints go with
# it, and nothing in the generation pipeline imports any of them.
from .cms import http as cms_http
from .cms import sites as cms_sites
from .cms import wordpress as cms_wordpress

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_HTML = REPO_ROOT / "web" / "index.html"

# The only files the output endpoint will ever serve. Anything else is a 404,
# which doubles as the path-traversal guard for the name segment.
OUTPUT_WHITELIST = {"blog.md", "eval.md", "dossier.md", "status.jsonl", "links-verified.txt"}

SSE_POLL_SECONDS = 0.5
SSE_HEARTBEAT_SECONDS = 15

log = logging.getLogger("geo-factory")

app = FastAPI(title="geo-factory", docs_url=None, redoc_url=None)

# The legacy UI in web/ is served from this same process and needs no CORS at all. The
# Next.js dashboard does: it runs on localhost:3000 in dev while this API stays on 8000, so
# every fetch it makes is cross origin. This allowance is an explicit origin list and nothing
# else. It is NOT a public API: no wildcard, and credentials stay off, so a page on any other
# origin cannot read a response and no browser will attach cookies to these calls.
#
# GEO_DASHBOARD_ORIGINS (comma separated) replaces the default list. It exists because port
# 3000 is often already taken: without it, a dashboard started on any other port gets its
# preflight refused and every fetch plus the SSE run feed dies, with nothing in the engine to
# turn. Setting it is a deliberate act, so the default stays the two dev origins.
DEFAULT_DASHBOARD_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"]


def _dashboard_origins():
    raw = os.environ.get("GEO_DASHBOARD_ORIGINS", "")
    origins = [item.strip() for item in raw.split(",") if item.strip()]
    return origins or DEFAULT_DASHBOARD_ORIGINS


DASHBOARD_DEV_ORIGINS = _dashboard_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=DASHBOARD_DEV_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

async def _cms_admin_gate(request: Request,
                          user: auth.Identity = Depends(auth.require_admin)):
    """The CMS router's admin gate, plus the one fact its routes need FROM the identity.

    require_admin already refuses a non-admin, and that alone was the whole dependency
    until publishes became attributable (012). server/cms/ imports no auth module and is
    deletable whole, so it cannot take an Identity as a parameter, and the email reaches it
    as a plain string on request.state instead. This is the seam: app.py knows about auth,
    server/cms/ knows about a string, and neither knows about the other's type.
    """
    request.state.admin_email = user.email
    return user


# The CMS push is a write, so it rides behind the admin gate like every other
# mutation. Attached here rather than inside the router so server/cms/ keeps
# knowing nothing about auth and stays deletable whole.
app.include_router(cms_router, dependencies=[Depends(_cms_admin_gate)])


@app.on_event("startup")
async def _warn_single_worker():
    log.warning(
        "geo-factory must run on ONE uvicorn worker: the blog queue is an "
        "in-process primitive in runner.py, so --workers N breaks the "
        "concurrency cap (it becomes N times GEO_CONCURRENCY)."
    )


@app.on_event("startup")
async def _export_agent_credentials():
    """Put the agent's credentials in os.environ before anything can open a session.

    FIRST STARTUP HOOK AND IT HAS TO BE, because everything downstream reads the result: the
    dispatch-time refusal in runner._stdio_mcp_config_ok reads os.environ, agent_env() filters
    os.environ, and .mcp.json interpolates out of the child environment. A packaged install gets
    its keys as a server/.env written after login, which db._load_cfg parses into a PRIVATE dict
    that deliberately never touches os.environ, so without this line a fully provisioned machine
    still ran every session with no research tools and no explanation. See db.export_agent_credentials.

    Logged by NAME and never by value, and at warning level when nothing moved on a machine that
    has no research credentials at all, because that machine is about to refuse every blog run and
    the reason belongs in the log the operator will actually look at.
    """
    moved = db.export_agent_credentials()
    if moved:
        log.info("exported %d agent credential(s) from server/.env: %s",
                 len(moved), ", ".join(sorted(moved)))
    ok, reason = runner.check_real_mode_ready()
    if not ok:
        log.warning("THIS ENGINE CANNOT RESEARCH AND WILL REFUSE EVERY BLOG RUN: %s", reason)


# Strong references to fire-and-forget startup tasks, so the reconciler cannot
# be garbage collected mid-sweep. Discarded by done-callback.
_STARTUP_TASKS = set()


@app.on_event("startup")
async def _reconcile_on_startup():
    """Commit whatever a crash stranded on scratch, without holding the port.

    The runner commits a topic's scratch to the record at its terminal line, so a
    process that died between the two leaves disk ahead of the record, and this
    sweep is what makes commit-at-terminal safe. It runs as a background task in
    a worker thread and NEVER blocks serving: the server must come up even when
    the database is briefly unreachable, and requests then fail loudly on their
    own rather than the whole app refusing to start.
    """
    async def sweep():
        try:
            committed = await asyncio.to_thread(sync.reconcile_all)
        except Exception:
            log.exception("startup reconcile failed; serving anyway")
            return
        # WARNING, not INFO, for the same reason _warn_single_worker is: under
        # default logging INFO never reaches stderr, and a crash-recovery sweep
        # that ran invisibly is one nobody can confirm ran. One line per boot.
        if committed:
            log.warning(
                "startup reconcile committed %d stranded topic(s): %s",
                len(committed),
                ", ".join(f"{client}/{topic}" for client, topic in committed),
            )
        else:
            log.warning("startup reconcile: record and scratch agree (0 topics committed)")

    task = asyncio.create_task(sweep())
    _STARTUP_TASKS.add(task)
    task.add_done_callback(_STARTUP_TASKS.discard)


@app.on_event("startup")
async def _start_queue_watchdog():
    """The one thing standing between a wedged session and a bricked engine.

    A blog session that stops responding holds its queue slot forever, because `async with`
    releases only when a coroutine UNWINDS and a task suspended in a thread never does. At the
    default width of two, two of those halt every brand in the repo until someone restarts this
    process, silently: the dashboard shows every topic queued and none running, which is exactly
    what an idle engine looks like. runner.queue_watchdog reclaims the slot; /api/queue is how
    anyone can tell the two apart. See the block above runner.topic_slot.

    Started here rather than lazily on the first run, because the failure it catches is one the
    run itself cannot notice, and one tick per minute over an idle engine costs a stat() of
    nothing.
    """
    task = asyncio.create_task(runner.queue_watchdog())
    _STARTUP_TASKS.add(task)
    task.add_done_callback(_STARTUP_TASKS.discard)


@app.on_event("startup")
async def _fail_stranded_comment_applies():
    """A comment apply lives in an in-memory task, so a restart orphans any comment this
    engine left marked applying: it would hold the in-flight cap, refuse dismissal, and
    disable the stage's Edit button forever. Failing it with a reason at boot is the
    recovery door. The sweep is AGE-GUARDED now that comments live on the shared record,
    on applying_since rather than created_at (a young applying row may be another
    machine's live apply, and an old comment retried a minute ago is one too; see
    reconcile_stranded),
    and it runs as a background task for the same reason the reconcile sweep above does:
    the server must come up even when the database is briefly unreachable."""
    async def sweep():
        try:
            await asyncio.to_thread(blog_edit.reconcile_stranded)
            await asyncio.to_thread(channel_mod.reconcile_stranded)
        except Exception:
            log.exception("stranded-comment sweep failed; serving anyway")

    task = asyncio.create_task(sweep())
    _STARTUP_TASKS.add(task)
    task.add_done_callback(_STARTUP_TASKS.discard)


@app.on_event("startup")
async def _client_answers_pickup():
    """OPT-IN automation for the revises portal-submitted answers are owed.

    The client portal writes answers into review_notes with no engine behind it
    (supabase/migrations/002_client_portal.sql). The PRIMARY path for the revise
    those answers are owed is the operator's own click: the dashboard shows the
    client-answered form and POST .../revise dispatches it, so a person chooses
    the moment this machine's quota is spent. This sweep is the optional hands-off
    variant, DISABLED BY DEFAULT for exactly that billing reason: only a machine
    started with GEO_ANSWERS_PICKUP=1 dispatches automatically (at startup and
    every five minutes, behind the same cross-machine claim the rerun route takes).
    """
    if os.environ.get("GEO_ANSWERS_PICKUP", "0") != "1":
        return

    def dispatch(slug, topic_slug):
        run_id = uuid.uuid4().hex
        runner.register_revise_run(run_id, slug, topic_slug)
        task = asyncio.create_task(_revise_task(run_id, slug, topic_slug))
        runner.register_run_task(run_id, task)
        task.add_done_callback(lambda _task: runner._discard_run_task(run_id))
        return task

    task = asyncio.create_task(
        client_answers.run_forever(
            dispatch,
            lambda slug, topic_slug: topic_slug in _live_run_slugs(slug)))
    _STARTUP_TASKS.add(task)
    task.add_done_callback(_STARTUP_TASKS.discard)


@app.on_event("startup")
async def _admin_email_notifications():
    """Poll for the things a CLIENT did and mail the operator about them.

    Separate from the pickup sweep above and deliberately NOT conditional on it: that one is off
    by default because it spends this machine's quota, while this one only reads and sends mail.
    The two answer different questions about the same event, and an operator who has not enabled
    automatic pickup is precisely the operator who needs telling that a rerun is owed.

    server/notify.py turns itself off when the machine has no RESEND_API_KEY, so this is a no-op
    on every machine that has not configured one.
    """
    task = asyncio.create_task(notify.run_forever())
    _STARTUP_TASKS.add(task)
    task.add_done_callback(_STARTUP_TASKS.discard)


# ---------------------------------------------------------------------------
# Auth: the login proxy, the health probe, and /api/me.
#
# THE UNAUTHENTICATED SURFACE IS EXACTLY FIVE ROUTES: GET / (the legacy static
# index), GET /api/health, and the three auth routes below. Everything else
# under /api carries auth.require_user (or require_admin, which depends on it),
# attached per route so tests/auth_check.py can introspect app.routes and fail
# the build on any route that forgot. Token verification is local (see auth.py);
# GoTrue is only on the wire for the three proxies here.
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    email: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


@app.get("/api/health")
async def api_health():
    # What run.sh polls for engine-up. It replaced /api/clients as the probe
    # target because that route now 401s an anonymous poll, and a poll that can
    # never succeed burns its whole timeout on a healthy engine.
    return {"ok": True}


@app.post("/api/login")
async def api_login(body: LoginRequest):
    # to_thread: the proxy is a blocking urllib call, matching the sync-DAL
    # posture db.py names. One 401 message for every failure mode, so the
    # response never says which of email or password was wrong.
    try:
        return await asyncio.to_thread(auth.login, body.email, body.password)
    except auth.AuthError:
        raise HTTPException(status_code=401, detail="invalid email or password")


@app.post("/api/refresh")
async def api_refresh(body: RefreshRequest):
    try:
        return await asyncio.to_thread(auth.refresh, body.refresh_token)
    except auth.AuthError:
        raise HTTPException(status_code=401, detail="invalid refresh token")


@app.post("/api/logout", status_code=204)
async def api_logout(body: LogoutRequest):
    # Best effort by contract: a logout must always succeed from the browser's
    # side, because the client is discarding its tokens either way and an error
    # here would leave it holding a session it already decided to end.
    await asyncio.to_thread(auth.logout, body.refresh_token)
    return None


@app.get("/api/me")
async def api_me(user: auth.Identity = Depends(auth.require_user)):
    if user.is_admin:
        # Everything, unfiltered, exactly as the pre-auth app answered: the org
        # and client lists ARE the admin's scope.
        orgs = [{"slug": org["slug"], "name": org["name"]}
                for org in clients_mod.list_orgs()]
        slugs = [entry["slug"] for entry in clients_mod.list_clients()]
    else:
        orgs = list(user.orgs)
        slugs = sorted(user.roles)
    return {"user_id": user.user_id, "email": user.email,
            "is_admin": user.is_admin, "orgs": orgs, "clients": slugs}


# ---------------------------------------------------------------------------
# App version + in-place update (desktop app only)
# ---------------------------------------------------------------------------
# app_update.py lives at the tree root beside launcher.py, and the engine runs from that tree,
# so `import app_update` resolves to the live tree it would swap. Imported lazily inside the
# handlers so any problem in it can never stop the engine from starting. These routes are only
# reachable on the desktop app: the hosted Vercel build has no engine behind /api and the
# Settings panel that calls them is hidden there (HOSTED_READONLY), so the client dashboard never
# touches this. See app_update.py for the two-phase (stage now, apply at next launch) design.

@app.get("/api/app/version")
async def api_app_version(user: auth.Identity = Depends(auth.require_user)):
    import app_update
    return {"version": app_update.current_version()}


def _any_live_run():
    """Any brand's run live right now. The app updater refuses while one is: applying an update
    restarts the whole app, and a restart mid-run kills that live Claude session."""
    return any(run.get("live") for run in runner.list_runs())


@app.get("/api/app/update/check")
async def api_app_update_check(user: auth.Identity = Depends(auth.require_admin)):
    # runs_active rides along so the panel can DISABLE the button and say why, rather than letting
    # the operator click into a 409. The POST re-checks it authoritatively, since a run can start
    # between this read and the click.
    import app_update
    result = await asyncio.to_thread(app_update.check)
    result["runs_active"] = _any_live_run()
    return result


@app.post("/api/app/update")
async def api_app_update(user: auth.Identity = Depends(auth.require_admin)):
    # NEVER update while a blog run (a live local Claude session) is in flight: the tray restart
    # that applies the update would kill it. This is the authoritative guard; the panel also
    # disables the button off the check's runs_active, but a run can start after that read.
    if _any_live_run():
        raise HTTPException(
            status_code=409,
            detail="A blog is generating right now. Wait for it to finish, then update.")
    # Downloads and stages the newest package. stage() writes the pending marker; the tray watcher
    # sees it and RESTARTS THE APP to apply it, so the response says restarting rather than asking
    # the operator to restart. A "no update / bad checksum / cannot reach Storage" comes back 400
    # with the reason, not a bare 500.
    import app_update
    try:
        result = await asyncio.to_thread(app_update.stage)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001 (surface the reason instead of a blank 500)
        raise HTTPException(status_code=500, detail=f"update failed: {exc}")
    return {**result, "restarting": True}


def _scope(user):
    """The brand slugs this caller may read, or None for see-everything.

    Accepts a non-Identity by design: tests (config_check.py) call handlers as
    plain functions, where Depends is never resolved and its sentinel lands
    here. Treating that as unscoped is safe because the sentinel cannot arrive
    over HTTP: FastAPI always resolves the dependency, and an unauthenticated
    request dies in require_user before any handler runs."""
    if isinstance(user, auth.Identity):
        return auth.scoped_slugs(user)
    return None


# ---------------------------------------------------------------------------
# Clients and preflight
# ---------------------------------------------------------------------------

# Mirrors the client_slug domain in supabase/schema.sql, underscore fixtures
# included. Kept as a guard in front of every record lookup: the old directory
# stat rejected traversal for free, and this is that guard's record-era twin.
_CLIENT_SLUG_RE = re.compile(r"^_?[a-z0-9]+(-[a-z0-9]+)*$")


def _client_or_404(slug, user=None):
    """The client must be a live clients row AND inside the caller's scope:
    record-backed, the disk is never asked. Out of scope answers the SAME 404 as
    does-not-exist, deliberately: a non-admin must not be able to distinguish a
    brand they cannot see from a brand that is not there."""
    scope = _scope(user)
    if (not _CLIENT_SLUG_RE.fullmatch(slug)
            or (scope is not None and slug not in scope)
            or not clients_mod.exists(slug)):
        raise HTTPException(status_code=404, detail=f"unknown client {slug!r}")


# One string for the one preflight refusal, shared by the per-slug check and the
# batched list read below so the two can never phrase the same "no" differently.
_PREFLIGHT_PLACEHOLDER_REASON = (
    "canonical-facts.md still contains the token PLACEHOLDER "
    "and has not been reviewed"
)


def _preflight(slug):
    """Mirror runner.run_topic's real-mode refusal so the operator hears the
    same 'no' at submit time instead of after a dispatch. Reads the record's
    canonical_facts column: scratch is only trusted mid-run, and preflight runs
    before a run exists.

    MISSING canonical facts are no longer a refusal, and that is the whole of this
    feature: the run builds the fact base first and waits, so refusing here would make a
    newly onboarded brand permanently ungenerable. The UI reads has_canonical_facts to tell
    the operator their first run starts with a long fact-gathering session.

    PLACEHOLDER still refuses, and must. That token means a human started the fact base and
    has not finished reviewing it. Generating over their work and running against their
    half-finished rules are both wrong, so the engine does neither and says so.
    """
    facts = db.q(
        "select canonical_facts from clients where slug = %s and deleted_at is null",
        (slug,), fetch="val")
    if facts is None:
        return True, None
    if "PLACEHOLDER" in facts:
        return False, _PREFLIGHT_PLACEHOLDER_REASON
    return True, None


@app.get("/")
async def index():
    if not INDEX_HTML.is_file():
        raise HTTPException(status_code=404, detail="web/index.html not found")
    return FileResponse(INDEX_HTML)


@app.get("/api/clients")
async def api_clients(user: auth.Identity = Depends(auth.require_user)):
    # Record-backed, and a pure read at last: the old onboarding side effects
    # (mkdir outputs/<slug>/, seed generated.csv) are gone because create_client
    # and run start own onboarding now, and a GET that writes is a GET that
    # surprises. Every field rides in on the record entry.
    # Scoped: a non-admin sees only the brands their grants name, and nothing in
    # the response betrays how many others exist.
    scope = _scope(user)
    # ONE batched read for every client's preflight flag instead of _preflight's
    # per-slug query inside the loop. The generated preflight_ok column encodes
    # exactly _preflight's rule (facts absent passes, PLACEHOLDER refuses), so
    # the flags cannot disagree with what submit time will say.
    preflight_map = dict(db.q(
        "select slug, preflight_ok from clients where deleted_at is null"))
    client_list = []
    for entry in clients_mod.list_clients():
        if scope is not None and entry["slug"] not in scope:
            continue
        # The original keys stay exactly as they were, so the legacy UI keeps working while
        # the dashboard reads the onboarding fields alongside them.
        ok = bool(preflight_map.get(entry["slug"], True))
        entry["preflight"] = {"ok": ok,
                              "reason": None if ok else _PREFLIGHT_PLACEHOLDER_REASON}
        client_list.append(entry)
    return {"clients": client_list}


# ---------------------------------------------------------------------------
# Organisations: a grouping over brands, computed on read.
#
# An org is the agency's client; a brand is the engine's unit of work. The grouping is
# derived from each brand's gates.json, so there is no orgs/ directory and no second config
# file that could drift out of sync with the brands it groups.
# ---------------------------------------------------------------------------

def _scoped_orgs(user):
    """list_orgs cut down to the caller's scope: orgs with no visible brand
    vanish whole, and a visible org lists only the brands the caller may see."""
    orgs = clients_mod.list_orgs()
    scope = _scope(user)
    if scope is None:
        return orgs
    filtered = []
    for org in orgs:
        brands = [brand for brand in org["brands"] if brand["slug"] in scope]
        if brands:
            filtered.append({**org, "brands": brands})
    return filtered


@app.get("/api/orgs")
async def api_orgs(user: auth.Identity = Depends(auth.require_user)):
    return {"orgs": _scoped_orgs(user)}


@app.get("/api/orgs/{org_slug}")
async def api_org(org_slug: str, user: auth.Identity = Depends(auth.require_user)):
    # Resolved against the SCOPED list, so an org outside a non-admin's grants
    # answers the same 404 as one that does not exist.
    for org in _scoped_orgs(user):
        if org["slug"] == org_slug:
            return org
    raise HTTPException(status_code=404, detail=f"unknown organisation {org_slug!r}")


@app.delete("/api/orgs/{org_slug}", status_code=204)
async def api_delete_org(org_slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Delete an EMPTY organisation and revoke its client portal login. Admin only.

    409 while the org still holds brands, naming them: a brand carries the blogs, the roadmap and
    the resources, and each one has its own two-gate delete in Settings. One org confirm standing
    in for all of them would be the widest destructive press in the app.

    THE GRANT GOES WITH THE ROW, and that ordering is the point rather than tidiness. Deleting
    the orgs row alone leaves org_members holding a live grant on that slug, and org_membership
    derives its org_slug as COALESCE(orgs.slug, clients.slug), so the next brand created with
    that same slug and no org of its own would inherit the dead org's login and be readable by
    whoever held it. The revoke runs FIRST for that reason: a failure then leaves an org nobody
    deleted, which is recoverable, where the other order leaves a grant nobody can see.
    """
    if clients_mod.read_org(org_slug) is None:
        raise HTTPException(status_code=404, detail=f"unknown organisation {org_slug!r}")
    # BEFORE the revoke, which is irreversible. Taking the refusal after it would mean a 409 an
    # operator reads as "nothing happened" while the org's portal login had already been
    # destroyed. hard_delete_org re-checks; this is the one that runs in time.
    try:
        await asyncio.to_thread(clients_mod.assert_org_empty, org_slug)
    except clients_mod.InvalidClient as refused:
        raise HTTPException(status_code=409, detail=str(refused)) from refused
    revoked = await asyncio.to_thread(portal_login.deprovision_one, org_slug)
    await asyncio.to_thread(clients_mod.hard_delete_org, org_slug)
    log.info("deleted organisation %s (revoked %d grant(s), auth user deleted: %s)",
             org_slug, revoked["revoked"], revoked["deleted_user"])
    return None


# ---------------------------------------------------------------------------
# Onboarding: create and edit a client, and manage its Resources.
# ---------------------------------------------------------------------------

class CreateClientRequest(BaseModel):
    name: str
    domain: str = ""
    industry: str = ""
    # Geography + language ("India, English"): what DataForSEO validates keywords against.
    # Asked at onboarding because the old workflow (hand-editing client.md's Market section)
    # was never surfaced anywhere, so every brand shipped without one and DataForSEO was
    # skipped on every run.
    market: str = ""
    description: str = ""
    # Optional: omitted means the brand is its own single-brand org, the common case.
    organisation_name: str = ""


class UpdateClientRequest(BaseModel):
    # All optional and all default None, so a PATCH carrying one field cannot blank the
    # others. None means "not sent", which clients.update_client reads as "do not write".
    description: Optional[str] = None
    name: Optional[str] = None
    organisation_name: Optional[str] = None
    # domain was MISSING here while the settings page sent it and toasted "Saved". Pydantic
    # drops an unmodelled key silently, so the operator changed a brand's domain, saw a
    # success toast, and the record never moved. The engine then researched against the old
    # site. Added to the model AND to update_client together, because either half alone
    # reproduces the same silent success one level down.
    #
    # industry is UNMODELLED here ON PURPOSE, the deliberate twin of that accident: the
    # describe session detects it from the brand website (server/describe.py ->
    # clients.set_onboarding_industry) and nobody edits it after, so the silent drop is now
    # the refusal. The settings page no longer offers the field.
    domain: Optional[str] = None
    # Same rule as domain: modelled here AND forwarded in api_update_client, or the settings
    # page's key is dropped and the operator sees "Saved" over a record that never moved.
    # Empty string clears the market; None means "not sent".
    market: Optional[str] = None
    # The brand's standing blog instructions, same rule as domain/industry: modelled here AND
    # forwarded in api_update_client, or an unmodelled key is dropped and the operator sees
    # "Saved" over a record that never moved. Empty string clears them; None means "not sent".
    custom_instructions: Optional[str] = None
    # The CMS's own routing slug for this brand. Same modelled-here-AND-forwarded rule as the
    # others: drop either half and the Settings key vanishes silently. Empty string clears it and
    # the publish payload falls back to the brand slug; None means "not sent".


def _read_client_or_404(slug, user=None):
    # Scope first, and out of scope IS the same 404 as unknown: see _client_or_404.
    scope = _scope(user)
    if scope is not None and slug not in scope:
        raise HTTPException(status_code=404, detail=f"unknown client {slug!r}")
    try:
        return clients_mod.read_client(slug)
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/industries", dependencies=[Depends(auth.require_user)])
async def api_industries():
    return {"industries": clients_mod.list_industries()}


@app.post("/api/clients", status_code=201)
async def api_create_client(body: CreateClientRequest,
                            user: auth.Identity = Depends(auth.require_admin)):
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="name is required")
    try:
        client = clients_mod.create_client(
            body.name,
            body.domain,
            body.industry,
            description=body.description,
            organisation_name=body.organisation_name,
            market=body.market,
        )
    except clients_mod.ClientExists as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except clients_mod.InvalidClient as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Mint the client portal login now, so a new organisation gets its credentials the instant it
    # exists and the admin is shown the password ONCE (below, in the create response). BEST-EFFORT
    # and strictly after the brand is written: the brand is the point, the login is a side effect,
    # and a GoTrue hiccup must never turn a good create into a 500. A brand joining an org that
    # already has a login mints nothing (has_login), because the one grant already fans out to it.
    # `portal_login` in the response is the fresh password when this call minted one, else null.
    portal = None
    try:
        org = client.get("organisation") or {}
        org_slug, org_name = org.get("slug"), org.get("name") or org.get("slug")
        if org_slug and not portal_login.has_login(org_slug):
            result = await asyncio.to_thread(portal_login.provision_one, org_slug, org_name)
            if result.get("password"):
                portal = {"email": result["email"], "password": result["password"]}
    except Exception:
        # Logged, never raised: the operator can still mint the login with
        # `python -m server.seed_org_users --org <slug>`, and the brand already exists.
        log.exception("portal login provisioning failed for %s", client.get("slug"))

    return {**client, "portal_login": portal}


@app.get("/api/clients/{slug}")
async def api_client(slug: str, user: auth.Identity = Depends(auth.require_user)):
    return _read_client_or_404(slug, user)


@app.patch("/api/clients/{slug}")
async def api_update_client(slug: str, body: UpdateClientRequest,
                            user: auth.Identity = Depends(auth.require_admin)):
    try:
        return clients_mod.update_client(
            slug,
            description=body.description,
            name=body.name,
            organisation_name=body.organisation_name,
            domain=body.domain,
            market=body.market,
            custom_instructions=body.custom_instructions,
        )
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except clients_mod.InvalidClient as exc:
        raise HTTPException(status_code=422, detail=str(exc))


# ---------------------------------------------------------------------------
# The blog destination (migration 035)
# ---------------------------------------------------------------------------
# ADMIN ONLY, ALL FOUR, and not merely because they are settings. `connect` and the stored blob
# carry a WRITE CREDENTIAL for a client's live website, so the read is admin-gated exactly like
# the write: there is no viewer-safe version of "show me the destination" that these routes
# needed to offer, and clients_mod.site_summary strips every secret key even so.

class SiteConnectRequest(BaseModel):
    """One connect attempt. `kind` is what the operator confirmed, never what detect guessed."""
    kind: str
    url: str
    # Whatever that driver's fields() asked for. Free-form because the driver owns the shape:
    # modelling WordPress's two keys here would mean editing this file to add Shopify, which is
    # the coupling server/cms/sites.py exists to avoid.
    credentials: dict = {}


class SiteDetectRequest(BaseModel):
    url: str


@app.get("/api/clients/{slug}/site")
async def api_site(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """This brand's destination, with every secret field removed.

    `fields` carries what a driver declared non-secret (the site URL, the username, the
    resolved post type), so the settings card can render the connected state without a second
    shape to maintain. The credential is never in this response.
    """
    _read_client_or_404(slug, user)
    return {
        **clients_mod.site_summary(slug),
        # The dropdown's options and the current driver's inputs, so the card is entirely
        # driven by the engine and adding a platform never edits the dashboard.
        "kinds": cms_sites.KINDS,
    }


@app.get("/api/clients/{slug}/site/fields")
async def api_site_fields(slug: str, kind: str,
                          user: auth.Identity = Depends(auth.require_admin)):
    """What connecting this kind asks for. The card renders whatever comes back."""
    _read_client_or_404(slug, user)
    return {"kind": kind, "fields": cms_sites.fields_for(kind)}


@app.post("/api/clients/{slug}/site/detect")
async def api_site_detect(slug: str, body: SiteDetectRequest,
                          user: auth.Identity = Depends(auth.require_admin)):
    """What platform runs this page, so the card can offer the right fields.

    A HINT AND NEVER A DECISION. `kind` empty means "could not tell", which is an ordinary
    answer the card handles with its dropdown, so this route does not fail on it. `unsupported`
    carries the sentence explaining why a recognised platform still cannot be connected, which
    is worth saying at setup rather than letting an operator promise a client something that
    cannot be built.
    """
    _read_client_or_404(slug, user)
    try:
        kind = await cms_sites.detect(body.url)
    except cms_http.TransportError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {
        "kind": "" if kind in cms_sites.UNSUPPORTED else kind,
        "unsupported": cms_sites.UNSUPPORTED.get(kind, ""),
        "fields": cms_sites.fields_for(kind),
    }


@app.post("/api/clients/{slug}/site/connect")
async def api_site_connect(slug: str, body: SiteConnectRequest,
                           user: auth.Identity = Depends(auth.require_admin)):
    """Prove the credential, resolve where blogs go, and store the destination.

    THE DESTINATION IS WRITTEN ONLY IF THE DRIVER PROVED IT. A connect that half-worked stores
    nothing, so the brand keeps whatever destination it had and the Post button keeps meaning
    what it meant a minute ago. That is why there is no separate "save" route for the blob:
    saving an unverified credential would put a button in front of an operator that fails on a
    real article.
    """
    _read_client_or_404(slug, user)

    if body.kind in cms_sites.UNSUPPORTED:
        raise HTTPException(status_code=422, detail=cms_sites.UNSUPPORTED[body.kind])

    try:
        site = await cms_sites.connect(body.kind, body.url, body.credentials)
    except cms_sites.UnknownDestination as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except cms_wordpress.ConnectError as exc:
        # 422 and not 502: every ConnectError names something the operator or the client can
        # change (a wrong address, a rejected login, a blocked REST API), so blaming the
        # upstream would send them looking in the wrong place.
        raise HTTPException(status_code=422, detail=str(exc))
    except cms_http.TransportError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    clients_mod.write_site(slug, site)
    return {**clients_mod.site_summary(slug), "kinds": cms_sites.KINDS}


@app.delete("/api/clients/{slug}/site", status_code=204)
async def api_site_disconnect(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Forget the destination and its credential.

    The Post button goes dark for this brand immediately, which is the honest outcome: there is
    nowhere to publish. Nothing already published is touched, and published_to on each topic
    still records where each article went.
    """
    _read_client_or_404(slug, user)
    clients_mod.write_site(slug, {})


@app.delete("/api/clients/{slug}", status_code=204)
async def api_delete_client(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """HARD delete a brand: its record (cascading every blog, channel post, roadmap sheet and
    resource), its client-portal login where the brand is its own organisation, and its scratch on
    disk. IRREVERSIBLE and admin-only; the dashboard gates it behind a consent checkbox and a slug
    retype. Refused with 409 while a run is live for the brand, so a delete never races a session
    writing the very topics it is dropping.

    THE GRANT GOES WITH THE ROW, the same rule api_delete_org states and for the same harm.
    `org_members` grants by ORG SLUG and carries no foreign key, so nothing cascades it. A brand
    with no organisation of its own answers to its OWN slug, and this delete is a HARD one, so the
    slug is reusable the moment it commits. Leaving the grant behind means the next brand created
    with that name inherits it: api_create_client mints nothing when has_login is already true, so
    the operator is never told, and the old holder keeps read and answer access to a workspace that
    is not theirs. self_org_slug is what decides, and it returns None for a brand whose slug an
    orgs row owns, because that login is shared with sibling brands this delete must not touch.

    RESOLVED BEFORE THE DELETE, and that ordering is load-bearing twice over. effective_org_slug
    reads org_membership, which filters `deleted_at is null`, so the slug is unreadable once the
    row is gone and a revoke resolved afterwards would silently revoke nothing. It also matches
    api_delete_org's reason: a failure here leaves a brand nobody deleted, which is recoverable,
    where the other order leaves a grant nobody can see."""
    _client_or_404(slug, user)
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run is live for {slug!r}; stop it before deleting the brand")
    own_org = await asyncio.to_thread(clients_mod.self_org_slug, slug)
    if own_org:
        revoked = await asyncio.to_thread(portal_login.deprovision_one, own_org)
        log.info("deleting brand %s revoked its own portal login (%d grant(s), auth user "
                 "deleted: %s, kept: %s)", slug, revoked["revoked"], revoked["deleted_user"],
                 ", ".join(revoked["kept"]) or "none")
    await asyncio.to_thread(clients_mod.hard_delete_client, slug)
    return None


def _public_job(job):
    """The job without its asyncio task handle, which is not serialisable."""
    return {key: value for key, value in job.items() if not key.startswith("_")}


@app.post("/api/clients/{slug}/describe", status_code=202)
async def api_describe_client(slug: str,
                              user: auth.Identity = Depends(auth.require_admin)):
    """Start a draft. Returns immediately; the engine owns the work.

    202 and not 200: a draft is a real Claude Code session against a live site and runs for
    tens of seconds. Awaiting it inside the request made the BROWSER the owner, so a refresh
    or a closed tab aborted a result the operator had already paid for while the session ran
    on regardless. Now the engine holds it and the browser only watches, which is the same
    rule blog runs already follow: this is an interface onto local work, never the work.
    """
    client = _read_client_or_404(slug, user)
    if _client_has_live_run(slug):
        # A describe is one SDK session. Spending one mid-batch competes with the five
        # topics already in flight for the same quota and the same MCP servers, and it buys
        # nothing: the field it drafts can be filled in after the run lands.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; draft the description after it finishes",
        )
    if describe.job_running(slug):
        # Refused rather than started. Two drafts for one brand spend twice the quota to
        # produce two rival answers for a single field, and the operator can only keep one.
        # The in-flight one is returned so a second tab attaches to it instead of racing it.
        return _public_job(describe.get_job(slug))

    # The result is NOT saved. A drafted description is a suggestion from an agent that read
    # one page. Writing it to disk here would make an unreviewed agent summary look exactly
    # like an operator decision, and every later reader would have no way to tell the two
    # apart. The operator edits it and PATCHes it, which is the review.
    return _public_job(describe.start_job(slug, client["name"], client["domain"]))


@app.get("/api/describe-jobs")
async def api_describe_jobs(user: auth.Identity = Depends(auth.require_admin)):
    """Every draft job the engine holds, live or settled. The mirror of GET /api/runs.

    A watcher that wants to know when ANY draft lands cannot ask the per-brand endpoint: it
    would have to name a slug, and a browser that reloaded mid draft has forgotten which one it
    started. Asking the engine what is running keeps the browser free of a registry of its own
    actions, which is the same rule the run list already follows and the reason DRAFT_JOBS lives
    server side at all.

    Declared ABOVE /api/clients/{slug}/describe deliberately: FastAPI matches in definition
    order, and both are GETs under /api. They cannot collide as written, since one is rooted at
    /api/describe-jobs and the other at /api/clients, but keeping the concrete path first is the
    habit that stops the next such pair being a bug.
    """
    return {"jobs": [_public_job(job) for job in describe.DRAFT_JOBS.values()]}


@app.get("/api/clients/{slug}/describe")
async def api_describe_job(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """The current draft job for this brand, or 404 when there is none.

    This is what makes a draft survive a refresh: the page asks the engine what is happening
    rather than remembering what it started. A tab that never issued the POST sees the same
    truth as the tab that did, which matters because six operators share one deployment.
    """
    _read_client_or_404(slug, user)
    job = describe.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no draft job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/describe", status_code=204)
async def api_clear_describe_job(slug: str,
                                 user: auth.Identity = Depends(auth.require_admin)):
    """Drop a settled draft once the operator has used or dismissed it.

    Without this the same finished draft would greet them on every visit forever. A RUNNING
    job is deliberately not cancellable here: the session is already spending quota, so the
    honest thing is to let it land and let the operator discard the result.
    """
    _read_client_or_404(slug, user)
    describe.clear_job(slug)
    return None


@app.get("/api/clients/{slug}/resources")
async def api_resources(slug: str, user: auth.Identity = Depends(auth.require_user)):
    _client_or_404(slug, user)
    return {"resources": clients_mod.list_resources(slug)}


@app.post("/api/clients/{slug}/resources", status_code=201)
async def api_resource_upload(slug: str, file: UploadFile = File(...),
                              user: auth.Identity = Depends(auth.require_admin)):
    _client_or_404(slug, user)
    raw = await file.read()
    if len(raw) > clients_mod.MAX_RESOURCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file is {len(raw)} bytes; the resource limit is "
                   f"{clients_mod.MAX_RESOURCE_BYTES} bytes",
        )
    try:
        return clients_mod.save_resource(slug, file.filename, raw)
    except db.DuplicateResource as exc:
        # 409 and not 400, because nothing about the request is malformed: it
        # conflicts with what is already on the server, and that is exactly what
        # 409 says. The detail names the file so the uploader can act on it
        # without guessing which of a multi-file drop was refused. Renaming or
        # deleting the existing resource first are the two ways forward, and
        # both are the uploader's decision rather than ours to make for them.
        raise HTTPException(
            status_code=409,
            detail=f"a resource named {str(exc)!r} already exists for client "
                   f"{slug!r}; delete it first or upload under a different name",
        )
    except clients_mod.BadResource as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/clients/{slug}/resources/{name}")
async def api_resource_file(slug: str, name: str, download: bool = False,
                            user: auth.Identity = Depends(auth.require_user)):
    """One uploaded resource's ORIGINAL bytes, streamed back out of Storage.

    Storage is content-addressed by sha256 and the row keeps the operator's exact
    filename, so what this answers is byte-for-byte the file that was uploaded:
    nothing re-encodes it. inline by default so a PDF or image previews in the
    browser; ?download=1 flips to attachment for a save-as. content_type falls
    back to a guess from the filename because rows migrated before the column
    existed hold NULL there.
    """
    _client_or_404(slug, user)
    row = db.q(
        """select object_path, content_type from client_resources cr
           join clients c on c.id = cr.client_id
           where c.slug = %s and c.deleted_at is null and cr.name = %s""",
        (slug, name), fetch="one")
    if row is None:
        raise HTTPException(status_code=404, detail=f"no resource {name!r} for client {slug!r}")
    object_path, content_type = row
    try:
        # storage_get takes the path INSIDE the bucket; the stored object_path
        # carries the bucket prefix (see sync.materialize_client, same split).
        raw = await asyncio.to_thread(db.storage_get, object_path.split("/", 1)[1])
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=f"storage read failed: {exc}")
    media_type = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
    disposition = "attachment" if download else "inline"
    ascii_name = name.encode("ascii", "replace").decode().replace('"', "")
    return Response(
        content=raw, media_type=media_type,
        headers={"Content-Disposition":
                 f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"})


@app.delete("/api/clients/{slug}/resources/{name}", status_code=204)
async def api_resource_delete(slug: str, name: str,
                              user: auth.Identity = Depends(auth.require_admin)):
    _client_or_404(slug, user)
    try:
        deleted = clients_mod.delete_resource(slug, name)
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=404, detail=f"no resource {name!r} for client {slug!r}")
    return None


# ---------------------------------------------------------------------------
# Roadmap. Columns are POSITIONAL: 1 -> topic, 2 -> covers, 5 -> prompts. There
# is no detection and no override, so there is nothing to negotiate here.
# ---------------------------------------------------------------------------

def _load_roadmap_or_404(slug, user=None, month=None):
    _client_or_404(slug, user)
    try:
        return roadmap.load_roadmap(slug, month)
    except roadmap.RoadmapNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except roadmap.BadUpload as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _live_run_slugs(slug):
    """Topic slugs in flight for this client right now.

    The ledger only records ships, so it cannot catch two operators submitting
    the same topic seconds apart. This closes that race. It works because the
    deployment runs ONE uvicorn worker, the same reason runner.py's semaphore
    works.
    """
    in_flight = set()
    for run in runner.list_runs():
        if run.get("client") != slug or not run.get("live"):
            continue
        # A repurpose run's topic_slug is the synthetic "<topic>/repurpose/<channel>", not a real
        # blog, so it must never count as a blog in flight: it would falsely block a regenerate of
        # the source blog and surface as a phantom row in the Blogs library. Repurpose duplicate
        # protection lives in api_repurpose, keyed on the synthetic slug, not here.
        if run.get("kind") == "repurpose":
            continue
        for topic in run.get("topics", []):
            # A topic whose session already settled (mark_topic_terminal) is not in flight,
            # however live its siblings are: its terminal status is written and its record
            # committed, so a failed one is re-selectable the moment it fails rather than
            # when the whole batch ends.
            if not topic.get("terminal"):
                in_flight.add(topic.get("topic_slug"))
    return in_flight


def _client_has_live_run(slug):
    return any(
        run.get("client") == slug and run.get("live") for run in runner.list_runs()
    )


def _refuse_if_topic_in_flight(slug, topic_slug, act):
    """Refuse a revise only where THIS TOPIC is already in a live run.

    NARROWED FROM "the brand has any live run", and the narrowing is the queue change made
    visible at the API. That older refusal was never about correctness: the engine held one
    repo-wide lock for a whole batch, so a queued revise meant waiting behind nineteen blogs
    with no way to say how long, and telling the operator to come back later was the honest
    answer to a question the engine could not answer. The queue is now per blog, so a revise is
    an ordinary waiter: it takes the next free slot of five and the operator watches it sit in
    the same queue as everything else.

    WHAT SURVIVES IS THE REAL CONFLICT, which is one topic being written by two sessions at
    once. A revise edits blog.md in place while a regenerate rewrites it, so whichever finished
    last would silently own the article and the other session's evaluator would have scored
    bytes nobody kept. api_generate refuses the mirror image of this from its own side
    (_live_run_slugs feeds its in_flight duplicate check), so both doors now refuse on the same
    fact rather than one on the topic and one on the brand.
    """
    if topic_slug in _live_run_slugs(slug):
        raise HTTPException(
            status_code=409,
            detail=f"{topic_slug!r} is already in a live run for {slug!r}; {act} would open a "
                   f"second session against the same draft. Wait for that run to finish.",
        )


@app.get("/api/clients/{slug}/roadmap")
async def api_roadmap(slug: str, month: Optional[int] = None,
                      user: auth.Identity = Depends(auth.require_user)):
    """One month's roadmap. No `month` means the current (latest) roadmap, which is what the
    Create tab and blog run read."""
    return roadmap.annotate_generated(slug, _load_roadmap_or_404(slug, user, month))


@app.get("/api/clients/{slug}/roadmap/months")
async def api_roadmap_months(slug: str,
                             user: auth.Identity = Depends(auth.require_user)):
    """Every roadmap the brand holds, one entry per month, for the roadmap tab's month list.

    An empty list is the normal empty state, never a 404: a brand with no roadmap has no months
    yet, and the tab renders "Add New Month Roadmap" over an empty list.
    """
    _client_or_404(slug, user)
    return {"months": roadmap.list_months(slug)}


@app.get("/api/clients/{slug}/roadmap/report")
async def api_roadmap_report(slug: str, month: Optional[int] = None,
                             user: auth.Identity = Depends(auth.require_user)):
    """The saved account of how this brand's roadmap was generated.

    No `month` reads the current (latest) month's report; a month names one specific sheet. Read
    from the record, not from the generation job, so it outlives the process that made it. The
    job answers "what is happening now" and is gone on restart; this answers "why does my roadmap
    look like this", which an operator asks weeks later. A 404 here is ordinary: an uploaded
    roadmap has no report, because nothing generated it.
    """
    _client_or_404(slug, user)
    report = roadmap_gen.read_report(slug, month)
    if report is None:
        raise HTTPException(
            status_code=404, detail=f"no roadmap generation report for {slug!r}"
        )
    return report


@app.get("/api/clients/{slug}/roadmap/sheet")
async def api_roadmap_sheet(slug: str, month: Optional[int] = None,
                            user: auth.Identity = Depends(auth.require_user)):
    """The raw CSV as a rectangle, for previewing the file the operator uploaded.

    No `month` previews the current (latest) roadmap; a month previews that specific one, which
    is how the preview dialog's month sidebar switches between them. Separate from /roadmap
    rather than folded into it: that route answers what the engine will read, three columns and
    their parse state, and this one answers what the file contains. A single route serving both
    would have to pick which meaning "rows" has.
    """
    _client_or_404(slug, user)
    try:
        return roadmap.read_sheet(slug, month)
    except roadmap.RoadmapNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/clients/{slug}/roadmap", status_code=204)
async def api_delete_roadmap(slug: str, month: int,
                             user: auth.Identity = Depends(auth.require_admin)):
    """Remove ONE month's roadmap AND every blog written from it. `month` is required: with a
    brand holding several, the caller must name which one.

    DELETING A MONTH DELETES ITS BLOGS, which reverses the old behaviour of keeping them. A month
    is the unit the operator works in: it holds a sheet and the blogs written from that sheet, and
    the Blogs tab groups by it. Keeping the blogs would leave a month that owns work but has no
    sheet behind it, which is a month the tab can no longer name, so the work would be
    unreachable rather than preserved.

    THIS IS DESTRUCTIVE AND IRREVERSIBLE, including for blogs that already shipped, were sent to
    a client, or were pushed to a CMS. A pushed blog's CMS post is NOT retracted, because this
    engine cannot un-publish someone else's site: the post stays live and the record of it goes,
    so the dialog names that count separately rather than burying it in a total. The sheet itself
    is archived to roadmap_uploads first (delete_roadmap), so the SHEET is recoverable and the
    blogs are not.

    Each blog goes through _delete_blog, the same path api_delete_blog uses, so the topic row
    cascades to its versions, status events, comments and review notes, and the scratch tree goes
    with it. Reusing that function rather than writing a second delete is what keeps "what it
    means to delete a blog" defined once.
    """
    _client_or_404(slug, user)
    if _client_has_live_run(slug):
        # A live run's rows came from a sheet. Deleting one underneath would leave the status
        # table describing topics whose source no longer exists, and the cascade below would be
        # racing the engine for the scratch tree it is writing into right now.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before deleting a roadmap",
        )
    owned = await asyncio.to_thread(roadmap.delete_roadmap, slug, month)
    # `is None` and never falsiness: an empty set is a real answer, a sheet whose rows parsed to
    # nothing, and it must delete no blogs rather than 404 as though the month did not exist.
    if owned is None:
        raise HTTPException(
            status_code=404, detail=f"{slug!r} has no Month {month} roadmap to delete")
    for topic_slug in sorted(owned):
        await asyncio.to_thread(_delete_blog, slug, topic_slug)
    return None


@app.post("/api/clients/{slug}/roadmap/upload")
async def api_roadmap_upload(slug: str, file: UploadFile = File(...),
                             user: auth.Identity = Depends(auth.require_admin)):
    _client_or_404(slug, user)
    if _client_has_live_run(slug):
        # Swapping the roadmap under a running queue would make the status table
        # describe rows that are no longer the ones running.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before uploading a new roadmap",
        )
    # No has_roadmap refusal: an upload ADDS the next month rather than replacing. The brand may
    # hold Month 1, Month 2, ...; this upload becomes the next number. save_upload returns which.

    raw = await file.read()
    if len(raw) > roadmap.MAX_UPLOAD_BYTES:
        # A roadmap is kilobytes. Bigger is a mistake or an attack: refuse early
        # rather than parse it.
        raise HTTPException(
            status_code=413,
            detail=f"file is {len(raw)} bytes; the roadmap limit is {roadmap.MAX_UPLOAD_BYTES} bytes",
        )

    try:
        saved = roadmap.save_upload(slug, file.filename, raw)
        payload = roadmap.load_upload(slug, saved["upload_id"])
    except roadmap.BadUpload as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    payload = roadmap.annotate_generated(slug, payload)
    payload["upload_id"] = saved["upload_id"]
    payload["archived"] = saved["archived"]
    payload["month"] = saved["month"]
    return payload


class GenerateRoadmapRequest(BaseModel):
    brand_url: str
    piece_count: int
    # Optional operator steer: geography lock, must-include topics, exclusions, named
    # competitors, intent mix. Empty is the common case and is passed through as such.
    notes: str = ""


@app.post("/api/clients/{slug}/roadmap/generate", status_code=202)
async def api_generate_roadmap(slug: str, body: GenerateRoadmapRequest,
                               user: auth.Identity = Depends(auth.require_admin)):
    """Start a roadmap generation. Returns immediately; the engine owns the work.

    202 and not 200, for the same reason the describe route is 202: this is one long SDK
    session walking seven stages of live research, and awaiting it inside the request would
    make the BROWSER the owner of work the operator has already paid for. A refresh would
    abort the request while the session ran on regardless. The engine holds the job; the
    browser only watches.
    """
    _client_or_404(slug)

    url = body.brand_url.strip()
    if not url.lower().startswith(("http://", "https://")):
        # The whole session is built on firecrawl_map of this URL. A bare domain or a typo
        # fails at the first tool call, minutes in, having already spent the session's setup.
        raise HTTPException(
            status_code=422,
            detail="brand_url must be an http:// or https:// URL",
        )
    if not 1 <= body.piece_count <= 50:
        # The agent is told to deliver piece_count rows. Zero is not a roadmap, and a count
        # in the hundreds is a typo that would spend an enormous session producing padding
        # the prompt explicitly forbids.
        raise HTTPException(
            status_code=422,
            detail=f"piece_count must be between 1 and 50; got {body.piece_count}",
        )

    if roadmap_gen.job_running(slug):
        # Refused rather than started, and checked BEFORE the has-roadmap rule below: a
        # session mid flight may have already written the CSV, and answering "delete it
        # first" while the generation that wrote it is still running would be a lie. The
        # in-flight job rides along so a second tab attaches to it instead of racing it.
        raise HTTPException(status_code=409, detail={
            "detail": f"a roadmap generation for {slug!r} is already running; watch that one "
                      f"rather than starting a second, which would race it to write the same file",
            "job": _public_job(roadmap_gen.get_job(slug)),
        })
    if roadmap_gen.rewrite_running(slug):
        # The mirror of the rewrite route's generation guard. A rewrite is splicing the
        # latest month while a generation would add the next one; the data would survive, but
        # two agent sessions researching one brand at once compete for the same MCP servers
        # and quota, and the operator watching "the roadmap session" would be watching two.
        raise HTTPException(
            status_code=409,
            detail=f"topic rewrites for {slug!r} are still running; let them land before "
                   f"generating a new month",
        )
    if _client_has_live_run(slug):
        # Same rule the roadmap upload and delete routes enforce, asked the same way: a live
        # run's rows came from a sheet, so no sheet may change underneath it.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before generating a roadmap",
        )
    # No has_roadmap refusal: a generation ADDS the next month rather than replacing. The
    # job_running check above still stands, so a brand cannot run two generations at once and
    # race them to the same next-month number.

    return _public_job(roadmap_gen.start_job(slug, url, body.piece_count, body.notes))


class RewriteRoadmapRequest(BaseModel):
    # 0-based row indices on the LATEST month's sheet, the same numbering RoadmapRow.index and
    # every display's "#" column carry (displayed as index + 1).
    row_indices: list[int]
    # The operator's account of what is wrong with the ticked rows. "" is allowed: rejecting
    # rows without a note is an ordinary answer, and the prompt says so rather than guessing.
    feedback: str = ""


@app.post("/api/clients/{slug}/roadmap/rewrite", status_code=202)
async def api_rewrite_roadmap(slug: str, body: RewriteRoadmapRequest,
                              user: auth.Identity = Depends(auth.require_admin)):
    """Rewrite the ticked rows of the latest roadmap. Returns immediately; the engine owns it.

    Same shape as /roadmap/generate because it IS a generation scoped to N rows: one long SDK
    session, 202, the browser watches the same job record. The refusals that are new here are
    the ones that keep a rewrite honest:

    - 422 for a row that is not on the sheet, named by index.
    - 422 for a row whose topic already has a blog on disk, at ANY status. The blog was
      written from that row's brief, and blogs join their row by topic_slug, so rewriting the
      row would orphan the article. Delete the blog first; that is a deliberate act.
    - The total never changes: the engine splices exactly one new row per rejected row, and
      refuses the whole splice otherwise.

    SEVERAL rewrites may run at once, and that is the operator's loop: reject rows 3 and 7,
    and while that batch runs, reject row 5 with different feedback. What keeps it safe is the
    409 below on OVERLAP: every running batch owns its rows outright, so two sessions can
    never splice the same row and the splices commute. A fresh generation stays exclusive.

    The brand's website comes off its own record, never the browser: the replacement topics
    are researched from it, and the generate dialog already works the same way.
    """
    client = _read_client_or_404(slug, user)

    payload = _load_roadmap_or_404(slug, user)
    if not body.row_indices:
        raise HTTPException(status_code=422, detail="no rows were selected to rewrite")

    on_sheet = {row["index"]: row for row in payload["rows"]}
    unknown = sorted(set(body.row_indices) - set(on_sheet))
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"row(s) {', '.join(str(i + 1) for i in unknown)} are not on the latest "
                   f"roadmap, which has {len(payload['rows'])} row(s)")

    written = {blog["topic_slug"] for blog in _blog_history(slug)}
    blocked = [on_sheet[i] for i in sorted(set(body.row_indices))
               if on_sheet[i]["topic_slug"] in written]
    if blocked:
        names = "; ".join(f"row {row['index'] + 1} ({row['topic']})" for row in blocked)
        raise HTTPException(
            status_code=422,
            detail=f"these rows already have a blog on disk, and rewriting the row would "
                   f"orphan the article: {names}. Delete the blog first if you really want "
                   f"to replace the topic.")

    url = str(client.get("domain") or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(
            status_code=422,
            detail=f"{slug!r} has no http(s) website on file, and the replacement topics are "
                   f"researched from the brand's own site; set the website in settings first")

    taken = roadmap_gen.rewrite_rows_in_flight(slug) & set(body.row_indices)
    if taken:
        raise HTTPException(
            status_code=409,
            detail=f"row(s) {', '.join(str(i + 1) for i in sorted(taken))} are already being "
                   f"rewritten by a running batch; wait for it to land, then reject them "
                   f"again if the replacement still misses")
    if roadmap_gen.job_running(slug):
        raise HTTPException(status_code=409, detail={
            "detail": f"a roadmap generation for {slug!r} is running; a rewrite would race it "
                      f"over the same sheet, so let it land first",
            "job": _public_job(roadmap_gen.get_job(slug)),
        })
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before rewriting the roadmap",
        )

    months = roadmap.list_months(slug)
    month = months[-1]["month"] if months else 1

    return _public_job(roadmap_gen.start_rewrite_job(
        slug, url, month, payload, body.row_indices, body.feedback))


@app.get("/api/clients/{slug}/roadmap/rewrites")
async def api_rewrite_jobs(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """Every rewrite job for this brand, running and settled, oldest first.

    A LIST, unlike the generation's single job, because several batches run at once. An empty
    list is the normal state, never a 404: most visits have no rewrite in flight. This is what
    makes a batch survive a refresh: the dialog asks the engine what is running rather than
    remembering what it started.
    """
    _client_or_404(slug, user)
    return {"jobs": [_public_job(job) for job in roadmap_gen.list_rewrite_jobs(slug)]}


@app.delete("/api/clients/{slug}/roadmap/rewrites/{job_id}", status_code=204)
async def api_clear_rewrite_job(slug: str, job_id: str,
                                user: auth.Identity = Depends(auth.require_admin)):
    """Drop ONE settled rewrite job once its report is read or dismissed. A running one is
    refused: the session is spending quota, and dropping the record would leave it landing a
    splice no job explains."""
    _client_or_404(slug, user)
    job = next((j for j in roadmap_gen.list_rewrite_jobs(slug) if j.get("id") == job_id), None)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no rewrite job {job_id!r} for {slug!r}")
    if not roadmap_gen.clear_rewrite_job(slug, job_id):
        raise HTTPException(
            status_code=409,
            detail=f"rewrite {job_id!r} is still running; it can be cleared once it lands")
    return None


@app.get("/api/clients/{slug}/roadmap/generate")
async def api_roadmap_generation_job(slug: str,
                                     user: auth.Identity = Depends(auth.require_user)):
    """The current generation job for this brand, or 404 when there has never been one.

    This is what makes a generation survive a refresh: the page asks the engine what is
    happening rather than remembering what it started. A tab that never issued the POST sees
    the same truth as the tab that did, which matters because several operators share one
    deployment.
    """
    _client_or_404(slug, user)
    job = roadmap_gen.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no roadmap generation job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/roadmap/generate", status_code=204)
async def api_clear_roadmap_generation(slug: str,
                                       user: auth.Identity = Depends(auth.require_admin)):
    """Drop a settled generation job once the operator has read or dismissed it.

    Without this the same finished report would greet them on every visit forever. A RUNNING
    job is refused rather than cleared: the session is already spending quota, and dropping
    the record would leave it writing a roadmap.csv that no job explains.
    """
    _client_or_404(slug, user)
    if roadmap_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the roadmap generation for {slug!r} is still running; it can be cleared "
                   f"once it finishes",
        )
    roadmap_gen.clear_job(slug)
    return None


# ---------------------------------------------------------------------------
# Monthly reports: generate (a job), then list / share / delete / pdf.
#
# Generation is a long SDK session, so the generate trio mirrors roadmap/generate exactly: 202
# and the browser watches. The rest are plain record reads and writes over the owner connection.
# The SHARING MODEL lives here: Generate writes the WORKING copy, Share copies it into the SHARED
# snapshot the client sees, Delete removes only the working copy so the shared snapshot survives,
# and a regenerate after a share leaves generated_at > shared_at, which the dashboard reads as
# "not shared yet". See supabase/migrations/020_client_reports.sql and server/report_gen.py.
#
# ROUTE ORDER MATTERS: the static /reports/generate paths are declared before /reports/{month},
# so a DELETE on /reports/generate reaches the clear-job handler rather than being read as a
# month named "generate". The {month} handlers still validate the format as a second guard.
# ---------------------------------------------------------------------------

def _report_status(has_working, generated_at, shared_at, has_shared):
    """The four states the dashboard branches on, derived from one row's timestamps.

    A working copy that was shared AT OR AFTER it was generated is up to date with the client;
    a working copy generated after the last share is the "not shared yet" case a regenerate
    creates. A month with no working copy but a shared snapshot is a report the operator deleted
    while the client keeps seeing the last one sent. Anything else is nothing at all.
    """
    if has_working:
        if shared_at is not None and generated_at is not None and shared_at >= generated_at:
            return "generated_shared"
        return "generated_unshared"
    if has_shared:
        return "deleted_shared"
    return "none"


@app.get("/api/clients/{slug}/reports")
async def api_reports(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """Every month this brand holds, plus the current month even when it has no report yet, so
    the tab can offer Generate over an empty current month. Each entry carries the WORKING
    report (what the admin sees and what the trend is drawn from), never the shared snapshot:
    a deleted month returns report null, so a deleted report stays unseeable to the operator
    exactly as the requirement asks, while the client keeps seeing the snapshot elsewhere."""
    _client_or_404(slug, user)
    cid = db.client_id(slug)
    rows = db.q(
        "select month, report, (pdf is not null), generated_at, generated_by, "
        "shared_at, shared_by, (shared_report is not null) "
        "from client_reports where client_id = %s order by month desc", (cid,)) if cid else []
    current = report_gen.current_month()
    reports = []
    seen = set()
    for month, report, has_pdf, gen_at, gen_by, shared_at, shared_by, has_shared in rows:
        seen.add(month)
        reports.append({
            "month": month,
            "status": _report_status(report is not None, gen_at, shared_at, has_shared),
            "report": report,
            "has_pdf": bool(has_pdf),
            "generated_at": gen_at,
            "generated_by": gen_by,
            "shared_at": shared_at,
            "shared_by": shared_by,
        })
    if current not in seen:
        reports.append({
            "month": current, "status": "none", "report": None, "has_pdf": False,
            "generated_at": None, "generated_by": None, "shared_at": None, "shared_by": None,
        })
    reports.sort(key=lambda r: r["month"], reverse=True)
    return {"current_month": current, "reports": reports}


@app.post("/api/clients/{slug}/reports/generate", status_code=202)
async def api_generate_report(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Start this month's report generation. 202, and the browser watches: this is one long SDK
    session against live data and DataForSEO, exactly the shape of a roadmap generation.

    Generation ALWAYS targets the current calendar month, computed here from the engine clock and
    never taken from the browser: a report carries numbers measured now, so letting a caller name
    a past month would stamp today's metrics under a label they do not belong to."""
    client = _read_client_or_404(slug, user)
    month = report_gen.current_month()

    if report_gen.job_running(slug):
        raise HTTPException(status_code=409, detail={
            "detail": f"a report generation for {slug!r} is already running; watch that one "
                      f"rather than starting a second, which would race it to write the same row",
            "job": _public_job(report_gen.get_job(slug)),
        })
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before generating a report")
    if report_gen.working_report_exists(slug, month):
        # One report per month. Regenerating means Delete first, which is the requirement and the
        # guard that keeps a generation from clobbering a report the operator may still want.
        raise HTTPException(
            status_code=409,
            detail=f"a report for {month} already exists; delete it first to regenerate")
    if not (client.get("domain") or "").strip():
        # The whole session audits a live site. No domain, nothing to audit, so refuse at submit
        # rather than spend a session that fails at its first scrape.
        raise HTTPException(
            status_code=422,
            detail="this brand has no domain recorded; a monthly report audits a live site")

    email = getattr(user, "email", "") or ""
    return _public_job(report_gen.start_job(slug, month, email))


@app.get("/api/clients/{slug}/reports/generate")
async def api_report_generation_job(slug: str,
                                    user: auth.Identity = Depends(auth.require_user)):
    """The current report generation job, or 404 when there has never been one. This is what
    lets a generation survive a refresh and be watched from a tab that never started it."""
    _client_or_404(slug, user)
    job = report_gen.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no report generation job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/reports/generate", status_code=204)
async def api_clear_report_generation(slug: str,
                                      user: auth.Identity = Depends(auth.require_admin)):
    """Drop a settled report generation job once the operator has read or dismissed it. A running
    job is refused: the session is spending quota and dropping its record would strand it."""
    _client_or_404(slug, user)
    if report_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the report generation for {slug!r} is still running; clear it once it finishes")
    report_gen.clear_job(slug)
    return None


@app.post("/api/clients/{slug}/reports/{month}/share")
async def api_share_report(slug: str, month: str,
                           user: auth.Identity = Depends(auth.require_admin)):
    """Send this month's WORKING report to the client: copy it into the shared snapshot the
    portal reads. Every share re-stamps shared_at, so it also re-shares after a regenerate.
    Refused when there is no working report to share (409): a share of nothing is nonsense, and
    Delete leaves report null precisely so this refusal fires for a deleted month."""
    _client_or_404(slug, user)
    if not report_gen.valid_month(month):
        raise HTTPException(status_code=404, detail=f"{month!r} is not a valid report month")
    if report_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a report generation for {slug!r} is running; wait for it before sharing")
    cid = db.client_id(slug)
    email = getattr(user, "email", "") or ""
    shared_at = db.q(
        "update client_reports set shared_report = report, shared_pdf = pdf, "
        "shared_at = now(), shared_by = %s "
        "where client_id = %s and month = %s and report is not null "
        "returning shared_at", (email, cid, month), fetch="val")
    if shared_at is None:
        raise HTTPException(
            status_code=409,
            detail=f"there is no generated report for {month} to share; generate it first")
    return {"month": month, "status": "generated_shared", "shared_at": shared_at, "shared_by": email}


@app.delete("/api/clients/{slug}/reports/{month}", status_code=204)
async def api_delete_report(slug: str, month: str,
                            user: auth.Identity = Depends(auth.require_admin)):
    """Remove this month's WORKING report: report, pdf and generation stamps. The SHARED snapshot
    is left untouched, so the client keeps seeing the last report sent, and there is no way for
    the operator to see the working copy again (the are-you-sure lives in the dashboard). When no
    shared snapshot remains either, the now-empty row is dropped. Idempotent: deleting a month
    that has no working report is a no-op 204."""
    _client_or_404(slug, user)
    if not report_gen.valid_month(month):
        raise HTTPException(status_code=404, detail=f"{month!r} is not a valid report month")
    if report_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a report generation for {slug!r} is running; wait for it before deleting")
    cid = db.client_id(slug)
    with db.tx() as cur:
        cur.execute(
            "update client_reports set report = null, pdf = null, generated_at = null, "
            "generated_by = null where client_id = %s and month = %s", (cid, month))
        cur.execute(
            "delete from client_reports where client_id = %s and month = %s "
            "and shared_report is null", (cid, month))
    return None


@app.get("/api/clients/{slug}/reports/{month}/pdf")
async def api_report_pdf(slug: str, month: str,
                         user: auth.Identity = Depends(auth.require_user)):
    """The WORKING report's PDF for one month, as a download. 404 when this month has no working
    PDF, which is both a deleted month and a report whose PDF never rendered (Chromium absent)."""
    _client_or_404(slug, user)
    if not report_gen.valid_month(month):
        raise HTTPException(status_code=404, detail=f"{month!r} is not a valid report month")
    cid = db.client_id(slug)
    pdf = db.q("select pdf from client_reports where client_id = %s and month = %s",
               (cid, month), fetch="val")
    if pdf is None:
        raise HTTPException(status_code=404, detail=f"no report PDF for {month}")
    return Response(
        content=bytes(pdf), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-{month}-report.pdf"'})


# ---------------------------------------------------------------------------
# Monthly ANALYSIS: run (a job), then list / delete / pdf.
#
# Deliberately kept SEPARATE from Reports (a different tab, a different table, a different skill),
# per the requirement to keep the two apart for now. Generation is a long SDK session, so the run
# trio mirrors reports/generate exactly: 202 and the browser watches. There is no Share here yet:
# Analysis is an admin-internal report, so the client-facing snapshot half of the table stays unused
# until a Share route is added. Everything else is a plain record read/write over the owner
# connection. Same ROUTE ORDER rule: the static /analysis/generate paths are declared before
# /analysis/{month} so a DELETE on /analysis/generate reaches the clear-job handler.
# See supabase/migrations/027_client_analyses.sql and server/analysis_gen.py.
# ---------------------------------------------------------------------------

@app.get("/api/clients/{slug}/analysis")
async def api_analyses(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """Every month this brand holds an analysis for, plus the current month even when it has none,
    so the tab can offer Run over an empty current month. Each entry carries the WORKING analysis
    (what the admin sees and what the trend is drawn from)."""
    _client_or_404(slug, user)
    cid = db.client_id(slug)
    rows = db.q(
        "select month, analysis, (pdf is not null), generated_at, generated_by "
        "from client_analyses where client_id = %s order by month desc", (cid,)) if cid else []
    current = analysis_gen.current_month()
    analyses = []
    seen = set()
    for month, analysis, has_pdf, gen_at, gen_by in rows:
        seen.add(month)
        analyses.append({
            "month": month,
            "status": "generated" if analysis is not None else "none",
            "analysis": analysis,
            "has_pdf": bool(has_pdf),
            "generated_at": gen_at,
            "generated_by": gen_by,
        })
    if current not in seen:
        analyses.append({
            "month": current, "status": "none", "analysis": None, "has_pdf": False,
            "generated_at": None, "generated_by": None,
        })
    analyses.sort(key=lambda r: r["month"], reverse=True)
    return {"current_month": current, "analyses": analyses}


@app.post("/api/clients/{slug}/analysis/generate", status_code=202)
async def api_generate_analysis(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Run this month's analysis. 202, and the browser watches: one long SDK session that merges up
    to six tools. Generation ALWAYS targets the current calendar month, computed from the engine
    clock, never taken from the browser."""
    client = _read_client_or_404(slug, user)
    month = analysis_gen.current_month()

    if analysis_gen.job_running(slug):
        raise HTTPException(status_code=409, detail={
            "detail": f"an analysis for {slug!r} is already running; watch that one rather than "
                      f"starting a second, which would race it to write the same row",
            "job": _public_job(analysis_gen.get_job(slug)),
        })
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before running an analysis")
    if analysis_gen.working_analysis_exists(slug, month):
        raise HTTPException(
            status_code=409,
            detail=f"an analysis for {month} already exists; delete it first to regenerate")
    if not (client.get("domain") or "").strip():
        raise HTTPException(
            status_code=422,
            detail="this brand has no domain recorded; a monthly analysis measures a live site")

    email = getattr(user, "email", "") or ""
    return _public_job(analysis_gen.start_job(slug, month, email))


@app.get("/api/clients/{slug}/analysis/generate")
async def api_analysis_generation_job(slug: str,
                                      user: auth.Identity = Depends(auth.require_user)):
    """The current analysis job, or 404 when there has never been one. Lets a run survive a refresh
    and be watched from a tab that never started it."""
    _client_or_404(slug, user)
    job = analysis_gen.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no analysis job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/analysis/generate", status_code=204)
async def api_clear_analysis_generation(slug: str,
                                        user: auth.Identity = Depends(auth.require_admin)):
    """Drop a settled analysis job once the operator has read or dismissed it. A running job is
    refused: the session is spending quota and dropping its record would strand it."""
    _client_or_404(slug, user)
    if analysis_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the analysis for {slug!r} is still running; clear it once it finishes")
    analysis_gen.clear_job(slug)
    return None


@app.delete("/api/clients/{slug}/analysis/{month}", status_code=204)
async def api_delete_analysis(slug: str, month: str,
                              user: auth.Identity = Depends(auth.require_admin)):
    """Remove this month's WORKING analysis: analysis, pdf and generation stamps. The reserved
    shared snapshot is left untouched. When no shared snapshot remains either, the now-empty row is
    dropped. Idempotent: deleting a month that has no working analysis is a no-op 204."""
    _client_or_404(slug, user)
    if not analysis_gen.valid_month(month):
        raise HTTPException(status_code=404, detail=f"{month!r} is not a valid analysis month")
    if analysis_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"an analysis for {slug!r} is running; wait for it before deleting")
    cid = db.client_id(slug)
    with db.tx() as cur:
        cur.execute(
            "update client_analyses set analysis = null, pdf = null, generated_at = null, "
            "generated_by = null where client_id = %s and month = %s", (cid, month))
        cur.execute(
            "delete from client_analyses where client_id = %s and month = %s "
            "and shared_analysis is null", (cid, month))
    return None


@app.get("/api/clients/{slug}/analysis/{month}/pdf")
async def api_analysis_pdf(slug: str, month: str,
                           user: auth.Identity = Depends(auth.require_user)):
    """The WORKING analysis's PDF for one month, as a download. 404 when this month has no working
    PDF, which is both a deleted month and an analysis whose PDF never rendered (Chromium absent)."""
    _client_or_404(slug, user)
    if not analysis_gen.valid_month(month):
        raise HTTPException(status_code=404, detail=f"{month!r} is not a valid analysis month")
    cid = db.client_id(slug)
    pdf = db.q("select pdf from client_analyses where client_id = %s and month = %s",
               (cid, month), fetch="val")
    if pdf is None:
        raise HTTPException(status_code=404, detail=f"no analysis PDF for {month}")
    return Response(
        content=bytes(pdf), media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{slug}-{month}-analysis.pdf"'})


# ---------------------------------------------------------------------------
# Canonical facts: the file, then the job that builds it.
#
# READ, plus ONE teardown. There is deliberately NO POST and NO PATCH here: a blog run starts
# the generation itself, because the fact base is a precondition of writing a blog rather than a
# thing an operator asks for, and a button that also started one would be a second way to do the
# same thing the run could disagree with. DELETE is the exception, and it is not a second way to
# build: it clears a wrong fact base so the next run drafts a fresh one, which is the empty state
# the UI already renders.
# ---------------------------------------------------------------------------

@app.get("/api/clients/{slug}/facts")
async def api_facts_file(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """The brand's canonical-facts.md itself, as text.

    Reading it is the whole of what this offers, and that is the point. The file is BINDING
    for every blog written for the brand, so it is a human's to review and edit on disk; a
    textarea in a browser would put the one file the pipeline trusts most one stray keystroke
    from a stale tab. An operator who needs to see what a draft was written against gets to
    see it without opening a terminal, and changing it stays a deliberate act somewhere else.

    404 is the EMPTY STATE and not an error: a brand whose fact base has never been built is
    the brand the client list already reports as has_canonical_facts false, and the first blog
    run drafts the file before it writes anything.
    """
    _client_or_404(slug, user)
    # Record-backed: the same canonical_facts column preflight refuses on, so this view and
    # the refusal can never be reading two different fact bases. The scratch copy under
    # clients/ is materialized for agents at run start and is never consulted here.
    facts = db.q(
        "select canonical_facts from clients where slug = %s and deleted_at is null",
        (slug,), fetch="val")
    if facts is None:
        raise HTTPException(status_code=404, detail=f"no canonical-facts.md for {slug!r}")
    return PlainTextResponse(facts, media_type="text/plain; charset=utf-8")

@app.get("/api/clients/{slug}/facts/generate")
async def api_facts_generation_job(slug: str,
                                   user: auth.Identity = Depends(auth.require_user)):
    """The current fact generation job for this brand, or 404 when there has never been one.

    This is what lets the operator watch a phase they did not start. The run reports phase
    "facts" and this endpoint says what that phase is actually doing, so a refresh, a closed
    tab, or a second operator on another machine all see the same truth as the tab that
    pressed Generate. A 404 means no fact base has ever been built here, which for a brand
    that already has one is the normal answer: the file is on disk and no job was needed.
    """
    _client_or_404(slug, user)
    job = facts_gen.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no facts generation job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/facts/generate", status_code=204)
async def api_clear_facts_generation(slug: str,
                                     user: auth.Identity = Depends(auth.require_admin)):
    """Drop a settled fact generation job once the operator has read or dismissed it.

    Without this the same finished report would greet them on every visit forever. A RUNNING
    job is refused rather than cleared: the session is already spending quota and a blog run
    is waiting on it, so dropping the record would leave that run blocked on a job nobody can
    see. Clearing the job never touches canonical-facts.md itself.
    """
    _client_or_404(slug, user)
    if facts_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the canonical facts generation for {slug!r} is still running; it can be "
                   f"cleared once it finishes",
        )
    facts_gen.clear_job(slug)
    return None


@app.delete("/api/clients/{slug}/facts", status_code=204)
async def api_delete_facts(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Delete the brand's canonical-facts.md entirely: the file, its report, and the record.

    The one WRITE in this section, and it is a teardown rather than a second way to build. An
    operator who got the fact base wrong clears it so the next blog run drafts a fresh one, which
    is the empty state has_canonical_facts already reports. Two things in flight are refused: a
    running build, because the blog run behind it is waiting on the file this would delete, and a
    live blog run, because it reads the scratch file this unlinks and the record this nulls. Both
    answer 409, so the operator stops the work first, exactly as clearing a running build does.
    """
    _client_or_404(slug, user)
    if facts_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the canonical facts generation for {slug!r} is still running; it can be "
                   f"deleted once it finishes",
        )
    if _live_run_slugs(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a blog run is live for {slug!r}; stop it before deleting the fact base",
        )
    facts_gen.delete_facts(slug)
    return None


# ---------------------------------------------------------------------------
# Discovery questions
#
# What the crawl could not learn, asked of the person who knows. See server/discovery.py for why
# this exists and what it deliberately is NOT: these questions hold nothing. No blog waits on
# them, no terminal status turns on them, and a brand with every one unanswered generates exactly
# as it does today. Nothing in this section writes a status line, and nothing may start to.
#
# ROUTE ORDER IS LOAD BEARING. /discovery/generate and /discovery/send are declared BEFORE
# /discovery/{question_id}, because FastAPI matches in declaration order and a literal path
# segment loses to a path parameter registered ahead of it: DELETE /discovery/generate would
# otherwise be read as "delete the question whose id is the word generate".
# ---------------------------------------------------------------------------

@app.post("/api/clients/{slug}/discovery/generate", status_code=202)
async def api_generate_discovery(slug: str,
                                 user: auth.Identity = Depends(auth.require_admin)):
    """Start a discovery question generation. Returns immediately; the engine owns the work.

    202 for the reason every other generation route is 202: one long SDK session crawling a live
    site, which the operator has already paid for by the time the browser could abort it.
    """
    _client_or_404(slug)
    if discovery.job_running(slug):
        raise HTTPException(status_code=409, detail={
            "detail": f"a discovery generation for {slug!r} is already running; watch that one "
                      f"rather than starting a second, which would spend a second session to "
                      f"produce the same questions",
            "job": _public_job(discovery.get_job(slug)),
        })
    if facts_gen.job_running(slug):
        # Both sessions crawl the same domain through the same MCP servers, and the fact base is
        # an INPUT to good questions: §9 is the richest source of things only a person can settle.
        # Running them at once spends two sessions to produce a worse form.
        raise HTTPException(
            status_code=409,
            detail=f"the canonical facts build for {slug!r} is still running; the questions read "
                   f"that file, so let it land first",
        )
    if _client_has_live_run(slug):
        # Same rule the describe route enforces: a session spent mid batch competes with the
        # topics already in flight for the same quota and the same MCP servers.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; generate the questions after it finishes",
        )
    return _public_job(discovery.start_job(slug))


@app.get("/api/clients/{slug}/discovery/generate")
async def api_discovery_job(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """The current discovery generation job, or 404 when there has never been one."""
    _client_or_404(slug, user)
    job = discovery.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no discovery job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/discovery/generate", status_code=204)
async def api_clear_discovery_job(slug: str,
                                  user: auth.Identity = Depends(auth.require_admin)):
    """Drop a settled job once the operator has read it. A RUNNING one is refused."""
    _client_or_404(slug, user)
    if discovery.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the discovery generation for {slug!r} is still running; it can be cleared "
                   f"once it finishes",
        )
    discovery.clear_job(slug)
    return None


@app.post("/api/clients/{slug}/discovery/send")
async def api_send_discovery(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Release every draft question to the client's portal.

    THE REVIEW GATE. Questions arrive from a model, and a model writing straight to a client is
    the one thing every other outward-facing surface in this app refuses. Until this press they
    are invisible to the client: portal_discovery_questions filters on sent_at.

    Releasing the SET rather than one question at a time is deliberate. A client answering a form
    that grows underneath them cannot tell what is left, and the operator reviewed the set.
    """
    _client_or_404(slug)
    sent = discovery.send(slug)
    if sent == 0:
        raise HTTPException(
            status_code=409,
            detail=f"there are no draft questions for {slug!r} to send; generate some first, or "
                   f"they have all been sent already",
        )
    return {"sent": sent, **discovery.list_questions(slug)}


@app.get("/api/clients/{slug}/discovery")
async def api_discovery(slug: str, user: auth.Identity = Depends(auth.require_user)):
    """Every question this brand holds, drafts and answers included. The operator's review view."""
    _client_or_404(slug, user)
    return discovery.list_questions(slug)


@app.delete("/api/clients/{slug}/discovery", status_code=204)
async def api_clear_discovery(slug: str, user: auth.Identity = Depends(auth.require_admin)):
    """Delete every question for this brand, answers included. The operator's reset.

    A running generation is refused: it is about to write the rows this would delete.
    """
    _client_or_404(slug, user)
    if discovery.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the discovery generation for {slug!r} is still running; clear it once the "
                   f"questions have landed",
        )
    discovery.clear(slug)
    return None


class DiscoveryEdit(BaseModel):
    question: str | None = None
    why: str | None = None


@app.patch("/api/clients/{slug}/discovery/{question_id}")
async def api_edit_discovery(slug: str, question_id: str, body: DiscoveryEdit,
                             user: auth.Identity = Depends(auth.require_admin)):
    """Fix the wording before it goes out.

    Refused once ANSWERED, in discovery.update_question, and the refusal is the point: the client
    answered THOSE words, and rewriting the question afterwards makes the record assert a pairing
    that never happened. It is the same reason an approved article is locked.
    """
    _client_or_404(slug)
    if not discovery.update_question(slug, question_id, body.question, body.why):
        raise HTTPException(
            status_code=409,
            detail="that question is not on this brand's form, or it has already been answered, "
                   "and an answered question keeps the wording it was answered against",
        )
    return discovery.list_questions(slug)


@app.delete("/api/clients/{slug}/discovery/{question_id}", status_code=204)
async def api_delete_discovery_question(slug: str, question_id: str,
                                        user: auth.Identity = Depends(auth.require_admin)):
    """Drop one weak question. Allowed after sending, refused once answered.

    Withdrawing a question the client has not reached yet is ordinary editing. Deleting one they
    already answered discards something a person actually wrote, so it is refused.
    """
    _client_or_404(slug)
    if not discovery.delete_question(slug, question_id):
        raise HTTPException(
            status_code=409,
            detail="that question is not on this brand's form, or it has been answered; an "
                   "answered question is kept because deleting it would discard the answer",
        )
    return None


@app.get("/api/clients/{slug}/ledger")
async def api_ledger(slug: str, user: auth.Identity = Depends(auth.require_user)):
    _client_or_404(slug, user)
    return {"rows": ledger.read_ledger(slug)}


def _title_from_blog(path):
    """First H1 in a draft, which is the writer's own title for the piece."""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("# "):
                return line[2:].strip()
    except OSError:
        pass
    return None


def _status_summaries(client_id):
    """topic_slug -> runner._summarize fold over the recorded status feed.

    The lines are rebuilt in line_no order with the keys _summarize reads, so
    history and the status table cannot drift apart: the record's fold and the
    scratch fold go through the one summariser.
    """
    rows = db.q(
        """select t.slug, e.stage, e.event, e.iter, e.score, e.status
           from status_events e
           join topics t on t.id = e.topic_id
           where e.client_id = %s and t.deleted_at is null
           order by t.slug, e.line_no""",
        (client_id,))
    lines_by_slug = {}
    for topic_slug, stage, event, iteration, score, status in rows:
        lines_by_slug.setdefault(topic_slug, []).append({
            "stage": stage, "event": event, "iter": iteration,
            "score": score, "status": status,
        })
    return {
        topic_slug: runner._summarize(topic_slug, lines)
        for topic_slug, lines in lines_by_slug.items()
    }


def _scratch_entry(slug, topic_slug, led, row_index):
    """One history entry off the scratch tree, the way the old disk scan built it.

    Used ONLY for topics a live run holds right now: mid-run, blog.md exists from
    the writer onward while nothing has been committed, and the record would hide
    or understate the topic. None when the scratch has no blog.md yet.
    """
    topic_dir = runner.output_dir(slug, topic_slug)
    blog_path = topic_dir / "blog.md"
    if not blog_path.is_file():
        return None
    lines = runner._read_status(topic_dir)
    summary = runner._summarize(topic_slug, lines) if lines else {}
    entry = led.get(topic_slug) or {}
    title = entry.get("topic") or _title_from_blog(blog_path) or topic_slug
    created = entry.get("generated_at")
    if not created:
        created = datetime.fromtimestamp(
            blog_path.stat().st_mtime, tz=timezone.utc
        ).isoformat()
    return {
        "topic": title,
        "topic_slug": topic_slug,
        "created": created,
        "score": summary.get("score"),
        "status": summary.get("status") or "unknown",
        "iterations": summary.get("iterations"),
        # DID THE LATEST RUN REACH A VERDICT? False on a `failed` row means the loop ran and missed
        # the bar, so there is a draft to read and a decision to make. True means the run produced
        # no judgement at all, so the row wants a retry and its score, if any, belongs to an
        # earlier attempt. See runner._summarize.
        "died": bool(summary.get("died")),
        # Always None on this path: a live/mid-run topic has committed no version, so there is no
        # terminal eval to explain a failure yet. The key is present for the one response shape,
        # exactly like version_no and uploaded below.
        "reason": None,
        "shipped": topic_slug in led,
        # No committed version yet on this path: a topic in a live run is being written now,
        # and the hosted editor is refused for it anyway (its fold is not `done`).
        "version_no": None,
        # Always False on this path and not an oversight: this entry describes a topic in a
        # LIVE RUN, and an upload is refused while any run for the client is live. The key is
        # present because the two builders answer one response shape, and a field that
        # appears on some entries and not others is a field every consumer has to defend
        # against.
        "uploaded": False,
        "roadmap_index": row_index.get(topic_slug),
    }


def _blog_history(slug):
    """Every blog for a client, newest first.

    THE SPLIT, in one sentence per side: SETTLED topics come from the record
    (topics joined to their latest blog_versions plus the status_events fold),
    because the runner commits scratch at the terminal line and scratch can be
    reclaimed after that; topics a LIVE run holds right now come from scratch,
    because agents write there mid-run and nothing is committed yet. Deleting a
    topic in the record (topics.deleted_at) is what removes a blog from the app
    and unblocks its roadmap row, the job a Finder delete used to do.
    """
    client_id = db.client_id(slug)
    if client_id is None:
        return []

    led = ledger.ledger_slugs(slug)
    # Read ONCE for the whole listing, not once per blog: this is a sheet parse, and doing it
    # inside the loop would re-read the same sheet twenty times for twenty copies of one question.
    row_index = roadmap.index_by_slug(slug)
    # Read once for the whole listing, for the same reason row_index is: both are one query
    # answering a question the loop below asks per blog.
    month_index = roadmap.month_by_slug(slug)
    summaries = _status_summaries(client_id)

    # The record: every live topic that carries at least one committed version,
    # with the latest version's title and commit time standing in for the old
    # H1 scan and mtime fallback.
    rows = db.q(
        """select t.slug, t.title, v.h1_title, v.committed_at, v.score,
                  v.version_no, v.eval_body
           from topics t
           join lateral (
             select h1_title, committed_at, score, version_no, eval_body from blog_versions v
             where v.topic_id = t.id
             order by v.version_no desc limit 1
           ) v on true
           where t.client_id = %s and t.deleted_at is null""",
        (client_id,))

    entries = {}
    for topic_slug, topic_title, h1_title, committed_at, version_score, version_no, eval_body in rows:
        # The score is the COMMITTED VERSION's, which sync.commit_topic binds to eval.md's SCORE
        # line. The status feed's fold (summary) still drives status and iterations, but NOT the
        # number: the feed can carry a phantom "best" score a run never shipped, and the Eval tab
        # shows eval.md, so reading the version score is what keeps header and Eval tab identical.
        unscored = version_score is None
        summary = summaries.get(topic_slug) or {}
        entry = led.get(topic_slug) or {}
        # The ledger holds the operator's own topic text, which beats a slug or a
        # writer-invented H1. Fall back only when the blog never shipped, in the
        # old scan's order: the ledger, then the H1, then the topic row, then the slug.
        title = entry.get("topic") or h1_title or topic_title or topic_slug
        created = entry.get("generated_at")
        if not created:
            created = committed_at.isoformat()
        entries[topic_slug] = {
            "topic": title,
            "topic_slug": topic_slug,
            "created": created,
            "score": version_score,
            "status": summary.get("status") or "unknown",
            "iterations": summary.get("iterations"),
            "died": bool(summary.get("died")),
            # WHY THIS DRAFT DID NOT SHIP, surfaced verbatim so a failed row shows its reason
            # without opening the blog. This is the evaluator's own eval.md (blog_versions.eval_body),
            # which IS the response explaining the failure, not a second copy of it. NULL at the
            # bar and above, exactly as asked, and null when there is no eval to show
            # (an uploaded blog, or a run that never scored).
            #
            # THE BAR HERE IS runner.SHIP_SCORE AND IT IS THE ONLY BAR. The band is binary: at or
            # above 90 the blog ships, below 90 it does not, so the comparison that answers "why
            # did this not ship" is the same comparison terminal resolution makes. A draft at 87
            # is below bar, it resolves failed, and it carries its eval body until the operator
            # reads it and sends it. It is also never a literal: this comparison once carried its own `95`,
            # and a second copy of a bar is a bar that drifts. The row's own status/score decide
            # whether a "More info" control renders; this only carries the text.
            "reason": eval_body if (
                version_score is not None and version_score < runner.SHIP_SCORE and eval_body
            ) else None,
            "shipped": topic_slug in led,
            # WHERE THIS BLOG CAME FROM, INFERRED rather than stored, and the inference is
            # exactly this: a blog that reached `done` with no score on its latest version
            # was never evaluated, and blog_upload is the only door into `done` that no
            # evaluator opened. runner._resolve_needs_review returns done ONLY at
            # score >= SHIP_SCORE, so a generated blog standing at done always carries a
            # number. Both halves are load bearing: `done` alone would catch a stopped or
            # failed run, and a null score alone would catch a run still mid-flight.
            #
            # BOTH CONDITIONS, AND NO THIRD. An earlier draft also required eval_body to be
            # null, which is true of an upload and harmlessly stricter here, but the hosted
            # Next route answers the same field over PostgREST where it cannot compute a
            # pair without dragging every eval body across the wire. Two surfaces answering
            # one field must not use two definitions, so the cheaper one wins and it is
            # sound on its own.
            #
            # Derived HERE, once, rather than in the browser, so this reasoning lives beside
            # the query it rests on. If a generated blog ever legitimately ships unscored,
            # this becomes a stored column and every caller keeps working unchanged.
            "uploaded": bool(unscored) and (summary.get("status") == "done"),
            # The latest COMMITTED version number, which the hosted editor sends back as
            # its optimistic lock: admin_save_blog_content refuses a save whose base does
            # not match, so two operators editing one article cannot silently bury each
            # other. The local engine holds APPLY_LOCK instead and ignores this.
            "version_no": version_no,
            # Which row of the CURRENT sheet this blog is, or None when it is on no row. Titles are
            # long, near identical to each other, and nobody holds twenty of them in their head:
            # "change blog six" is the question operators and their clients actually ask, and until
            # this field existed the app could not answer it. Zero based, exactly like
            # RoadmapRow.index; every DISPLAY adds one. See roadmap.index_by_slug.
            "roadmap_index": row_index.get(topic_slug),
            # WHICH MONTH THIS BLOG BELONGS TO, derived from the sheet whose row asked for it.
            # None when no sheet holds the slug, which is a blog created off-roadmap through
            # /create/new or a hand-upload. The Blogs tab groups by this and files a None under
            # the latest month, because generation is locked to the latest month, so an
            # off-roadmap blog was necessarily made while that month was current.
            #
            # Unlike roadmap_index this is NOT the current sheet's answer: a month 1 blog must
            # keep saying month 1 once month 2 exists. See roadmap.month_by_slug.
            "month": month_index.get(topic_slug),
        }

    # Read ONCE and used TWICE below: the scratch overlay picks its topics from this set, and
    # every entry's `live` flag is computed from it. One read so the overlay and the flag can
    # never describe different moments, which would put a topic's scratch on the wire under an
    # entry claiming no run holds it.
    live_slugs = _live_run_slugs(slug)

    # The live overlay: scratch is authoritative for topics in a live run, so a
    # mid-run topic appears (and a mid-revise one reports) exactly as the disk
    # scan surfaced it, terminal line still unwritten.
    for topic_slug in live_slugs:
        if not topic_slug:
            continue
        live_entry = _scratch_entry(slug, topic_slug, led, row_index)
        if live_entry is not None:
            # Stamped here rather than threaded into _scratch_entry, so month_index stays the one
            # source both paths read and a mid-run blog files under the same month it will keep
            # once it settles. A live blog with no sheet row reads None exactly as a settled one
            # does, and the tab files both the same way.
            live_entry["month"] = month_index.get(topic_slug)
            entries[topic_slug] = live_entry

    # THE OPERATOR TITLE OVERRIDE, applied to settled and live entries alike in ONE place.
    # topics.title is NULL for a generated blog, so both title derivations above fall through to
    # the ledger topic or the H1; when an operator RENAMES a blog (POST .../blogs/{topic}/title
    # writes topics.title) that edit is the top-precedence label and outranks every derived
    # source. Applied here rather than threaded through the settled expression and the scratch
    # entry separately, so the two paths cannot disagree about the operator's chosen title.
    for topic_slug, edited in db.q(
            "select slug, title from topics where client_id = %s and deleted_at is null "
            "and title is not null", (client_id,)):
        if topic_slug in entries and edited and edited.strip():
            entries[topic_slug]["topic"] = edited

    # The send-to-client stamp is a RECORD fact (two engines share one record, and a blog
    # teammate A sent must read as sent on teammate B's machine), so it comes from topics
    # for every entry, scratch-overlaid ones included. The review loop's two other facts
    # ride the same read: the approval comes off the same topics rows, and the open
    # client-suggestion counts come from ONE grouped query over blog_comments, never a
    # per-topic probe (twenty blogs must not cost twenty counts).
    # The publish stamp rides this same read for the same reason: it is a record fact, so a
    # blog teammate A pushed to the CMS must read as published on teammate B's machine.
    sent_rows = db.q(
        """select slug, sent_to_client_at, client_approved_at, published_at, cms_status
           from topics where client_id = %s and deleted_at is null""",
        (client_id,))
    sent_map = {row[0]: row[1:] for row in sent_rows}
    # parent_id is null: a client's REPLY is not a change request, and counting one would
    # put a "changes requested" chip on the library card for "thanks, looks good".
    # TWO COUNTS FROM ONE READ, because they answer two different questions. open+applying is
    # changes_requested, the send-gate count. Adding failed gives comments_pending, the
    # human-facing count the state tags split on: a failed apply is the team's retry, so to
    # both humans that comment is simply not yet addressed, and a tag that read "resolved"
    # over one would lie to the admin exactly as portal-data.ts documents it lying to the
    # client. The two tags fold the same fact or the two audiences disagree.
    comment_rows = db.q(
        """select t.slug,
                  count(*) filter (where c.state in ('open', 'applying')),
                  count(*) filter (where c.state in ('open', 'applying', 'failed'))
           from blog_comments c
           join topics t on t.id = c.topic_id
           where c.client_id = %s and c.author = 'client'
             and c.parent_id is null
             and c.state in ('open', 'applying', 'failed')
           group by t.slug""",
        (client_id,))
    changes_map = {row[0]: row[1] for row in comment_rows}
    pending_map = {row[0]: row[2] for row in comment_rows}
    # THE ROUND, which is a different question from the queue above and drives the STATE.
    # "Has the client asked for anything since we last sent this?" It ignores comment state
    # entirely, so it survives resolving, dismissing and a failed apply alike, and only
    # mark_sent moving sent_to_client_at forward closes it. Keying the state off the open
    # COUNT instead meant resolving the last suggestion returned the article to client_review,
    # where the admin has no Send button, stranding the fix they had just made.
    round_map = {row[0] for row in db.q(
        """select distinct t.slug
           from blog_comments c
           join topics t on t.id = c.topic_id
           where c.client_id = %s and c.author = 'client'
             and c.parent_id is null
             and t.sent_to_client_at is not null
             and c.created_at > t.sent_to_client_at""",
        (client_id,))}
    # ANSWERS SUBMITTED: has the client fully answered the form that is on this blog RIGHT NOW.
    # blogState() derives a state from this, and the state exists so an article does not vanish
    # from under a client the moment they press submit: between the submit and the rerun's
    # terminal line the topic still folds to needs_review, and after a clean rerun it folds to
    # internal_review, which the client may not see. Without this fact the card they just acted
    # on disappears with no receipt.
    #
    # SCOPED TO THE CURRENT FORM AND NOTHING ELSE, which is the whole difficulty. review_notes
    # keeps every answered round forever, so "this topic has any answered question" would be true
    # from the first submit onward: the blog would pin at answers_submitted, internal_review would
    # be masked, client_review would be unreachable, and the article would never ship. The current
    # form is the newest evaluator round BY blog_version_id, exactly as client_answers._PENDING_SQL
    # and portal-data.ts define it, and a new round of questions carries a new anchor and no
    # replies, so the fact clears itself with no expiry rule to get wrong.
    #
    # THE REPLY AUTHOR IS FILTERED TO 'client' AND THAT IS DELIBERATE. _PENDING_SQL is
    # author-agnostic on purpose, because it asks a DISPATCH question ("is a revise owed") that an
    # operator-answered form owes just the same. This asks a VISIBILITY question, and portal-data.ts
    # records what an unfiltered read cost there: an operator answering an internal form satisfied
    # it identically, and an internal_review article the client must never see appeared in their
    # portal captioned as their own answers. Same fold, different author filter, and each surface
    # filters for the question it is actually asking.
    #
    # STALENESS IS NOT APPLIED HERE, and that is the point rather than an omission. The other three
    # twins raise stale once a new version lands under the form, because they gate whether the form
    # may still be SUBMITTED or DISPATCHED. This fact says the client already answered, which a new
    # version cannot un-do. Clearing it when the rerun commits is exactly the vanishing card above:
    # a clean rerun at or above the 90 bar asks nothing new, so the client is meant to
    # keep holding the old draft and their own answers until an admin sends. The stamp therefore
    # stands until the next round of questions replaces the anchor or a send moves the article past
    # it in blogState's ladder.
    answered_map = dict(db.q(
        """with form as (
             select n.topic_id,
                    (select n2.blog_version_id from review_notes n2
                      where n2.topic_id = n.topic_id and n2.author = 'evaluator'
                        and n2.parent_id is null
                      order by n2.created_at desc limit 1) as version_id
             from review_notes n
             where n.client_id = %s and n.author = 'evaluator' and n.parent_id is null
             group by n.topic_id)
           select t.slug, max(r.created_at)
           from form f
           join topics t on t.id = f.topic_id and t.deleted_at is null
           join review_notes q on q.topic_id = f.topic_id and q.author = 'evaluator'
                              and q.parent_id is null and q.blog_version_id = f.version_id
           join review_notes r on r.parent_id = q.id and r.author = 'client'
           where not exists (
                   select 1 from review_notes q2
                   where q2.topic_id = f.topic_id and q2.author = 'evaluator'
                     and q2.parent_id is null and q2.blog_version_id = f.version_id
                     and not exists (select 1 from review_notes r2
                                      where r2.parent_id = q2.id and r2.author = 'client'))
           group by t.slug""",
        (client_id,)))

    # Newest first stays the default, because the library's own question is "what happened lately".
    # Sorting by roadmap_index here would be wrong twice over: a blog on no row has none to sort by,
    # and the operator can already order by number in the browser, where it is one click and
    # reversible rather than a decision baked into every caller of this function.
    blogs = list(entries.values())
    for entry in blogs:
        sent_at, approved_at, published_at, cms_status = sent_map.get(
            entry["topic_slug"], (None, None, None, None))
        entry["sent_to_client"] = sent_at.isoformat() if sent_at else None
        entry["client_approved"] = approved_at.isoformat() if approved_at else None
        entry["changes_requested"] = int(changes_map.get(entry["topic_slug"], 0))
        entry["comments_pending"] = int(pending_map.get(entry["topic_slug"], 0))
        entry["change_round_open"] = entry["topic_slug"] in round_map
        # An ISO stamp rather than a boolean, matching every other human-act field on this
        # entry, so a card can render "Questions answered, 18 Jul" without a second call.
        answered_at = answered_map.get(entry["topic_slug"])
        entry["answers_submitted"] = answered_at.isoformat() if answered_at else None
        # Null means "no record of a push", never "not published". See cms/record.py.
        entry["published"] = published_at.isoformat() if published_at else None
        entry["cms_status"] = cms_status
        # IS A RUN HOLDING THIS TOPIC RIGHT NOW, from the run registry and from nothing else.
        #
        # THE STATUS FOLD CANNOT ANSWER THIS AND THE ATTEMPT WAS A SHIPPED BUG. status.jsonl is
        # append-only and OUTLIVES the run that wrote it (runner._status_baseline says so at
        # length), so runner._terminal_line scanning the whole file returns the PREVIOUS run's
        # verdict for a topic a new run is working on this second. A re-run therefore reports
        # `needs_review` or `done` while it is live, so a live answer-driven revise rendered as
        # "Has questions" with the answer form still mounted, inviting a second submit against a
        # revise already applying the first. Only the first run a topic ever has folds to
        # "running", because only then is the file free of an older terminal line.
        #
        # The registry has no such history: a run is in RUNS from the operator's POST until its
        # task settles, and nothing else. QUEUED COUNTS AS LIVE, deliberately: register_run
        # publishes a run as live before it starts (the engine's queue can hold it for minutes), the
        # scratch overlay above already treats those topics as the run's, and every write guard
        # in this file refuses on the same flag. A topic the operator has committed to a run is
        # not one to offer an edit or an answer form on.
        #
        # PRODUCED HERE, CONSUMED ON THE DASHBOARD. The state machine keys `generating` off this
        # rather than off the fold; this side owes it the fact and nothing more.
        entry["live"] = entry["topic_slug"] in live_slugs
    blogs.sort(key=lambda b: b["created"], reverse=True)
    return blogs


@app.get("/api/clients/{slug}/blogs")
async def api_blogs(slug: str, user: auth.Identity = Depends(auth.require_user)):
    _client_or_404(slug, user)
    return {"blogs": _blog_history(slug)}


@app.get("/api/clients/{slug}/blogs/download-all")
async def api_blogs_download_all(slug: str,
                                 topics: list[str] | None = Query(None),
                                 user: auth.Identity = Depends(auth.require_user)):
    """Every blog this brand has, as ONE .docx: a cover page reading "Blog N" with the article's
    title beneath, then the article, for each blog. Reads the latest committed version body per
    live topic, the SAME body the library shows, ordered by roadmap position so "Blog 1" is the
    first row of the content plan. Engine-only, like the report and analysis PDFs.

    `topics` NARROWS IT TO A SELECTION and changes nothing else: same query, same roadmap
    ordering, same cover pages, filtered. The library's bulk bar bundles what the operator ticked.
    The cover numbers stay SEQUENTIAL OVER THE DOCUMENT, so a subset reads Blog 1, Blog 2, Blog 3
    rather than carrying the gaps of what was left out. That is the cover page doing its own job:
    the number orients a reader inside THIS document, and it has never matched the library's "#"
    column anyway, which counts engine-written blogs in creation order while this orders by the
    content plan. Omitted (the whole brand) is the original behaviour, byte for byte.

    Declared before the /blogs/{topic}/... routes so "download-all" is never read as a topic."""
    _client_or_404(slug, user)
    wanted = {t for t in (topics or []) if t}
    cid = db.client_id(slug)
    rows = db.q(
        """select t.slug, t.title as topic_title,
                  coalesce(v.h1_title, t.slug) as fallback, v.body
             from topics t
             join lateral (
               select h1_title, body from blog_versions v
               where v.topic_id = t.id order by v.version_no desc limit 1
             ) v on true
            where t.client_id = %s and t.deleted_at is null
              and v.body is not null and length(btrim(v.body)) > 0""",
        (cid,)) if cid else []
    if wanted:
        rows = [row for row in rows if row[0] in wanted]
    if not rows:
        raise HTTPException(
            status_code=404,
            detail=(f"none of the {len(wanted)} selected blogs has a draft to download"
                    if wanted else f"no blogs to download for {slug!r}"))

    # Title and order mirror the library's own precedence: an operator rename (topics.title) wins
    # over the ledger's operator topic text, which beats a writer H1, and roadmap position orders
    # the plan, sheet-less blogs falling after it by title.
    led = ledger.ledger_slugs(slug)
    order = roadmap.index_by_slug(slug)

    def title_of(topic_slug, topic_title, fallback):
        # ONE precedence, used for both the tiebreak and the shown label, so a sheet-less blog
        # is never ordered by a title different from the one on its cover page.
        return topic_title or (led.get(topic_slug) or {}).get("topic") or fallback

    def sort_key(row):
        topic_slug, topic_title, fallback, _body = row
        index = order.get(topic_slug)
        return (index if index is not None else 10 ** 9, title_of(topic_slug, topic_title, fallback).lower())

    blogs = [
        (title_of(topic_slug, topic_title, fallback), body)
        for topic_slug, topic_title, fallback, body in sorted(rows, key=sort_key)
    ]
    data = await asyncio.to_thread(docx_export.build_docx, blogs)
    return Response(
        content=data, media_type=docx_export.CONTENT_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{slug}-blogs.docx"'})


# ---------------------------------------------------------------------------
# The operator answer loop.
#
# An evaluator can ask the operator a question no rewrite answers, because the missing thing is a
# fact only a person holds. These two routes are the whole of the operator's side: read the form,
# submit the form. Submitting starts a SURGICAL REVISE, and runner.revise_topic SHIPS THE CLARIFIED
# DRAFT AT WHATEVER IT SCORES, higher or lower. Truth beats score: the operator's answer changed
# the fact base the earlier score was computed against, so a fall is the truth costing points, not
# the draft getting worse. A negative answer forces a claim to be CUT, and the old
# higher-score-ships rule read that cut as damage and handed back the original with the violation
# still in it. The original returns only where no clarified draft was produced AT ALL: a stop, a
# crash, or a session that died before scoring, each of which leaves a half applied revise rather
# than a corrected article.
# ---------------------------------------------------------------------------

class AnswerItem(BaseModel):
    id: str
    answer: str


class AnswersRequest(BaseModel):
    answers: list[AnswerItem]


def _topic_or_404(slug, topic_slug):
    """The topic must be a live topics row: record-backed, never a directory stat, because
    scratch outlives and predates the record only inside a run. The slug-format check stays as
    the traversal guard the old resolve() gave: an unknown topic and a smuggled ../ get the
    same answer, because both are asking for something that is not this client's blog."""
    if runner.slugify(topic_slug) != topic_slug or db.topic_id(slug, topic_slug) is None:
        raise HTTPException(
            status_code=404, detail=f"no blog {topic_slug!r} for client {slug!r}"
        )


@app.get("/api/clients/{slug}/blogs/{topic}/questions")
async def api_questions(slug: str, topic: str,
                        user: auth.Identity = Depends(auth.require_user)):
    """The evaluator's questions for one blog, plus what the operator can do about them.

    stale and blocking are computed here rather than stored, and that is deliberate. Both are
    facts about the questions RELATIVE to the blog right now: the blog moves on, and a stored
    flag would be a snapshot of what was true when the evaluator asked. The staleness bug this
    endpoint exists to expose is exactly that mismatch.
    """
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    try:
        return questions_mod.describe_questions(slug, topic)
    except questions_mod.NoQuestions as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/clients/{slug}/blogs/{topic}/answers", status_code=202)
async def api_answers(slug: str, topic: str, body: AnswersRequest,
                      user: auth.Identity = Depends(auth.require_user)):
    """Record the operator's answers and start a surgical revise.

    202 and not 200, for the reason every long job here is 202: the revise is a real session and
    the engine owns it. The browser only watches, through the same SSE run feed a batch uses.

    The refusals run before the write, in this order, and the order is the point. STALE first:
    a stale form is void permanently, and no edit to the body saves it, so telling the operator
    to fill in q2 before telling them the whole form describes a draft that no longer exists
    would waste a round trip on a fix that was never going to work. Then the live run, which is
    transient and honestly answered by "wait". Then the body, which is the only one they can fix
    by typing.
    """
    _client_or_404(slug, user)

    # The one write a non-admin may perform, and only with a role that says so:
    # an org viewer reads, an org admin or commenter answers. The evaluator's
    # questions are the client's to answer (facts only the client holds), which
    # is why this write alone is not admin-gated. The isinstance guard is the
    # same sentinel rule _scope documents: config_check calls handlers as plain
    # functions where Depends never resolves, and that sentinel cannot arrive
    # over HTTP because require_user runs before any handler does.
    if isinstance(user, auth.Identity) and not (
            user.is_admin or user.roles.get(slug) in ("admin", "commenter")):
        raise HTTPException(status_code=403, detail="answering requires a commenter or admin role")

    _topic_or_404(slug, topic)

    # THE APPROVED LOCK, ahead of the form checks, because it is the permanent one and they
    # are not: a stale form can be re-asked and an unanswered one can be answered, while an
    # approved article is finished. An answer dispatches a surgical revise, which rewrites the
    # draft and commits a version, so it is a full edit reached through the answer door.
    # Refused here rather than at the revise's own commit, where migration 013's trigger would
    # catch it only after a real SDK session had already been spent on it.
    _require_not_approved(slug, topic, "a revise")

    try:
        state = questions_mod.describe_questions(slug, topic)
    except questions_mod.NoQuestions as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    if state["stale"]:
        # The bug this whole feature tripped over once, refused at the boundary. Answers about a
        # superseded draft fed into a revise of a different one would carry every bit of a human
        # answer's authority and none of its relevance.
        raise HTTPException(
            status_code=409,
            detail=(
                f"these questions describe iteration {state['iter']} of {topic!r}, but the blog "
                f"is on iteration {questions_mod.current_iteration(slug, topic)}. A revise has "
                f"replaced the draft they ask about, so it no longer exists and these answers "
                f"cannot be applied to the draft that does."
            ),
        )
    _refuse_if_topic_in_flight(slug, topic, "answering")

    try:
        questions_mod.write_answers(slug, topic, [item.model_dump() for item in body.answers])
    except questions_mod.UnansweredQuestions as exc:
        # Every question needs an answer: a revise dispatched on a half filled form would hand the
        # writer silence where the operator meant to say something, and silence reads as "no
        # constraint" rather than "not answered yet".
        raise HTTPException(status_code=422, detail={
            "detail": str(exc),
            "unanswered": exc.ids,
        })
    except questions_mod.NoQuestions as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    run_id = uuid.uuid4().hex
    # Registered synchronously, before the task is scheduled, exactly as api_generate does it: the
    # 202 carries the record back and _client_has_live_run must see this run immediately, or a
    # second submit slips through the gap before the task first runs.
    record = runner.register_revise_run(run_id, slug, topic)
    # A revise is registered live exactly like a batch, so stop_client already MARKS it stopped.
    # Without a handle it would only ever mark it: the record would read stopped while the session
    # kept spending quota, which is the one outcome a Stop button may never produce. Registered on
    # this side, with no await after register_revise_run, for the reason api_generate gives.
    task = asyncio.create_task(_revise_task(run_id, slug, topic))
    runner.register_run_task(run_id, task)
    task.add_done_callback(lambda _task: runner._discard_run_task(run_id))
    return record


@app.post("/api/clients/{slug}/blogs/{topic}/revise", status_code=202)
async def api_revise_answered(slug: str, topic: str,
                              user: auth.Identity = Depends(auth.require_admin)):
    """RERUN: dispatch the answer-driven revise an already-answered form is owed.

    The portal records a client's answers with no engine behind it, so the revise the
    contract mandates has nowhere to run at submit time. This route is that dispatch,
    placed behind the operator's own click: the run spends THIS machine's quota, so a
    person chooses the moment, which is also why the automatic pickup sweep ships
    disabled. Admin-only: answering is the client's act, rerunning is the operator's.

    Refusals mirror api_answers where they share a reason: unknown topic, no form,
    stale form, live run. Two are this route's own: a form nobody answered has nothing to
    apply (409), and a claim already held means another machine's engine is mid-rerun on
    this exact topic, so a second dispatch would double-spend (409). The claim is released
    when the dispatched task settles; a crashed engine's claim expires on its own.
    """
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    # The same lock api_answers makes, at the same point and for the same reason: this route
    # dispatches the identical revise, so an approved article has to be refused on both doors
    # or the rerun button becomes the way around the one that checks.
    _require_not_approved(slug, topic, "a revise")

    try:
        state = questions_mod.describe_questions(slug, topic)
    except questions_mod.NoQuestions as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if state["stale"]:
        raise HTTPException(
            status_code=409,
            detail=f"these questions describe an earlier draft of {topic!r}; a revise has "
                   f"already replaced the draft they ask about, so there is nothing to rerun",
        )
    if not state["answered"]:
        raise HTTPException(
            status_code=409,
            detail=f"the questions on {topic!r} have no answers yet, so a rerun has nothing "
                   f"to apply; answer them (or wait for the client to) first",
        )
    _refuse_if_topic_in_flight(slug, topic, "rerunning")

    tid = db.topic_id(slug, topic)
    if not client_answers.claim(tid):
        raise HTTPException(
            status_code=409,
            detail="another engine already claimed this rerun; it is being reworked there",
        )

    run_id = uuid.uuid4().hex
    record = runner.register_revise_run(run_id, slug, topic)
    task = asyncio.create_task(_revise_task(run_id, slug, topic))
    runner.register_run_task(run_id, task)
    task.add_done_callback(lambda _task: runner._discard_run_task(run_id))
    task.add_done_callback(
        lambda _task, t=tid, cs=slug, ts=topic: client_answers._release_later(t, cs, ts))
    return record


# ---------------------------------------------------------------------------
# The admin-review stage: operator edits on a SHIPPED blog, then the send to the client.
#
# These routes exist for exactly one workflow state: the blog is done (the evaluator passed
# it and nothing is asked), and an operator is polishing it before the client receives it.
# Nothing here touches the pipeline: the score stands, gates already ran before it, and the
# only thing that changes is the article's bytes and, at the end, the sent stamp that lets
# the portal show it.
# ---------------------------------------------------------------------------

@app.exception_handler(blog_edit.EditError)
async def _edit_error_handler(request: Request, exc: blog_edit.EditError):
    """EditError is a 409, app wide, because every one of them is a refusal and none is a bug.

    THE GUARD THAT PRODUCED THE 500 IT WAS WRITTEN TO PREVENT. blog_edit's approved lock exists
    so an operator gets a sentence naming the approval instead of an unmapped PORTAL:LOCKED
    exception from migration 013's trigger. It raises EditError, which is the shape the BACKGROUND
    apply path already handles (_apply lands it on the comment as a failed verdict with its reason
    attached). Nothing handled it on the REQUEST path, so the same refusal reaching a route came
    back as a 500 with a stack trace: exactly the outcome the lock was added to remove, one layer
    up from where it was removed.

    REGISTERED ONCE HERE RATHER THAN WRAPPED AROUND EACH CALL, and the reason is that the set of
    routes able to reach one is not stable. Two do today: filing a comment (blog_edit.add_comment)
    and saving the operator's own bytes (blog_edit.save_content). Both already call
    _require_not_approved first, so the approved EditError behind them is the TOCTOU remainder, an
    approval landing between the route's SELECT and the write, which is ordinary here because the
    portal is a second writer against one shared record. save_content also raises for a moved
    record (CONFLICT_ERROR) and add_comment for a topic that vanished mid request. A per route
    try/except would have to be remembered by the third route, and a refusal protocol enforced by
    remembering is the one this module already learned does not hold.

    409 FITS EVERY MEMBER, which is what makes one status honest rather than lazy. Each EditError
    reports a request that cannot proceed against the article's CURRENT state, whether that state
    is approved, moved under the caller, or gone. The messages are written for an operator to
    read, so the exception's own text is the detail, exactly as the UploadError mapping does with
    its own. The model-facing ones (a dead edit session, unparseable output) never reach a
    request: _apply catches them in the background and attaches them to the comment.
    """
    return JSONResponse(status_code=409, content={"detail": str(exc)})


class CommentRequest(BaseModel):
    selected_text: str
    instruction: str
    context_before: str = ""
    context_after: str = ""


class ContentRequest(BaseModel):
    body: str


def _topic_status(slug, topic_slug):
    """The status fold for ONE topic, from the record. The callers below run after
    _topic_or_404, so the client and topic both exist."""
    client_id = db.client_id(slug)
    summary = _status_summaries(client_id).get(topic_slug) or {}
    return summary.get("status") or "unknown"


def _require_done(slug, topic_slug, act):
    """409 unless the topic's verdict is done. Editing a draft the pipeline still owns
    races the writer and the revise restore; editing a failed one polishes something the
    evaluator never passed. The stage is for shipped blogs, and the engine says so."""
    status = _topic_status(slug, topic_slug)
    if status != "done":
        raise HTTPException(
            status_code=409,
            detail=f"{topic_slug!r} is {status}, not done; {act} is for shipped blogs only",
        )


def _require_reviewable(slug, topic_slug, act):
    """409 unless the verdict is done OR failed: the admin-review bench, which now includes a
    failed draft. The operator may polish a draft that fell below the 90 bar, with
    edits and Claude comments, before sending it, because the artifact that goes out should be
    the draft they are satisfied with, not the draft plus a wish list. The
    boundaries stay hard: needs_review
    is a hold no edit clears (answering is the only door), stopped and running have no settled
    draft to edit, and the SEND stays behind _require_done, which a failed draft passes only by
    being promoted into `done` on the way through it."""
    status = _topic_status(slug, topic_slug)
    if status not in ("done", "failed"):
        raise HTTPException(
            status_code=409,
            detail=f"{topic_slug!r} is {status}, not done or failed; {act} is for settled "
                   f"drafts on the admin-review bench only",
        )


def _require_not_approved(slug, topic_slug, act):
    """409 unless the client's approval is absent. The HTTP half of the approved lock.

    Migration 013 put triggers on blog_versions and top-level blog_comments so no engine can
    change an article the client signed off on, and blog_edit's guards refuse before those
    triggers fire. This is the layer above both: it answers the OPERATOR, in the 409 every
    other refusal on these routes already speaks, instead of letting a database exception with
    an unmapped PORTAL:LOCKED string surface as a 500 and a stack trace.

    It runs beside _require_done rather than inside it because the two say different things and
    send the operator to different places. Not-done means the pipeline is not finished with the
    blog yet; approved means it is finished with it permanently, and the only act left is the
    publish. A blog can be done and approved at once, so both checks run. On the edit and
    comment doors this one goes second, because done is the more basic fact and its message is
    the more useful one for a topic that is neither. On the SEND door it goes first, because the
    promotion sits between the two there and an approved row must be refused before a done
    verdict is appended to its trail.
    """
    approved = blog_edit.approved_at(slug, topic_slug)
    if approved is not None:
        raise HTTPException(
            status_code=409, detail=blog_edit.locked_detail(approved, act))


def _with_client_since(slug, topic_slug):
    """When this article went out to the client, IF it is still with them unanswered, else None.

    ONE DEFINITION OF "out with the client", because two callers refuse on it in two different
    idioms: _require_not_with_client raises on the spot for a single-topic route, and api_generate
    collects every offending row so it can refuse a whole submit and name them all. Two copies of
    this condition is how one door comes to permit what the other refuses.

    The condition is `sent_to_client_at is not null AND no round open`, which is exactly
    blogState's `client_review` (a send stamp with the round test deciding between client_review
    and changes_requested). The round predicate is copied from blog_edit.sent_state so the two
    agree by construction: top-level client comments only, created after the last send, ignoring
    comment state entirely so resolving one does not close the round.

    A topic the record does not hold answers None. db.topic_id filters deleted_at, which is the
    behaviour this wants rather than an accident: deleting the topic in the record is the
    documented way to re-free it (ledger.live_slugs says so), and a deleted topic is not with
    anybody.
    """
    tid = db.topic_id(slug, topic_slug)
    if tid is None:
        return None
    row = db.q(
        """select t.sent_to_client_at,
                  exists (select 1 from blog_comments c
                           where c.topic_id = t.id and c.author = 'client'
                             and c.parent_id is null
                             and t.sent_to_client_at is not null
                             and c.created_at > t.sent_to_client_at)
           from topics t where t.id = %s""",
        (tid,), fetch="one")
    if row is None:
        return None
    sent_at, round_open = row
    # Never sent, so the article has never left the team. A round open means the client has asked
    # for something and the article is back with the team to answer it, which is the state whose
    # whole purpose is to permit the edit. Either way, not with the client.
    if sent_at is None or round_open:
        return None
    return sent_at


def _require_not_with_client(slug, topic_slug, act):
    """409 while the article is OUT WITH THE CLIENT and they have asked for nothing back.

    THE BUG THIS CLOSES DECOUPLES AN APPROVAL FROM THE BYTES IT DESCRIBES. mark_sent pins
    topics.sent_version_id to the version it released, and the portal renders THAT version, so
    the client is reading fixed bytes. An admin save between the send and the approval commits a
    new version while the pin stays where it was, and the client then approves the version they
    were sent. Migration 013 locks the article at that moment with the record permanently
    asserting an approval over bytes that are not the current ones, and no later act can
    reconcile the two, because approved is the state in which nobody edits anything.

    REFUSING IS WHAT THE STATE MACHINE ALREADY PROMISES, so this adds no new rule. dashboard's
    blog-state.ts gives `client_review` an EMPTY admin action list, and says why in the same
    words: the client is reading the exact bytes pinned by sent_version_id, so an edit here
    changes the article underneath someone mid review. The UI has hidden the control all along;
    this is the API agreeing with it. The alternative, clearing the send on every save, was
    rejected because it silently retracts an article a client may be halfway through reading and
    turns a typo fix into an unsend nobody asked for.

    THE ROUND IS WHAT MAKES THIS SAFE, and it is the difference between refusing and dead ending
    the loop. A client change request opens a round, which moves the article to
    `changes_requested`, whose admin actions include `edit` precisely so the team can make the
    change that was asked for. So the refusal is scoped to sent AND no round open, matching
    blogState exactly. A round is sticky until the next send (blog_edit.sent_state says why), so
    resolving the last suggestion does not slam this door on the operator mid fix.

    An approved article never reaches here: _require_not_approved runs first and its sentence is
    the more useful one, naming the date and the one act left.
    """
    sent_at = _with_client_since(slug, topic_slug)
    if sent_at is None:
        return
    raise HTTPException(
        status_code=409,
        detail=(f"{topic_slug!r} was sent to the client on {sent_at:%d %b %Y} and is with them "
                f"now, so {act} is not available on it. They are reading the exact version that "
                f"was sent, and changing it here would leave them approving bytes that are no "
                f"longer the current ones. Wait for them to approve it or ask for a change; a "
                f"change request reopens this for editing."),
    )


@app.get("/api/clients/{slug}/blogs/{topic}/comments")
async def api_blog_comments(slug: str, topic: str,
                            user: auth.Identity = Depends(auth.require_user)):
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    return {"comments": await asyncio.to_thread(blog_edit.read_comments, slug, topic)}


@app.post("/api/clients/{slug}/blogs/{topic}/comments", status_code=202)
async def api_add_blog_comment(slug: str, topic: str, body: CommentRequest,
                               user: auth.Identity = Depends(auth.require_admin)):
    """File one selection comment and start the Claude session that applies it.

    202 with the comment record: the apply is a real session taking tens of seconds, so
    the browser watches the comment list rather than holding this request open. Refusals
    run permanent-first, exactly as api_answers orders its own: the topic's
    state, then the transient live run and in-flight cap, then the body the operator can
    fix by typing.
    """
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    _require_reviewable(slug, topic, "a Claude edit")
    # Permanent before transient, exactly as this route's own ordering comment states: an
    # approved article is locked for good, so saying so before the live-run and in-flight
    # refusals keeps the operator from waiting out a run to retry something that will never
    # be allowed. An operator comment is born 'applying' and runs Claude at once, which is
    # why filing one on an approved article is refused rather than merely left unapplied.
    _require_not_approved(slug, topic, "a Claude edit")
    # THE SAME HOLE THE SAVE ROUTE HAD, through a different door. A Claude edit commits a new
    # blog_versions row exactly as a manual save does, so filing one while the article is out
    # with the client moves the bytes while topics.sent_version_id still points at the version
    # they are reading. They then approve a version that is no longer current, and migration
    # 013 locks that divergence in permanently. blog-state.ts grants `client_review` no
    # `comments` action for this reason, so an operator reaching here is bypassing a refusal
    # the product already makes; guarding the save alone would have enforced the state machine
    # on one of the three doors that write a version.
    _require_not_with_client(slug, topic, "a Claude edit")
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; edit once it finishes so the engine's "
                   f"own writes are not raced",
        )
    if await asyncio.to_thread(blog_edit.in_flight_count, slug, topic) >= blog_edit.MAX_IN_FLIGHT:
        raise HTTPException(
            status_code=409,
            detail=f"{blog_edit.MAX_IN_FLIGHT} changes are already in flight for "
                   f"{topic!r}; wait for one to land before filing another",
        )
    selected = body.selected_text.strip()
    instruction = body.instruction.strip()
    if not selected or not instruction:
        raise HTTPException(
            status_code=422,
            detail="a comment needs both the selected text and an instruction",
        )

    comment = await asyncio.to_thread(
        blog_edit.add_comment,
        slug, topic,
        selected_text=selected,
        instruction=instruction,
        context_before=body.context_before,
        context_after=body.context_after,
        author="operator",
        author_email=getattr(user, "email", "") or "",
    )
    blog_edit.start_apply(slug, topic, comment["id"])
    return comment


@app.post("/api/clients/{slug}/blogs/{topic}/comments/{comment_id}/resolve", status_code=202)
async def api_resolve_blog_comment(slug: str, topic: str, comment_id: str,
                                   user: auth.Identity = Depends(auth.require_admin)):
    """Send one waiting comment to Claude. The client's suggestions arrive in state
    'open' with no apply behind them (the portal runs no engine), so this button is
    where an operator spends the session on one; a 'failed' comment of either author
    retries through the same door. 202 with the flipped record, for the reason filing
    a comment answers 202: the apply is a real session and the browser watches the
    comment list. Refusals run permanent-first, exactly as filing orders its own:
    the topic's state, then the transient live run, then the comment itself. The
    in-flight cap no longer has its own step here, because it rides inside the flip
    statement (resolve_comment says why); this route reads its refusal off a flip that
    returned nothing."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    _require_reviewable(slug, topic, "a Claude edit")
    # Resolving spends a Claude session that ends in a committed version, so it is the same
    # act as filing a comment as far as the approved lock is concerned. It matters separately
    # from the filing route because a suggestion filed BEFORE the approval is still sitting
    # there open afterwards, and this button is the one that would apply it.
    _require_not_approved(slug, topic, "a Claude edit")
    # Same reasoning as the filing route: an apply commits a version, so doing it while the
    # client is reading moves the bytes out from under sent_version_id.
    #
    # THIS GUARD IS A NO-OP FOR THE CASE THIS BUTTON EXISTS TO SERVE, which is why it is safe
    # here. _with_client_since answers "sent AND no change round open", so a topic with a live
    # client suggestion is `changes_requested`, not `client_review`, and passes straight
    # through. Resolving is the whole point of that state. What it refuses is resolving a
    # suggestion left over from a PREVIOUS round after the article went back out, where the
    # apply would change bytes the client is reading right now.
    _require_not_with_client(slug, topic, "a Claude edit")
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; resolve once it finishes so the engine's "
                   f"own writes are not raced",
        )
    found = await asyncio.to_thread(blog_edit.get_comment, slug, topic, comment_id)
    if found is None:
        raise HTTPException(status_code=404, detail=f"no comment {comment_id!r} on {topic!r}")
    flipped = await asyncio.to_thread(blog_edit.resolve_comment, slug, topic, comment_id)
    if flipped is None:
        # TWO conditions can refuse the flip and they now share one statement: the
        # comment's state, and the in-flight cap that used to be a separate count this
        # route ran first (resolve_comment says why that count could not stay here).
        # Re-read to say which, because "still open" and "three are already running" send
        # the operator to different actions. A comment that STILL reads open or failed was
        # refused by the cap; anything else was refused by its own state.
        fresh = await asyncio.to_thread(blog_edit.get_comment, slug, topic, comment_id)
        state = (fresh or found)["state"]
        if state in ("open", "failed"):
            raise HTTPException(
                status_code=409,
                detail=f"{blog_edit.MAX_IN_FLIGHT} changes are already in flight for "
                       f"{topic!r}; wait for one to land before starting another",
            )
        raise HTTPException(
            status_code=409,
            detail=f"this change is {state}; only an open or failed one can "
                   f"be resolved with Claude",
        )
    blog_edit.start_apply(slug, topic, comment_id)
    return flipped


@app.post("/api/clients/{slug}/blogs/{topic}/comments/{comment_id}/to-instructions")
async def api_comment_to_instructions(slug: str, topic: str, comment_id: str,
                                      user: auth.Identity = Depends(auth.require_admin)):
    """Reframe one comment as a standing brand instruction and append it to the brand's
    custom instructions, then stamp the comment so every surface reads it as added.

    The ENGINE owns the whole act on purpose: the reframe is a Claude call, and the append
    is ATOMIC IN THE DATABASE (a concat inside one UPDATE), because two operators clicking
    at once, or one click racing another comment's, must not interleave: a read here, a
    multi-second reframe, and a write-back was exactly that lost-update window, and the
    review that found it proved two concurrent appends dropped a line. No done gate and
    no approved gate: the write lands on the BRAND record, not on this article, which is
    also why the button stays live on a resolved comment. 409 answers a comment already
    stamped, because the reframed line is already in the instructions and a second append
    would say it twice."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    comment = await asyncio.to_thread(blog_edit.get_comment, slug, topic, comment_id)
    if comment is None:
        raise HTTPException(status_code=404, detail=f"no comment {comment_id!r} on {topic!r}")
    if comment.get("added_to_instructions"):
        raise HTTPException(status_code=409,
                            detail="this comment is already in the brand instructions")

    record = await asyncio.to_thread(clients_mod.read_client, slug)
    brand_name = record.get("name") or slug
    try:
        line = await blog_edit.reframe_as_instruction(
            brand_name, comment["selected_text"], comment["instruction"])
    except blog_edit.EditError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    def _append_instruction():
        # The concat happens inside the UPDATE, so concurrent appends serialize on the row
        # and neither is lost; the multi-second reframe above sits safely outside it. The
        # scratch copy then follows the record, exactly as update_client orders it.
        db.q(
            r"""update clients
                set custom_instructions = case
                      when btrim(coalesce(custom_instructions, '')) = '' then %s
                      else rtrim(custom_instructions) || E'\n\n' || %s
                    end
                where id = %s""",
            (line, line, db.client_id(slug)), fetch="none")
        db.invalidate_client_cache()
        sync.materialize_client(slug)

    await asyncio.to_thread(_append_instruction)
    stamped = await asyncio.to_thread(
        blog_edit.mark_added_to_instructions, slug, topic, comment_id)
    return {"instruction": line, "comment": stamped}


@app.delete("/api/clients/{slug}/blogs/{topic}/comments/{comment_id}", status_code=204)
async def api_delete_blog_comment(slug: str, topic: str, comment_id: str,
                                  user: auth.Identity = Depends(auth.require_admin)):
    """DISMISS one comment, any author's: closed without an edit, never deleted. The verb
    changed with the shared record, because the client can see their own suggestion, and
    a row that silently vanished reads as lost while a dismissed one reads as reviewed.
    An applying one is still refused: its background task would land its verdict on a
    row that reads closed."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    found = await asyncio.to_thread(blog_edit.get_comment, slug, topic, comment_id)
    if found is None:
        raise HTTPException(status_code=404, detail=f"no comment {comment_id!r} on {topic!r}")
    if found.get("state") == "applying":
        raise HTTPException(
            status_code=409,
            detail="this change is still being applied; it can be dismissed once it lands",
        )
    if await asyncio.to_thread(blog_edit.dismiss_comment, slug, topic, comment_id) is None:
        # A resolve flipped it to applying between the read above and the dismiss: the
        # atomic close refused, so answer exactly what the pre-check would have.
        raise HTTPException(
            status_code=409,
            detail="this change is still being applied; it can be dismissed once it lands",
        )
    return Response(status_code=204)


class TitleRequest(BaseModel):
    title: str


@app.post("/api/clients/{slug}/blogs/{topic}/title")
async def api_set_blog_title(slug: str, topic: str, body: TitleRequest,
                             user: auth.Identity = Depends(auth.require_admin)):
    """Rename one blog: set topics.title, the operator-facing label the library and stage show.
    Synchronous, a single-column UPDATE.

    NO status gate and NO live-run 409, unlike api_save_blog_content below. Those guard the
    blog.md BYTES the writer and revise produce, plus the client-review pin; a title is a
    topics-column label the loop never rewrites mid-run (sync.commit_topic calls db.ensure_topic
    WITHOUT a title, so its coalesce keeps the operator's value). So a rename races nothing the
    engine writes and stays editable at any status. The override wins at read time in
    _blog_history, where a non-null topics.title outranks the ledger topic and the H1."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    # A title is a single-line label. Collapse every run of whitespace (including the newlines a
    # paste can carry) to one space so it renders cleanly in the h2 and the docx cover, and cap
    # length like every other write endpoint (api_save_blog_content, uploads) rather than storing
    # an unbounded string that becomes top-precedence in every label.
    title = " ".join(body.title.split())
    if not title:
        raise HTTPException(
            status_code=422,
            detail="a blank title cannot be saved; the blog keeps its current title instead",
        )
    if len(title) > 300:
        raise HTTPException(
            status_code=422,
            detail="this title is too long; keep it under 300 characters",
        )
    tid = db.topic_id(slug, topic)  # _topic_or_404 already resolved this, so never None here
    await asyncio.to_thread(
        db.q, "update topics set title = %s where id = %s", (title, tid), fetch="none")
    return {"title": title}


@app.post("/api/clients/{slug}/blogs/{topic}/content")
async def api_save_blog_content(slug: str, topic: str, body: ContentRequest,
                                user: auth.Identity = Depends(auth.require_admin)):
    """Save the operator's own edit of blog.md. Synchronous, not 202: the write plus the
    record commit is subsecond, and the operator pressing Save deserves to know it landed
    before the button releases."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    _require_reviewable(slug, topic, "editing")
    # The editor is the most direct way to change bytes the client already accepted, so the
    # lock is checked before the body is even looked at. save_content refuses this too; this
    # is what turns the refusal into a 409 the Save button can render, rather than the 500 an
    # unmapped PORTAL:LOCKED exception from the trigger would produce.
    _require_not_approved(slug, topic, "editing")
    # THE SEND, checked right after the approval and for the same family of reason: both say the
    # article's bytes are no longer the team's alone to change. Approved says so permanently;
    # this says so for as long as the client holds it unanswered. Without this line a save during
    # client_review commits a version the send pin does not point at, and the approval that lands
    # next describes bytes nobody is reading (see _require_not_with_client).
    _require_not_with_client(slug, topic, "editing")
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; edit once it finishes so the engine's "
                   f"own writes are not raced",
        )
    text = body.body
    if not text.strip():
        raise HTTPException(
            status_code=422,
            detail="an empty article cannot be saved; delete the topic instead if that "
                   "is the intent",
        )
    if len(text.encode("utf-8")) > 1_000_000:
        raise HTTPException(status_code=413, detail="the article is over 1 MB, which no blog is")

    # Under the same lock the comment applies hold: a save landing inside an apply's
    # read-session-write window would be overwritten by the apply's stale base. The UI
    # disables Edit while a change is applying, so waiting here is rare and brief.
    async with blog_edit.APPLY_LOCK:
        word_count = await asyncio.to_thread(blog_edit.save_content, slug, topic, text)
    return {"word_count": word_count}


@app.post("/api/clients/{slug}/blogs/{topic}/send")
async def api_send_blog_to_client(slug: str, topic: str,
                                  user: auth.Identity = Depends(auth.require_admin)):
    """Release one blog to the client portal at ANY score, first send and Send again both.

    THE ONE RELEASE DOOR, and it is always an operator's press. Every blog waits on the
    admin-review bench whatever it scored, nothing auto-releases, and this button is the exit
    for all of them: a draft that fell below the 90 bar leaves through it too, on the operator's
    authority, which is the only thing the separate promote button ever said.

    THE DONE-GATE IS NOT WIDENED. blog_edit.promote_if_failed appends the `done` verdict first,
    naming the operator and the score, exactly as the CMS door already does
    (server/cms/routes.py), so _require_done passes because the blog genuinely BECAME done. The
    trail still reads "failed at 87, then a person sent it": deleting the second button deleted
    no audit line. Every other status falls through that helper untouched, so needs_review still
    holds at any score, stopped still has no verdict to release, and a failed topic with no
    evaluator-scored draft is refused because there is nothing to send.

    The portal shows a blog for review only once this stamp exists, so the admin-review
    stage is the default for every blog and this button is its exit. No longer
    idempotent, deliberately: a re-send after a review round is a new release of changed
    bytes, so every press re-stamps the date, pins sent_version_id to the latest
    committed version, and clears the client's approval (mark_sent says why). The one
    refusal at the end is an open client suggestion, because sending over it would release an
    article the client is still waiting to see changed, and the dialog owes them an
    answer (resolve or dismiss) before the next version lands in their portal.

    THAT REFUSAL IS THE STATEMENT'S, not this route's. Reading the count here and then
    stamping left a gap a portal write fits inside: the read returns zero, the client
    files a suggestion, and the send releases the article over a request nobody has seen.
    mark_sent asserts the same condition in the UPDATE's own WHERE and answers None when
    it fails, so the 409 below describes a refusal the database made.
    """
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    # ORDER: the two refusals that must land BEFORE anything is appended to the trail, then the
    # promotion, then the gates that read the verdict it wrote.
    #
    # The live-run refusal is first because a stale fold is exactly what makes a send dangerous:
    # a retry leaves the previous session's terminal status on record until the new run settles,
    # so a send inside that window would promote and release bytes the running writer is already
    # replacing. It came off the deleted promote route and it is the one refusal the send never
    # had.
    if topic in _live_run_slugs(slug):
        raise HTTPException(
            status_code=409,
            detail=f"{topic!r} is generating right now in a live run; sending is for "
                   f"settled topics",
        )
    # THE APPROVED LOCK, AND HERE IT GUARDS AN ACT NO TRIGGER SEES. Sending inserts nothing, it
    # UPDATEs topics, so neither trigger in migration 013 fires on it, and the UPDATE clears
    # client_approved_at as it re-stamps. A re-send would erase the approval that every other
    # guard reads, which is why migration 013 closed the hosted build's equivalent inside
    # admin_done_topic and called sending the most damaging of the three acts it covers.
    #
    # BEFORE mark_sent, not after. mark_sent refuses an approved article too, but its refusal
    # protocol is None, which this route already spends on the open-suggestion case below. The
    # operator would read "the client's suggestions are still open" for an article that is
    # locked, which sends them to resolve comments that are not the problem.
    #
    # AND BEFORE THE PROMOTION, which is the order the deleted route already recorded: an
    # approved row that folds back to failed is a resurrected one, and promoting over it would
    # append a done verdict claiming a send that the very next line refuses.
    _require_not_approved(slug, topic, "sending to the client")
    email = getattr(user, "email", "") or ""
    try:
        await asyncio.to_thread(blog_edit.promote_if_failed, slug, topic,
                                _topic_status(slug, topic), email)
    except blog_edit.EditError as exc:
        # Either the topic has no evaluator-scored draft to take responsibility for, or the
        # promotion line did not land in the record (promote_to_done says how that happens and
        # what clears it). Nothing was ledgered and nothing was sent.
        raise HTTPException(status_code=409, detail=str(exc))
    _require_done(slug, topic, "sending to the client")
    # A PROMOTION THAT LANDS OVER A SEND THAT IS THEN REFUSED LEAVES THE BLOG DONE AND UNSENT,
    # and that is accepted rather than designed around. The refusal below lives in mark_sent's
    # own WHERE precisely because checking first is racy, so no ordering here removes it. What
    # it leaves is a blog that is genuinely done, sitting on the done bench with this same
    # button offered, so the operator resolves the client's suggestions and presses again. The
    # promotion line names the act they took and the second press is what completes it.
    state = await asyncio.to_thread(blog_edit.mark_sent, slug, topic, email)
    if state is None:
        raise HTTPException(
            status_code=409,
            detail="the client's suggestions are still open; resolve or dismiss each "
                   "one before sending again",
        )
    return state


@app.get("/api/clients/{slug}/blogs/{topic}/review")
async def api_blog_review(slug: str, topic: str,
                          user: auth.Identity = Depends(auth.require_user)):
    """The delivery state for one blog: sent, approved, and how many client suggestions
    are open. The stage page polls this beside the comment list instead of refetching
    the whole blogs listing for one topic's chip. require_user, not require_admin: it
    is a read, and it reveals nothing the caller's scoped blogs list does not."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    return await asyncio.to_thread(blog_edit.sent_state, slug, topic)


class UploadBlogRequest(BaseModel):
    body: str
    replace: bool = False


@app.post("/api/clients/{slug}/blogs/{topic}/upload")
async def api_upload_blog(slug: str, topic: str, payload: UploadBlogRequest,
                          user: auth.Identity = Depends(auth.require_admin)):
    """Ingest an article the operator already has, in place of generating one.

    The other door into admin review. Everything downstream of this point is identical to
    a generated blog's path: the same stage page, the same comment rail, the same Send to
    client. What differs is the warrant, and blog_upload keeps that difference visible
    rather than smoothing it over: no score is invented, no eval body is written, and the
    status line names the person who uploaded it.

    NO _topic_or_404 AND NO _require_done, deliberately, and they are the two guards a
    reader will expect. Both ask the record about a topic that, on the common path, does
    not exist yet: the whole point is a roadmap row that was never generated, so
    _topic_or_404 would 404 every first upload and _require_done would 409 it as
    "unknown, not done". The topic row is created by the upload itself.

    THE ROADMAP IS THE AUTHORITY ON WHAT MAY BE UPLOADED, which is what replaces them. The
    slug has to match a row in this client's roadmap, and the title, scope and prompts
    recorded against the blog are read from that row server-side. The browser sends an
    article and a slug; it never gets to tell the engine what topic it is, exactly as
    api_generate re-reads its rows rather than trusting the posted ones.
    """
    row = _upload_row_or_refuse(slug, topic, user)

    # Under the comment-apply lock, exactly as a manual save is: a replace landing inside
    # an apply's read-session-write window would be overwritten by the apply's stale base.
    async with blog_edit.APPLY_LOCK:
        try:
            return await asyncio.to_thread(
                blog_upload.upload_blog, slug, topic,
                row.get("topic") or topic, row.get("covers") or "",
                row.get("prompts") or [], payload.body,
                getattr(user, "email", "") or "", bool(payload.replace),
            )
        except blog_upload.UploadError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.detail)


def _upload_row_or_refuse(slug: str, topic: str, user: auth.Identity) -> dict:
    """The shared preamble for the upload door: the roadmap row the
    slug names, or a refusal. THE ROADMAP IS THE AUTHORITY on what may be uploaded and the
    title/scope/prompts come from it, never from the browser, exactly as api_generate re-reads
    its rows. NO _topic_or_404 and NO _require_done: a first upload's topic does not exist yet
    (see api_upload_blog). The live-run refusal is the one /content makes for the same reason,
    that the engine owns the scratch tree while a session is open."""
    _client_or_404(slug, user)
    if runner.slugify(topic) != topic:
        raise HTTPException(status_code=404, detail="not found")
    rows = _load_roadmap_or_404(slug, user)["rows"]
    row = next((r for r in rows if r.get("topic_slug") == topic), None)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"no roadmap row for {topic!r}; a blog can only be uploaded against a "
                   f"topic this brand's roadmap plans")
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; upload once it finishes so the engine's "
                   f"own writes are not raced",
        )
    return row


class NewBlogRequest(BaseModel):
    body: str


@app.post("/api/clients/{slug}/blogs/new")
async def api_create_blog(slug: str, payload: NewBlogRequest,
                          user: auth.Identity = Depends(auth.require_admin)):
    """Create a blog the roadmap never planned, from pasted markdown. THE OFF-ROADMAP TWIN of
    api_upload_blog, for the operator who changed their mind and wants a blog no roadmap row
    covers, without editing the roadmap to add one.

    The difference from api_upload_blog is the whole reason this exists: that door requires a
    roadmap row and reads the title, scope and prompts from it, so _upload_row_or_refuse 404s a
    slug the roadmap does not name. Here there is no row, so the title comes from the article's
    own H1 (the same line sync commits as h1_title, so topics.title and h1_title agree) and
    scope and prompts are empty. Everything downstream is IDENTICAL: blog_upload.upload_blog
    writes the same done, null-score record naming the uploader and the same ledger interlock,
    so the blog lands in admin review and is treated exactly like every other uploaded blog.

    The roadmap is deliberately not consulted or edited: the app never writes the operator's
    CSV, so an off-roadmap blog lives only in the record, through its topic row and ledger row.
    The path is POST /blogs/new; nothing shadows it, since there is no bare POST /blogs/{topic}
    (every topic write carries a suffix: /upload, /content, /title, /send). A blog whose title
    slugifies to "new" is reached by GET/DELETE /blogs/{topic}, a different method, so it never
    collides with this create route either."""
    _client_or_404(slug, user)
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; create this blog once it finishes so the "
                   f"engine's own writes are not raced")
    # The first '# ' line is the title, matched exactly as sync derives h1_title on commit so the
    # label this stores and the one sync stores cannot disagree. No H1 means no title and no slug.
    title = next((ln[2:].strip() for ln in payload.body.splitlines() if ln.startswith("# ")), "")
    if not title:
        raise HTTPException(
            status_code=422,
            detail="give the article a title as a top-level '# Heading' on its first line")
    topic_slug = runner.slugify(title)
    if not topic_slug:
        raise HTTPException(
            status_code=422,
            detail="that title has no letters or numbers to build a web address from; add some")
    if db.topic_id(slug, topic_slug) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"a blog titled {title!r} already exists; edit that one or change this title")
    async with blog_edit.APPLY_LOCK:
        try:
            return await asyncio.to_thread(
                blog_upload.upload_blog, slug, topic_slug,
                title, "", [], payload.body,
                getattr(user, "email", "") or "", False,
            )
        except blog_upload.UploadError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.detail)


@app.delete("/api/clients/{slug}/blogs/{topic}", status_code=204)
async def api_delete_blog(slug: str, topic: str,
                          user: auth.Identity = Depends(auth.require_admin)):
    """Remove one blog: HARD-delete the topic row and drop its scratch tree. Deleting the
    topics row cascades to every child (blog_versions, status_events, review_notes,
    blog_comments all carry `on delete cascade` on the topic FK), so nothing about this blog
    survives in the record and a later regenerate of the same slug starts genuinely fresh: no
    stale status feed for a new run's line ordinals to collide with, no old versions or
    comments resurfacing. The scratch dir goes too, or the startup reconciler would find bytes
    ahead of the (now absent) record and re-commit them, recreating the topic via ensure_topic.
    Refused while a run is live, because the engine is writing that scratch tree right now.
    Idempotent: deleting an unknown or already-gone topic is a 204 no-op.

    A hard delete replaces the old topics.deleted_at soft delete deliberately: the operator
    asked that a delete leave nothing behind so a rerun is clean, and the soft model left the
    row and its children in place, which is exactly what resurfaced stale versions and froze
    the status feed for reruns."""
    _client_or_404(slug, user)
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; delete once it finishes so the engine's "
                   f"own writes are not raced")
    await asyncio.to_thread(_delete_blog, slug, topic)
    return None


def _delete_blog(slug: str, topic_slug: str) -> None:
    tid = db.topic_id(slug, topic_slug)
    if tid is not None:
        # Children cascade off this one delete; see api_delete_blog for the list.
        db.q("delete from topics where id = %s", (tid,), fetch="none")
    tdir = runner.output_dir(slug, topic_slug)
    if tdir.is_dir():
        shutil.rmtree(tdir, ignore_errors=True)


@app.delete("/api/clients/{slug}/runs/topics/{topic}")
async def api_stop_topic(slug: str, topic: str,
                         user: auth.Identity = Depends(auth.require_admin)):
    """Stop ONE topic: cancel it if it is running, withdraw it if it is only queued.

    THE BRAND-WIDE STOP STAYS AND IS STILL THE RIGHT DEFAULT. DELETE /runs ends everything for a
    brand in one press, which is what an operator wants when a whole batch is wrong, and the
    contract's reason for it holds: run-scoping THAT button would make them press it five times
    while the queue raced them. This is a different act with a different scope. The queue table
    lists topics one per row, so its per-row control has to reach one row, and reaching it through
    a brand-wide stop would take four other blogs down with it.

    It answers with WHICH of the two happened, because the operator's own act differs: cancelling a
    running session throws away real work and the dashboard warns before it, while withdrawing a
    queued one costs nothing and needs no warning. The engine is the only thing that can tell them
    apart at the moment of the press, and a browser that decided for itself would be racing the
    queue it is describing.

    404 when the brand has no such topic in flight, rather than a cheerful 200 over nothing done:
    a row that has already finished, or one that was never queued, is not a thing to stop.
    """
    _client_or_404(slug, user)
    if runner.slugify(topic) != topic:
        raise HTTPException(status_code=404, detail="not found")
    stopped = await asyncio.to_thread(runner.stop_topic, slug, topic)
    if stopped is None:
        raise HTTPException(status_code=404, detail="no live or queued run for this topic")
    return {"client": slug, "topic_slug": topic, "stopped": stopped}


@app.get("/api/pending-reruns")
async def api_pending_reruns(user: auth.Identity = Depends(auth.require_admin)):
    """Every topic sitting on an answered current form at needs_review: the rerun queue.

    Admin-only for the same reason /api/describe-jobs is: the answer spans every brand
    with no per-org filter, safe only behind the admin gate.
    """
    pending = await asyncio.to_thread(client_answers.pending_topics)
    return {"pending": [
        {"client": client_slug, "topic_slug": topic_slug}
        for client_slug, topic_slug, _tid in pending
    ]}


async def _revise_task(run_id, slug, topic_slug):
    try:
        result = await runner.revise_topic(slug, topic_slug, run_id)
    except Exception:
        # The topic's own terminal status line is already written by revise_topic, and the run is
        # flipped out of live in its finally. Nothing to repair here: log it and let the operator
        # read the reason off status.jsonl, which is where every other failure lands too.
        log.exception("revise %s for client %s topic %s crashed", run_id, slug, topic_slug)
        return

    # THE LEDGER, through the same callback a batch uses, because a revise ships blogs too. A
    # topic capped at needs_review that the operator lifts to 90+ by answering the blocking
    # questions reaches done HERE and nowhere else, so without this call the artifact the ledger
    # exists to record would never enter it: it would be missing from generated.csv, and
    # ledger.live_slugs would not dedupe it, so re-selecting that row in a later batch would
    # silently spend real research and model quota rewriting a blog that already shipped.
    # record_success ignores anything that is not done and skips a slug already recorded, so a
    # revise of an already-ledgered blog is a no-op here.
    #
    # Routed through runner._notify rather than awaited bare, because making this task cancellable
    # is what put a cancel window on this exact line. revise_topic has already returned, so the
    # blog is written, scored and terminal on disk; a stop landing on a bare await here would lose
    # the ledger entry for a blog that shipped and hand the next batch a real bill for rewriting
    # it. That is the same race guarded() has, one await apart, so it gets the same shielded writer
    # rather than a second hand-rolled shield in this file: the strong-reference set that keeps a
    # detached delivery from being collected mid-write is subtle enough that two copies of it means
    # one of them drifts.
    await runner._notify(lambda payload: _on_topic_done(slug, run_id, payload), result)


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    rows: list[int]
    upload_id: Optional[str] = None
    # Instructions specific to THIS run's blogs, typed in the dialog after Generate. Optional
    # and often None: a run with none behaves exactly as before. Stamped onto each selected row
    # in api_generate so it rides down to run_topic, which lays it down as a file every agent
    # reads. It ranks with the brand instructions (major priority, never above canonical-facts).
    session_instructions: Optional[str] = None


@app.get("/api/queue")
async def api_queue(user: auth.Identity = Depends(auth.require_admin)):
    """What the one queue is doing: slots in use, who holds each, and how long since it moved.

    IT EXISTS BECAUSE A WEDGED QUEUE AND AN IDLE ONE LOOKED IDENTICAL. Every surface reads
    status.jsonl, so a blog whose session hung wrote nothing and rendered exactly like a blog
    waiting its turn, and a stuck engine read as a slow one for hours. `since_progress_seconds`
    beside `stall_timeout` is the whole answer: one number says whether the watchdog is about to
    act, and until now nothing in the app could report either.

    Admin only and repo-wide, because the queue is repo-wide: scoping it per brand would describe
    a cap that is not per brand. It reads in-process state and touches no database.
    """
    return runner.queue_state()


@app.get("/api/runs")
async def api_runs(user: auth.Identity = Depends(auth.require_user)):
    # Scoped like every list: a non-admin sees only runs for brands their grants
    # name, and nothing in the response betrays how many others exist.
    scope = _scope(user)
    runs = runner.list_runs()
    if scope is not None:
        runs = [run for run in runs if run.get("client") in scope]
    return {"runs": runs}


async def _on_topic_done(slug, run_id, result):
    """Awaited once per topic as it completes. Records ships in the ledger."""
    try:
        ledger.record_success(slug, result, result.get("row") or {}, run_id)
    except Exception:
        # A ledger write must never take down a run that already produced a
        # blog. The blog is on disk either way; log and carry on.
        log.exception("ledger append failed for run %s client %s", run_id, slug)


async def _batch_task(run_id, slug, rows):
    try:
        callback = lambda result: _on_topic_done(slug, run_id, result)
        # run_id is passed so run_batch can flip this run from queued to running at the
        # instant it genuinely starts, which is its first queue slot or its fact base build.
        # Only the runner knows that moment: the queue is repo-wide and a submit can wait
        # behind five other blogs for minutes.
        await runner.run_batch(slug, rows, on_topic_done=callback,
                               run_id=run_id)
    except Exception:
        # The run must still flip to not-live for /api/runs and the SSE
        # closer; per-topic failures already landed in status.jsonl.
        log.exception("run %s for client %s crashed", run_id, slug)
    finally:
        # finish_run leaves an already-stopped run stopped, so this fires harmlessly on the
        # cancelled path too. CancelledError is not an Exception, so it skips the handler above and
        # unwinds through here, which is exactly what the stop wants: the record settles, with no
        # arm pretending the operator's stop was a crash. The task HANDLE is deliberately not
        # dropped here; see the done-callback in api_generate for why a finally cannot do it.
        runner.finish_run(run_id)


@app.delete("/api/clients/{slug}/runs")
async def api_stop_client_runs(slug: str,
                               user: auth.Identity = Depends(auth.require_admin)):
    """Stop every live run for one brand. Finished blogs are kept; in-flight ones are discarded.

    This deliberately BREAKS the idiom the other three DELETEs share, and the break is the whole
    feature rather than an oversight. api_clear_roadmap_generation and api_clear_facts_generation
    409 a running job on the reasoning that the session is already spending quota, so the honest
    thing is to let it land and let the operator discard the result. That reasoning holds for a job
    the operator cannot see the cost of and did not ask to end. It is the exact opposite of what a
    Stop button is: here the operator IS the one deciding, and the quota being spent is precisely
    what they are asking to stop spending. An endpoint that answered "it can be stopped once it
    finishes" would be describing the button as broken.

    What IS borrowed from those endpoints is the shape: validate the brand at the boundary, keep
    the guard in the module that owns the state (runner.stop_client re-checks "live" itself, so the
    route is not the only thing standing between a stop and a run), and hand back the record.

    Brand scoped because the operator chose "stop everything for that brand". Run scoping would
    make them press it once per run while their own queue raced them, which for five queued runs is
    not a stop at all.

    Not awaited, and that is not an oversight either: stop_client is synchronous ON PURPOSE so that
    marking and cancelling cannot be interleaved with a finally that would fire finish_run over the
    mark. Adding an await in front of it would reintroduce the window it was written to close.

    Idempotent: a brand with nothing live reports zero and 200s. A second press, a double click, or
    a stale tab is not an error condition, and 409ing it would summon the operator to nothing.
    """
    _client_or_404(slug)
    return runner.stop_client(slug)


@app.post("/api/clients/{slug}/generate", status_code=202)
async def api_generate(slug: str, body: GenerateRequest,
                       user: auth.Identity = Depends(auth.require_admin)):
    _client_or_404(slug, user)

    # When an upload_id is present, re-read and re-parse THAT archived file
    # server-side. The browser sends row indices only: it never gets to tell the
    # server what a row contains, so a tampered payload cannot redirect a run.
    if body.upload_id:
        try:
            payload = roadmap.load_upload(slug, body.upload_id)
        except roadmap.BadUpload as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        payload = _load_roadmap_or_404(slug)
    by_index = {row["index"]: row for row in payload["rows"]}

    if not body.rows:
        raise HTTPException(status_code=400, detail="no rows selected")

    # Boundary validation: every selected row must carry topic, covers, and
    # prompts NOW, so a doomed run is refused at submit time and never twenty
    # minutes into one.
    problems = []
    selected = []
    for index in body.rows:
        row = by_index.get(index)
        if row is None:
            problems.append({"index": index, "missing": ["row does not exist"]})
        elif not row["complete"]:
            problems.append({"index": index, "missing": row["missing"]})
        else:
            selected.append(row)
    if problems:
        raise HTTPException(status_code=422, detail=problems)

    # Duplicate check, before anything is scheduled. A row is a duplicate if it
    # already shipped AND its blog still exists on disk, or if it is in flight in
    # a live run. Refuse the WHOLE submit so the UI can red exactly the offending
    # rows and the operator deselects and resubmits, rather than half a batch
    # running.
    shipped = ledger.live_slugs(slug)
    in_flight = _live_run_slugs(slug)
    duplicates = []
    for row in selected:
        entry = shipped.get(row["topic_slug"])
        if entry is not None:
            score = entry.get("score")
            try:
                score = int(score)
            except (TypeError, ValueError):
                score = None
            duplicates.append({
                "index": row["index"],
                "topic": row["topic"],
                "topic_slug": row["topic_slug"],
                "reason": "already_generated",
                "score": score,
                "generated_at": entry.get("generated_at") or None,
            })
        elif row["topic_slug"] in in_flight:
            duplicates.append({
                "index": row["index"],
                "topic": row["topic"],
                "topic_slug": row["topic_slug"],
                "reason": "in_flight",
                "score": None,
                "generated_at": None,
            })
    if duplicates:
        names = ", ".join(repr(d["topic"]) for d in duplicates)
        raise HTTPException(status_code=409, detail={
            "detail": f"{len(duplicates)} selected row(s) already exist for {slug}: {names}. "
                      f"Deselect them and resubmit.",
            "duplicates": duplicates,
        })

    # THE APPROVED LOCK, before a run is registered and long before a session is opened.
    #
    # Almost every approved topic is already refused by the duplicate check above, because
    # approval can only follow a ship and a shipped blog is in the ledger. Almost is not
    # always: blog_upload documents the generated-but-not-ledgered state a failed ledger write
    # leaves behind, and in it the duplicate check passes. A generate would then research,
    # draft, gate, link check and evaluate a full article against an approved topic, spending
    # real Firecrawl, DataForSEO and model quota, and die at its commit when the record's
    # trigger refuses the version. Migration 013's header names that late death and accepts it
    # as the price of the invariant; this block is the cheaper refusal in front of it, and it
    # is where the refusal belongs, because this is the only point in the chain that can still
    # answer the operator rather than a status line.
    #
    # THE WHOLE SUBMIT IS REFUSED, matching the duplicate block above it: a batch that ran
    # nineteen of twenty rows and silently dropped the locked one would leave the operator
    # reading a run summary to work out what happened to it.
    locked = []
    for row in selected:
        approved = blog_edit.approved_at(slug, row["topic_slug"])
        if approved is not None:
            locked.append(f"{row['topic']!r} (approved {approved:%d %b %Y})")
    if locked:
        raise HTTPException(
            status_code=409,
            detail=f"{len(locked)} selected row(s) are locked because the client approved "
                   f"them: {', '.join(locked)}. An approved article cannot be regenerated; "
                   f"publishing it to their site is the only act left. Deselect them and "
                   f"resubmit.",
        )

    # THE SEND LOCK, and it is the approved lock's other half rather than a new kind of rule.
    # Approved says the client accepted these bytes; sent says the client is READING these bytes
    # and has not answered yet. A regenerate is the most complete rewrite there is, so doing it
    # under either one changes the article beneath a person the app has told to go read it.
    #
    # WHAT THIS ADDS BEYOND THE DUPLICATE CHECK ABOVE, which catches most of these already: a
    # send can only follow a ship and a shipped blog is in the ledger, so almost every sent topic
    # is refused as already_generated before reaching this line. Almost is not always, and the gap
    # is the one the approved block names for itself: blog_upload documents the
    # generated-but-not-ledgered state a failed ledger write leaves behind, and in it the
    # duplicate check passes while the topic is out with a client right now.
    #
    # WHAT IT PREVENTS IS WORSE THAN A WASTED RUN. The client is pinned to sent_version_id and
    # reading it; a regenerate replaces the article underneath them. Worse, a regenerate that
    # FAILS leaves the send stamp standing over a topic whose status is now failed, and the state
    # machine reads the delivery stamp before the status, so the row reports "With client" with an
    # empty admin action list and the failure is reported nowhere at all. Refusing removes that
    # situation rather than relabelling it, which is why the fix is here and not in the ladder.
    #
    # THE STATE MACHINE ALREADY SAYS THIS: client_review grants the admin NO actions. A round
    # open means the client asked for something and the article is back with the team, which is
    # changes_requested, where regenerating is a legitimate way to answer them, so
    # _with_client_since returns None there and this block stays quiet. A topic never sent
    # returns None too, so a first generate is untouched.
    #
    # THE WHOLE SUBMIT IS REFUSED with the shape and vocabulary of the two blocks above it, so
    # the browser gets a class of answer it already renders.
    with_client = []
    for row in selected:
        sent_at = _with_client_since(slug, row["topic_slug"])
        if sent_at is not None:
            with_client.append(f"{row['topic']!r} (sent {sent_at:%d %b %Y})")
    if with_client:
        raise HTTPException(
            status_code=409,
            detail=f"{len(with_client)} selected row(s) are with the client for review: "
                   f"{', '.join(with_client)}. Regenerating would replace the article they are "
                   f"reading, so it is refused until they approve it or ask for a change. "
                   f"Deselect them and resubmit.",
        )

    ok, reason = _preflight(slug)
    if not ok:
        raise HTTPException(status_code=409, detail=f"preflight failed for {slug}: {reason}")

    run_id = uuid.uuid4().hex
    topics = []
    for row in selected:
        # Instructions typed for THIS run ride down on the row, which travels verbatim to
        # run_topic; it lays them at <out_dir>/session-instructions.md for the agents. Trimmed
        # so a blank textarea reads the same as None: no file written, no change to the run.
        row["session_instructions"] = (body.session_instructions or "").strip()
        # status.jsonl is append-only and survives across runs, so a rerun of
        # a finished topic would replay the old run's history and terminal
        # line into the new SSE stream. Record the current byte size now,
        # before the batch task can write (create_task does not run until we
        # next await), so this run's tail starts after all prior lines.
        # Deliberately a SCRATCH stat, not a record count: the SSE tail reads
        # scratch during a live run, and a missing file stats to 0 below.
        status_path = runner.output_dir(slug, row["topic_slug"]) / "status.jsonl"
        try:
            tail_offset = status_path.stat().st_size
        except OSError:
            tail_offset = 0
        topics.append({
            "index": row["index"],
            "topic_slug": row["topic_slug"],
            "tail_offset": tail_offset,
        })
    runner.register_run(run_id, slug, topics)
    # The handle is registered HERE, by the caller, and not by _batch_task as its own first act.
    # Both reach the same dict, but only this one closes the ghost-run window. register_run above
    # publishes the run to /api/runs as live, and _client_has_live_run and _live_run_slugs both
    # branch on that field, so from this line the run is already visible and already stoppable. A
    # task that registered itself could not run until the next await (the same scheduling fact the
    # tail_offset comment above depends on), which leaves a real gap: a DELETE landing in it would
    # find the run in RUNS, mark it stopped, find no handle to cancel, and return a summary saying
    # it stopped a run that then starts and writes blogs anyway. The operator would read "stopped"
    # while their quota drained. Registering here has no such gap, because nothing between
    # register_run and this line awaits, so no request can be served between them.
    # Held so the task is not garbage collected mid flight, and dropped when it settles: the same
    # three lines describe.py and roadmap_gen.py already use, for the same two reasons.
    #
    # The discard is a done-callback and NOT a finally inside _batch_task, because a finally cannot
    # cover the path this feature creates. A task cancelled before its first step never enters its
    # coroutine at all, so no body and no finally of its own ever runs, and the window where that
    # happens is exactly the window described above: the operator presses Stop between this line
    # and the loop first scheduling the task. A finally would leak a handle for every run stopped
    # in that window, for the life of the process. A done-callback fires on every path there is,
    # including the never-started one, which is why the two jobs that already keep handles settled
    # on it rather than on a finally.
    task = asyncio.create_task(_batch_task(run_id, slug, selected))
    runner.register_run_task(run_id, task)
    task.add_done_callback(lambda _task: runner._discard_run_task(run_id))
    return {"run_id": run_id, "topics": topics}


# ---------------------------------------------------------------------------
# Repurpose: a shipped blog -> one channel-native piece (LinkedIn post, Medium article,
# Bluesky post, X thread).
# A repurpose run reuses the blog run's registry, semaphore, status feed, SSE tail and stop
# path (see server/repurpose.py), so it shows up as a running session and is stoppable exactly
# like a blog run. It is generate -> review only: no eval, no ledger, no record.
# ---------------------------------------------------------------------------

class RepurposeRequest(BaseModel):
    topic_slug: str
    channel: str


def _resolve_blog_markdown(slug, topic_slug):
    """The source blog's markdown: disk when it is there (always, on the local engine, and
    authoritative for a topic a live run holds), the record otherwise (hosted, or after a scratch
    reclaim). None when there is no shipped blog to repurpose."""
    path = runner.output_dir(slug, topic_slug) / "blog.md"
    if path.is_file():
        text = path.read_text(encoding="utf-8")
        if text.strip():
            return text
    return _record_artifact(slug, topic_slug, "blog.md")


@app.post("/api/clients/{slug}/repurpose", status_code=202)
async def api_repurpose(slug: str, body: RepurposeRequest,
                        user: auth.Identity = Depends(auth.require_admin)):
    """Start one repurpose run. Mirrors api_generate: resolve, refuse duplicates, spawn the run
    (register + launch + commit-on-success live in repurpose.spawn, shared with the CMS hook)."""
    _client_or_404(slug, user)

    the_channel = (body.channel or "").strip().lower()
    if the_channel not in repurpose.CHANNELS:
        raise HTTPException(status_code=400,
                            detail=f"unknown channel {body.channel!r}; expected one of "
                                   f"{', '.join(repurpose.CHANNELS)}")

    topic_slug = body.topic_slug
    # Same slug-format guard api_output_file uses: the source must be a real blog slug, so a
    # topic_slug smuggling separators or dot-dots is refused before any path is built.
    if runner.slugify(topic_slug) != topic_slug:
        raise HTTPException(status_code=404, detail="not found")

    source_body = _resolve_blog_markdown(slug, topic_slug)
    if not source_body:
        raise HTTPException(status_code=404,
                            detail=f"no shipped blog for {topic_slug!r} to repurpose")

    # A regenerate must never replace bytes the client already accepted: mark_posted gates only on
    # client_approved_at, so overwriting an approved or posted post would ship un-approved text.
    # Refuse it before spending a run; commit_post's WHERE is the DB-level backstop for the race.
    existing = channel_mod.get_post(slug, topic_slug, the_channel)
    if existing and existing["state"] in ("approved", "posted"):
        raise HTTPException(status_code=409,
                            detail=f"this {repurpose.CHANNEL_LABELS[the_channel]} is "
                                   f"{existing['state']} and locked; it cannot be regenerated")

    # One live repurpose per (blog, channel): a second is refused, not run, so two clicks never
    # race two sessions onto one post.md.
    if repurpose.live_run_exists(slug, topic_slug, the_channel):
        raise HTTPException(status_code=409,
                            detail=f"a repurpose of this blog into the "
                                   f"{repurpose.CHANNEL_LABELS[the_channel]} is already running")

    run_id, topics = await repurpose.spawn(slug, topic_slug, the_channel, source_body)
    return {"run_id": run_id, "topics": topics}


@app.get("/api/clients/{slug}/repurpose")
async def api_repurpose_listing(slug: str, channel: str,
                                user: auth.Identity = Depends(auth.require_user)):
    """{source_topic_slug: {generated_at, chars}} for every published blog that already has a
    <channel> artifact. One call, so the channel tab can label every row without N probes."""
    _client_or_404(slug, user)
    channel = channel.strip().lower()
    if channel not in repurpose.CHANNELS:
        raise HTTPException(status_code=400,
                            detail=f"unknown channel {channel!r}")
    return {"artifacts": repurpose.listing(slug, channel)}


@app.get("/api/clients/{slug}/repurpose/{topic_slug}/{channel}")
async def api_repurpose_artifact(slug: str, topic_slug: str, channel: str,
                                 user: auth.Identity = Depends(auth.require_user)):
    """One channel artifact's text plus its stamp. 404 when it was never generated."""
    _client_or_404(slug, user)
    if runner.slugify(topic_slug) != topic_slug:
        raise HTTPException(status_code=404, detail="not found")
    channel = channel.strip().lower()
    if channel not in repurpose.CHANNELS:
        raise HTTPException(status_code=404, detail="not found")
    art = repurpose.artifact(slug, topic_slug, channel)
    if art is None:
        raise HTTPException(status_code=404, detail="not generated")
    return art


# ---------------------------------------------------------------------------
# Channel posts: the review lifecycle for a generated channel piece, on its OWN track
# (server/channel.py, channel_posts + channel_post_comments). A separate cousin of the blog
# review loop: no score, no eval, no questions, no ledger. generate -> created -> sent ->
# client requests changes / approves -> posted. The comment machinery reuses blog_edit's
# tool-less Claude editor against the post body.
# ---------------------------------------------------------------------------

def _channel_or_400(channel):
    ch = (channel or "").strip().lower()
    if ch not in channel_mod.CHANNELS:
        raise HTTPException(status_code=400, detail=f"unknown channel {channel!r}")
    return ch


def _channel_topic_guard(slug, topic, channel_value, user):
    """Shared preamble for every channel review route: client, slug-format, channel. Returns the
    normalised channel."""
    _client_or_404(slug, user)
    if runner.slugify(topic) != topic:
        raise HTTPException(status_code=404, detail="not found")
    return _channel_or_400(channel_value)


@app.get("/api/clients/{slug}/channel/{channel}")
async def api_channel_posts(slug: str, channel: str,
                            user: auth.Identity = Depends(auth.require_user)):
    """Every generated post for a brand on one channel, newest first: the Created-tab table."""
    _client_or_404(slug, user)
    ch = _channel_or_400(channel)
    return {"posts": await asyncio.to_thread(channel_mod.list_posts, slug, ch)}


@app.get("/api/clients/{slug}/channel/{channel}/download")
async def api_channel_download(slug: str, channel: str,
                               topics: list[str] | None = Query(None),
                               user: auth.Identity = Depends(auth.require_user)):
    """The named posts for one channel as ONE .docx, a cover page per piece: the Created tab's
    bulk download. `topics` are SOURCE BLOG slugs, the same key everything else on this track uses.

    Declared before /channel/{channel}/{topic} so "download" is never read as a topic slug. That
    ordering is the whole guard: `_channel_topic_guard` would accept "download" as a well-formed
    slug and this would 404 as an ungenerated post, which reads like the operator's own selection
    was wrong.

    Omitting `topics` bundles nothing and 404s rather than bundling the brand, deliberately: the
    blogs export has a whole-brand meaning because a brand HAS a blog library, while a channel
    download only ever comes from a selection, and a bare URL that dumps every LinkedIn post is a
    thing nobody asked for that somebody would eventually rely on."""
    _client_or_404(slug, user)
    ch = _channel_or_400(channel)
    wanted = [t for t in (topics or []) if t]
    pieces = await asyncio.to_thread(channel_mod.bodies, slug, ch, wanted)
    if not pieces:
        raise HTTPException(
            status_code=404,
            detail=(f"none of the {len(wanted)} selected posts has text to download"
                    if wanted else "name the posts to download"))
    # The cover word, from the one map rather than a conditional: a ternary here silently
    # labelled every channel that was not linkedin as a Medium article, so the first bundle
    # of X threads would have come out reading "Medium article 1". Python cannot check this
    # the way the dashboard's Record<RepurposeChannel, _> maps check their side, so the fix
    # is to have exactly one place that knows a channel's name.
    label = repurpose.CHANNEL_LABELS[ch]
    data = await asyncio.to_thread(docx_export.build_docx, pieces, label)
    return Response(
        content=data, media_type=docx_export.CONTENT_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{slug}-{ch}.docx"'})


@app.get("/api/clients/{slug}/channel/{channel}/{topic}")
async def api_channel_post(slug: str, channel: str, topic: str,
                           user: auth.Identity = Depends(auth.require_user)):
    """One generated post with its body and delivery state. 404 when it was never generated."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    post = await asyncio.to_thread(channel_mod.get_post, slug, topic, ch)
    if post is None:
        raise HTTPException(status_code=404, detail="not generated")
    return post


@app.get("/api/clients/{slug}/channel/{channel}/{topic}/comments")
async def api_channel_comments(slug: str, channel: str, topic: str,
                               user: auth.Identity = Depends(auth.require_user)):
    ch = _channel_topic_guard(slug, topic, channel, user)
    return {"comments": await asyncio.to_thread(channel_mod.read_comments, slug, topic, ch)}


@app.post("/api/clients/{slug}/channel/{channel}/{topic}/comments", status_code=202)
async def api_add_channel_comment(slug: str, channel: str, topic: str, body: CommentRequest,
                                  user: auth.Identity = Depends(auth.require_admin)):
    """File one selection comment on a post and start the Claude session that applies it. 202
    with the record: the browser watches the comment list, exactly as the blog flow does."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    if await asyncio.to_thread(channel_mod.get_post, slug, topic, ch) is None:
        raise HTTPException(status_code=404, detail="not generated")
    if repurpose.live_run_exists(slug, topic, ch):
        raise HTTPException(status_code=409,
                            detail=f"a {repurpose.CHANNEL_LABELS[ch]} is being generated for this "
                                   f"blog right now; edit once it finishes so the engine's own "
                                   f"write is not raced")
    if await asyncio.to_thread(channel_mod.in_flight_count, slug, topic, ch) >= channel_mod.MAX_IN_FLIGHT:
        raise HTTPException(status_code=409,
                            detail=f"{channel_mod.MAX_IN_FLIGHT} changes are already in flight; wait "
                                   f"for one to land before filing another")
    selected = body.selected_text.strip()
    instruction = body.instruction.strip()
    if not selected or not instruction:
        raise HTTPException(status_code=422,
                            detail="a comment needs both the selected text and an instruction")
    try:
        comment = await asyncio.to_thread(
            channel_mod.add_comment, slug, topic, ch,
            selected_text=selected, instruction=instruction,
            context_before=body.context_before, context_after=body.context_after,
            author="operator", author_email=getattr(user, "email", "") or "")
    except channel_mod.EditError as exc:
        # The one refusal add_comment raises is the approved lock.
        raise HTTPException(status_code=409, detail=str(exc))
    channel_mod.start_apply(slug, topic, ch, comment["id"])
    return comment


@app.post("/api/clients/{slug}/channel/{channel}/{topic}/comments/{comment_id}/resolve",
          status_code=202)
async def api_resolve_channel_comment(slug: str, channel: str, topic: str, comment_id: str,
                                      user: auth.Identity = Depends(auth.require_admin)):
    """Send one waiting comment to Claude (a client suggestion, or a failed retry). 202 with the
    flipped record; the in-flight cap rides inside the flip (channel_mod.resolve_comment)."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    if repurpose.live_run_exists(slug, topic, ch):
        raise HTTPException(status_code=409,
                            detail=f"a {repurpose.CHANNEL_LABELS[ch]} is being generated for this "
                                   f"blog right now; resolve once it "
                                   f"finishes")
    found = await asyncio.to_thread(channel_mod.get_comment, slug, topic, ch, comment_id)
    if found is None:
        raise HTTPException(status_code=404, detail=f"no comment {comment_id!r}")
    flipped = await asyncio.to_thread(channel_mod.resolve_comment, slug, topic, ch, comment_id)
    if flipped is None:
        fresh = await asyncio.to_thread(channel_mod.get_comment, slug, topic, ch, comment_id)
        state = (fresh or found)["state"]
        if state in ("open", "failed"):
            raise HTTPException(status_code=409,
                                detail=f"{channel_mod.MAX_IN_FLIGHT} changes are already in flight; "
                                       f"wait for one to land")
        raise HTTPException(status_code=409,
                            detail=f"this change is {state}; only an open or failed one can be "
                                   f"resolved with Claude")
    channel_mod.start_apply(slug, topic, ch, comment_id)
    return flipped


@app.delete("/api/clients/{slug}/channel/{channel}/{topic}/comments/{comment_id}",
            status_code=204)
async def api_delete_channel_comment(slug: str, channel: str, topic: str, comment_id: str,
                                     user: auth.Identity = Depends(auth.require_admin)):
    """Dismiss one comment: closed without an edit, never deleted (the client can see their own
    suggestion). An applying one is refused; it dismisses once it lands."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    found = await asyncio.to_thread(channel_mod.get_comment, slug, topic, ch, comment_id)
    if found is None:
        raise HTTPException(status_code=404, detail=f"no comment {comment_id!r}")
    if found.get("state") == "applying":
        raise HTTPException(status_code=409,
                            detail="this change is still being applied; dismiss once it lands")
    if await asyncio.to_thread(channel_mod.dismiss_comment, slug, topic, ch, comment_id) is None:
        raise HTTPException(status_code=409,
                            detail="this change is still being applied; dismiss once it lands")
    return Response(status_code=204)


@app.post("/api/clients/{slug}/channel/{channel}/{topic}/content")
async def api_save_channel_content(slug: str, channel: str, topic: str, body: ContentRequest,
                                   user: auth.Identity = Depends(auth.require_admin)):
    """Save the operator's own edit of the post body. Synchronous, like the blog content save."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    if await asyncio.to_thread(channel_mod.get_post, slug, topic, ch) is None:
        raise HTTPException(status_code=404, detail="not generated")
    if repurpose.live_run_exists(slug, topic, ch):
        raise HTTPException(status_code=409,
                            detail=f"a {repurpose.CHANNEL_LABELS[ch]} is being generated for this "
                                   f"blog right now; edit once it "
                                   f"finishes")
    text = body.body
    if not text.strip():
        raise HTTPException(status_code=422, detail="an empty post cannot be saved")
    if len(text.encode("utf-8")) > 1_000_000:
        raise HTTPException(status_code=413, detail="the post is over 1 MB")
    async with channel_mod.APPLY_LOCK:
        try:
            word_count = await asyncio.to_thread(channel_mod.save_content, slug, topic, ch, text)
        except channel_mod.EditError as exc:
            raise HTTPException(status_code=409, detail=str(exc))
    return {"word_count": word_count}


@app.post("/api/clients/{slug}/channel/{channel}/{topic}/send")
async def api_send_channel_post(slug: str, channel: str, topic: str,
                                user: auth.Identity = Depends(auth.require_admin)):
    """Release one post to the client as Ready to post, first send and Send again both. Refused
    (409) over an open client suggestion, exactly as the blog send is."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    if await asyncio.to_thread(channel_mod.get_post, slug, topic, ch) is None:
        raise HTTPException(status_code=404, detail="not generated")
    email = getattr(user, "email", "") or ""
    state = await asyncio.to_thread(channel_mod.mark_sent, slug, topic, ch, email)
    if state is None:
        raise HTTPException(status_code=409,
                            detail="the client's suggestions are still open, or the post is "
                                   "already approved; resolve each one before sending again")
    return state


@app.post("/api/clients/{slug}/channel/{channel}/{topic}/posted")
async def api_mark_channel_posted(slug: str, channel: str, topic: str,
                                  user: auth.Identity = Depends(auth.require_admin)):
    """Mark the piece live on the channel. The one act left after the client approves: gated on
    the approval, because the client accepts the exact bytes before they go out."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    if await asyncio.to_thread(channel_mod.get_post, slug, topic, ch) is None:
        raise HTTPException(status_code=404, detail="not generated")
    email = getattr(user, "email", "") or ""
    state = await asyncio.to_thread(channel_mod.mark_posted, slug, topic, ch, email)
    if state is None:
        raise HTTPException(status_code=409,
                            detail="this post is not ready to mark posted: the client must "
                                   "approve it first, and it must not already be posted")
    return state


@app.delete("/api/clients/{slug}/channel/{channel}/{topic}", status_code=204)
async def api_delete_channel_post(slug: str, channel: str, topic: str,
                                  user: auth.Identity = Depends(auth.require_admin)):
    """Remove one channel post and its scratch dir. THE SOURCE BLOG IS UNTOUCHED: the blog returns
    to the New tab, tickable again, keeping its draft and everything on its own track.

    Refused while a generation for this exact (blog, channel) is live, for the reason every other
    write on this track is: the engine is writing that post.md right now and a delete would race
    the commit that follows it. Idempotent otherwise, a 204 whether or not a post was there,
    because a bulk delete of eight posts must not fail on the one somebody already removed."""
    ch = _channel_topic_guard(slug, topic, channel, user)
    if repurpose.live_run_exists(slug, topic, ch):
        raise HTTPException(status_code=409,
                            detail=f"a {repurpose.CHANNEL_LABELS[ch]} is being generated for this "
                                   f"blog right now; delete once it finishes so the engine's "
                                   f"own write is not raced")
    await asyncio.to_thread(channel_mod.delete_post, slug, topic, ch)
    return None


# The CMS auto-repurpose: a successful CMS publish fires a LinkedIn and a Medium variation from
# the just-posted blog. Registered as an after-publish hook so server/cms/ stays decoupled and
# deletable (it knows nothing about channels; app.py owns the coupling).
async def _auto_repurpose_on_publish(slug, topic_slug):
    """Spawn a LinkedIn and a Medium post from the freshly published blog, skipping any channel
    that already has a post (never clobber a hand-made one) or one already generating. The blog's
    just-posted bytes ARE its current committed body, which is what a repurpose reads. Best-effort:
    every failure is logged, never raised, so it can never turn a good publish into a failed one.

    AUTO_CHANNELS, NOT CHANNELS, AND THAT IS THE WHOLE DIFFERENCE BETWEEN THE TWO KINDS OF TAB.
    Bluesky and X are in CHANNELS and are NOT in AUTO_CHANNELS, so they get every other surface a
    channel has (their own tab, record, review loop, client portal view, delete) and are never
    fired by a publish. Reading CHANNELS here would spend one SDK session per published blog per
    short-form channel that no operator asked for, which is the opposite of the manual
    select-then-Generate flow those two tabs exist to provide. A channel joins this loop by being
    added to AUTO_CHANNELS deliberately, never by being added to CHANNELS."""
    body = await asyncio.to_thread(_resolve_blog_markdown, slug, topic_slug)
    if not body:
        return
    for ch in repurpose.AUTO_CHANNELS:
        if await asyncio.to_thread(channel_mod.post_id, slug, topic_slug, ch) is not None:
            continue
        if repurpose.live_run_exists(slug, topic_slug, ch):
            continue
        try:
            await repurpose.spawn(slug, topic_slug, ch, body)
        except Exception:
            log.exception("auto-repurpose spawn failed for %s/%s/%s", slug, topic_slug, ch)


cms_routes.after_publish(_auto_repurpose_on_publish)


# ---------------------------------------------------------------------------
# SSE: tail status.jsonl files. UNCHANGED by the Supabase rewire, by design:
# a live run's progress feed is the scratch file the agents append to, and the
# record only catches up at the terminal commit.
# ---------------------------------------------------------------------------

class _TopicTail:
    """Byte-offset tail over one topic's status.jsonl. File-based on purpose:
    the agents append to that file and nothing else, so progress is never read
    from in-memory state."""

    def __init__(self, client, topic_slug, start_offset=0):
        self.topic_slug = topic_slug
        self.path = runner.output_dir(client, topic_slug) / "status.jsonl"
        # Start at the byte size recorded when the run was registered, never
        # at 0: the file persists across runs, and replaying a previous run's
        # lines would surface its terminal status as this run's.
        self.offset = start_offset
        self.terminal = False

    def read_new(self):
        """Return newly appended parsed lines, consuming only up to the last
        newline so a partially written trailing line is never mangled."""
        if not self.path.is_file():
            return []
        try:
            with open(self.path, "rb") as handle:
                handle.seek(self.offset)
                chunk = handle.read()
        except OSError:
            return []
        cut = chunk.rfind(b"\n")
        if cut < 0:
            return []
        complete, self.offset = chunk[: cut + 1], self.offset + cut + 1

        lines = []
        for raw in complete.decode("utf-8", errors="replace").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            data["topic_slug"] = self.topic_slug
            if data.get("status") in runner.TERMINAL_STATUSES:
                self.terminal = True
            lines.append(data)
        return lines


async def _event_stream(run):
    tails = [
        _TopicTail(run["client"], t["topic_slug"], t.get("tail_offset", 0))
        for t in run["topics"]
    ]
    last_beat = time.monotonic()
    try:
        while True:
            for tail in tails:
                for line in tail.read_new():
                    yield f"event: status\ndata: {json.dumps(line)}\n\n"
            if tails and all(tail.terminal for tail in tails):
                closing = {"run_id": run["run_id"], "live": False}
                yield f"event: run\ndata: {json.dumps(closing)}\n\n"
                return
            # THE RUN ITSELF SETTLING IS ALSO AN END, and this is the backstop for the day the
            # tails do not agree. The test above asks the FILES whether the work is over, which is
            # right and is not sufficient: a topic that never wrote a line has a tail that can
            # never turn terminal, so ONE silent topic held this stream open forever, with the
            # watch view spinning on "0 running, 1 queued" for a run that ended an hour before.
            # runner's sweeps are what stop a topic going silent in the first place; this is what
            # makes the next silent topic cost a stale row instead of a stuck screen.
            #
            # The record is only consulted AFTER the tails disagree with it, so a live run is
            # never cut short, and the final drain below is what keeps the last frames: a topic
            # writes its terminal line strictly before finish_run clears `live`, so anything
            # unread at this instant is still on disk and still ours to send.
            if not run.get("live"):
                for tail in tails:
                    for line in tail.read_new():
                        yield f"event: status\ndata: {json.dumps(line)}\n\n"
                closing = {"run_id": run["run_id"], "live": False}
                yield f"event: run\ndata: {json.dumps(closing)}\n\n"
                return
            if time.monotonic() - last_beat >= SSE_HEARTBEAT_SECONDS:
                yield ": ping\n\n"
                last_beat = time.monotonic()
            await asyncio.sleep(SSE_POLL_SECONDS)
    except asyncio.CancelledError:
        # Client disconnected: end the generator quietly, nothing to clean up.
        return


@app.get("/api/runs/{run_id}/events")
async def api_run_events(run_id: str,
                         user: auth.Identity = Depends(auth.require_user_sse)):
    run = runner.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")
    # Same 404 as unknown, deliberately: a non-admin must not learn that a run
    # exists for a brand they cannot see. require_user_sse accepts the token as
    # ?access_token= because EventSource cannot set headers; header wins.
    scope = _scope(user)
    if scope is not None and run.get("client") not in scope:
        raise HTTPException(status_code=404, detail=f"unknown run {run_id!r}")
    return StreamingResponse(
        _event_stream(run),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Output files
# ---------------------------------------------------------------------------

def _record_artifact(slug, topic_slug, name):
    """One whitelisted artifact's text from the record, or None when it holds nothing.

    Each name maps to the column the runner commits it to: blog.md and eval.md to the
    latest blog_versions row, dossier.md and links-verified.txt to the topics row, and
    status.jsonl rebuilt line for line from status_events with exactly the keys
    .claude/status.py writes, one JSON object per line and a trailing newline.
    """
    tid = db.topic_id(slug, topic_slug)
    if tid is None:
        return None
    if name == "dossier.md":
        return db.q("select dossier from topics where id = %s", (tid,), fetch="val")
    if name == "links-verified.txt":
        return db.q("select links_verified from topics where id = %s", (tid,), fetch="val")
    if name in ("blog.md", "eval.md"):
        row = db.q(
            """select body, eval_body from blog_versions
               where topic_id = %s order by version_no desc limit 1""",
            (tid,), fetch="one")
        if row is None:
            return None
        return row[0] if name == "blog.md" else row[1]
    if name == "status.jsonl":
        rows = db.q(
            """select ts, slug_reported, stage, event, iter, score, status, note
               from status_events where topic_id = %s order by line_no""",
            (tid,))
        if not rows:
            return None
        lines = []
        for ts, slug_reported, stage, event, iteration, score, status, note in rows:
            lines.append(json.dumps({
                "ts": ts.isoformat() if ts is not None else None,
                "slug": slug_reported or topic_slug,
                "stage": stage,
                "event": event,
                "iter": iteration,
                "score": score,
                "status": status,
                "note": note,
            }, ensure_ascii=False))
        return "\n".join(lines) + "\n"
    return None


@app.get("/api/clients/{slug}/output/{topic_slug}/{name}")
async def api_output_file(slug: str, topic_slug: str, name: str,
                          user: auth.Identity = Depends(auth.require_user)):
    if name not in OUTPUT_WHITELIST:
        raise HTTPException(status_code=404, detail="not found")
    _client_or_404(slug, user)

    # Slug-format guard: the record-era stand-in for the old resolve() check, so a
    # topic_slug smuggling separators or dot-dots 404s before any path or query is built.
    if runner.slugify(topic_slug) != topic_slug:
        raise HTTPException(status_code=404, detail="not found")

    # THE SPLIT: while a live run holds this topic the scratch file is authoritative,
    # because agents append there mid-run and the commit only lands at the terminal line.
    if topic_slug in _live_run_slugs(slug):
        path = runner.output_dir(slug, topic_slug) / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        return PlainTextResponse(
            path.read_text(encoding="utf-8"), media_type="text/plain; charset=utf-8"
        )

    # Settled topics come from the record, which outlives any scratch reclaim.
    text = _record_artifact(slug, topic_slug, name)
    if text is None:
        raise HTTPException(status_code=404, detail="not found")
    return PlainTextResponse(text, media_type="text/plain; charset=utf-8")
