"""Operator editing of a SHIPPED blog: manual saves, and selection-scoped Claude fixes.

This is the admin-review stage that sits between "the evaluator passed the draft" and "the
client receives it". It exists OUTSIDE the pipeline: the evaluator's score is final and is
never re-rolled here, gates already ran before that score, and nothing in this module
dispatches Agent R, W, or E. What it does is let an operator change the article they are
about to send, either by typing (save_content) or by selecting a passage and telling Claude
what to change about it (comments + apply), and let the client's own suggestions ride the
same machinery once the blog is sent.

The comment flow mirrors a document review tool: someone selects rendered text, writes an
instruction, and the engine runs ONE short tool-less SDK session that returns a surgical
old/new edit for that passage alone. The edit is applied server-side with an exact,
must-be-unique string replacement, so the session can never rewrite more than it claimed to.
A session that cannot comply says so and the comment fails honestly; nothing is applied.

Comments live in the blog_comments table (the RECORD), not in a local working file. The
phase-1 comments.json is retired because two things now write comments the engine's disk
never sees: the client files suggestions from the hosted portal (portal_suggest_change,
supabase/migrations/005_client_review.sql), and two engines share one record, so a comment
teammate A resolves must read as resolved on teammate B's machine. Rows travel over the
wire in the phase-1 entry shape (author split into author + author_email), built by _wire
below, and the article itself still follows the house rule (disk is the editing surface,
the record follows it): every accepted edit writes blog.md and then sync.commit_topic, so
blog_versions gains a version and the hosted view, portal, and CMS push all see exactly
what the operator approved.

Comments are THREADS, not a flat list. A row with parent_id set is a REPLY: it carries its
text in `instruction`, has no selection, and is never applied, never counted, never
resolved. read_comments nests replies under their parent and every other query in this
module filters `parent_id is null`, because a reply is someone talking about the change
rather than asking for one: count "thanks, looks good" as an open suggestion and it blocks
Send again forever.

Applies are serialised by one lock. Two sessions editing one article race each other's
read-modify-write; two editing different articles could run together, but one operator files
three comments in a burst and correctness beats ten seconds of latency here.
"""
import asyncio
import json
import logging
import os
import uuid

from . import db, runner, sync

log = logging.getLogger("geo-factory")

# The operator's own ceiling: at most this many comments may be open (still applying) at
# once. The limit is enforced at the POST, so the fourth request is refused loudly rather
# than queued silently.
MAX_IN_FLIGHT = 3

# One short session: the article and the instruction are both in the prompt, no tool is
# allowed, so an answer that has not landed in a handful of turns is looping, not working.
MAX_TURNS = 8

# Serialises every apply. See the module docstring for why it is one lock, not per-topic.
APPLY_LOCK = asyncio.Lock()

# Task handles, so an in-flight apply is never garbage collected. Keyed by comment id;
# dropped when the task settles. One uvicorn worker means one process holds this dict.
_APPLY_TASKS = {}

# The same honest error text phase 1 wrote, kept verbatim: the operator's recovery act
# (file the change again, or press Resolve) has not changed.
STRANDED_ERROR = ("the engine restarted while this change was being applied, "
                  "so it never landed; file it again")

# The lost-update refusal, shared by both write paths. APPLY_LOCK serialises this PROCESS
# and nothing more, so the second engine editing one article is unlocked by construction:
# both read the record's body, both run a session, and the later write silently discards
# the earlier operator's change with no trace that it happened. Refusing beats a lost edit,
# because the operator can see the refusal and cannot see the loss.
CONFLICT_ERROR = ("the article changed while this change was being applied; "
                  "try it again")


class EditError(Exception):
    """A comment apply that cannot proceed, with the reason the operator reads."""


# ---------------------------------------------------------------------------
# The approved lock
# ---------------------------------------------------------------------------
# supabase/migrations/013_approved_lock.sql put two BEFORE INSERT triggers on the record: no
# new blog_versions row, and no new TOP-LEVEL blog_comments row, once topics.client_approved_at
# is set. Those triggers are the invariant and they stay the backstop, because five write paths
# in two languages reach those tables and the database is the only thing all five must pass.
#
# What a trigger cannot do is refuse WELL. It fires at the INSERT, which on every engine path
# is the last step of a sequence that has already run a Claude session and already written
# blog.md to disk, and it arrives as a psycopg exception carrying a PORTAL:LOCKED string that
# nothing in server/ knows how to read. The operator asks to edit an approved article and gets
# a 500 with a stack trace, for an act the engine should have declined at the door. The two
# helpers below are that door: one SELECT and one sentence, so each write path can refuse in
# the idiom its own caller already understands rather than inventing a sixth.
#
# THE SENTENCE IS NOT "PERMISSION DENIED", and the difference is not pedantry. The operator
# holds every permission this act needs; the ARTICLE is in a state that forbids it. A
# permission error sends them to ask someone for access that nobody can grant, and they come
# back with the same 500. Naming the approval, its date, and the one act still available sends
# them somewhere that works.


