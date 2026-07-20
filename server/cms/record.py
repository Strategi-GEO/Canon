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


def record_publish(client_slug, topic_slug, result, email=None):
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
                     cms_status   = %s
               where id = %s""",
            (email,
             _text(result.get("post_id")),
             _text(result.get("slug")),
             _text(result.get("status")),
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
