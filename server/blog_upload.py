"""Ingesting a blog the engine did not write.

WHY THIS EXISTS: a roadmap topic has two ways to reach admin review. The engine can
research, draft, gate and evaluate it, or an operator can hand the finished article over
as markdown. The second path is for the blogs that already exist: one written before this
app did, one commissioned outside it, one carried over from another system. Retyping such
an article into the editor to get it into the review loop is a worse use of an hour than
uploading the file, and dispatching a full research run over work that is already done
spends real Firecrawl and model quota to produce something nobody asked for.

WHAT AN UPLOAD IS NOT, and this is the whole design: it is not a shortcut past the
evaluator, and it does not pretend to be one. A generated blog reaches "done" by scoring
at or above the ship band. An uploaded blog reaches "done" because a named human vouched
for it. Those are different warrants, and the record keeps them apart rather than blurring
them: an uploaded blog carries NO score, NO eval body, NO dossier, and a status note
naming the uploader. NOTHING HERE WRITES A 95. A synthetic score would read downstream as
an audit that never ran, and the library, the ledger, the stage page and the CMS payload
would all repeat it in good faith. A null score is the honest record of "no evaluator saw
this", and every gate that matters keys on the status word rather than the number, so
honesty costs the operator nothing.

THE LEDGER ROW IS NOT BOOKKEEPING, it is the interlock. ledger.live_slugs feeds
api_generate's duplicate check, so a topic with an uploaded blog and no ledger row still
reads as ungenerated: the roadmap offers it, the operator selects it, and a research run
spends its quota rewriting an article that was already finished and may already be with
the client. The ledger row is what closes that door, which is why it is written here and
not left to the caller.

GATES ARE ADVISORY ON THIS PATH, ON PURPOSE. gates.py is the contract the ENGINE's drafts
are held to, and it is enforced there by refusing to leave the writer until it exits 0. An
uploaded article was written under a different process by someone who is now taking
responsibility for it, and blocking the upload on a banned phrase would leave that person
with a file they cannot get into the system and no editor to fix it in. So the gates run,
the report comes back with the response, and the operator reads it before they press the
button. They can then fix the file and upload again, or accept it and edit in the review
stage where the whole article is in front of them. Refusing here would move the work
outside the app; reporting here keeps it inside.
"""
from __future__ import annotations

import logging
import subprocess
import sys
from datetime import datetime, timezone

from . import blog_edit, db, ledger, runner, sync

log = logging.getLogger("engine.blog_upload")

# The ceiling /content already enforces on a manual save. One number, one reason: no blog
# is a megabyte, so anything past it is a paste accident or a file that is not an article.
MAX_BLOG_BYTES = 1_000_000

# How long the advisory gate run may take before it is abandoned. gates.py is pure regex
# over one file and finishes in well under a second; this bound exists so a pathological
# input cannot hold the upload open, not because the normal case is slow.
GATES_TIMEOUT_S = 30


class UploadError(Exception):
    """A refusal the operator can act on, carrying the HTTP status the route answers with.

    The status travels with the message because the two are decided together: "this topic
    already has a blog" is a 409 the operator resolves by confirming a replace, while "this
    file is empty" is a 422 they resolve by picking a different file, and a route that
    guessed would tell them the wrong thing about which.
    """

    def __init__(self, detail: str, status: int = 409):
        super().__init__(detail)
        self.detail = detail
        self.status = status


def _has_open_client_suggestions(topic_slug_id: str) -> bool:
    """Whether a client is still waiting on a suggestion against this topic.

    Top-level rows only, and 'applying' counts alongside 'open', for the reasons
    blog_edit.sent_state spells out: a reply asks for nothing, and a suggestion mid-apply
    is not yet resolved.
    """
    return bool(db.q(
        """select 1 from blog_comments
           where topic_id = %s and author = 'client' and parent_id is null
             and state in ('open', 'applying') limit 1""",
        (topic_slug_id,), fetch="val"))