def approved_at(client_slug, topic_slug):
    """When the client approved this article, or None when they have not.

    ONE query behind every approved-lock guard in the engine, rather than five copies of the
    same SELECT drifting apart as the column moves. An unknown client or topic answers None,
    exactly as every other read in this module does: a topic the record has never heard of
    cannot be approved, and the caller's own missing-topic refusal is the honest one for it.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return None
    return db.q("select client_approved_at from topics where id = %s",
                (tid,), fetch="val")


def locked_detail(approved, act):
    """The refusal every locked write path reads back, in one place so they all agree.

    Carries the DATE because the operator's next question is always "approved when", and they
    should not have to open another surface to answer it. Names the CMS push because it is the
    one act an approval leaves open: it changes no bytes, so it cannot make the record assert
    something the client never signed off on. `act` is the caller's own name for what it was
    asked to do, so the sentence describes the refused act rather than a generic write.
    """
    return (f"the client approved this article on {approved:%d %b %Y}, so it is locked and "
            f"{act} is not available on it. Posting it to the CMS is the only act left.")


def _refuse_if_approved(client_slug, topic_slug, act):
    """Raise EditError when this article is approved, in the shape this module's callers
    already handle: _apply lands an EditError on the comment as a failed verdict with its
    reason attached, so a locked article fails the comment honestly instead of stranding it
    on 'applying' behind a database exception nobody mapped."""
    approved = approved_at(client_slug, topic_slug)
    if approved is not None:
        raise EditError(locked_detail(approved, act))


# The columns every comment read selects, in the order _wire unpacks. One string, so a new
# column cannot be added to one query and forgotten in another.
_COMMENT_COLS = """id, created_at, author, author_email, selected_text,
                   context_before, context_after, instruction, state,
                   finished_at, error, edits, applying_since"""

# A reply's columns, and they are fewer on purpose: a reply has no selection, no state the
# UI branches on, and no apply verdict, so serving those keys would invite a surface to
# render a reply as though it were a change request.
_REPLY_COLS = """id, created_at, author, author_email, instruction"""


def _wire(row, replies=()):
    """One TOP-LEVEL blog_comments row as the wire dict every surface reads: the phase-1
    comments.json entry with author split into author ('operator' | 'client') and
    author_email, plus applying_since and its thread. Timestamps flatten to isoformat;
    edits arrives already decoded, because psycopg maps jsonb to Python."""
    (comment_id, created_at, author, author_email, selected_text, context_before,
     context_after, instruction, state, finished_at, error, edits, applying_since) = row
    return {
        "id": str(comment_id),
        "created": created_at.isoformat(),
        "author": author,
        "author_email": author_email,
        "selected_text": selected_text,
        "context_before": context_before,
        "context_after": context_after,
        "instruction": instruction,
        "state": state,
        "finished": finished_at.isoformat() if finished_at else None,
        "error": error,
        "edits": edits,
        "applying_since": applying_since.isoformat() if applying_since else None,
        # Oldest first inside the thread, which is the order a conversation is read in.
        # Always present, even empty: a surface that has to test for the key would print
        # "undefined replies" the first time one arrives.
        "replies": list(replies),
    }


def _wire_reply(row):
    """One reply row as its wire dict. The reply's text lives in `instruction` on the
    record (one table, one insert path) and travels as `body`, because nothing about a
    reply instructs anything: naming it `instruction` on the wire is how a consumer talks
    itself into feeding one to the apply session."""
    reply_id, created_at, author, author_email, instruction = row
    return {
        "id": str(reply_id),
        "created": created_at.isoformat(),
        "author": author,
        "author_email": author_email,
        "body": instruction,
    }


def _replies_for(parent_ids):
    """Every reply to the given parents, keyed by parent id, oldest first. ONE query for a
    whole page of threads: a per-comment fetch would cost twenty round trips on a busy
    article, ten seconds apart, for the rest of the review.

    The ids become uuid.UUID objects before they travel, so psycopg sends a real uuid[]
    and the `= any` compares against the column's own type. A list of plain strings dumps
    as an array of psycopg's unknown, which leaves the element type to inference: it
    happens to resolve here, and it is not something a query on the read path should be
    resting on."""
    ids = [uuid.UUID(str(pid)) for pid in parent_ids]
    if not ids:
        return {}
    rows = db.q(
        f"""select parent_id, {_REPLY_COLS} from blog_comments
            where parent_id = any(%s) order by created_at""",
        (ids,))
    threads = {}
    for row in rows:
        threads.setdefault(str(row[0]), []).append(_wire_reply(row[1:]))
    return threads


def _is_uuid(value):
    """Comment ids arrive from URL segments, so a non-uuid string (a phase-1 hex id, a
    typo, a probe) must read as an unknown comment, never as a database error."""
    try:
        uuid.UUID(str(value))
    except (ValueError, TypeError):
        return False
    return True


def read_comments(client_slug, topic_slug):
    """Every THREAD for one topic, oldest first, DISMISSED AND RESOLVED INCLUDED: the UI
    decides what to hide, and a read that pre-filtered would make a dismissal invisible to
    the very page that audits it. Each entry carries its replies, oldest first; a reply is
    never a top-level entry, because it annotates a change request rather than being one.
    An unknown topic is the empty state, exactly as a missing comments.json was."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return []
    rows = db.q(
        f"""select {_COMMENT_COLS} from blog_comments
            where topic_id = %s and parent_id is null order by created_at""",
        (tid,))
    threads = _replies_for([row[0] for row in rows])
    return [_wire(row, threads.get(str(row[0]), ())) for row in rows]


