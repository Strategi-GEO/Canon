"""The one endpoint behind the Post button.

POST /api/clients/{slug}/blogs/{topic_slug}/publish

An APIRouter rather than handlers in app.py, so this whole feature attaches with
one include_router line and detaches by deleting it. app.py keeps knowing nothing
about the CMS beyond that line.

The endpoint is a thin seam: gate, build, resolve key, POST, map the failure to a
status. Every real decision lives in gate.py, payload.py and client.py, where it
is testable without HTTP.
"""
import logging

from fastapi import APIRouter, HTTPException, Request

from .. import clients as clients_mod
from .. import ledger, runner
from . import client as cms_client
from . import gate
from . import meta_gen
from . import payload as payload_mod
from . import record
from .payload import PayloadError

log = logging.getLogger("geo-factory")

router = APIRouter(tags=["cms"])

# Coroutines to run after a SUCCESSFUL push, each fn(slug, topic_slug). Empty unless something
# registers, which keeps this router deletable whole: the channel auto-repurpose (app.py) hooks
# in here at import, and with server/cms/ deleted the registration simply never happens. A hook
# that raises is logged and swallowed, never allowed to turn a good publish into a failed one.
_after_publish = []


def after_publish(fn):
    """Register a coroutine fn(slug, topic_slug) to run after every successful CMS push."""
    _after_publish.append(fn)


def _status_for(upstream):
    """The status this endpoint answers with, given the CMS's own status.

    Deliberately NOT a passthrough. The CMS's 401 means OUR key is bad, which is this
    engine's misconfiguration and not the browser's, so echoing 401 to the dashboard would
    read as "your session expired" and send an operator to log in somewhere. 503 says the
    engine is not configured to do this right now, which is the truth.
    """
    if upstream in (401, 403):
        # A bad or read-only key. The operator cannot fix it from the UI, but naming it
        # sends whoever can to the right place immediately.
        return 503
    if upstream == 422:
        # The CMS rejected our payload. Ours to fix, and 502 would blame the CMS for it.
        return 422
    if upstream == 429:
        return 429
    # 5xx, a non-JSON body, or an unreachable host: genuinely the upstream's failure.
    return 502


