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
gate reads the latest committed blog_versions body and the status_events feed,
never the scratch tree, because a publish is an act on a SETTLED blog: the
runner commits scratch at the terminal line, so a topic still mid-run has not
committed its new lines yet and the fold answers with the last settled state,
which is exactly the draft that shipped. Tests inject their fixtures through
the runner parameter's fetch seams below, so they never touch the live record.
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
    """The latest committed draft body, or None when the record holds no version.

    The LATEST version and deliberately not the shipped_version_id pointer,
    because the disk-era gate read blog.md, which is always the newest draft;
    the status check is what guarantees that newest draft is the one that
    shipped, and re-anchoring here would let the two disagree.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if not tid:
        return None
    return db.q(
        """select body from blog_versions where topic_id = %s
           order by version_no desc limit 1""",
        (tid,), fetch="val")


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

    # THE ARTIFACT IS ASKED WHETHER IT IS FAKE, because nothing else can be trusted to know.
    #
    # is_demo_client above catches only a client whose gates.json sets demo_mode. It does NOT
    # catch GEO_MOCK=1, the global test switch, which fakes EVERY client, real ones included,
    # while still writing the result into that client's REAL output folder and REAL ledger
    # with a terminal status of "done". So a mock blog for Vacation Village reaches this
    # function with is_demo_client False and status "done", and every check above passes it.
    #
    # The environment cannot answer this. GEO_MOCK is read at GENERATION time and a push
    # happens later, in a process that may never have had it set, so runner.geo_mock() here
    # would report on the wrong moment entirely. The file itself is the only witness to how
    # it was made, and every mock and demo artifact carries DEMO_MARKER as its first line.
    #
    # This is the last line of defence and it has to hold: split_title drops everything above
    # the H1, which is exactly where DEMO_MARKER sits, so a mock draft that got past here
    # would arrive in a client's CMS as a clean, approvable article with the one line saying
    # "Not for publication" removed on the way. Refuse on the raw text, before any transform.
    if runner.DEMO_MARKER in blog_md:
        raise PublishRefused(
            f"'{topic_slug}' is mock content: it carries the engine's not-for-publication "
            f"marker, so it was generated with no research and no API calls (demo mode, or a "
            f"run with GEO_MOCK=1). It can never reach a CMS.",
            status="mock",
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