def get_comment(client_slug, topic_slug, comment_id):
    """One TOP-LEVEL comment as its wire dict, or None when the topic or the comment is
    unknown. A reply's id answers None too, and that is the point: a reply is not
    addressable as a comment anywhere in this module, so the resolve, dismiss and apply
    doors all refuse one by looking it up and finding nothing, rather than each carrying
    its own parent check for someone to forget."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""select {_COMMENT_COLS} from blog_comments
            where id = %s and topic_id = %s and parent_id is null""",
        (comment_id, tid), fetch="one")
    if not row:
        return None
    return _wire(row, _replies_for([row[0]]).get(str(row[0]), ()))


def in_flight_count(client_slug, topic_slug):
    """How many applies are live for one topic, counted on the RECORD: two engines share
    it, so a count over one machine's memory would let each spend the whole cap alone.
    Top-level only, like every count in this module: the row constraint already keeps a
    reply in 'open', and this filter is what keeps that true if the constraint ever moves."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return 0
    return db.q(
        """select count(*) from blog_comments
           where topic_id = %s and parent_id is null and state = 'applying'""",
        (tid,), fetch="val") or 0


def reconcile_stranded():
    """Fail rows stuck in 'applying', AGE-GUARDED. Runs at startup.

    An apply lives in _APPLY_TASKS, and a restart empties that dict, so a comment this
    engine left applying belongs to a task that no longer exists. Left alone it wedges
    the whole edit surface: it counts against the in-flight cap forever, refuses
    dismissal, and keeps the stage's Edit button disabled. The age guard is what the
    shared record adds: a young applying row may be ANOTHER machine's live apply, which
    this engine must not declare dead just because it booted. Fifteen minutes is the
    bound; an apply is one tool-less session capped at MAX_TURNS turns plus a commit,
    and nothing legitimate runs a quarter hour. Failed-with-a-reason is the honest
    state, and the operator resolves or files the change again.

    THE CLOCK IS applying_since, NEVER created_at. A comment filed an hour ago and
    resolved a minute ago is a LIVE apply on some engine, and created_at said it was an
    hour old: every retry of an older comment died at the next boot of any machine, which
    is the exact opposite of what the age guard is for. The coalesce covers a row that
    entered 'applying' before this column existed, because a null comparison is never
    true and such a row would hold the in-flight cap forever."""
    failed = db.q(
        """update blog_comments
             set state = 'failed', finished_at = now(), error = %s
           where state = 'applying'
             and coalesce(applying_since, created_at) < now() - interval '15 minutes'""",
        (STRANDED_ERROR,), fetch="none")
    if failed:
        log.warning("failed %d stranded applying comment(s) older than 15 minutes", failed)


def add_comment(client_slug, topic_slug, *, selected_text, instruction,
                context_before="", context_after="", author="operator",
                author_email=""):
    """File one comment and return its wire dict. Operator comments start in 'applying'
    because the route auto-applies them, exactly as phase 1 did; client comments never
    pass through here (portal_suggest_change inserts them as 'open' with no engine
    behind them). The caller has already refused demo clients, non-done topics, live
    runs, and the in-flight cap."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        raise EditError(f"no topic {topic_slug!r} for client {client_slug!r}")
    # THE APPROVED LOCK, in front of the trigger that would otherwise refuse this INSERT.
    # An operator comment is born 'applying' and the route runs Claude on it immediately, so
    # it is an edit wearing a comment's clothes, which is exactly the reasoning migration 013
    # gives for closing top-level comments alongside versions. Replies are untouched here
    # because reply_comment carries parent_id and the trigger exempts it: replying is the
    # cheapest act in the loop and an approval is no reason to make someone wait on silence.
    _refuse_if_approved(client_slug, topic_slug, "a Claude edit")
    state = "applying" if author == "operator" else "open"
    # applying_since is stamped by the same expression that sets the state, so the two can
    # never disagree: an 'applying' row with no stamp is a row the stranded sweep cannot
    # age, and an 'open' row with one would age a comment nobody is applying.
    # insert..select so client_id rides in from the topic row: a comment whose client_id
    # disagreed with its topic's would be the composite FK's refusal anyway.
    row = db.q(
        f"""insert into blog_comments
              (topic_id, client_id, author, author_email, selected_text,
               context_before, context_after, instruction, state, applying_since)
            select id, client_id, %s, %s, %s, %s, %s, %s, %s,
                   case when %s = 'applying' then now() end
            from topics where id = %s
            returning {_COMMENT_COLS}""",
        (author, author_email, selected_text, context_before, context_after,
         instruction, state, state, tid), fetch="one")
    return _wire(row)


