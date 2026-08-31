"""Channel posts: a shipped blog repurposed into ONE channel-native piece (a LinkedIn post, a
Medium article, a Bluesky post, an X post), on their OWN track.

This is the SEPARATE-TRACK cousin of the blog review loop. It deliberately does not touch
topics / blog_versions / blog_comments, so a channel post can never leak into a blog surface
(the Blogs list, the brand blog_count, the ledger, the roadmap red-flags). Its record is
channel_posts + channel_post_comments (migration 031), and its lifecycle mirrors a blog's
delivery ladder minus everything a repurpose lacks: no score, no eval, no evaluator questions,
no ledger, no versions.

  generate -> created -> sent to client -> client requests changes / approves -> posted

What it DOES reuse, because these are content-agnostic and not blog-data plumbing:
  * blog_edit._edit_session / apply_edits / EditError  -- the tool-less Claude markdown editor
    that turns one selection + instruction into a surgical old/new edit. A channel post's
    resolve-with-Claude is the identical act on a different artifact.

The post body is edited IN PLACE (no versions): a channel post has no re-generation loop that
would reflow text out from under a client's comment, so a suggestion anchors to the live body.
The disk artifact under outputs/<client>/<topic>/repurpose/<channel>/post.md stays the raw
generation output and a fallback; once committed, channel_posts.body is the source of truth.
"""
import asyncio
import json
import logging
import os
import shutil
import uuid

from . import blog_edit, db, repurpose, runner

log = logging.getLogger("geo-factory")

CHANNELS = repurpose.CHANNELS  # linkedin, medium, bluesky, x

# Same shape as blog_edit: at most this many operator applies open at once, per post; one lock
# serialises every apply in this process so two sessions never race one post's read-edit-write.
MAX_IN_FLIGHT = 3
APPLY_LOCK = asyncio.Lock()
_APPLY_TASKS = {}

# Verbatim from blog_edit: the operator's recovery act is the same (file it again, or Resolve).
STRANDED_ERROR = blog_edit.STRANDED_ERROR
CONFLICT_ERROR = blog_edit.CONFLICT_ERROR
EditError = blog_edit.EditError


def _channel_ok(channel):
    return channel in CHANNELS


# ---------------------------------------------------------------------------
# The record
# ---------------------------------------------------------------------------

def post_id(client_slug, source_topic_slug, channel):
    """The channel_posts.id for one (blog, channel), or None when no post exists yet."""
    tid = db.topic_id(client_slug, source_topic_slug)
    if tid is None or not _channel_ok(channel):
        return None
    return db.q(
        "select id from channel_posts where source_topic_id = %s and channel = %s",
        (tid, channel), fetch="val")


_POST_COLS = """cp.id, t.slug, t.title, cp.channel, cp.body, cp.created_at, cp.updated_at,
                cp.sent_to_client_at, cp.sent_to_client_by, cp.client_approved_at,
                cp.client_approved_by, cp.posted_at, cp.posted_by"""


def _state(sent_at, approved_at, posted_at, change_round_open):
    """The delivery state, newest human act first, exactly like blogState's ladder. `generating`
    (a live run) and a technical `failed` are overlaid by the caller from the run feed, never
    stored here, so they are not in this fold."""
    if posted_at:
        return "posted"
    if approved_at:
        return "approved"
    if sent_at:
        return "changes_requested" if change_round_open else "sent"
    return "created"


def _wire_post(row, *, comments_pending, change_round_open, include_body):
    (post_id_, source_slug, source_title, channel, body, created_at, updated_at,
     sent_at, sent_by, approved_at, approved_by, posted_at, posted_by) = row
    out = {
        "id": str(post_id_),
        "source_topic_slug": source_slug,
        "source_topic": source_title or source_slug,
        "channel": channel,
        "state": _state(sent_at, approved_at, posted_at, change_round_open),
        "created_at": created_at.isoformat(),
        "updated_at": updated_at.isoformat(),
        "sent_to_client": sent_at.isoformat() if sent_at else None,
        "sent_to_client_by": sent_by,
        "client_approved": approved_at.isoformat() if approved_at else None,
        "client_approved_by": approved_by,
        "posted_at": posted_at.isoformat() if posted_at else None,
        "posted_by": posted_by,
        "comments_pending": comments_pending,
        "change_round_open": change_round_open,
    }
    if include_body:
        out["content"] = body
    return out


