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
import asyncio
import json
import logging
import mimetypes
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (FileResponse, JSONResponse, PlainTextResponse,
                               StreamingResponse)
from pydantic import BaseModel

from . import auth, blog_edit, blog_upload, client_answers, db, describe, facts_gen, ledger, roadmap, roadmap_gen, runner, sync
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
        "geo-factory must run on ONE uvicorn worker: the client lock and the "
        "5-topic semaphore are in-process primitives in runner.py, so "
        "--workers N breaks the concurrency cap (it becomes 5N)."
    )


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
        client_answers.run_forever(dispatch, _client_has_live_run))
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
    # surprises. demo_mode and every other field ride in on the record entry.
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
    # geo_mock is a wire-compat field the dashboard still reads, and it is now the literal
    # False: the mock execution path is removed from the engine, so no client can ever
    # produce fake output. The key stays so no reader's shape breaks; the value is the truth.
    return {"geo_mock": False, "clients": client_list}


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
    # geo_mock rides at the top level for the same reason /api/clients carries it: the
    # dashboard reads the key. It is the literal False now that the mock execution path is
    # removed; the field stays so no reader's shape breaks.
    return {"geo_mock": False, "orgs": _scoped_orgs(user)}


@app.get("/api/orgs/{org_slug}")
async def api_org(org_slug: str, user: auth.Identity = Depends(auth.require_user)):
    # Resolved against the SCOPED list, so an org outside a non-admin's grants
    # answers the same 404 as one that does not exist.
    for org in _scoped_orgs(user):
        if org["slug"] == org_slug:
            return org
    raise HTTPException(status_code=404, detail=f"unknown organisation {org_slug!r}")


# ---------------------------------------------------------------------------
# Onboarding: create and edit a client, and manage its Resources.
# ---------------------------------------------------------------------------

class CreateClientRequest(BaseModel):
    name: str
    domain: str = ""
    industry: str = ""
    description: str = ""
    demo_mode: bool = False
    # Optional: omitted means the brand is its own single-brand org, the common case.
    organisation_name: str = ""


class UpdateClientRequest(BaseModel):
    # All optional and all default None, so a PATCH carrying one field cannot blank the
    # others. None means "not sent", which clients.update_client reads as "do not write".
    description: Optional[str] = None
    name: Optional[str] = None
    organisation_name: Optional[str] = None
    # domain and industry were MISSING here while the settings page sent both of them and
    # toasted "Saved". Pydantic drops an unmodelled key silently, so the operator changed a
    # brand's domain, saw a success toast, and the record never moved. The engine then
    # researched against the old site. Added to the model AND to update_client together,
    # because either half alone reproduces the same silent success one level down.
    domain: Optional[str] = None
    industry: Optional[str] = None


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
        return clients_mod.create_client(
            body.name,
            body.domain,
            body.industry,
            description=body.description,
            demo_mode=body.demo_mode,
            organisation_name=body.organisation_name,
        )
    except clients_mod.ClientExists as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except clients_mod.InvalidClient as exc:
        raise HTTPException(status_code=422, detail=str(exc))


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
            industry=body.industry,
        )
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except clients_mod.InvalidClient as exc:
        raise HTTPException(status_code=422, detail=str(exc))


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

def _load_roadmap_or_404(slug, user=None):
    _client_or_404(slug, user)
    try:
        return roadmap.load_roadmap(slug)
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
        for topic in run.get("topics", []):
            in_flight.add(topic.get("topic_slug"))
    return in_flight


def _client_has_live_run(slug):
    return any(
        run.get("client") == slug and run.get("live") for run in runner.list_runs()
    )


@app.get("/api/clients/{slug}/roadmap")
async def api_roadmap(slug: str, user: auth.Identity = Depends(auth.require_user)):
    return roadmap.annotate_generated(slug, _load_roadmap_or_404(slug, user))