def reply_comment(client_slug, topic_slug, comment_id, *, body,
                  author="operator", author_email=""):
    """Add one reply to an existing top-level comment and return its reply wire dict, or
    None when the parent is unknown, another topic's, or itself a reply (get_comment
    refuses all three by construction).

    Replying is NOT resolving: the parent's state is untouched, nothing is applied, and no
    count moves. An operator answering "we cut that line, it was a duplicate" is telling
    the client something, and turning that sentence into a Claude session or into a
    dismissal would silently decide the request on their behalf. The client's own replies
    arrive through portal_reply_comment, which enforces the same one-level rule at the
    database."""
    tid = db.topic_id(client_slug, topic_slug)
    # get_comment carries the uuid check and the top-level filter, so the id is a real
    # comment on THIS topic by the time it reaches the insert's explicit ::uuid cast.
    if tid is None or get_comment(client_slug, topic_slug, comment_id) is None:
        return None
    row = db.q(
        f"""insert into blog_comments
              (topic_id, client_id, parent_id, author, author_email, selected_text,
               context_before, context_after, instruction, state)
            select id, client_id, %s::uuid, %s, %s, '', '', '', %s, 'open'
            from topics where id = %s
            returning {_REPLY_COLS}""",
        (comment_id, author, author_email, body, tid), fetch="one")
    return _wire_reply(row)


def resolve_comment(client_slug, topic_slug, comment_id):
    """Atomically flip one 'open' or 'failed' comment to 'applying' and return its wire
    dict, or None when the state or the in-flight cap refuses. The WHERE is the whole race
    guard: two admins pressing Resolve together get one flip and one None, never two apply
    sessions. 'failed' is flippable so the same door retries a failed operator apply and a
    failed client resolve alike. finished/error/edits reset with the flip, because they
    describe the attempt this one supersedes.

    THE CAP IS IN THIS STATEMENT, not in a count the route ran first. Read-then-flip spans
    two transactions with an HTTP handler's await inside, and two admins resolving
    different comments in that window each read two-of-three and each started a session, so
    four Claude runs raced one article against a cap of three. Folding the count into the
    WHERE closes the window the app opened. It does not close the database's own: under
    READ COMMITTED both statements can still read the same snapshot, so a simultaneous pair
    can land one over the cap. That residue is bounded at one extra session and is worth
    naming rather than papering over, because a lock big enough to close it would serialise
    every resolve on every topic."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""update blog_comments
              set state = 'applying', applying_since = now(),
                  finished_at = null, error = null, edits = null
            where id = %s and topic_id = %s and parent_id is null
              and state in ('open', 'failed')
              and (select count(*) from blog_comments f
                    where f.topic_id = %s and f.parent_id is null
                      and f.state = 'applying') < %s
            returning {_COMMENT_COLS}""",
        (comment_id, tid, tid, MAX_IN_FLIGHT), fetch="one")
    return _wire(row) if row else None


def dismiss_comment(client_slug, topic_slug, comment_id):
    """Close one comment without an edit, any author's, and return its wire dict. None
    means 'applying' refused the close (or the comment vanished): a live apply's task
    would land its verdict on a row that reads closed, so the caller 409s and dismisses
    after it settles. DISMISSED, NEVER DELETED, since the record went shared: the client
    can see their own suggestion, and a row that silently vanished reads as lost while
    a dismissed one reads as reviewed."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""update blog_comments
              set state = 'dismissed', finished_at = now()
            where id = %s and topic_id = %s and parent_id is null
              and state <> 'applying'
            returning {_COMMENT_COLS}""",
        (comment_id, tid), fetch="one")
    return _wire(row) if row else None


def _finish_comment(comment_id, *, state, error=None, edits=None):
    """Land one apply's verdict ('resolved' | 'failed') on the record, ONLY while the row
    still reads 'applying'. Without that clause a superseded task overwrites whatever
    happened since: the stranded sweep fails a comment, the operator dismisses it, the old
    task finally returns and stamps 'resolved' on a dismissed row with edits nobody
    applied. A verdict is about the attempt that produced it, so it lands only where that
    attempt is still the live one. edits travels as dumped JSON with an explicit cast,
    because psycopg adapts a bare Python list as an array, not as jsonb."""
    db.q(
        """update blog_comments
             set state = %s, finished_at = now(), error = %s, edits = %s::jsonb
           where id = %s and state = 'applying'""",
        (state, error, json.dumps(edits) if edits is not None else None, comment_id),
        fetch="none")


def start_apply(client_slug, topic_slug, comment_id):
    """Apply one comment in the background. The 202 pattern every engine job uses: the
    browser watches the comment record, never the request."""
    task = asyncio.create_task(_apply(client_slug, topic_slug, comment_id))
    _APPLY_TASKS[comment_id] = task
    task.add_done_callback(lambda _t: _APPLY_TASKS.pop(comment_id, None))
    return task