def _round_open(sent_at, tid_post_id):
    """Whether the client has filed a suggestion SINCE the last send: the round, not the queue,
    mirroring blog_edit.sent_state. False before any send."""
    if sent_at is None:
        return False
    return bool(db.q(
        """select exists (select 1 from channel_post_comments c
                           where c.channel_post_id = %s and c.author = 'client'
                             and c.created_at > %s)""",
        (tid_post_id, sent_at), fetch="val"))


def _pending(post_id_):
    """Open + applying client suggestions on one post: what the send gate reads and what the
    Changes-requested count shows. Client-authored only, like blog_edit.sent_state."""
    return db.q(
        """select count(*) from channel_post_comments
           where channel_post_id = %s and author = 'client'
             and state in ('open', 'applying')""",
        (post_id_,), fetch="val") or 0


def get_post(client_slug, source_topic_slug, channel):
    """One channel post as its wire dict (body included), or None when it was never generated."""
    tid = db.topic_id(client_slug, source_topic_slug)
    if tid is None or not _channel_ok(channel):
        return None
    row = db.q(
        f"""select {_POST_COLS} from channel_posts cp
             join topics t on t.id = cp.source_topic_id
            where cp.source_topic_id = %s and cp.channel = %s""",
        (tid, channel), fetch="one")
    if not row:
        return None
    pid, sent_at = row[0], row[7]
    return _wire_post(row, comments_pending=_pending(pid),
                      change_round_open=_round_open(sent_at, pid), include_body=True)


def list_posts(client_slug, channel):
    """Every channel post for a brand, newest first: the Created-tab table. No body (the table
    shows title + state + date), so it is one query plus the two per-row folds."""
    cid = db.client_id(client_slug)
    if cid is None or not _channel_ok(channel):
        return []
    rows = db.q(
        f"""select {_POST_COLS} from channel_posts cp
             join topics t on t.id = cp.source_topic_id
            where cp.client_id = %s and cp.channel = %s and t.deleted_at is null
            order by cp.updated_at desc""",
        (cid, channel))
    out = []
    for row in rows:
        pid, sent_at = row[0], row[7]
        out.append(_wire_post(row, comments_pending=_pending(pid),
                              change_round_open=_round_open(sent_at, pid),
                              include_body=False))
    return out


def channel_states(client_slug, channel):
    """{source_topic_slug: state} for every blog that has a <channel> post, so the New tab can
    tag each blog Created / Posted and refuse to reselect it. One query, two folds per row."""
    return {p["source_topic_slug"]: p["state"] for p in list_posts(client_slug, channel)}


def bodies(client_slug, channel, source_topic_slugs):
    """[(title, body)] for the named posts, in the order the caller asked for, skipping any that
    do not exist or carry no text. Feeds docx_export.build_docx for the Created tab's bulk
    download, which is the one reader that wants many bodies and none of the delivery state.

    ONE QUERY over the whole selection rather than get_post per slug: get_post runs two extra
    folds per row (pending comments, change round) for facts a document does not carry, and a
    download of a dozen posts would run three dozen queries to throw all of it away."""
    cid = db.client_id(client_slug)
    slugs = [s for s in source_topic_slugs if s]
    if cid is None or not _channel_ok(channel) or not slugs:
        return []
    rows = db.q(
        """select t.slug, coalesce(nullif(btrim(t.title), ''), t.slug), cp.body
             from channel_posts cp
             join topics t on t.id = cp.source_topic_id
            where cp.client_id = %s and cp.channel = %s and t.deleted_at is null
              and t.slug = any(%s)""",
        (cid, channel, slugs))
    found = {slug: (title, body) for slug, title, body in rows if body and body.strip()}
    return [found[slug] for slug in slugs if slug in found]