@router.post("/api/clients/{slug}/blogs/{topic_slug}/publish")
async def api_publish_blog(slug: str, topic_slug: str, request: Request):
    """Push one shipped blog to the CMS as a draft.

    Not 202: this is a single request the operator is watching, so it stays
    synchronous and the answer is the CMS's own. Nothing is queued, and there is
    no background job to leave half-finished.

    `request` is here for ONE reason: the email that attributes the push, read off
    request.state where app.py's gate left it. This package imports no auth module and
    stays deletable whole, which is why the identity arrives as a string on the request
    rather than as an Identity this file would have to import a type for. getattr with a
    default means deleting app.py's stash degrades attribution to null instead of raising.
    """
    if not clients_mod.exists(slug):
        raise HTTPException(status_code=404, detail=f"No client '{slug}'")

    # The slug reaches the filesystem through output_dir, so it is validated
    # against the slug pattern before it gets there. A topic_slug of ".." is a
    # 404, exactly as it is for the artifact reader.
    if not runner.slugify(topic_slug) == topic_slug:
        raise HTTPException(status_code=404, detail=f"No blog '{topic_slug}'")

    # A FAILED blog the operator chose to publish is promoted first, then pushed, and the gate
    # below is NOT widened: assert_publishable still demands the literal `done`, because a CMS
    # draft is directly approvable by an editor, so anything reaching the CMS can reach the
    # client. What changes is that the operator takes responsibility for a draft that fell
    # below the 90 bar and that they have READ, expressed as the appended `done` verdict naming
    # them and the score, so the trail reads "failed at 81, then a person published it". Every
    # other status falls through untouched to assert_publishable's own refusal. NO SEND HAPPENS
    # HERE: posting to the CMS and releasing to the client are two acts and the operator picked
    # this one, so the promotion line says so and sent_to_client stays null.
    #
    # blog_edit is imported INSIDE the function so this package still detaches whole: a module
    # scope import would execute on import of a package whose whole promise is that deleting it
    # costs app.py one line. blog_edit is the engine proper and never imports cms, no cycle.
    from .. import blog_edit
    try:
        blog_edit.promote_if_failed(
            slug, topic_slug, gate.blog_status(runner, slug, topic_slug),
            getattr(request.state, "admin_email", None) or "",
            act="published it to the CMS")
    except blog_edit.EditError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    # THE GATE RUNS FIRST AND FOR FREE, so a blog the CMS will refuse never costs a model call.
    # assert_publishable raises before any token is spent; only a draft that will actually be
    # sent earns its editorial metadata.
    try:
        blog_md = gate.assert_publishable(runner, slug, topic_slug)
    except gate.PublishRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused))

    # The five editorial fields, written from the finished draft. {} on every failure path, and
    # {} is ordinary: build_for_publish falls back to the derived excerpt, H1 title, TL;DR
    # description, industry category and brand tag it has always produced, so a slow, absent or
    # refusing model costs this push its polish and never the push.
    meta = await meta_gen.generate(
        slug, blog_md,
        title_max=payload_mod.META_TITLE_MAX,
        desc_max=payload_mod.META_DESCRIPTION_MAX,
    )

    try:
        payload = gate.build_for_publish(
            runner, ledger, slug, topic_slug, client=clients_mod.read_client(slug), meta=meta
        )
    except gate.PublishRefused as refused:
        # 409, not 403: the blog exists and the operator may push it, just not in
        # the state it is currently in. 403 would read as a permissions problem.
        raise HTTPException(status_code=409, detail=str(refused))
    except PayloadError as bad:
        raise HTTPException(status_code=422, detail=str(bad))

    # One shared key posts to every org; the payload's `client` slug routes it. So there is no
    # org to resolve here, and no synthesised-org collision to guard: the destination is the
    # brand slug in the body, which is unique, not the key.
    key = cms_client.resolve_key()
    # The detail comes from cms_client because that module is the one that knows WHERE it
    # looked. It reads the process environment first and server/.env second, and an operator
    # who is told only "set it in the engine's environment" is told the one thing that does
    # not work on the packaged app: a Finder-launched .app reads no shell profile, so an
    # export never reaches the engine and the file is the only door. Composing the sentence
    # here meant it could not name the file without this route knowing the resolution order,
    # which is exactly the duplication that let the message go stale when the order changed.
    if not key:
        raise HTTPException(status_code=503, detail=cms_client.missing_key_detail())

    try:
        result = await cms_client.push_draft(payload, key)
    except cms_client.CmsError as cause:
        # The upstream status is MAPPED, not flattened. Every CmsError used to become a 502,
        # which told an operator with a revoked key that the CMS was down: they would go and
        # ask why the CMS was broken when the answer was their own credential. A 502
        # is only honest when the CMS genuinely failed or was unreachable.
        log.warning(
            "CMS push failed for %s/%s (upstream %s): %s",
            slug, topic_slug, cause.status or "unreachable", cause,
        )
        raise HTTPException(status_code=_status_for(cause.status), detail=str(cause))

    log.info(
        "CMS push ok for %s/%s: post %s",
        slug, topic_slug, result.get("post_id"),
    )

    # THE TAG VOCABULARY GROWS ONLY ON A PUSH THE CMS ACCEPTED, which is why this sits after the
    # error arm and not beside the generate call. category_name and tags are get-or-create with
    # no read endpoint, so this file is the engine's only record of what that CMS actually holds;
    # remembering a tag from a push that 4xx'd would teach the next run to reuse a tag nobody
    # ever created. It cannot raise (see meta_gen.remember_tags): the article is already in the
    # CMS by this line.
    meta_gen.remember_tags(slug, payload.get("tags") or [])

    # AFTER the push and never before it. The stamp records something that happened, so
    # writing it first would leave a publish date on an article the CMS then refused. It
    # cannot raise (see record.py): the article is already in the CMS by this line, and
    # nothing about bookkeeping is allowed to report that as a failed publish.
    record.record_publish(
        slug, topic_slug, result,
        email=getattr(request.state, "admin_email", None),
    )

    # PUBLISHING IS A RELEASE, SO IT STAMPS THE SEND. Pushing to the client's own CMS is the
    # operator's most final act: the article is live on their site by this line. Leaving
    # sent_to_client null after it meant the portal hid an article the client could already read,
    # because blogState drops `published` whenever there is no send.
    #
    # THAT GUARD IS SATISFIED HERE, NOT BYPASSED, and the difference is the whole reason this is
    # safe. It exists because a record with published_at and NO send once put an internal draft in
    # front of a client who was never sent it. Stamping the send makes that state unreachable
    # instead of tolerated: after this line there is no way to be published without a send.
    #
    # Best-effort and AFTER the record, for the same reason record_publish is: the article is in
    # the CMS, and no bookkeeping failure may report a successful publish as a failed one. A
    # refused stamp (an open client suggestion, an approved article) leaves the publish standing
    # and the operator can still send from the stage page.
    # blog_edit imported inside the function, and asyncio with it, for the reason stated where
    # promote_if_failed is called above: this package must still detach whole.
    try:
        import asyncio

        from .. import blog_edit as _blog_edit

        await asyncio.to_thread(
            _blog_edit.mark_sent, slug, topic_slug,
            getattr(request.state, "admin_email", None) or "",
        )
    except Exception:
        log.exception("post-publish send stamp failed for %s/%s", slug, topic_slug)

    # After the record, fire any post-publish hooks (the channel auto-repurpose). Best-effort:
    # the article is already in the CMS, so a hook failure is logged and never surfaced as a
    # failed publish. Hooks only SPAWN work (they return once a run is scheduled), so this does
    # not hold the operator's request open on a generation.
    for hook in list(_after_publish):
        try:
            await hook(slug, topic_slug)
        except Exception:
            log.exception("after-publish hook failed for %s/%s", slug, topic_slug)

    # The CMS's shape, flattened to what the drawer actually renders. `skipped`
    # means a human already advanced the post past draft, which the UI must show
    # as a success and never as a failed push to retry.
    return {
        "post_id": result.get("post_id"),
        "slug": result.get("slug"),
        "status": result.get("status"),
        "created": bool(result.get("created")),
        "updated": bool(result.get("updated")),
        "skipped": result.get("skipped"),
        "preview_token": result.get("preview_token"),
    }