async def _apply(client_slug, topic_slug, comment_id):
    try:
        async with APPLY_LOCK:
            await _apply_locked(client_slug, topic_slug, comment_id)
    except EditError as exc:
        await asyncio.to_thread(
            _finish_comment, comment_id, state="failed", error=str(exc))
    except Exception as exc:  # a bug must never strand the comment on "applying"
        log.exception("comment apply died for %s/%s", client_slug, topic_slug)
        await asyncio.to_thread(
            _finish_comment, comment_id, state="failed",
            error=f"{type(exc).__name__}: {exc}")


async def _apply_locked(client_slug, topic_slug, comment_id):
    comment = await asyncio.to_thread(get_comment, client_slug, topic_slug, comment_id)
    if comment is None:
        return

    # The route refused a live run, but this task waited on the lock: a run that started
    # in the gap would race the writer agent for blog.md, so re-check before touching it.
    _refuse_live_run(client_slug, "applied")

    # The approved lock, re-checked for the same reason and at the same moment. add_comment
    # refused an already-approved article, but this task then queued on APPLY_LOCK behind
    # other applies, and an approval landing in that window makes the edit below one the
    # client never agreed to. Checked before the session rather than only before the commit
    # so a locked article costs no model spend at all.
    await asyncio.to_thread(
        _refuse_if_approved, client_slug, topic_slug, "a Claude edit")

    # Scratch may be reclaimed for a settled topic. Materialize lays blog.md AND
    # status.jsonl down from the record, and status.jsonl is load-bearing: commit_topic
    # re-folds it for the version row's score and shipped flag, so committing without it
    # would record the edited article as unshipped and unscored.
    await asyncio.to_thread(sync.materialize_topic, client_slug, topic_slug)

    blog_path = runner.output_dir(client_slug, topic_slug) / "blog.md"
    # The RECORD's latest bytes, not whatever scratch this machine happens to hold: two
    # engines share one record, and materialize refreshes nothing that already exists, so
    # a teammate's committed edit would otherwise be silently reverted by an apply built
    # on this machine's stale copy. The selection was made against the record (both
    # surfaces serve settled topics from it), so the record is also what its author meant.
    body, base_version = await asyncio.to_thread(_record_body, client_slug, topic_slug)
    if body is None:
        if not blog_path.is_file():
            raise EditError("this topic has no blog.md to edit")
        body = blog_path.read_text(encoding="utf-8")

    edits = await _edit_session(
        body=body,
        selected_text=comment.get("selected_text") or "",
        context_before=comment.get("context_before") or "",
        context_after=comment.get("context_after") or "",
        instruction=comment.get("instruction") or "",
    )

    # The session ran for tens of seconds; a run registered meanwhile owns these files now.
    _refuse_live_run(client_slug, "applied")

    # And the client may have approved the article in that same window, from the portal,
    # while this session was rewriting the very passage they were reading. Checked here
    # rather than left to the trigger because the write below lands on DISK first: the
    # trigger would refuse the commit that follows, the commit-failure arm would restore
    # blog.md, and the operator would read "the record could not be updated" for a refusal
    # that has a name and a date.
    await asyncio.to_thread(
        _refuse_if_approved, client_slug, topic_slug, "a Claude edit")

    # And the OTHER engine may have committed in that same window. The edits below were
    # computed against base_version's bytes, so landing them on a newer article writes a
    # body that never contained the teammate's change: a silent revert of work nobody was
    # told about. Checked immediately before the write, so the window it leaves is the
    # write itself rather than the session.
    await asyncio.to_thread(_refuse_moved_record, client_slug, topic_slug, base_version)

    new_body = apply_edits(body, edits)
    prev_bytes = blog_path.read_bytes() if blog_path.is_file() else None
    blog_path.write_text(new_body, encoding="utf-8")
    try:
        await asyncio.to_thread(sync.commit_topic, client_slug, topic_slug)
    except Exception:
        # Never leave the edit on disk with the record unaware of it: the startup
        # reconciler would commit those bytes later as though the apply had succeeded,
        # while the comment reads failed. Restore, then report the commit failure.
        if prev_bytes is not None:
            blog_path.write_bytes(prev_bytes)
        log.exception("commit failed after comment apply for %s/%s", client_slug, topic_slug)
        raise EditError("the record could not be updated, so nothing was changed; try again")

    await asyncio.to_thread(
        _finish_comment, comment_id, state="resolved", edits=edits)


def _refuse_live_run(client_slug, verb):
    if any(run.get("client") == client_slug and run.get("live")
           for run in runner.list_runs()):
        raise EditError(
            f"a run for {client_slug!r} started before this change was {verb}; "
            f"try again once the run finishes")


