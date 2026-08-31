"""The one endpoint behind the Post button.

POST /api/clients/{slug}/blogs/{topic_slug}/publish

An APIRouter rather than handlers in app.py, so this whole feature attaches with
one include_router line and detaches by deleting it. app.py keeps knowing nothing
about publishing beyond that line.

THERE IS ONE DESTINATION SHAPE AND IT IS THE CLIENT'S OWN WEBSITE. This route used
to fork: a driver for a brand on its own site, and a direct call into the Strategi
CMS for everyone else. The CMS is gone, so the fork is gone with it, and a brand
either has a driver or has nowhere to publish. That second case is a refusal, which
is what assert_destination already said and what the Post button now shows as a
disabled control naming the setting.

The endpoint is a thin seam: gate, build, push, map the failure to a status. Every
real decision lives in gate.py, payload.py and the driver, where it is testable
without HTTP.
"""
import logging

from fastapi import APIRouter, HTTPException, Request

from .. import clients as clients_mod
from .. import ledger, runner
from . import gate
from . import http as sites_http
from . import meta_gen
from . import payload as payload_mod
from . import record
from . import sites
from .payload import PayloadError

log = logging.getLogger("geo-factory")

router = APIRouter(tags=["cms"])

# Coroutines to run after a SUCCESSFUL push, each fn(slug, topic_slug). Empty unless something
# registers, which keeps this router deletable whole: the channel auto-repurpose (app.py) hooks
# in here at import, and with server/cms/ deleted the registration simply never happens. A hook
# that raises is logged and swallowed, never allowed to turn a good publish into a failed one.
_after_publish = []


def after_publish(fn):
    """Register a coroutine fn(slug, topic_slug) to run after every successful publish."""
    _after_publish.append(fn)


def _status_for(upstream):
    """The status this endpoint answers with, given the destination's own status.

    Deliberately NOT a passthrough. The site's 401 means OUR credential is bad, which is this
    engine's misconfiguration and not the browser's, so echoing 401 to the dashboard would
    read as "your session expired" and send an operator to log in somewhere. 503 says the
    engine is not configured to do this right now, which is the truth.
    """
    if upstream in (401, 403):
        # A bad or read-only credential. The operator cannot fix it from the UI, but naming it
        # sends whoever can to the right place immediately.
        return 503
    if upstream == 422:
        # The site rejected our payload. Ours to fix, and 502 would blame the site for it.
        return 422
    if upstream == 429:
        return 429
    # 5xx, a non-JSON body, or an unreachable host: genuinely the upstream's failure.
    return 502


