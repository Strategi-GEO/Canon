"""The only-push-finished-blogs check.

WHY THIS IS A SERVER-SIDE REFUSAL AND NOT A DISABLED BUTTON. A CMS draft is
directly approvable by an editor, and the CMS cannot tell a blog that scored 96
from one that hit the iteration cap at 88 and stopped: both arrive as a draft
someone can click publish on. So an unvetted piece reaching the CMS is a piece
that can reach the client. The button hiding itself is a courtesy to the
operator; THIS is the guard, and it must hold against a stale tab, a replayed
request, and a hand-rolled curl.

The rule is exactly the engine's own: a blog is publishable when its terminal
status in the recorded status feed is the literal string "done". Not "not
failed", not "has a blog", not "scored >= 95 somewhere in its history".
needs_review is the amber path and it is never pushed, which is the whole point.

WHERE THE BYTES COME FROM since the Supabase rewire: the RECORD, always. The
gate reads a committed blog_versions body and the status_events feed, never the
scratch tree, because a publish is an act on a SETTLED blog: the runner commits
scratch at the terminal line, so a topic still mid-run has not committed its new
lines yet and the fold answers with the last settled state, which is exactly the
draft that shipped. WHICH committed version is not always the latest one: an
approved article is anchored to the version the client actually read, for the
reason _record_blog states at length. Tests inject their fixtures through the
runner parameter's fetch seams below, so they never touch the live record.
"""
from .. import db
from . import payload as payload_mod


class PublishRefused(Exception):
    """This blog is not in a state that may reach the CMS.

    Carries `status` so the endpoint can name what it found. An operator told
    "refused" learns nothing; one told "this blog is needs_review" knows to go
    and resolve the review.
    """

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def _record_status_lines(client_slug, topic_slug):
    """The recorded status feed as parsed lines, in line_no order.

    The same dict shape runner._read_status yields off scratch, so the one
    summariser folds record and scratch identically. Record, not scratch: the
    commit at the terminal line is what makes a blog settled enough to publish.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if not tid:
        return []
    rows = db.q(
        """select stage, event, iter, score, status from status_events
           where topic_id = %s order by line_no""",
        (tid,))
    return [
        {"stage": stage, "event": event, "iter": iteration,
         "score": score, "status": status}
        for stage, event, iteration, score, status in rows
    ]


def _record_blog(client_slug, topic_slug):
    """The committed draft body this push must ship, or None when there is none.

    TWO ANCHORS, and which one applies is decided by topics.client_approved_at.

    UNAPPROVED: the LATEST version, and deliberately not the shipped_version_id
    pointer, because the disk-era gate read blog.md, which is always the newest
    draft; the status check is what guarantees that newest draft is the one that
    shipped, and re-anchoring here would let the two disagree. Nothing about
    that path changes, and every blog that has never been near the portal takes
    it.

    APPROVED: topics.sent_version_id, which pins the exact bytes the client read
    and signed off on. Migration 013 locks an approved article for one stated
    reason, that every write after the approval "makes the record assert
    something the client never did: they approved v4, the article is now v6, and
    nothing on the page distinguishes the two". That same migration names
    posting to the CMS as the ONE act the lock leaves open, on the ground that
    it "changes nothing about the article". THAT GROUND ONLY HOLDS WHILE THE
    PUSH SHIPS THE APPROVED BYTES. A push anchored to the latest version would
    carry v6 out through the single door the lock deliberately left unlocked,
    and it would arrive at the CMS under an approval describing v4, which is the
    precise assertion migration 013 exists to make impossible. So the
    latest-version rule is not merely unhelpful here, it is inverted, and the
    send pointer wins.

    A DIVERGENCE IS REFUSED, NOT SILENTLY RESOLVED. If an approved topic's
    sent_version_id is not the latest version, then some path wrote a version
    after the send that the approval does not describe, and this gate has no way
    to know which of the two the operator means. Shipping the sent version
    publishes an article the record no longer holds as current; shipping the
    latest publishes bytes the client never saw. Both are wrong in a way nobody
    downstream would ever notice, because the CMS receives a draft either way and
    an editor cannot tell one from the other. So the refusal names both versions
    and hands the decision to a person, which is the only correct owner of it.
    The same reasoning covers an approved topic with NO sent_version_id: nothing
    then proves which bytes the approval describes, and a guess is exactly what
    must not happen.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if not tid:
        return None
    # ONE round trip for both anchors and the divergence test. The lateral is
    # the same "highest version_no wins" ordering commit_topic and materialize
    # already use, kept identical so the three cannot drift into disagreeing
    # about what "latest" means. The plain left join on sent_version_id carries
    # `sent.topic_id = t.id` as well as the id match: the composite FK from
    # migration 005 already forbids a cross-topic pointer, and restating it here
    # means this query answers with THIS topic's bytes even if that FK is ever
    # dropped.
    row = db.q(
        """select t.client_approved_at, t.sent_version_id,
                  latest.id, latest.version_no, latest.body,
                  sent.version_no, sent.body
             from topics t
             left join lateral (
                    select v.id, v.version_no, v.body
                      from blog_versions v
                     where v.topic_id = t.id
                     order by v.version_no desc limit 1) latest on true
             left join blog_versions sent
                    on sent.id = t.sent_version_id and sent.topic_id = t.id
            where t.id = %s""",
        (tid,), fetch="one")
    if row is None:
        return None
    (approved, sent_id, latest_id, latest_no, latest_body,
     sent_no, sent_body) = row

    if approved is None:
        # The unapproved path, byte for byte what this function has always done.
        # A None here means the record holds no version at all, and
        # assert_publishable turns that into its own refusal.
        return latest_body

    if sent_id is None or sent_body is None:
        # An approval with no version behind it. Migration 005 backfilled
        # sent_version_id from shipped_version_id for every pre-005 send, so a
        # null at this point is not the old-data case: it is an approval whose
        # subject cannot be identified, and there is no safe byte to ship for it.
        raise PublishRefused(
            f"'{topic_slug}' is approved, but the record does not say which "
            f"version the client approved, so there are no confirmed bytes to "
            f"push. Send the article again and have the client re-approve it.",
            status="approved_version_unknown",
        )

    if latest_id is not None and str(sent_id) != str(latest_id):
        raise PublishRefused(
            f"'{topic_slug}' is approved at version {sent_no}, but version "
            f"{latest_no} is the latest in the record, so the approval and the "
            f"article have come apart. Posting either one would misrepresent "
            f"what the client agreed to, so this push is refused until a human "
            f"decides which version is the real article.",
            status="approved_version_mismatch",
        )

    # Approval and record agree. Return the SENT version's bytes rather than the
    # latest row's, even though the two are the same row here: the returned
    # value is then anchored to the approval by construction, not by a
    # comparison that a later edit to this function could quietly drop.
    return sent_body


