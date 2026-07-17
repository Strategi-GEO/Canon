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
import os
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from . import db, describe, facts_gen, ledger, roadmap, roadmap_gen, runner, sync
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

app.include_router(cms_router)


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


# ---------------------------------------------------------------------------
# Clients and preflight
# ---------------------------------------------------------------------------

# Mirrors the client_slug domain in supabase/schema.sql, underscore fixtures
# included. Kept as a guard in front of every record lookup: the old directory
# stat rejected traversal for free, and this is that guard's record-era twin.
_CLIENT_SLUG_RE = re.compile(r"^_?[a-z0-9]+(-[a-z0-9]+)*$")


def _client_or_404(slug):
    """The client must be a live clients row: record-backed, the disk is never asked."""
    if not _CLIENT_SLUG_RE.fullmatch(slug) or not clients_mod.exists(slug):
        raise HTTPException(status_code=404, detail=f"unknown client {slug!r}")


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
        return False, (
            "canonical-facts.md still contains the token PLACEHOLDER "
            "and has not been reviewed"
        )
    return True, None


@app.get("/")
async def index():
    if not INDEX_HTML.is_file():
        raise HTTPException(status_code=404, detail="web/index.html not found")
    return FileResponse(INDEX_HTML)


@app.get("/api/clients")
async def api_clients():
    # Record-backed, and a pure read at last: the old onboarding side effects
    # (mkdir outputs/<slug>/, seed generated.csv) are gone because create_client
    # and run start own onboarding now, and a GET that writes is a GET that
    # surprises. demo_mode and every other field ride in on the record entry.
    client_list = []
    for entry in clients_mod.list_clients():
        # The original keys stay exactly as they were, so the legacy UI keeps working while
        # the dashboard reads the onboarding fields alongside them.
        ok, reason = _preflight(entry["slug"])
        entry["preflight"] = {"ok": ok, "reason": reason}
        client_list.append(entry)
    # geo_mock is reported so the UI can shout about it. Only the demo org is
    # meant to produce fake output; GEO_MOCK=1 fakes EVERY client while still
    # saving the result into that client's real output folder and ledger, so a
    # forgotten switch would quietly fill a live brand with unresearched drafts.
    # Anything this dangerous has to be visible, not just documented.
    return {"geo_mock": runner.geo_mock(), "clients": client_list}


# ---------------------------------------------------------------------------
# Organisations: a grouping over brands, computed on read.
#
# An org is the agency's client; a brand is the engine's unit of work. The grouping is
# derived from each brand's gates.json, so there is no orgs/ directory and no second config
# file that could drift out of sync with the brands it groups.
# ---------------------------------------------------------------------------

@app.get("/api/orgs")
async def api_orgs():
    # geo_mock rides at the top level for the same reason /api/clients reports it: only demo
    # brands are meant to produce fake output, and a forgotten GEO_MOCK=1 fakes EVERY brand
    # while still saving into that brand's real folder and ledger. The UI has to be able to
    # shout about it, so it cannot be left implicit here either.
    return {"geo_mock": runner.geo_mock(), "orgs": clients_mod.list_orgs()}


@app.get("/api/orgs/{org_slug}")
async def api_org(org_slug: str):
    org = clients_mod.read_org(org_slug)
    if org is None:
        raise HTTPException(status_code=404, detail=f"unknown organisation {org_slug!r}")
    return org


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


def _read_client_or_404(slug):
    try:
        return clients_mod.read_client(slug)
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.get("/api/industries")
async def api_industries():
    return {"industries": clients_mod.list_industries()}


@app.post("/api/clients", status_code=201)
async def api_create_client(body: CreateClientRequest):
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
async def api_client(slug: str):
    return _read_client_or_404(slug)


@app.patch("/api/clients/{slug}")
async def api_update_client(slug: str, body: UpdateClientRequest):
    try:
        return clients_mod.update_client(
            slug,
            description=body.description,
            name=body.name,
            organisation_name=body.organisation_name,
        )
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except clients_mod.InvalidClient as exc:
        raise HTTPException(status_code=422, detail=str(exc))


def _public_job(job):
    """The job without its asyncio task handle, which is not serialisable."""
    return {key: value for key, value in job.items() if not key.startswith("_")}


@app.post("/api/clients/{slug}/describe", status_code=202)
async def api_describe_client(slug: str):
    """Start a draft. Returns immediately; the engine owns the work.

    202 and not 200: a draft is a real Claude Code session against a live site and runs for
    tens of seconds. Awaiting it inside the request made the BROWSER the owner, so a refresh
    or a closed tab aborted a result the operator had already paid for while the session ran
    on regardless. Now the engine holds it and the browser only watches, which is the same
    rule blog runs already follow: this is an interface onto local work, never the work.
    """
    client = _read_client_or_404(slug)
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
async def api_describe_jobs():
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
async def api_describe_job(slug: str):
    """The current draft job for this brand, or 404 when there is none.

    This is what makes a draft survive a refresh: the page asks the engine what is happening
    rather than remembering what it started. A tab that never issued the POST sees the same
    truth as the tab that did, which matters because six operators share one deployment.
    """
    _read_client_or_404(slug)
    job = describe.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no draft job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/describe", status_code=204)
