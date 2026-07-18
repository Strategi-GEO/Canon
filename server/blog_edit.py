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


class EditError(Exception):
    """A comment apply that cannot proceed, with the reason the operator reads."""


# The columns every comment read selects, in the order _wire unpacks. One string, so a new
# column cannot be added to one query and forgotten in another.
_COMMENT_COLS = """id, created_at, author, author_email, selected_text,
                   context_before, context_after, instruction, state,
                   finished_at, error, edits"""


def _wire(row):
    """One blog_comments row as the wire dict every surface reads: the phase-1
    comments.json entry with author split into author ('operator' | 'client') and
    author_email. Timestamps flatten to isoformat; edits arrives already decoded,
    because psycopg maps jsonb to Python."""
    (comment_id, created_at, author, author_email, selected_text, context_before,
     context_after, instruction, state, finished_at, error, edits) = row
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
    }


def _is_uuid(value):
    """Comment ids arrive from URL segments, so a non-uuid string (a phase-1 hex id, a
    typo, a probe) must read as an unknown comment, never as a database error."""
    try:
        uuid.UUID(str(value))
    except (ValueError, TypeError):
        return False
    return True


def read_comments(client_slug, topic_slug):
    """Every comment for one topic, oldest first, DISMISSED INCLUDED: the UI decides what
    to hide, and a read that pre-filtered would make a dismissal invisible to the very
    page that audits it. An unknown topic is the empty state, exactly as a missing
    comments.json was."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return []
    rows = db.q(
        f"""select {_COMMENT_COLS} from blog_comments
            where topic_id = %s order by created_at""",
        (tid,))
    return [_wire(row) for row in rows]


def get_comment(client_slug, topic_slug, comment_id):
    """One comment as its wire dict, or None when the topic or the comment is unknown."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"select {_COMMENT_COLS} from blog_comments where id = %s and topic_id = %s",
        (comment_id, tid), fetch="one")
    return _wire(row) if row else None


def in_flight_count(client_slug, topic_slug):
    """How many applies are live for one topic, counted on the RECORD: two engines share
    it, so a count over one machine's memory would let each spend the whole cap alone."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return 0
    return db.q(
        "select count(*) from blog_comments where topic_id = %s and state = 'applying'",
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
    state, and the operator resolves or files the change again."""
    failed = db.q(
        """update blog_comments
             set state = 'failed', finished_at = now(), error = %s
           where state = 'applying'
             and created_at < now() - interval '15 minutes'""",
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
    state = "applying" if author == "operator" else "open"
    # insert..select so client_id rides in from the topic row: a comment whose client_id
    # disagreed with its topic's would be the composite FK's refusal anyway.
    row = db.q(
        f"""insert into blog_comments
              (topic_id, client_id, author, author_email, selected_text,
               context_before, context_after, instruction, state)
            select id, client_id, %s, %s, %s, %s, %s, %s, %s
            from topics where id = %s
            returning {_COMMENT_COLS}""",
        (author, author_email, selected_text, context_before, context_after,
         instruction, state, tid), fetch="one")
    return _wire(row)


def resolve_comment(client_slug, topic_slug, comment_id):
    """Atomically flip one 'open' or 'failed' comment to 'applying' and return its wire
    dict, or None when the state refuses. The WHERE is the whole race guard: two admins
    pressing Resolve together get one flip and one None, never two apply sessions.
    'failed' is flippable so the same door retries a failed operator apply and a failed
    client resolve alike. finished/error/edits reset with the flip, because they
    describe the attempt this one supersedes."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None or not _is_uuid(comment_id):
        return None
    row = db.q(
        f"""update blog_comments
              set state = 'applying', finished_at = null, error = null, edits = null
            where id = %s and topic_id = %s and state in ('open', 'failed')
            returning {_COMMENT_COLS}""",
        (comment_id, tid), fetch="one")
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
            where id = %s and topic_id = %s and state <> 'applying'
            returning {_COMMENT_COLS}""",
        (comment_id, tid), fetch="one")
    return _wire(row) if row else None


def _finish_comment(comment_id, *, state, error=None, edits=None):
    """Land one apply's verdict ('resolved' | 'failed') on the record. edits travels as
    dumped JSON with an explicit cast, because psycopg adapts a bare Python list as an
    array, not as jsonb."""
    db.q(
        """update blog_comments
             set state = %s, finished_at = now(), error = %s, edits = %s::jsonb
           where id = %s""",
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
    body = await asyncio.to_thread(_record_body, client_slug, topic_slug)
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
    """The latest committed blog body, or None when the record holds no version."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return None
    row = db.q(
        """select body from blog_versions
           where topic_id = %s order by version_no desc limit 1""",
        (tid,), fetch="one")
    return row[0] if row else None


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
    sync.materialize_topic(client_slug, topic_slug)
    tdir = runner.output_dir(client_slug, topic_slug)
    tdir.mkdir(parents=True, exist_ok=True)
    blog_path = tdir / "blog.md"
    prev_bytes = blog_path.read_bytes() if blog_path.is_file() else None
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
    is in flight would release bytes the apply is about to change."""
    empty = {"sent_to_client": None, "sent_to_client_by": None,
             "client_approved": None, "client_approved_by": None,
             "changes_requested": 0}
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return empty
    row = db.q(
        """select t.sent_to_client_at, t.sent_to_client_by,
                  t.client_approved_at, t.client_approved_by,
                  (select count(*) from blog_comments c
                    where c.topic_id = t.id and c.author = 'client'
                      and c.state in ('open', 'applying'))
           from topics t where t.id = %s""",
        (tid,), fetch="one")
    if row is None:
        return empty
    sent_at, sent_by, approved_at, approved_by, changes = row
    return {
        "sent_to_client": sent_at.isoformat() if sent_at else None,
        "sent_to_client_by": sent_by,
        "client_approved": approved_at.isoformat() if approved_at else None,
        "client_approved_by": approved_by,
        "changes_requested": int(changes or 0),
    }


def mark_sent(client_slug, topic_slug, email):
    """Release one shipped blog to the client portal, first send and every re-send.

    Phase 1's first-send-wins idempotency is GONE, deliberately: after a review round,
    Send again is a new release of changed bytes, so every call re-stamps the date and
    the sender. sent_version_id pins WHICH version this send released (the portal
    renders it, and a client suggestion anchors to it), and the client's approval is
    CLEARED with the stamp, because an approval describes the exact bytes the client
    read and must not survive a re-send of different ones as though they approved those
    too. The route owns the one refusal (open suggestions block a re-send)."""
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return sent_state(client_slug, topic_slug)
    db.q(
        """update topics
             set sent_to_client_at = now(),
                 sent_to_client_by = %s,
                 sent_version_id = (
                   select v.id from blog_versions v
                   where v.topic_id = topics.id
                   order by v.version_no desc limit 1),
                 client_approved_at = null,
                 client_approved_by = null
           where id = %s""",
        (email or None, tid), fetch="none")
    return sent_state(client_slug, topic_slug)
