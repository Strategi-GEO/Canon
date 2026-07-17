"""The only-push-finished-blogs check.

WHY THIS IS A SERVER-SIDE REFUSAL AND NOT A DISABLED BUTTON. A CMS draft is
directly approvable by an editor, and the CMS cannot tell a blog that scored 96
from one that hit the iteration cap at 88 and stopped: both arrive as a draft
someone can click publish on. So an unvetted piece reaching the CMS is a piece
that can reach the client. The button hiding itself is a courtesy to the
operator; THIS is the guard, and it must hold against a stale tab, a replayed
request, and a hand-rolled curl.

The rule is exactly the engine's own: a blog is publishable when its terminal
status in status.jsonl is the literal string "done". Not "not failed", not
"has a blog.md", not "scored >= 95 somewhere in its history". needs_review is
the amber path and it is never pushed, which is the whole point.
"""
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


def blog_status(runner, client_slug, topic_slug):
    """The topic's terminal status, via the runner's OWN summariser.

    Deliberately not a second reading of status.jsonl. _summarize is what the
    blogs list and the status table already report a topic with, so routing this
    check through it means the gate can never disagree with the status the
    operator is looking at when they press the button. A private reimplementation
    here would be a second definition of "done" free to drift from the first.
    """
    out_dir = runner.output_dir(client_slug, topic_slug)
    lines = runner._read_status(out_dir)
    if not lines:
        return None
    return runner._summarize(topic_slug, lines).get("status")


def assert_publishable(runner, client_slug, topic_slug):
    """Raise PublishRefused unless this blog shipped. Returns the blog text.

    Reads blog.md here rather than leaving it to the caller so that the check and
    the bytes cannot come apart: whatever this returns is what the gate approved.
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

    out_dir = runner.output_dir(client_slug, topic_slug)
    blog_path = out_dir / "blog.md"
    if not blog_path.is_file():
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

    try:
        return blog_path.read_text(encoding="utf-8")
    except OSError as cause:
        raise PublishRefused(f"Cannot read blog.md for '{topic_slug}': {cause}", status=status)


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