async def api_clear_describe_job(slug: str):
    """Drop a settled draft once the operator has used or dismissed it.

    Without this the same finished draft would greet them on every visit forever. A RUNNING
    job is deliberately not cancellable here: the session is already spending quota, so the
    honest thing is to let it land and let the operator discard the result.
    """
    _read_client_or_404(slug)
    describe.clear_job(slug)
    return None


@app.get("/api/clients/{slug}/resources")
async def api_resources(slug: str):
    _client_or_404(slug)
    return {"resources": clients_mod.list_resources(slug)}


@app.post("/api/clients/{slug}/resources", status_code=201)
async def api_resource_upload(slug: str, file: UploadFile = File(...)):
    _client_or_404(slug)
    raw = await file.read()
    if len(raw) > clients_mod.MAX_RESOURCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file is {len(raw)} bytes; the resource limit is "
                   f"{clients_mod.MAX_RESOURCE_BYTES} bytes",
        )
    try:
        return clients_mod.save_resource(slug, file.filename, raw)
    except clients_mod.BadResource as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except clients_mod.UnknownClient as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/clients/{slug}/resources/{name}", status_code=204)
async def api_resource_delete(slug: str, name: str):
    _client_or_404(slug)
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

def _load_roadmap_or_404(slug):
    _client_or_404(slug)
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
async def api_roadmap(slug: str):
    return roadmap.annotate_generated(slug, _load_roadmap_or_404(slug))


@app.get("/api/clients/{slug}/roadmap/report")
async def api_roadmap_report(slug: str):
    """The saved account of how this brand's roadmap was generated.

    Read from the record, not from the generation job, so it outlives the process that made it.
    The job answers "what is happening now" and is gone on restart; this answers "why does my
    roadmap look like this", which an operator asks weeks later. A 404 here is ordinary: an
    uploaded roadmap has no report, because nothing generated it.
    """
    _client_or_404(slug)
    report = roadmap_gen.read_report(slug)
    if report is None:
        raise HTTPException(
            status_code=404, detail=f"no roadmap generation report for {slug!r}"
        )
    return report


@app.get("/api/clients/{slug}/roadmap/sheet")
async def api_roadmap_sheet(slug: str):
    """The raw CSV as a rectangle, for previewing the file the operator uploaded.

    Separate from /roadmap rather than folded into it: that route answers what the engine will
    read, three columns and their parse state, and this one answers what the file contains. A
    single route serving both would have to pick which meaning "rows" has.
    """
    _client_or_404(slug)
    try:
        return roadmap.read_sheet(slug)
    except roadmap.RoadmapNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.delete("/api/clients/{slug}/roadmap", status_code=204)
async def api_delete_roadmap(slug: str):
    """Remove the brand's roadmap so a new one can be uploaded or generated.

    This is the ONLY way to change a roadmap, by design: an upload is refused while one
    exists. Replacing in place is how a roadmap gets swapped by accident, and the app spent
    a while offering a "Replace roadmap" button that quietly replaced nothing, which is the
    same class of lie in the other direction. Deleting is explicit, the UI confirms it, and
    what it destroys is stated up front.

    It removes roadmap.csv and NOTHING else. Blogs already written stay on disk, and the
    ledger still records them. A roadmap is the input, not the work.
    """
    _client_or_404(slug)
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
async def api_roadmap_upload(slug: str, file: UploadFile = File(...)):
    _client_or_404(slug)
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
async def api_generate_roadmap(slug: str, body: GenerateRoadmapRequest):
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
async def api_roadmap_generation_job(slug: str):
    """The current generation job for this brand, or 404 when there has never been one.

    This is what makes a generation survive a refresh: the page asks the engine what is
    happening rather than remembering what it started. A tab that never issued the POST sees
    the same truth as the tab that did, which matters because several operators share one
    deployment.
    """
    _client_or_404(slug)
    job = roadmap_gen.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no roadmap generation job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/roadmap/generate", status_code=204)
async def api_clear_roadmap_generation(slug: str):
    """Drop a settled generation job once the operator has read or dismissed it.

    Without this the same finished report would greet them on every visit forever. A RUNNING
    job is refused rather than cleared: the session is already spending quota, and dropping
    the record would leave it writing a roadmap.csv that no job explains.
    """
    _client_or_404(slug)
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
async def api_facts_file(slug: str):
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
    _client_or_404(slug)
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
async def api_facts_generation_job(slug: str):
    """The current fact generation job for this brand, or 404 when there has never been one.

    This is what lets the operator watch a phase they did not start. The run reports phase
    "facts" and this endpoint says what that phase is actually doing, so a refresh, a closed
    tab, or a second operator on another machine all see the same truth as the tab that
    pressed Generate. A 404 means no fact base has ever been built here, which for a brand
    that already has one is the normal answer: the file is on disk and no job was needed.
    """
    _client_or_404(slug)
    job = facts_gen.get_job(slug)
    if job is None:
        raise HTTPException(status_code=404, detail=f"no facts generation job for {slug!r}")
    return _public_job(job)