@app.get("/api/clients/{slug}/roadmap/report")
async def api_roadmap_report(slug: str,
                             user: auth.Identity = Depends(auth.require_user)):
    """The saved account of how this brand's roadmap was generated.

    Read from the record, not from the generation job, so it outlives the process that made it.
    The job answers "what is happening now" and is gone on restart; this answers "why does my
    roadmap look like this", which an operator asks weeks later. A 404 here is ordinary: an
    uploaded roadmap has no report, because nothing generated it.
    """
    _client_or_404(slug, user)
    report = roadmap_gen.read_report(slug)
    if report is None:
        raise HTTPException(
            status_code=404, detail=f"no roadmap generation report for {slug!r}"
        )
    return report


@app.get("/api/clients/{slug}/roadmap/sheet")
async def api_roadmap_sheet(slug: str,
                            user: auth.Identity = Depends(auth.require_user)):
    """The raw CSV as a rectangle, for previewing the file the operator uploaded.

    Separate from /roadmap rather than folded into it: that route answers what the engine will
    read, three columns and their parse state, and this one answers what the file contains. A
    single route serving both would have to pick which meaning "rows" has.
    """
    _client_or_404(slug, user)
    try:
        return roadmap.read_sheet(slug)
    except roadmap.RoadmapNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/clients/{slug}/roadmap", status_code=204)