def _status_lines_for(runner, client_slug, topic_slug):
    """The test seam: a runner carrying fetch_status_lines is a sandbox whose
    fixtures never reached the record, so it answers instead of the database."""
    fetch = getattr(runner, "fetch_status_lines", None)
    if fetch is not None:
        return fetch(client_slug, topic_slug)
    return _record_status_lines(client_slug, topic_slug)


def _blog_text_for(runner, client_slug, topic_slug):
    """The test seam for the draft bytes, same rule as _status_lines_for."""
    fetch = getattr(runner, "fetch_blog", None)
    if fetch is not None:
        return fetch(client_slug, topic_slug)
    return _record_blog(client_slug, topic_slug)


def blog_status(runner, client_slug, topic_slug):
    """The topic's terminal status, via the runner's OWN summariser.

    Deliberately not a second fold over the status feed. _summarize is what the
    blogs list and the status table already report a topic with, so routing this
    check through it means the gate can never disagree with the status the
    operator is looking at when they press the button. A private reimplementation
    here would be a second definition of "done" free to drift from the first.
    """
    lines = _status_lines_for(runner, client_slug, topic_slug)
    if not lines:
        return None
    return runner._summarize(topic_slug, lines).get("status")


def assert_publishable(runner, client_slug, topic_slug):
    """Raise PublishRefused unless this blog shipped. Returns the blog text.

    Reads the draft bytes here rather than leaving it to the caller so that the
    check and the bytes cannot come apart: whatever this returns is what the
    gate approved, and both come from the same record.
    """
    # A demo blog reaches status "done" like any other, because demo mode runs the
    # same terminal-status path. It is templated placeholder text written with zero
    # research and zero API calls, and the marker saying so is prose in the body
    # that a CMS has no way to read. So "done" alone does NOT make it publishable,
    # and the status check below would happily pass it. Refuse the client outright.
    if runner.is_demo_client(client_slug):
        raise PublishRefused(
            f"'{client_slug}' is a demo client. Demo blogs are placeholder text "
            f"generated without research, so they never reach a CMS.",
            status="demo",
        )

    blog_md = _blog_text_for(runner, client_slug, topic_slug)
    if blog_md is None:
        raise PublishRefused(f"No blog on disk for '{topic_slug}'.")

    status = blog_status(runner, client_slug, topic_slug)
    if status is None:
        raise PublishRefused(
            f"'{topic_slug}' has no status feed, so the engine cannot confirm it finished.",
            status=None,
        )
    if status != "done":
        raise PublishRefused(
            f"'{topic_slug}' is {status}, not done. Only a blog the engine shipped "
            f"may reach the CMS, because a draft there is directly approvable.",
            status=status,
        )

    return blog_md


def build_for_publish(runner, ledger, client_slug, topic_slug, client=None):
    """Gate, then transform. The only way this package builds a payload.

    Gate FIRST and unconditionally: building a payload for a needs_review blog and
    then deciding not to send it puts one `if` between an unvetted draft and the
    client, and that `if` is one refactor from being the wrong way round.

    `client` is the client record (industry and display name), read by the caller
    so payload.py stays a pure function of text.
    """
    blog_md = assert_publishable(runner, client_slug, topic_slug)

    # The ledger row carries the operator's own target prompts. Its absence is not
    # fatal: target_queries is optional, and record_success only writes rows for
    # done blogs anyway, so a gate-passing blog nearly always has one.
    row = ledger.ledger_slugs(client_slug).get(topic_slug) or {}
    client = client or {}
    return payload_mod.build_payload(
        client_slug,
        topic_slug,
        blog_md,
        prompts=row.get("prompts"),
        industry=client.get("industry"),
        # The client's DISPLAY name ("BLR Brewing"), never entity_names[0]: that list is the
        # gate's entity vocabulary and holds things like "ALPL 3 LLP", which is a legal
        # entity and has no business becoming a public tag on a client's blog.
        brand_name=client.get("name"),
    )
