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

from fastapi import APIRouter, HTTPException

from .. import clients as clients_mod
from .. import ledger, runner
from . import client as cms_client
from . import gate
from .payload import PayloadError

log = logging.getLogger("geo-factory")

router = APIRouter(tags=["cms"])


def _org_slug(client_slug):
    """The org a brand belongs to, which selects the write key.

    read_client resolves this the same way every other reader sees it. A brand
    with no explicit org is its own single-brand org, so this is never empty for
    a client that exists.
    """
    record = clients_mod.read_client(client_slug) or {}
    org = record.get("organisation") or {}
    return org.get("slug") or client_slug


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
async def api_publish_blog(slug: str, topic_slug: str):
    """Push one shipped blog to the CMS as a draft.

    Not 202: this is a single request the operator is watching, so it stays
    synchronous and the answer is the CMS's own. Nothing is queued, and there is
    no background job to leave half-finished.
    """
    if not clients_mod.exists(slug):
        raise HTTPException(status_code=404, detail=f"No client '{slug}'")

    # The slug reaches the filesystem through output_dir, so it is validated
    # against the slug pattern before it gets there. A topic_slug of ".." is a
    # 404, exactly as it is for the artifact reader.
    if not runner.slugify(topic_slug) == topic_slug:
        raise HTTPException(status_code=404, detail=f"No blog '{topic_slug}'")

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

    org_slug = _org_slug(slug)
    key = cms_client.resolve_key(org_slug)
    if not key:
        raise HTTPException(
            status_code=503,
            detail=(
                f"No CMS write key configured for org '{org_slug}'. Set "
                f"{cms_client.key_var_for_org(org_slug)} in the engine's environment."
            ),
        )

    try:
        result = await cms_client.push_draft(payload, key)
    except cms_client.CmsError as cause:
        # The upstream status is MAPPED, not flattened. Every CmsError used to become a 502,
        # which told an operator with a revoked key that the CMS was down: they would go and
        # ask why cms.strategi.is was broken when the answer was their own credential. A 502
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