@router.post("/api/clients/{slug}/blogs/{topic_slug}/publish")
async def api_publish_blog(slug: str, topic_slug: str, request: Request):
    """Publish one shipped blog live on the client's own website.

    Not 202: this is a single request the operator is watching, so it stays
    synchronous and the answer is the site's own. Nothing is queued, and there is
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

    # WHERE THIS BRAND PUBLISHES, AND WHETHER IT MAY, BEFORE ANYTHING IS SPENT OR MOVED. Both
    # refusals are free, and they are checked ahead of promote_if_failed on purpose: promotion
    # APPENDS a terminal `done` line naming the operator, so refusing after it would leave a
    # blog recorded as shipped by a person whose press was then rejected.
    #
    # read_site and not the client record: clients.site carries a write credential for a live
    # client website, so it is read here through its own query rather than through the shape
    # that GET /api/clients/{slug} returns to any logged-in user.
    site = clients_mod.read_site(slug)
    try:
        gate.assert_destination(site, slug)
        gate.assert_client_approved(
            site, slug, topic_slug, gate.client_approved_at(slug, topic_slug))
    except gate.PublishRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused))

    # WHETHER THIS BUILD CAN REACH IT AT ALL. None is not a second path any more: it is a brand
    # set to a destination this build has no driver for, refused before anything is promoted or
    # spent. assert_destination already caught the EMPTY case with the sentence about connecting
    # a website, so what reaches here is a non-empty kind with no driver, which is a downgrade or
    # a blob written by a newer build.
    driver = sites.driver_for(site.get("kind"))
    if driver is None:
        raise HTTPException(
            status_code=409,
            detail=f"'{slug}' is set to publish to '{site.get('kind')}', which this version of "
                   f"Canon cannot post to. Reconnect the client's website in Settings.")

    # A FAILED blog the operator chose to publish is promoted first, then pushed, and the gate
    # below is NOT widened: assert_publishable still demands the literal `done`, because the push
    # puts the article live on the client's public site. What changes is that the operator takes
    # responsibility for a draft that fell below the 90 bar and that they have READ, expressed as
    # the appended `done` verdict naming them and the score, so the trail reads "failed at 81,
    # then a person published it". Every other status falls through untouched to
    # assert_publishable's own refusal.
    #
    # blog_edit is imported INSIDE the function so this package still detaches whole: a module
    # scope import would execute on import of a package whose whole promise is that deleting it
    # costs app.py one line. blog_edit is the engine proper and never imports cms, no cycle.
    from .. import blog_edit
    try:
        blog_edit.promote_if_failed(
            slug, topic_slug, gate.blog_status(runner, slug, topic_slug),
            getattr(request.state, "admin_email", None) or "",
            # The trail names WHERE, because a permanent line in the record saying an article
            # went somewhere it did not is not fixable later.
            act=f"published it to {sites.host_of(site)}")
    except blog_edit.EditError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    # THE GATE RUNS FIRST AND FOR FREE, so a blog the site will refuse never costs a model call.
    # assert_publishable raises before any token is spent; only a draft that will actually be
    # published earns its editorial metadata.
    try:
        blog_md = gate.assert_publishable(runner, slug, topic_slug)
    except gate.PublishRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused))

    # The written SEO title and description. {} on every failure path, and {} is ordinary:
    # build_for_publish falls back to the derived H1 title and TL;DR description it has always
    # produced, so a slow, absent or refusing model costs this push its polish and never the
    # push.
    #
    # GENERATED FOR A WEBSITE NOW, WHERE IT ONCE WAS NOT. The old skip was sound while
    # article_from_payload dropped these fields: WordPress SEO fields belong to whichever plugin
    # the site runs, so there was nothing to send them to and generating them bought an operator
    # a two-minute wait for strings nobody used. connect() now resolves that plugin's own meta
    # keys off the site's REST schema, so on a site that has one there is somewhere for these to
    # land and the piece publishes with its own title and description rather than the theme's
    # fallback. On a site with no writable SEO plugin the driver drops them exactly as before.
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

    # One call, and no discovery in it: the post type, the section and the SEO meta keys were
    # all resolved once when the brand was connected and are read straight off the stored
    # destination. What the record already knows about this article there (its id, and when we
    # last pushed) is what makes a second press an UPDATE rather than a duplicate, and what lets
    # the driver refuse to overwrite an edit somebody made on their side afterwards.
    try:
        result = await sites.push(
            site,
            sites.article_from_payload(payload),
            record.remote_article(slug, topic_slug, sites.host_of(site)),
        )
    except sites_http.TransportError as cause:
        log.warning("site push failed for %s/%s (%s): %s",
                    slug, topic_slug, cause.status or "unreachable", cause)
        raise HTTPException(status_code=_status_for(cause.status), detail=str(cause))

    log.info("site push ok for %s/%s: post %s at %s",
             slug, topic_slug, result.get("post_id"), result.get("url"))
    return await _settle(slug, topic_slug, result, request, destination=sites.host_of(site))


async def _settle(slug, topic_slug, result, request, *, destination):
    """Everything after a push the destination accepted: record, stamp, hooks, answer.

    ITS OWN FUNCTION THOUGH THERE IS ONE CALLER, because every line below is about an article
    that is already published and none of it may raise. Keeping it apart from the route is what
    makes that property readable: the route decides and pushes, this records.

    NOTHING HERE MAY RAISE ITS WAY OUT. The article is live by the time this is called, so a
    bookkeeping failure that surfaced as an error would report a landed publish as a failed
    one, and the operator would press again.
    """
    # AFTER the push and never before it. The stamp records something that happened, so
    # writing it first would leave a publish date on an article the destination then refused.
    # It cannot raise (see record.py): the article is already published by this line, and
    # nothing about bookkeeping is allowed to report that as a failed publish.
    record.record_publish(
        slug, topic_slug, result,
        email=getattr(request.state, "admin_email", None),
        destination=destination,
    )

    # PUBLISHING IS A RELEASE, SO IT STAMPS THE SEND. It is the operator's most final act: the
    # article is live on the client's own site by this line. Leaving
    # sent_to_client null after it meant the portal hid an article the client could already read,
    # because blogState drops `published` whenever there is no send.
    #
    # THAT GUARD IS SATISFIED HERE, NOT BYPASSED, and the difference is the whole reason this is
    # safe. It exists because a record with published_at and NO send once put an internal draft in
    # front of a client who was never sent it. Stamping the send makes that state unreachable
    # instead of tolerated: after this line there is no way to be published without a send.
    #
    # Best-effort and AFTER the record, for the same reason record_publish is: the article is
    # live, and no bookkeeping failure may report a successful publish as a failed one. A
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
    # the article is already live, so a hook failure is logged and never surfaced as a
    # failed publish. Hooks only SPAWN work (they return once a run is scheduled), so this does
    # not hold the operator's request open on a generation.
    for hook in list(_after_publish):
        try:
            await hook(slug, topic_slug)
        except Exception:
            log.exception("after-publish hook failed for %s/%s", slug, topic_slug)

    # The destination's shape, flattened to what the drawer actually renders. `skipped` means
    # the article was left alone deliberately and the UI must show it as a success, never as a
    # failed push to retry: somebody edited the article on their site since our last push.
    #
    # `url` is the article's own address as the site reported it, never one built from a slug:
    # permalink structure is a per-site setting, so a derived URL is wrong on a good fraction of
    # sites.
    return {
        "post_id": result.get("post_id"),
        "slug": result.get("slug"),
        "status": result.get("status"),
        "url": result.get("url"),
        "destination": destination,
        "created": bool(result.get("created")),
        "updated": bool(result.get("updated")),
        "skipped": result.get("skipped"),
    }


@router.delete("/api/clients/{slug}/blogs/{topic_slug}/publish")
async def api_unpublish_blog(slug: str, topic_slug: str, request: Request,
                             force: bool = False, hard: bool = False):
    """Take one published article back off the client's own website.

    DELETE ON THE PUBLISH PATH, not a new noun, because it is exactly the inverse of the POST
    above: same resource, same admin gate, same attribution, opposite direction.

    WHAT IT DOES NOT CHECK, AND WHY EACH ONE WOULD BE A BUG.

      assert_publishable's literal-`done`. gate.py grounds that check on an unvetted piece
      reaching a driver being a piece the public can read: it is about what is delivered, and
      this delivers nothing. Applying it here inverts it. The commonest reason to press Unpublish
      is that the WRONG article is live, and a wrong article's status has usually moved since (a
      retry, a regeneration that ended failed). Refusing to retract because the blog is no longer
      `done` would leave the mistake on a client's public site with no door in the app at all.

      assert_client_approved. Publishing "is the final release, and the thing that authorises a
      final release in this app is the client's own approval". A REMOVAL is not a release.
      Demanding approval to take something down means the one publish that should never have
      happened, the unapproved one, is the one that cannot be undone.

      The approval lock. Nothing here inserts into blog_versions or blog_comments, so migration
      013's triggers do not fire. But the permission rests on the RIGHT ground, because
      blog_edit.mark_sent also changes no bytes and IS still locked in Python: the rule this
      codebase follows is not "byte-free acts are allowed", it is NEVER CLEAR A STAMP RECORDING
      A CLIENT'S ACT. This clears published_at and published_by, which are OURS, and leaves
      client_approved_at and sent_to_client_at alone.

      promote_if_failed. Appending an operator-authority `done` verdict for a take-down would
      put a lie on the trail.

      A live-run 409. A run rewrites blog.md; it does not touch the remote post. A refusal with
      no failure behind it is a stall.

    THE ORDER IS REFUSE, ACT, RECORD, and the record RAISES rather than swallowing. See
    record_unpublish: the article is down by then, so a swallowed stamp leaves every surface
    saying it is live on a site it is not on, with a live-link button pointing at a 404.
    """
    if not clients_mod.exists(slug):
        raise HTTPException(status_code=404, detail=f"No client '{slug}'")
    if not runner.slugify(topic_slug) == topic_slug:
        raise HTTPException(status_code=404, detail=f"No blog '{topic_slug}'")

    site = clients_mod.read_site(slug)
    try:
        gate.assert_destination(site, slug)
        gate.assert_site_destination(site, slug, topic_slug)
    except gate.PublishRefused as refused:
        raise HTTPException(status_code=409, detail=str(refused))

    # What the record knows about this article on their site. None means nothing was ever
    # pushed there, which is a 409 and not a 404: the blog exists, it simply is not on a site.
    remote = record.remote_article(slug, topic_slug, sites.host_of(site))
    if remote is None:
        raise HTTPException(
            status_code=409,
            detail=f"'{topic_slug}' has never been posted to {sites.host_of(site)}, so there "
                   f"is nothing to take down.")

    try:
        result = await sites.unpublish(site, remote, force=force, hard=hard)
    except sites_http.TransportError as cause:
        raise HTTPException(status_code=_status_for(cause.status), detail=str(cause))
    except sites.UnknownDestination as cause:
        raise HTTPException(status_code=409, detail=str(cause))

    # EDITED ON THEIR SITE IS A REFUSAL HERE, NOT A SUCCESS, and that is the one place this
    # route deliberately differs from the POST. There, `skipped` means "we correctly left it
    # alone" and the article is where the operator wanted it either way. Here the operator
    # asked for it to come DOWN and it is still UP, so reporting success would be a lie that
    # the live-link button would then contradict. 409 with the date, and ?force=true is the
    # operator answering it having been told.
    if result.get("skipped") == "edited_on_site":
        raise HTTPException(
            status_code=409,
            detail=f"Somebody edited this on {sites.host_of(site)} after we last published it. "
                   f"Taking it down hides their version from readers. Nothing they wrote is "
                   f"deleted. Press again to take it down anyway.")

    record.record_unpublish(
        slug, topic_slug, result,
        email=getattr(request.state, "admin_email", None) or None)

    return {
        "post_id": result.get("post_id"),
        "status": result.get("status"),
        "url": result.get("url"),
        "destination": sites.host_of(site),
        # "gone" (already deleted on their site) and "already_draft" (we had already taken it
        # down) are both SUCCESSES: the operator asked for the article not to be public and it
        # is not. The UI says which, because "it was already down" is worth knowing.
        "skipped": result.get("skipped"),
        "hard": bool(hard),
    }