@app.delete("/api/clients/{slug}/facts/generate", status_code=204)
async def api_clear_facts_generation(slug: str):
    """Drop a settled fact generation job once the operator has read or dismissed it.

    Without this the same finished report would greet them on every visit forever. A RUNNING
    job is refused rather than cleared: the session is already spending quota and a blog run
    is waiting on it, so dropping the record would leave that run blocked on a job nobody can
    see. Clearing the job never touches canonical-facts.md itself.
    """
    _client_or_404(slug)
    if facts_gen.job_running(slug):
        raise HTTPException(
            status_code=409,
            detail=f"the canonical facts generation for {slug!r} is still running; it can be "
                   f"cleared once it finishes",
        )
    facts_gen.clear_job(slug)
    return None


@app.get("/api/clients/{slug}/ledger")
async def api_ledger(slug: str):
    _client_or_404(slug)
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
        """select t.slug, t.title, v.h1_title, v.committed_at
           from topics t
           join lateral (
             select h1_title, committed_at from blog_versions v
             where v.topic_id = t.id
             order by v.version_no desc limit 1
           ) v on true
           where t.client_id = %s and t.deleted_at is null""",
        (client_id,))

    entries = {}
    for topic_slug, topic_title, h1_title, committed_at in rows:
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
            # Which row of the CURRENT sheet this blog is, or None when it is on no row. Titles are
            # long, near identical to each other, and nobody holds twenty of them in their head:
            # "change blog six" is the question operators and their clients actually ask, and until
            # this field existed the app could not answer it. Zero based, exactly like
            # RoadmapRow.index; every DISPLAY adds one. See roadmap.index_by_slug.
            "roadmap_index": row_index.get(topic_slug),
        }

    # The live overlay: scratch is authoritative for topics in a live run, so a
    # mid-run topic appears (and a mid-revise one reports) exactly as the disk
    # scan surfaced it, terminal line still unwritten.
    for topic_slug in _live_run_slugs(slug):
        if not topic_slug:
            continue
        live_entry = _scratch_entry(slug, topic_slug, led, row_index)
        if live_entry is not None:
            entries[topic_slug] = live_entry

    # Newest first stays the default, because the library's own question is "what happened lately".
    # Sorting by roadmap_index here would be wrong twice over: a blog on no row has none to sort by,
    # and the operator can already order by number in the browser, where it is one click and
    # reversible rather than a decision baked into every caller of this function.
    blogs = list(entries.values())
    blogs.sort(key=lambda b: b["created"], reverse=True)
    return blogs


@app.get("/api/clients/{slug}/blogs")
async def api_blogs(slug: str):
    _client_or_404(slug)
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
async def api_questions(slug: str, topic: str):
    """The evaluator's questions for one blog, plus what the operator can do about them.

    stale and blocking are computed here rather than stored, and that is deliberate. Both are
    facts about the questions RELATIVE to the blog right now: the blog moves on, and a stored
    flag would be a snapshot of what was true when the evaluator asked. The staleness bug this
    endpoint exists to expose is exactly that mismatch.
    """
    _client_or_404(slug)
    _topic_or_404(slug, topic)
    try:
        return questions_mod.describe_questions(slug, topic)
    except questions_mod.NoQuestions as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@app.post("/api/clients/{slug}/blogs/{topic}/answers", status_code=202)
async def api_answers(slug: str, topic: str, body: AnswersRequest):
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
    _client_or_404(slug)
    _topic_or_404(slug, topic)

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
async def api_runs():
    return {"runs": runner.list_runs()}


async def _on_topic_done(slug, run_id, result):
    """Awaited once per topic as it completes. Records ships in the ledger."""
    try:
        ledger.record_success(slug, result, result.get("row") or {}, run_id)
    except Exception:
        # A ledger write must never take down a run that already produced a
        # blog. The blog is on disk either way; log and carry on.
        log.exception("ledger append failed for run %s client %s", run_id, slug)


async def _batch_task(run_id, slug, rows, mock):
    try:
        callback = lambda result: _on_topic_done(slug, run_id, result)
        # run_id is passed so run_batch can flip this run from queued to running at the
        # instant it takes CLIENT_LOCK. Only the runner knows that moment: the lock is
        # repo-wide and a session can wait behind another for minutes.
        await runner.run_batch(slug, rows, mock=mock, on_topic_done=callback,
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
async def api_stop_client_runs(slug: str):
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
async def api_generate(slug: str, body: GenerateRequest):
    _client_or_404(slug)

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

    # Mock mode comes from the GEO_MOCK env only; a request can never choose
    # it, so a production deployment cannot be tricked into fake output.
    mock = runner.geo_mock()
    if not mock:
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
    task = asyncio.create_task(_batch_task(run_id, slug, selected, mock))
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
    mock mode must exercise the exact plumbing production uses, so progress is
    never read from in-memory state."""

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
async def api_run_events(run_id: str):
    run = runner.get_run(run_id)
    if run is None:
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
async def api_output_file(slug: str, topic_slug: str, name: str):
    if name not in OUTPUT_WHITELIST:
        raise HTTPException(status_code=404, detail="not found")
    _client_or_404(slug)

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