def _record_body(client_slug, topic_slug):
    """The latest committed blog body AND the version_no it came from, or (None, None)
    when the record holds no version. The number is what makes the read checkable later:
    bytes alone cannot tell a caller whether the article moved underneath it."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return None, None
    row = db.q(
        """select body, version_no from blog_versions
           where topic_id = %s order by version_no desc limit 1""",
        (tid,), fetch="one")
    return (row[0], row[1]) if row else (None, None)


def _record_version_no(client_slug, topic_slug):
    """The latest committed version_no, or None when the record holds no version."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return None
    return db.q(
        """select version_no from blog_versions
           where topic_id = %s order by version_no desc limit 1""",
        (tid,), fetch="val")


def _refuse_moved_record(client_slug, topic_slug, base_version):
    """Refuse when the record's latest version is no longer the one this write was built
    on. base_version None means the record held nothing when the write began, so a version
    appearing since is a move exactly like any other."""
    if _record_version_no(client_slug, topic_slug) != base_version:
        raise EditError(CONFLICT_ERROR)


def apply_edits(body, edits):
    """Apply old/new replacements in order, each old required EXACTLY ONCE in the text it
    lands on. Zero occurrences means the session paraphrased instead of copying; two or
    more means the replacement could land somewhere the operator never selected. Both are
    refusals, never guesses."""
    updated = body
    for edit in edits:
        old = edit["old"]
        count = updated.count(old)
        if count == 0:
            raise EditError(
                "the edit session quoted text that is not in the article verbatim, "
                "so nothing was changed; try the comment again")
        if count > 1:
            raise EditError(
                "the edit session's quoted text appears more than once in the article, "
                "so the change could not be placed safely; try a more specific selection")
        updated = updated.replace(old, edit["new"], 1)
    if updated == body:
        raise EditError("the edit session returned changes that change nothing")
    return updated


def _prompt(body, selected_text, context_before, context_after, instruction):
    return f"""You are applying ONE operator-requested change to a finished blog article.

The article's full markdown source sits between the ARTICLE markers. The operator selected
a passage in the RENDERED article (markdown syntax stripped) and wrote an instruction for
how that passage should change. Apply the instruction to the selected passage only, and
leave every other part of the article untouched.

<<<ARTICLE
{body}
ARTICLE>>>

The selected passage, as rendered:
<<<SELECTED
{selected_text}
SELECTED>>>

Rendered text just before the selection: {context_before!r}
Rendered text just after the selection: {context_after!r}

The operator's instruction:
<<<INSTRUCTION
{instruction}
INSTRUCTION>>>

Return ONLY a JSON object as your final message. No code fences, no prose before or after:
{{"edits": [{{"old": "<exact substring copied verbatim from the article source>", "new": "<its replacement>"}}]}}

Rules:
- Each "old" must be copied character for character from the article source, including its
  markdown syntax, and must occur exactly once in the source. Extend it with surrounding
  sentences when needed to make it unique.
- Change only what the instruction asks. Do not rewrite beyond the selected passage and do
  not improve anything else.
- Keep the markdown valid: headings, tables, lists, and links stay well formed.
- Never use an em dash or an en dash anywhere; use commas or colons.
- Keep the article's voice: active, definitive, no hedging words such as might, could,
  possibly, perhaps, typically. Never open a sentence with "And" or "But".
- Do not invent factual claims, statistics, sources, or URLs. The instruction may rephrase,
  cut, restructure, or soften what is already there; if it demands a NEW fact or source you
  cannot take from the article itself, return {{"edits": [], "refusal": "<one sentence
  naming what you cannot do>"}} instead of guessing.
"""


async def _edit_session(body, selected_text, context_before, context_after, instruction):
    """One tool-less SDK session. Returns validated [{"old", "new"}, ...] or raises
    EditError with the reason the operator reads."""
    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError as exc:
        raise EditError(f"the Claude Agent SDK is unavailable ({exc})")

    try:
        from claude_agent_sdk import ClaudeSDKError
    except ImportError:
        ClaudeSDKError = ()

    options = ClaudeAgentOptions(
        cwd=str(runner.REPO_ROOT),
        # No setting_sources: this session needs neither the project MCP config nor the
        # engine contract in CLAUDE.md, whose pipeline rules describe agents this is not.
        permission_mode="acceptEdits",
        # The article travels in the prompt and the answer travels back as text, so any
        # tool use is the session wandering. Denied, not merely unlisted: allowed_tools
        # is a skip-the-prompt list and only disallowed_tools actually blocks. READS are
        # denied too, deliberately: the article contains text scraped from the open web,
        # so this prompt is an injection surface, and a session that can Read has a path
        # from a hostile paragraph to server/.env landing inside a published edit.
        disallowed_tools=[
            "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit",
            "Read", "Glob", "Grep", "LS", "NotebookRead", "Task", "TodoWrite",
            "WebFetch", "WebSearch", "mcp__firecrawl", "mcp__dataforseo",
        ],
        max_turns=MAX_TURNS,
        model=os.environ.get("GEO_MODEL") or None,
        env=db.agent_env(),
    )

    prompt = _prompt(body, selected_text, context_before, context_after, instruction)
    text = ""
    try:
        from contextlib import aclosing
        async with aclosing(query(prompt=prompt, options=options)) as session:
            async for message in session:
                found = _final_text(message)
                if found:
                    # Keep the LAST text message: the final turn is the answer.
                    text = found
    except ClaudeSDKError as exc:
        raise EditError(f"the edit session died ({exc})")

    if not text:
        raise EditError("the edit session returned no text")
    return _parse_edits(text)