def _current_status(client_slug: str, topic_slug: str) -> str:
    """This topic's status as the record folds it, or "unknown" when it has no events.

    The same fold app._topic_status performs, done here against one topic rather than
    through that helper, because app imports this module and the reverse import would close
    a cycle. runner._summarize is the shared fold either way, so the two cannot drift on
    what a status IS: only on how the lines are fetched.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return "unknown"
    rows = db.q(
        """select stage, event, iter, score, status from status_events
           where topic_id = %s order by line_no""", (tid,))
    lines = [{"stage": s, "event": e, "iter": i, "score": sc, "status": st}
             for s, e, i, sc, st in rows]
    if not lines:
        return "unknown"
    return runner._summarize(topic_slug, lines).get("status") or "unknown"


def _committed_version_no(client_slug: str, topic_slug: str) -> int | None:
    """The latest committed version number for this topic, or None when it has none.

    This is the "does a blog already exist here" test, and it deliberately asks the RECORD
    rather than the disk. Scratch is rebuildable and a stray blog.md in outputs/ proves
    nothing about what the team has; a committed version is the thing the library lists,
    the client may have been sent, and an upload would overwrite.
    """
    tid = db.topic_id(client_slug, topic_slug)
    if tid is None:
        return None
    return db.q(
        "select max(version_no) from blog_versions where topic_id = %s",
        (tid,), fetch="val")


def run_gates(client_slug: str, blog_path) -> dict:
    """Run the mechanical gates over an uploaded file and report what they said.

    ADVISORY. The return value is a report, never a verdict this module acts on: see the
    module docstring for why an upload is not blocked on it. A gate run that cannot happen
    at all (missing script, crash, timeout) reports itself as unavailable rather than
    inventing a pass, because "we did not check" and "we checked and it was fine" must not
    look the same to the operator reading the dialog.
    """
    script = runner.REPO_ROOT / ".claude" / "gates.py"
    if not script.is_file():
        return {"ran": False, "reason": "the gates script is not installed", "failures": []}
    # gates.py reads clients/<slug>/gates.json off disk and exits 2 when it is absent, so
    # the client's config has to exist before the run. Every other caller is an agent
    # subprocess that was materialized on its way in; this one is a web request, and on a
    # machine that has only ever served the record there may be no clients/ tree at all.
    try:
        sync.materialize_client(client_slug)
    except Exception:
        log.warning("could not materialize %s for the gate run", client_slug, exc_info=True)

    try:
        proc = subprocess.run(
            [sys.executable, str(script), "--client", client_slug, str(blog_path)],
            capture_output=True, text=True, timeout=GATES_TIMEOUT_S,
            cwd=str(runner.REPO_ROOT),
        )
    except subprocess.TimeoutExpired:
        return {"ran": False, "reason": "the gate run timed out", "failures": []}
    except OSError as exc:
        log.warning("gates could not run for %s: %s", client_slug, exc)
        return {"ran": False, "reason": "the gate run could not start", "failures": []}

    # EXIT 2 IS NOT A FAILING ARTICLE, it is a gate run that never happened: a missing or
    # malformed gates.json, an unreadable file, a bad argument. Reporting it as "passed:
    # false" would put a red banner in front of the operator naming rules the article may
    # not have broken, so it reports as unavailable, exactly as a timeout does.
    if proc.returncode not in (0, 1):
        detail = (proc.stderr or "").strip().splitlines()
        log.warning("gates exited %s for %s: %s", proc.returncode, client_slug, detail[-1:])
        return {"ran": False, "reason": "the gates could not read this client's config",
                "failures": []}

    # One line per rule, shaped "[FAIL] gate-name  detail" by print_report. Only the FAIL
    # lines are lifted: WARNs pass on the engine's own path too, so surfacing them here
    # would make an upload look worse than the identical text would look generated.
    failures = [
        line.strip() for line in (proc.stdout or "").splitlines()
        if line.lstrip().startswith("[FAIL")
    ]
    return {"ran": True, "passed": proc.returncode == 0, "failures": failures, "reason": ""}


def upload_blog(client_slug: str, topic_slug: str, title: str, covers: str,
                prompts, body: str, email: str, replace: bool) -> dict:
    """Ingest one operator-supplied article and put it in admin review. SYNC: call via
    to_thread, and under blog_edit.APPLY_LOCK, so an upload cannot interleave with a
    comment apply's read-session-write and be silently overwritten by the apply's stale
    base. The route holds the lock, exactly as it does for a manual save.

    THE ORDER IS THE CONTRACT. Refusals first and all of them, because a half-done upload
    is worse than a refused one: the file lands, then the ledger write fails, and the
    topic is now generated-but-not-ledgered, which is the exact state that lets a research
    run spend quota over it. Then the write, then one commit_topic that lands the topic
    row, the version, the status rows and the shipped pointer in a single transaction, and
    only then the ledger.

    Returns the shape the route answers with: word count, the version it created, and the
    advisory gate report.
    """
    text = body.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise UploadError(
            "that file has no article in it; check you picked the right one", status=422)
    if len(text.encode("utf-8")) > MAX_BLOG_BYTES:
        raise UploadError(
            "that file is over 1 MB, which no blog is; check you picked a markdown "
            "article and not an export", status=413)

    tid = db.topic_id(client_slug, topic_slug)

    # THE APPROVED LOCK, AHEAD OF EVERY OTHER TOPIC-STATE REFUSAL. An approved article always
    # has a committed version, so checking after the replace-confirm below would tell the
    # operator to confirm a replace and only then refuse the replace they confirmed, which is
    # a round trip spent teaching them nothing. This is also the refusal that cannot be argued
    # with by adding `replace=true`: the confirm exists for "you are about to overwrite a
    # blog", and no confirmation makes an article the client signed off on overwritable.
    #
    # UploadError with a 409, which is this module's whole refusal protocol: the route maps
    # status and detail straight onto the HTTPException, so nothing new is needed to carry it.
    approved = blog_edit.approved_at(client_slug, topic_slug)
    if approved is not None:
        raise UploadError(
            blog_edit.locked_detail(approved, "uploading an article over it"), status=409)

    existing = _committed_version_no(client_slug, topic_slug)
    if existing is not None and not replace:
        raise UploadError(
            f"{topic_slug!r} already has a blog; uploading would replace it, so confirm "
            f"the replace if that is what you meant")
    # A replace over an unanswered client suggestion is the same wrong as a re-send over
    # one, and refused for the same reason: the client is waiting to see something change,
    # and swapping the whole article underneath them answers nothing while destroying the
    # text their comment is anchored to.
    if existing is not None and tid is not None and _has_open_client_suggestions(tid):
        raise UploadError(
            "the client's suggestions are still open on this blog; resolve or dismiss "
            "each one before replacing the article")

    # A HELD BLOG IS NOT OVERWRITTEN, and this refusal is in Python rather than only in the
    # button's disabled state because of what it prevents. needs_review means the evaluator
    # asked the operator a question that is current, on disk, and answerable, and the
    # question form is keyed to a draft. Writing a done line over that topic supersedes the
    # hold in the status fold while leaving the form standing, so the blog would read as
    # shipped on one surface and as awaiting an answer on another, which is the dead end
    # with no door the engine contract forbids. Answering or deleting the topic is the way
    # out of a hold; an upload is not.
    if tid is not None and _current_status(client_slug, topic_slug) == "needs_review":
        raise UploadError(
            "this topic is held for an answer the evaluator asked for; answer its "
            "questions or delete the topic before uploading an article over it")

    # Materialize only a topic the record already knows. A first upload has no record to
    # lay down, and materialize_topic on an unknown topic would be a lookup that answers
    # nothing. Where there IS a record, this is the same reason the manual save
    # materializes first: status.jsonl must be the record's history before a line is
    # appended to it, or the append lands on a stale file and commit_topic's line numbers
    # disagree with the rows already stored.
    if tid is not None:
        sync.materialize_topic(client_slug, topic_slug)

    tdir = runner.output_dir(client_slug, topic_slug)
    tdir.mkdir(parents=True, exist_ok=True)
    blog_path = tdir / "blog.md"
    prev_bytes = blog_path.read_bytes() if blog_path.is_file() else None
    blog_path.write_text(text, encoding="utf-8")

    gates = run_gates(client_slug, blog_path)

    # THE TERMINAL LINE, written directly and never through _resolve_needs_review. That
    # resolver reads a score and demotes a scoreless topic to "failed", which is right for
    # a run that produced no verdict and wrong for an article that was never going to have
    # one. stage="write" because writing is the stage that genuinely completed; the note
    # carries the provenance the enum cannot, since STAGES is closed and adding an "upload"
    # member would change a shape every existing consumer already switches on.
    who = (email or "").strip() or "an operator"
    try:
        runner._status_module().append_status(
            str(tdir), topic_slug, stage="write", event="end", iter=1,
            score=None, status="done",
            note=f"uploaded by {who}; no engine run, no evaluator score",
        )
    except Exception:
        _restore(blog_path, prev_bytes)
        raise

    # ensure_topic BEFORE commit_topic, and with the title: commit_topic calls it without
    # one, so a first upload committed through that path alone would leave topics.title
    # NULL and the library showing a blank row until an h1 rescued it.
    try:
        # Pass the title ONLY when this topic has none yet, so a REPLACE upload never clobbers an
        # operator's manual rename: topics.title is now the editable label the library shows, and
        # ensure_topic's coalesce only guards against NULL, not against a non-null incoming value.
        # A first upload still gets its title, which is what stops a blank library row.
        # tid resolved at the top of this function is still valid: nothing between there and
        # here creates or deletes the topic, so reuse it instead of re-querying.
        existing_title = db.q("select title from topics where id = %s", (tid,),
                              fetch="val") if tid else None
        db.ensure_topic(client_slug, topic_slug,
                        None if existing_title else (title or topic_slug))
        sync.commit_topic(client_slug, topic_slug)
    except Exception:
        # Same rule the manual save follows: bytes the record refused must not sit in
        # scratch waiting for the startup reconciler to launder them into a version.
        _restore(blog_path, prev_bytes)
        raise

    version_no = _committed_version_no(client_slug, topic_slug)

    # The interlock, last, and deliberately not fatal. ON CONFLICT DO NOTHING means a
    # replace over an already-ledgered topic writes nothing and returns None, which is
    # correct and not an error. A genuine failure here leaves a committed blog with no
    # ledger row, so it is logged loudly: the blog is real and shipping it is right, but
    # the operator's regenerate guard is missing and someone needs to know.
    try:
        ledger.append_row(client_slug, {
            "topic": title or topic_slug,
            "topic_slug": topic_slug,
            "covers": covers or "",
            "prompts": prompts or [],
            # NULL, not 95. See the module docstring: no evaluator scored this.
            "score": None,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            # NULL run_id is the structural mark of an upload: no run produced it.
            "run_id": None,
        })
    except Exception:
        log.exception(
            "uploaded blog committed but the ledger row failed for %s/%s; the roadmap "
            "will still offer this topic for generation", client_slug, topic_slug)

    return {
        "topic_slug": topic_slug,
        "word_count": len(text.split()),
        "version_no": version_no,
        "replaced": existing is not None,
        "gates": gates,
    }


def _restore(blog_path, prev_bytes) -> None:
    """Put back whatever was there before a failed upload, or remove the file we made.

    The manual save only ever restores, because /content refuses a topic that has no blog
    yet and so always has previous bytes. An upload does not: a first upload creates
    blog.md, and leaving that orphan behind on a failed commit hands the startup
    reconciler a file it would read as scratch running ahead of the record and commit on
    its own, turning a refused upload into a published one at the next restart.
    """
    try:
        if prev_bytes is not None:
            blog_path.write_bytes(prev_bytes)
        elif blog_path.is_file():
            blog_path.unlink()
    except OSError:
        log.exception("could not roll back %s after a failed upload", blog_path)
