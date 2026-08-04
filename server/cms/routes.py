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


def _promote_if_failed(slug, topic_slug, email):
    """A FAILED blog the operator chose to publish is promoted first, then pushed.

    THE GATE IS NOT WIDENED, and that is the whole design. assert_publishable still demands
    the literal `done`, because its rule protects something real: a CMS draft is directly
    approvable by an editor, so anything that reaches the CMS can reach the client. What
    changes is that the operator may now take responsibility for a sub-95 draft they have
    READ, exactly as the promote-and-send door already lets them, and the way that
    responsibility is expressed here is the same appended `done` verdict naming them and the
    score. The trail therefore reads "failed at 87, then a person published it", never a
    silent bypass, and every downstream consumer (the fold, topic_rollup, the portal) sees a
    coherent record instead of a published blog whose status says it failed.

    NO SEND HAPPENS HERE. Posting to the CMS and releasing to the client are two acts and the
    operator picked this one, so the promotion line says so and sent_to_client stays null.

    Silent no-op for every other status: a `done` blog needs nothing, and needs_review,
    stopped and running fall through to assert_publishable's own refusal, which already names
    what it found. Refusals raised here are the promote route's own, re-raised as 409 so the
    operator reads the same sentence either door produces.
    """
    # Imported INSIDE the function so this package still detaches whole: an import at module
    # scope would make server/cms/ a load-bearing dependency of nothing, but it would also
    # execute on import of a package whose whole promise is that deleting it costs app.py one
    # line. blog_edit is the engine proper and never imports cms, so there is no cycle.
    from .. import blog_edit, db

    if gate.blog_status(runner, slug, topic_slug) != "failed":
        return

    cid = db.client_id(slug)
    score = db.q(
        """select v.score from blog_versions v
           join topics t on t.id = v.topic_id
           where t.client_id = %s and t.slug = %s and t.deleted_at is null
           order by v.version_no desc limit 1""",
        (cid, topic_slug), fetch="val")
    if score is None:
        # The same refusal api_promote_blog gives, for the same reason: gates and the link
        # pass run BEFORE the eval, so an unscored draft is the one artifact a failed topic
        # cannot vouch for, and the 95 bar is meant to be the ONLY thing being waived.
        raise HTTPException(
            status_code=409,
            detail=f"{topic_slug!r} has no evaluator-scored draft, so there is nothing to "
                   f"take responsibility for; generate it again instead",
        )
    try:
        blog_edit.promote_to_done(slug, topic_slug, score, email,
                                  act="published it to the CMS")
    except blog_edit.EditError as exc:
        raise HTTPException(status_code=409, detail=str(exc))


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

    _promote_if_failed(slug, topic_slug, getattr(request.state, "admin_email", None) or "")

    try:
        payload = gate.build_for_publish(
            runner, ledger, slug, topic_slug, client=clients_mod.read_client(slug)
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

    # AFTER the push and never before it. The stamp records something that happened, so
    # writing it first would leave a publish date on an article the CMS then refused. It
    # cannot raise (see record.py): the article is already in the CMS by this line, and
    # nothing about bookkeeping is allowed to report that as a failed publish.
    record.record_publish(
        slug, topic_slug, result,
        email=getattr(request.state, "admin_email", None),
    )

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