async def api_delete_roadmap(slug: str,
                             user: auth.Identity = Depends(auth.require_admin)):
    """Remove the brand's roadmap so a new one can be uploaded or generated.

    This is the ONLY way to change a roadmap, by design: an upload is refused while one
    exists. Replacing in place is how a roadmap gets swapped by accident, and the app spent
    a while offering a "Replace roadmap" button that quietly replaced nothing, which is the
    same class of lie in the other direction. Deleting is explicit, the UI confirms it, and
    what it destroys is stated up front.

    It removes roadmap.csv and NOTHING else. Blogs already written stay on disk, and the
    ledger still records them. A roadmap is the input, not the work.
    """
    _client_or_404(slug, user)
    if _client_has_live_run(slug):
        # A live run's rows came from this sheet. Deleting it underneath would leave the
        # status table describing topics whose source no longer exists.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before deleting the roadmap",
        )
    if not roadmap.delete_roadmap(slug):
        raise HTTPException(status_code=404, detail=f"{slug!r} has no roadmap to delete")
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
    if roadmap.has_roadmap(slug):
        # One roadmap per brand, and replacing it takes a deliberate delete first. An upload
        # that silently overwrote the existing sheet would redefine every topic the brand
        # writes from, and the operator would find out later, from a blog about the wrong
        # subject. The refusal names the way forward rather than just saying no.
        raise HTTPException(
            status_code=409,
            detail=(
                f"{slug!r} already has a content roadmap. Delete it first, then upload a new "
                f"one. Deleting removes the topic list only: blogs already written stay."
            ),
        )

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
    if _client_has_live_run(slug):
        # Same rule the roadmap upload and delete routes enforce, asked the same way: a live
        # run's rows came from this sheet, so the sheet must not change underneath it.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; wait for it to finish before generating a roadmap",
        )
    if roadmap.has_roadmap(slug):
        # One roadmap per brand, and replacing it takes a deliberate delete first, exactly as
        # the upload route requires. Generating over an existing sheet would redefine every
        # topic the brand writes from, and the operator would find out from a blog about the
        # wrong subject.
        raise HTTPException(
            status_code=409,
            detail=(
                f"{slug!r} already has a content roadmap. Delete it first, then generate a new "
                f"one. Deleting removes the topic list only: blogs already written stay."
            ),
        )

    return _public_job(roadmap_gen.start_job(slug, url, body.piece_count, body.notes))


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
# Canonical facts: the file, then the job that builds it.
#
# READ ONLY, all three. There is deliberately NO POST and NO PATCH here: a blog run starts the
# generation itself, because the fact base is a precondition of writing a blog rather than a
# thing an operator asks for. A button that also started one would be a second way to do the
# same thing, and the two could disagree about which fact base a run is using while the run
# was already reading it.
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
    summaries = _status_summaries(client_id)

    # The record: every live topic that carries at least one committed version,
    # with the latest version's title and commit time standing in for the old
    # H1 scan and mtime fallback.
    rows = db.q(
        """select t.slug, t.title, v.h1_title, v.committed_at, v.score is null,
                  v.version_no
           from topics t
           join lateral (
             select h1_title, committed_at, score, version_no from blog_versions v
             where v.topic_id = t.id
             order by v.version_no desc limit 1
           ) v on true
           where t.client_id = %s and t.deleted_at is null""",
        (client_id,))

    entries = {}
    for topic_slug, topic_title, h1_title, committed_at, unscored, version_no in rows:
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
            "score": summary.get("score"),
            "status": summary.get("status") or "unknown",
            "iterations": summary.get("iterations"),
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
            entries[topic_slug] = live_entry

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
    changes_map = dict(db.q(
        """select t.slug, count(*)
           from blog_comments c
           join topics t on t.id = c.topic_id
           where c.client_id = %s and c.author = 'client'
             and c.parent_id is null
             and c.state in ('open', 'applying')
           group by t.slug""",
        (client_id,)))
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
    # a clean rerun at >= 95 asks nothing new, so the client is meant to keep holding the old draft
    # and their own answers until an admin sends. The stamp therefore stands until the next round of
    # questions replaces the anchor or a send moves the article past it in blogState's ladder.
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
        # publishes a run as live before it starts (CLIENT_LOCK can hold it for minutes), the
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

    # THE DEMO REFUSAL, before the topic is even resolved. An answer dispatches a surgical
    # revise, which is a real SDK session, and a demo fixture must never spend real API
    # credits: the mock path that used to make this free is removed. runner.revise_topic
    # refuses this too, so nothing bypassing the route can spend money on a fixture.
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))

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
    if _client_has_live_run(slug):
        # One session per client at a time, the rule CLIENT_LOCK enforces anyway. Refusing here
        # means the operator hears it now, rather than watching a queued revise sit behind a
        # batch that has nineteen blogs left to write.
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; answer once it finishes so the revise is not "
                   f"queued behind it",
        )

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

    Refusals mirror api_answers where they share a reason: demo, unknown topic, no form,
    stale form, live run. Two are this route's own: a form nobody answered has nothing to
    apply (409), and a claim already held means another machine's engine is mid-rerun on
    this exact topic, so a second dispatch would double-spend (409). The claim is released
    when the dispatched task settles; a crashed engine's claim expires on its own.
    """
    _client_or_404(slug, user)
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))
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
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; rerun once it finishes so the revise is "
                   f"not queued behind it",
        )

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
# the portal show it. Every route refuses demo fixtures: a comment apply spends real API
# credits, and a demo blog is templated placeholder text nobody should polish or deliver.
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


class ReplyRequest(BaseModel):
    body: str


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
    CMS push. A blog can be done and approved at once, so both checks run and this one goes
    second: done is the more basic fact and its message is the more useful one for a topic that
    is neither.
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
    run permanent-first, exactly as api_answers orders its own: demo, then the topic's
    state, then the transient live run and in-flight cap, then the body the operator can
    fix by typing.
    """
    _client_or_404(slug, user)
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))
    _topic_or_404(slug, topic)
    _require_done(slug, topic, "a Claude edit")
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
    comment list. Refusals run permanent-first, exactly as filing orders its own: demo,
    then the topic's state, then the transient live run, then the comment itself. The
    in-flight cap no longer has its own step here, because it rides inside the flip
    statement (resolve_comment says why); this route reads its refusal off a flip that
    returned nothing."""
    _client_or_404(slug, user)
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))
    _topic_or_404(slug, topic)
    _require_done(slug, topic, "a Claude edit")
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


@app.post("/api/clients/{slug}/blogs/{topic}/comments/{comment_id}/reply",
          status_code=201)
async def api_reply_blog_comment(slug: str, topic: str, comment_id: str,
                                 body: ReplyRequest,
                                 user: auth.Identity = Depends(auth.require_admin)):
    """Answer one comment in its thread, as the operator.

    201 and not 202, because nothing runs: a reply is a sentence the client reads, and it
    leaves the parent's state exactly where it was. REPLYING IS NOT RESOLVING, and keeping
    those two doors apart is the whole point of this one: an operator who wants to say "we
    cut that line, it was a duplicate" must be able to say it without a Claude session
    deciding the request on the client's behalf, and without the comment disappearing from
    the client's rail as though it had been handled.

    No demo refusal and no done gate, unlike every route above: those exist because an
    apply spends real API credits on an article worth polishing, and a reply spends
    neither. An unknown comment and a reply's own id both answer 404, because a reply is
    not addressable as a comment (blog_edit.get_comment says why)."""
    _client_or_404(slug, user)
    _topic_or_404(slug, topic)
    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=422, detail="a reply needs something in it")
    reply = await asyncio.to_thread(
        blog_edit.reply_comment,
        slug, topic, comment_id,
        body=text,
        author="operator",
        author_email=getattr(user, "email", "") or "",
    )
    if reply is None:
        raise HTTPException(status_code=404, detail=f"no comment {comment_id!r} on {topic!r}")
    return reply


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


@app.post("/api/clients/{slug}/blogs/{topic}/content")
async def api_save_blog_content(slug: str, topic: str, body: ContentRequest,
                                user: auth.Identity = Depends(auth.require_admin)):
    """Save the operator's own edit of blog.md. Synchronous, not 202: the write plus the
    record commit is subsecond, and the operator pressing Save deserves to know it landed
    before the button releases."""
    _client_or_404(slug, user)
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))
    _topic_or_404(slug, topic)
    _require_done(slug, topic, "editing")
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
    """Release one shipped blog to the client portal, first send and Send again both.

    The portal shows a blog for review only once this stamp exists, so the admin-review
    stage is the default for every shipped blog and this button is its exit. No longer
    idempotent, deliberately: a re-send after a review round is a new release of changed
    bytes, so every press re-stamps the date, pins sent_version_id to the latest
    committed version, and clears the client's approval (mark_sent says why). The one
    refusal is an open client suggestion, because sending over it would release an
    article the client is still waiting to see changed, and the dialog owes them an
    answer (resolve or dismiss) before the next version lands in their portal.

    THAT REFUSAL IS THE STATEMENT'S, not this route's. Reading the count here and then
    stamping left a gap a portal write fits inside: the read returns zero, the client
    files a suggestion, and the send releases the article over a request nobody has seen.
    mark_sent asserts the same condition in the UPDATE's own WHERE and answers None when
    it fails, so the 409 below describes a refusal the database made.
    """
    _client_or_404(slug, user)
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))
    _topic_or_404(slug, topic)
    _require_done(slug, topic, "sending to the client")
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
    _require_not_approved(slug, topic, "sending to the client")
    email = getattr(user, "email", "") or ""
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
    _client_or_404(slug, user)
    # Same first refusal as generate: a demo brand has no real fact base, and letting one
    # take a real article would put genuine copy behind a fixture whose blogs are marked
    # not for publication.
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))
    if runner.slugify(topic) != topic:
        raise HTTPException(status_code=404, detail="not found")

    rows = _load_roadmap_or_404(slug, user)["rows"]
    row = next((r for r in rows if r.get("topic_slug") == topic), None)
    if row is None:
        raise HTTPException(
            status_code=404,
            detail=f"no roadmap row for {topic!r}; a blog can only be uploaded against a "
                   f"topic this brand's roadmap plans")

    # The live-run refusal /content already makes, for the same reason and at the same
    # breadth: while a session is open the engine owns the scratch tree, and an upload
    # landing beside it races materialize and commit for a file both are writing.
    if _client_has_live_run(slug):
        raise HTTPException(
            status_code=409,
            detail=f"a run for {slug!r} is live; upload once it finishes so the engine's "
                   f"own writes are not raced",
        )

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
    # topic capped at needs_review that the operator lifts to 95+ by answering the blocking
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
        # instant it takes CLIENT_LOCK. Only the runner knows that moment: the lock is
        # repo-wide and a session can wait behind another for minutes.
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

    # THE DEMO REFUSAL, before anything else is even validated. A demo fixture can no longer
    # generate anything: the mock path that used to make it free is removed, so the only thing
    # a generate could do here is open real SDK sessions, and for a demo client with no
    # canonical-facts.md the very first spend would be ensure_facts building a fact base for a
    # fake brand. runner.run_batch refuses this too, so nothing bypassing the route can spend.
    if runner.is_demo_client(slug):
        raise HTTPException(status_code=409, detail=runner.demo_refusal_detail(slug))

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
                   f"posting it to the CMS is the only act left. Deselect them and resubmit.",
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