def delete_post(client_slug, source_topic_slug, channel):
    """Remove one channel post: the record and the generation's scratch dir, nothing else.

    THE SOURCE BLOG IS UNTOUCHED, which is the whole shape of this act. A channel post is a
    repurpose ON ITS OWN TRACK (see the module docstring), so deleting one puts its blog back in
    the New tab with the Generate box tickable again, and the blog itself keeps its draft, its
    score, its ledger row and its own delivery state. Deleting the row cascades to
    channel_post_comments on the FK, so no client suggestion outlives the post it was filed on.

    The scratch dir goes for the reason api_delete_blog's does: post.md would otherwise sit ahead
    of an absent record, and repurpose.listing reads that file directly, so the legacy artifact
    route would keep reporting a post the Created tab no longer has.

    Idempotent, and returns whether anything was there: an unknown blog, an unknown channel or an
    already-deleted post is False and never an error."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is not None:
        db.q("delete from channel_posts where id = %s", (pid,), fetch="none")
    art_dir = repurpose.repurpose_dir(client_slug, source_topic_slug, channel)
    if art_dir.is_dir():
        shutil.rmtree(art_dir, ignore_errors=True)
    return pid is not None


def commit_post(client_slug, source_topic_slug, channel, body):
    """Upsert the generated body into the record: insert on first generation, replace the body in
    place on a regenerate. Delivery stamps are left untouched, so a regenerate updates the text
    without moving the piece back down the ladder. Returns the wire dict, or None for an unknown
    source blog. Called after a repurpose run lands a post.md.

    THE UPDATE REFUSES AN APPROVED OR POSTED ROW at the database, so no regenerate can ever
    replace bytes the client accepted (mark_posted gates only on client_approved_at, so an
    overwrite there would ship un-approved text). api_repurpose refuses this case up front with a
    clear 409; this WHERE closes the one race that guard structurally cannot, a run that started
    while the post was still sent and commits after the client approves mid-run. When it skips,
    the approved bytes stay and get_post returns them unchanged."""
    tid = db.topic_id(client_slug, source_topic_slug)
    if tid is None or not _channel_ok(channel):
        return None
    cid = db.client_id(client_slug)
    db.q(
        """insert into channel_posts (client_id, source_topic_id, channel, body)
           values (%s, %s, %s, %s)
           on conflict (source_topic_id, channel) do update
             set body = excluded.body, updated_at = now()
             where channel_posts.client_approved_at is null
               and channel_posts.posted_at is null""",
        (cid, tid, channel, body), fetch="none")
    return get_post(client_slug, source_topic_slug, channel)


# ---------------------------------------------------------------------------
# The approved lock: no new comment or Claude edit once the client has approved.
# A channel post has no re-generation, so this is the whole lock (no version trigger needed).
# ---------------------------------------------------------------------------

def _approved_at(post_id_):
    return db.q("select client_approved_at from channel_posts where id = %s",
                (post_id_,), fetch="val")


def _refuse_if_approved(post_id_, act):
    approved = _approved_at(post_id_)
    if approved is not None:
        raise EditError(
            f"the client approved this post on {approved:%d %b %Y}, so it is locked and "
            f"{act} is not available on it. Marking it posted is the only act left.")


# ---------------------------------------------------------------------------
# Comments: the same state machine as blog_comments, its own table.
# ---------------------------------------------------------------------------

_COMMENT_COLS = """id, created_at, author, author_email, selected_text,
                   context_before, context_after, instruction, state,
                   finished_at, error, edits, applying_since"""


def _wire_comment(row):
    (cid, created_at, author, author_email, selected_text, context_before,
     context_after, instruction, state, finished_at, error, edits, applying_since) = row
    return {
        "id": str(cid),
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
        # Channel posts carry no replies and no add-to-instructions: those are blog-review
        # affordances. Present and empty so a surface that reads the key renders nothing.
        "replies": [],
        "added_to_instructions": None,
    }


def _is_uuid(value):
    try:
        uuid.UUID(str(value))
    except (ValueError, TypeError):
        return False
    return True


def read_comments(client_slug, source_topic_slug, channel):
    """Every comment for one post, oldest first, dismissed and resolved included: the UI decides
    what to hide. Empty for a post that was never generated."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        return []
    rows = db.q(
        f"""select {_COMMENT_COLS} from channel_post_comments
            where channel_post_id = %s order by created_at""",
        (pid,))
    return [_wire_comment(row) for row in rows]


