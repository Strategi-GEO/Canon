"""What the record learns from a push that already happened.

One function, called by routes.py after the CMS has answered 2xx. It exists as its own
module rather than living in gate.py because gate.py answers "may this be pushed", reads
only, and is testable with no write path anywhere in it. A write in that file would make
the gate a thing that changes the world, which is the one property a gate must not have.

WHY THIS NEVER RAISES, AND WHY THAT IS NOT LAZINESS. By the time it runs, the article is
already in the CMS. The push is the act; this stamp is bookkeeping about the act. If the
update fails, the truthful thing to tell the operator is still "published", because the
thing they asked for happened. Raising here would report a failed publish for an article
that published fine, and the operator would push again, which is safe (source_run_id
addresses the same post forever) but teaches them the button is unreliable. So a failure
here is logged loudly and swallowed, and the cost is a missing stamp: the article shows no
publish record even though it went out. That is the same state every article published
before 012 is already in, and the UI is built to read a missing stamp as "no record"
rather than as "not published", so a swallowed failure degrades into a state the app
already handles honestly.
"""
import logging

from .. import db

log = logging.getLogger("geo-factory")


def remote_article(client_slug, topic_slug, destination):
    """What the record knows about this article ON `destination`, or None if nothing.

    THE WHOLE OF RE-POST SAFETY, and it is why the driver needs no idempotency key of its own.
    A client's WordPress has no concept of one, so "have we posted this before" has to be
    answered from here. post_id null means create, post_id set means update that article.

    pushed_at rides along because the driver compares it against the destination's own modified
    stamp: an article edited on their site AFTER our last push must not be silently overwritten.

    `destination` IS REQUIRED AND IT IS A CORRECTNESS ARGUMENT, NOT A FILTER. cms_post_id holds
    ONE id and the column cannot say which system issued it, so an id is only meaningful on the
    destination that issued it. Hand a Strategi CMS post id to a brand that has since connected
    WordPress and the driver does not fail: it PATCHes wp/v2/posts/<that number>, which is very
    likely a real and completely unrelated article on the client's site, and publishing drafts or
    overwrites it. Answering None instead makes a push CREATE, which is the truth (this article
    has never been on this site) and is the only safe answer; and it makes an unpublish refuse
    with the route's own "has never been posted to <host>" sentence.

    A NULL published_to IS A MISMATCH, never a wildcard. Migration 035 added the column, so a null
    is a record written before it, and every push before 035 went to the Strategi CMS. Treating it
    as "matches whatever you ask" would reinstate exactly the confusion above for the oldest rows
    in the record, which are the ones most likely to have moved destination since.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return None
    # coalesce(published_at, unpublished_at) AND THAT ONE WORD IS THE WHOLE CLOBBER GUARD.
    # wordpress._edited_since compares the site's modified stamp against pushed_at and returns
    # False outright when pushed_at is None, so what this column resolves to decides whether the
    # guard is armed. record_unpublish CLEARS published_at (every surface keys "is it live" off
    # it), and our own draft flip bumps the post's modified stamp, so:
    #   keep published_at        -> the next Post press sees a post modified after it and reports
    #                               skipped="edited_on_site", which routes.py treats as a SUCCESS.
    #                               The operator is told the push worked and the article stays down.
    #   clear it, no coalesce    -> pushed_at is None, the guard is OFF for every later push, and
    #                               a client who edits the drafted post gets silently clobbered.
    #   coalesce with unpublished_at -> our flip falls inside the guard's own one-second slack and
    #                               a genuine client edit after it still fires. Correct both ways.
    row = db.q("select cms_post_id, coalesce(published_at, unpublished_at), published_to "
               "from topics where id = %s", (tid,), fetch="one")
    if row is None or not row[0]:
        return None
    if str(row[2] or "") != str(destination or ""):
        return None
    return {"post_id": str(row[0]), "pushed_at": row[1]}


def record_unpublish(client_slug, topic_slug, result, email=None):
    """Stamp one topic as taken back off the client's website. RAISES on failure, unlike
    record_publish, and the difference is the point.

    record_publish swallows: the article is already in the CMS by the time it runs, so a failed
    stamp must not surface as a publish failure. THIS IS THE MIRROR IMAGE AND THE OPPOSITE
    ANSWER. The article is DOWN by the time this runs, and a swallowed failure here leaves
    published_at set over an article nobody can reach: every surface keeps saying it is live on
    the client's site, the operator believes the button did nothing and presses it again, and the
    live-link button offers a URL that 404s. A 500 naming the split is strictly better than a
    record that quietly disagrees with the client's website.

    FIELD BY FIELD, and what is deliberately untouched matters as much as what moves:
      published_at / published_by  CLEARED. published_at is the entire input to the dashboard's
                                   `published` state and to the live-link button, so leaving it
                                   set keeps every surface asserting the article is on a site it
                                   is not on. Cleared as a PAIR: one fact, one date.
      unpublished_at / _by         WRITTEN. The audit half, and the input to the coalesce above.
      cms_status                   RE-STAMPED FROM THE RECEIPT, never a hardcoded "draft". This
                                   column stores the platform's own word verbatim (see
                                   record_publish); a trash lands "trash" and a flip lands
                                   "draft", and hardcoding would lie on exactly the branch where
                                   they differ.
      cms_post_id                  KEPT, and this is mandatory. remote_article returns None the
                                   instant it is falsy and push() then CREATES A DUPLICATE at a
                                   new slug. Cleared ONLY when the post is GONE from their site:
                                   deleted there, or trashed by a hard unpublish, which releases
                                   the slug and leaves the id naming nothing anyone can reach.
                                   Keeping it in either case makes every later push resurrect or
                                   fail against a post that is not there.
      cms_url / cms_slug           KEPT. "A url once known stays known" (record_publish). It is
                                   where the article WAS, which is what a re-publish restores.
      sent_to_client_at, client_approved_at
                                   UNTOUCHED. The client was sent it and approved it. Taking an
                                   article off a website does not un-send or un-approve it, and
                                   clearing a stamp that records a CLIENT's act is the line this
                                   codebase does not cross (see blog_edit.mark_sent).
    """
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        raise ValueError(f"No topic {client_slug}/{topic_slug} to record an unpublish against")

    # A TRASHED post counts as gone for this purpose, and reading the platform's own word is
    # what makes that true rather than a second parameter. WordPress renames post_name to
    # "<slug>__trashed" when it trashes, RELEASING the slug, so the id no longer names an
    # article anyone can reach. Keeping it would send the next push down its update branch to
    # resurrect a trashed post in place, at whatever section and slug it had, instead of
    # creating a clean one. `gone` already means exactly "do not push to this id again".
    result_status = _text((result or {}).get("status"))
    gone = (result or {}).get("skipped") == "gone" or result_status == "trash"
    db.q(
        """update topics
             set published_at   = null,
                 published_by   = null,
                 unpublished_at = now(),
                 unpublished_by = %s,
                 cms_status     = coalesce(%s, cms_status),
                 cms_post_id    = case when %s then null else cms_post_id end
           where id = %s""",
        (email, result_status, gone, tid),
        fetch="none")


def record_publish(client_slug, topic_slug, result, email=None, destination=None):
    """Stamp one topic with the push the CMS just accepted.

    RE-STAMPED ON EVERY PUSH, not first-write-wins, matching blog_edit.mark_sent. A second
    push updates the same CMS post in place, so the interesting fact is when the CMS last
    received these bytes. First-write-wins would freeze the date at an article's first
    push and then quietly lie about every revision sent afterwards.

    `status` is the CMS's own word and is stored verbatim rather than folded into a
    boolean. A push whose result is skipped means a human already advanced that post past
    draft, so the article is live and pushing again will not move it, which is a different
    situation from an ordinary draft and calls for a different action.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        # Unreachable through the route, which resolved this topic to build the payload.
        # Guarded anyway because the alternative is a TypeError inside an except-less path
        # that runs after a successful push.
        log.warning("CMS publish recorded for unknown topic %s/%s", client_slug, topic_slug)
        return

    try:
        db.q(
            """update topics
                 set published_at = now(),
                     published_by = %s,
                     cms_post_id  = %s,
                     cms_slug     = %s,
                     cms_status   = %s,
                     -- coalesce, NOT overwrite: the Strategi CMS answers with no url and a
                     -- website destination does, so a plain assignment would blank a good
                     -- link on any later push that could not supply one. A url once known
                     -- stays known until a push replaces it with a different one.
                     cms_url      = coalesce(%s, cms_url),
                     published_to = coalesce(%s, published_to)
               where id = %s""",
            (email,
             _text(result.get("post_id")),
             _text(result.get("slug")),
             _text(result.get("status")),
             _text(result.get("url")),
             _text(destination),
             tid),
            fetch="none")
    except Exception:
        # See the module docstring: the article is already in the CMS, so this cannot be
        # allowed to surface as a publish failure. exception() keeps the traceback, because
        # a stamp that silently stops being written is exactly the kind of rot that goes
        # unnoticed until someone asks why nothing shows a publish date.
        log.exception("Failed to record CMS publish for %s/%s", client_slug, topic_slug)


def _text(value):
    """The CMS's JSON is not ours to trust the types of: post_id has arrived as both a
    number and a string across CMS versions, and these columns are text. None stays None,
    so a field the CMS omitted reads as unknown rather than as the string 'None'."""
    return None if value is None else str(value)