def _final_text(message):
    """Pull plain text out of one SDK message, tolerating shapes across SDK versions."""
    parts = []
    for block in getattr(message, "content", None) or []:
        text = getattr(block, "text", None)
        if isinstance(text, str) and text.strip():
            parts.append(text.strip())
    return "\n".join(parts).strip()


def _parse_edits(text):
    """The validate-what-came-back step: what a session says and what it returns are two
    different claims, and only one is checkable."""
    raw = text.strip()
    if raw.startswith("```"):
        # Defensive fence strip; the prompt forbids fences.
        raw = raw.split("\n", 1)[-1] if "\n" in raw else raw
        raw = raw.rsplit("```", 1)[0].strip()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        raise EditError("the edit session returned no parseable JSON, so nothing was changed")
    if not isinstance(payload, dict) or not isinstance(payload.get("edits"), list):
        raise EditError("the edit session returned the wrong shape, so nothing was changed")

    edits = payload["edits"]
    if not edits:
        refusal = payload.get("refusal")
        raise EditError(
            str(refusal).strip() if isinstance(refusal, str) and refusal.strip()
            else "the edit session declined the change without a reason")

    cleaned = []
    for edit in edits:
        old = edit.get("old") if isinstance(edit, dict) else None
        new = edit.get("new") if isinstance(edit, dict) else None
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise EditError("the edit session returned a malformed edit, so nothing was changed")
        cleaned.append({"old": old, "new": new})
    return cleaned


# ---------------------------------------------------------------------------
# Manual save, and the send-to-client stamp
# ---------------------------------------------------------------------------

def save_content(client_slug, topic_slug, body):
    """Write the operator's own bytes and commit them. SYNC: call via to_thread, and only
    under APPLY_LOCK (the route holds it), so a save can never interleave with a comment
    apply's read-session-write and be silently overwritten by the apply's stale base.

    Materialize first, for the same status.jsonl reason _apply_locked names; the
    operator's body then overwrites whatever blog.md was laid down. Returns the committed
    word count, measured the way commit_topic measures it."""
    # THE APPROVED LOCK, FIRST, before a byte of scratch is touched. The route refuses this
    # too and carries the operator's 409; this line is what holds for anything reaching
    # save_content directly, and it belongs at the top because every step below writes: the
    # materialize lays files down, the write replaces blog.md, and only commit_topic reaches
    # the trigger. Left to the trigger alone the operator's bytes sit on disk through a failed
    # commit and a restore, for an act that was never going to land.
    _refuse_if_approved(client_slug, topic_slug, "editing")
    base_version = _record_version_no(client_slug, topic_slug)
    sync.materialize_topic(client_slug, topic_slug)
    tdir = runner.output_dir(client_slug, topic_slug)
    tdir.mkdir(parents=True, exist_ok=True)
    blog_path = tdir / "blog.md"
    prev_bytes = blog_path.read_bytes() if blog_path.is_file() else None
    # The apply path's guard, for the same reason: APPLY_LOCK holds this process only, so
    # a teammate's engine can commit between the materialize above and the write below,
    # and these bytes would bury it. What this cannot see is an editor opened BEFORE that
    # commit, because the browser sends no version to compare; closing that needs a version
    # on the wire, and this closes the half the engine can prove.
    _refuse_moved_record(client_slug, topic_slug, base_version)
    blog_path.write_text(body, encoding="utf-8")
    try:
        sync.commit_topic(client_slug, topic_slug)
    except Exception:
        # Same rule as the apply path: an edit the record refused must not sit on disk
        # waiting for the startup reconciler to launder it into a committed version.
        if prev_bytes is not None:
            blog_path.write_bytes(prev_bytes)
        raise
    return len(body.split())