def get_comment(client_slug, source_topic_slug, channel, comment_id):
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""select {_COMMENT_COLS} from channel_post_comments
            where id = %s and channel_post_id = %s""",
        (comment_id, pid), fetch="one")
    return _wire_comment(row) if row else None


def in_flight_count(client_slug, source_topic_slug, channel):
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        return 0
    return db.q(
        """select count(*) from channel_post_comments
           where channel_post_id = %s and state = 'applying'""",
        (pid,), fetch="val") or 0


def add_comment(client_slug, source_topic_slug, channel, *, selected_text, instruction,
                context_before="", context_after="", author="operator", author_email="",
                auto_apply=True):
    """File one comment and return its wire dict. Operator comments start 'applying' (the route
    auto-applies them); a client suggestion (Phase 3) comes in 'open'. The caller has already
    refused the in-flight cap and unknown posts."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        raise EditError(f"no {channel} post for {source_topic_slug!r}")
    _refuse_if_approved(pid, "a Claude edit")
    state = "applying" if (auto_apply and author == "operator") else "open"
    cid = db.client_id(client_slug)
    row = db.q(
        f"""insert into channel_post_comments
              (channel_post_id, client_id, author, author_email, selected_text,
               context_before, context_after, instruction, state, applying_since)
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s,
                    case when %s = 'applying' then now() end)
            returning {_COMMENT_COLS}""",
        (pid, cid, author, author_email, selected_text, context_before, context_after,
         instruction, state, state), fetch="one")
    return _wire_comment(row)


def resolve_comment(client_slug, source_topic_slug, channel, comment_id):
    """Flip one 'open' or 'failed' comment to 'applying' atomically, cap enforced in the WHERE
    (see blog_edit.resolve_comment for the race reasoning). None when the state or the cap
    refuses, or the comment is unknown."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""update channel_post_comments
              set state = 'applying', applying_since = now(),
                  finished_at = null, error = null, edits = null
            where id = %s and channel_post_id = %s
              and state in ('open', 'failed')
              and (select count(*) from channel_post_comments f
                    where f.channel_post_id = %s and f.state = 'applying') < %s
            returning {_COMMENT_COLS}""",
        (comment_id, pid, pid, MAX_IN_FLIGHT), fetch="one")
    return _wire_comment(row) if row else None


def dismiss_comment(client_slug, source_topic_slug, channel, comment_id):
    """Close one comment without an edit. None when 'applying' refused the close or it vanished:
    a live apply would land its verdict on a closed row, so the route 409s and retries after."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""update channel_post_comments
              set state = 'dismissed', finished_at = now()
            where id = %s and channel_post_id = %s and state <> 'applying'
            returning {_COMMENT_COLS}""",
        (comment_id, pid), fetch="one")
    return _wire_comment(row) if row else None


def _finish_comment(comment_id, *, state, error=None, edits=None):
    """Land one apply's verdict, only while the row still reads 'applying' (a superseded task
    must not overwrite a later dismissal), exactly like blog_edit._finish_comment."""
    db.q(
        """update channel_post_comments
             set state = %s, finished_at = now(), error = %s, edits = %s::jsonb
           where id = %s and state = 'applying'""",
        (state, error, json.dumps(edits) if edits is not None else None, comment_id),
        fetch="none")


def reconcile_stranded():
    """Fail comments stuck 'applying' past 15 minutes, age-guarded on applying_since. Runs at
    startup, mirroring blog_edit.reconcile_stranded: a restart empties _APPLY_TASKS, so a comment
    this engine left applying belongs to a task that no longer exists."""
    failed = db.q(
        """update channel_post_comments
             set state = 'failed', finished_at = now(), error = %s
           where state = 'applying'
             and coalesce(applying_since, created_at) < now() - interval '15 minutes'""",
        (STRANDED_ERROR,), fetch="none")
    if failed:
        log.warning("failed %d stranded channel comment(s) older than 15 minutes", failed)


def start_apply(client_slug, source_topic_slug, channel, comment_id):
    """Apply one comment in the background. The 202 pattern: the browser watches the record."""
    task = asyncio.create_task(_apply(client_slug, source_topic_slug, channel, comment_id))
    _APPLY_TASKS[comment_id] = task
    task.add_done_callback(lambda _t: _APPLY_TASKS.pop(comment_id, None))
    return task


async def _apply(client_slug, source_topic_slug, channel, comment_id):
    try:
        async with APPLY_LOCK:
            await _apply_locked(client_slug, source_topic_slug, channel, comment_id)
    except EditError as exc:
        await asyncio.to_thread(_finish_comment, comment_id, state="failed", error=str(exc))
    except Exception as exc:
        log.exception("channel comment apply died for %s/%s/%s",
                      client_slug, source_topic_slug, channel)
        await asyncio.to_thread(_finish_comment, comment_id, state="failed",
                                error=f"{type(exc).__name__}: {exc}")


async def _apply_locked(client_slug, source_topic_slug, channel, comment_id):
    comment = await asyncio.to_thread(
        get_comment, client_slug, source_topic_slug, channel, comment_id)
    if comment is None:
        return
    pid = await asyncio.to_thread(post_id, client_slug, source_topic_slug, channel)
    if pid is None:
        return

    # The approved lock, re-checked here: this task queued on APPLY_LOCK behind others, and an
    # approval landing in that window makes the edit one the client never agreed to. Checked
    # before the session so a locked post costs no model spend.
    await asyncio.to_thread(_refuse_if_approved, pid, "a Claude edit")

    body = await asyncio.to_thread(_body_of, pid)
    if body is None or not body.strip():
        raise EditError("this post has no body to edit")

    edits = await blog_edit._edit_session(
        body=body,
        selected_text=comment.get("selected_text") or "",
        context_before=comment.get("context_before") or "",
        context_after=comment.get("context_after") or "",
        instruction=comment.get("instruction") or "",
    )

    # The session ran for tens of seconds; re-check the approval before the write, then guard the
    # lost update: the body may have changed under another apply. blog_edit's version-number
    # guard has no analogue here (no versions), so the check is the bytes themselves.
    await asyncio.to_thread(_refuse_if_approved, pid, "a Claude edit")
    new_body = blog_edit.apply_edits(body, edits)
    updated = await asyncio.to_thread(_write_body_if_unchanged, pid, body, new_body)
    if not updated:
        raise EditError(CONFLICT_ERROR)

    await asyncio.to_thread(_finish_comment, comment_id, state="resolved", edits=edits)


def _body_of(post_id_):
    return db.q("select body from channel_posts where id = %s", (post_id_,), fetch="val")


def _write_body_if_unchanged(post_id_, expected_body, new_body):
    """Write new_body only if the record still holds expected_body: the lost-update guard, since
    a channel post has no version number to compare. Also refreshes the disk post.md so the raw
    artifact stays coherent. Returns True when it wrote."""
    wrote = db.q(
        """update channel_posts set body = %s, updated_at = now()
           where id = %s and body = %s""",
        (new_body, post_id_, expected_body), fetch="none")
    if not wrote:
        return False
    _sync_disk(post_id_, new_body)
    return True