def sent_state(client_slug, topic_slug):
    """The delivery state for one topic: the send stamp, the client's approval, and how
    many client suggestions are still open. changes_requested counts 'applying' with
    'open', because a suggestion mid-apply is not yet resolved and Send again while one
    is in flight would release bytes the apply is about to change. TOP-LEVEL rows only: a
    client's reply asks for nothing, and counting one would leave "thanks, looks good"
    blocking the re-send it was thanking the team for."""
    empty = {"sent_to_client": None, "sent_to_client_by": None,
             "client_approved": None, "client_approved_by": None,
             "changes_requested": 0, "change_round_open": False,
             "published": None, "published_by": None, "cms_status": None}
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return empty
    row = db.q(
        """select t.sent_to_client_at, t.sent_to_client_by,
                  t.client_approved_at, t.client_approved_by,
                  (select count(*) from blog_comments c
                    where c.topic_id = t.id and c.author = 'client'
                      and c.parent_id is null
                      and c.state in ('open', 'applying')),
                  -- THE ROUND, a different question from the count above it: has the client
                  -- asked for anything SINCE we last sent this. State, not queue. It ignores
                  -- comment state, so resolving, dismissing and a failed apply all leave it
                  -- standing, and only mark_sent moving sent_to_client_at forward closes it.
                  exists (select 1 from blog_comments c
                           where c.topic_id = t.id and c.author = 'client'
                             and c.parent_id is null
                             and t.sent_to_client_at is not null
                             and c.created_at > t.sent_to_client_at),
                  t.published_at, t.published_by, t.cms_status
           from topics t where t.id = %s""",
        (tid,), fetch="one")
    if row is None:
        return empty
    (sent_at, sent_by, approved_at, approved_by, changes, round_open,
     published_at, published_by, cms_status) = row
    return {
        "sent_to_client": sent_at.isoformat() if sent_at else None,
        "sent_to_client_by": sent_by,
        "client_approved": approved_at.isoformat() if approved_at else None,
        "client_approved_by": approved_by,
        "changes_requested": int(changes or 0),
        "change_round_open": bool(round_open),
        # NULL here means "no record of a push", NEVER "not published": nothing recorded a
        # publish before 012, and a failed stamp after a successful push leaves the same
        # null (see cms/record.py). Every consumer renders the positive fact only.
        "published": published_at.isoformat() if published_at else None,
        "published_by": published_by,
        "cms_status": cms_status,
    }


def mark_sent(client_slug, topic_slug, email):
    """Release one shipped blog to the client portal, first send and every re-send.

    Phase 1's first-send-wins idempotency is GONE, deliberately: after a review round,
    Send again is a new release of changed bytes, so every call re-stamps the date and
    the sender. sent_version_id pins WHICH version this send released (the portal
    renders it, and a client suggestion anchors to it), and the client's approval is
    CLEARED with the stamp, because an approval describes the exact bytes the client
    read and must not survive a re-send of different ones as though they approved those
    too.

    RETURNS None WHEN THE SEND IS REFUSED, which is the one refusal this act has: an open
    or applying client suggestion means the client is still waiting to see something
    change, and re-sending over it releases an article that does not answer them yet. The
    refusal lives in this statement's WHERE rather than in a count the route ran first,
    because check-then-act across two transactions is exactly wide enough for a suggestion
    filed from the portal to land in between: the route reads zero, the client files one,
    the send goes out over it, and the suggestion now sits open against bytes the client
    has already been sent. Zero rows updated IS the refusal, and the route turns it into a
    409. Replies are excluded from the count for the reason sent_state excludes them."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return sent_state(client_slug, topic_slug)

    # THE APPROVED LOCK, AND THIS IS THE ONE PATH NO TRIGGER COVERS. Sending inserts nothing:
    # it UPDATEs topics, so neither trigger in migration 013 ever fires on it. Migration 013
    # closed the hosted build's equivalent inside admin_done_topic and named this act the most
    # damaging of the three, because the UPDATE below CLEARS client_approved_at as it re-stamps.
    # A re-send would erase the very record the whole lock protects, and then every other guard
    # in this file would read the article as unapproved and let it be rewritten freely. So this
    # check is not belt and braces here: it is the lock itself for this act.
    #
    # None IS the refusal, the same protocol the open-suggestion refusal already answers with,
    # so api_send_blog_to_client turns it into a 409 with no new error type to teach it. The
    # route runs its own approved check first and carries the sentence with the date; a caller
    # reaching mark_sent directly reads the refusal from the None and this comment.
    if approved_at(client_slug, topic_slug) is not None:
        return None

    sent = db.q(
        """update topics
             set sent_to_client_at = now(),
                 sent_to_client_by = %s,
                 sent_version_id = (
                   select v.id from blog_versions v
                   where v.topic_id = topics.id
                   order by v.version_no desc limit 1),
                 client_approved_at = null,
                 client_approved_by = null
           where id = %s
             -- THE APPROVED REFUSAL BELONGS IN THIS WHERE, not only in the read above it.
             -- The read is check-then-act across two statements, and this UPDATE is precisely
             -- the thing that NULLS client_approved_at: an approval landing in the window
             -- between them is destroyed by the statement guarding against it, leaving no
             -- record that it ever existed. Migration 013's triggers cannot cover this,
             -- because they are BEFORE INSERT and this is an UPDATE on topics.
             --
             -- Zero rows updated is already this function's refusal protocol, so the caller
             -- needs no new error to understand it. The read stays: it is what lets the route
             -- answer with the date and a sentence instead of a bare 409.
             and client_approved_at is null
             and not exists (
               select 1 from blog_comments c
               where c.topic_id = topics.id and c.author = 'client'
                 and c.parent_id is null
                 and c.state in ('open', 'applying'))""",
        (email or None, tid), fetch="none")
    if not sent:
        return None
    return sent_state(client_slug, topic_slug)