def _sync_disk(post_id_, body):
    """Best-effort: keep the disk post.md in step with the record. Not load-bearing (the record
    is the source of truth), so a missing directory is ignored."""
    row = db.q(
        """select c.slug, t.slug, cp.channel from channel_posts cp
             join topics t on t.id = cp.source_topic_id
             join clients c on c.id = cp.client_id
            where cp.id = %s""", (post_id_,), fetch="one")
    if not row:
        return
    client_slug, source_slug, channel = row
    try:
        out = repurpose.repurpose_dir(client_slug, source_slug, channel)
        if out.is_dir():
            (out / "post.md").write_text(body, encoding="utf-8")
    except OSError:
        pass


def save_content(client_slug, source_topic_slug, channel, body):
    """The operator's own bytes, written straight to the record. Refused on an approved post.
    Returns the committed word count."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        raise EditError(f"no {channel} post for {source_topic_slug!r}")
    _refuse_if_approved(pid, "editing")
    db.q("update channel_posts set body = %s, updated_at = now() where id = %s",
         (body, pid), fetch="none")
    _sync_disk(pid, body)
    return len(body.split())


# ---------------------------------------------------------------------------
# The delivery acts: send, and mark posted.
# ---------------------------------------------------------------------------

def mark_sent(client_slug, source_topic_slug, channel, email):
    """Release one post to the client as Ready to post, first send and every re-send. Re-stamps
    the date and CLEARS any approval (an approval describes the exact bytes the client read).
    Returns None when refused: an open or applying client suggestion, or an already-approved post
    (a re-send would erase the approval). The refusal lives in the WHERE for the race reason
    blog_edit.mark_sent documents."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        return None
    if _approved_at(pid) is not None:
        return None
    sent = db.q(
        """update channel_posts
             set sent_to_client_at = now(), sent_to_client_by = %s,
                 client_approved_at = null, client_approved_by = null
           where id = %s
             and client_approved_at is null
             and not exists (select 1 from channel_post_comments c
                              where c.channel_post_id = channel_posts.id
                                and c.author = 'client'
                                and c.state in ('open', 'applying'))""",
        (email or None, pid), fetch="none")
    if not sent:
        return None
    return get_post(client_slug, source_topic_slug, channel)


def mark_approved(client_slug, source_topic_slug, channel, email):
    """The client accepting the post. Phase 3 (the portal) is the real caller; kept here so the
    act lives beside its siblings. Refused unless the post is currently sent and unapproved with
    no open suggestions, mirroring the blog approve gate."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        return None
    approved = db.q(
        """update channel_posts
             set client_approved_at = now(), client_approved_by = %s
           where id = %s and sent_to_client_at is not null
             and client_approved_at is null and posted_at is null
             and not exists (select 1 from channel_post_comments c
                              where c.channel_post_id = channel_posts.id
                                and c.author = 'client'
                                and c.state in ('open', 'applying'))
           returning id""",
        (email or None, pid), fetch="one")
    if not approved:
        return None
    return get_post(client_slug, source_topic_slug, channel)


def mark_posted(client_slug, source_topic_slug, channel, email):
    """The admin marking the piece live on the channel. The one act left after the client
    approves: gated on client_approved_at, because the client approves the exact bytes before
    they go out. Returns None when refused (not approved, or already posted)."""
    pid = post_id(client_slug, source_topic_slug, channel)
    if pid is None:
        return None
    posted = db.q(
        """update channel_posts set posted_at = now(), posted_by = %s
           where id = %s and client_approved_at is not null and posted_at is null
           returning id""",
        (email or None, pid), fetch="one")
    if not posted:
        return None
    return get_post(client_slug, source_topic_slug, channel)
