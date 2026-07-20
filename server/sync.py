"""Disk <-> Supabase synchronisation: materialize before a session, commit after.

THE MODEL, in one paragraph. Supabase is the record; the working tree is scratch
that Claude agent subprocesses physically need (they run .claude/gates.py against
clients/<slug>/gates.json and Edit blog.md as a real file). materialize_*() lays
the scratch down from the record before a session spawns. commit_topic() reads
whatever the session left on disk and writes it to the record after the terminal
status line. reconcile_all() runs at server startup and commits anything a crash
stranded on disk, which is what makes "commit at terminal" safe: the window
between a terminal line and its commit is covered by the next startup, not lost.

ORDERING RULES this module must never break:
- The terminal resolver (_enforce_terminal_status, _resolve_needs_review) reads
  questions and status from DISK, the same surface the agents wrote seconds
  earlier. commit_topic runs strictly AFTER resolution. Committing first would
  let the resolver read a store the agent's last write never reached.
- commit_topic is IDEMPOTENT everywhere: status lines key on (topic_id, line_no)
  with ON CONFLICT DO NOTHING, a blog version is inserted only when the bytes
  differ from the latest committed version, and everything else is an upsert.
  Idempotence is what lets the startup reconciler re-commit blindly.
- A stopped or failed topic commits too. The frozen dossier is the expensive
  half of a blog, and the engine contract promises a stopped topic is cheap to
  resume; a commit that only ran on `done` would break that promise the first
  time scratch got reclaimed.
"""

from __future__ import annotations

import json
import logging
import pathlib

from . import db

log = logging.getLogger("geo.sync")

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
CLIENTS_DIR = REPO_ROOT / "clients"
OUTPUTS_ROOT = REPO_ROOT / "outputs"


def _client_dir(slug):
    return CLIENTS_DIR / slug


def _topic_dir(client_slug, topic_slug):
    # Import here, not at module top: runner imports sync, and sync only needs
    # runner's path helper, so the late import breaks the cycle.
    from . import runner
    return runner.output_dir(client_slug, topic_slug)


def _read(path):
    """None for absent, '' for present-but-empty. The difference is the record:
    a zero-byte NEEDS_REVIEW marker is a real hold, distinct from an absent one."""
    p = pathlib.Path(path)
    if not p.is_file():
        return None
    return p.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Materialize: record -> scratch, before a session spawns
# ---------------------------------------------------------------------------

def materialize_client(slug):
    """Lay clients/<slug>/ down from the record.

    Everything an agent reads by path must exist before the SDK session spawns:
    gates.json (gates.py anchors it relative to its own __file__, so the layout
    is fixed), client.md, canonical-facts.md, and Resources/. Writes are
    unconditional for the small files (cheap, and the record always wins over a
    stale scratch copy); Resources download only on sha mismatch because the
    vacation-village kit is 12 MB.
    """
    cid = db.client_id(slug)
    if not cid:
        raise LookupError(f"unknown client {slug!r}")
    row = db.q(
        """select gates, client_md, canonical_facts, description
           from clients where id = %s""", (cid,), fetch="one")
    gates, client_md, facts, description = row

    cdir = _client_dir(slug)
    cdir.mkdir(parents=True, exist_ok=True)
    (cdir / "gates.json").write_text(
        json.dumps(gates or {}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")
    if client_md is not None:
        (cdir / "client.md").write_text(client_md, encoding="utf-8")
    # client.md's template tells agents the operator-owned brand description
    # lives at clients/<slug>/description.md, so the promise must be kept on
    # disk even when the description is empty.
    (cdir / "description.md").write_text(description or "", encoding="utf-8")
    # canonical-facts.md is the ONE file where disk wins over the record,
    # because the file IS the human's editing surface: the workflow is that a
    # person reviews and hand-edits it, and no dashboard editor exists for it.
    # Clobbering a hand-edit with the record would silently undo a human
    # correction to the binding fact base, which is the worst possible silent
    # loss this system can produce. So a disk copy that differs from the record
    # is committed UP, and only an absent disk copy is laid down from the
    # record. Every other client file keeps record-wins semantics.
    facts_path = cdir / "canonical-facts.md"
    disk_facts = _read(facts_path)
    if disk_facts is not None and disk_facts != facts:
        db.q("""update clients set canonical_facts = %s, canonical_facts_at = now()
                where id = %s""", (disk_facts, cid), fetch="none")
        log.warning("materialize_client: %s canonical-facts.md differed from the "
                    "record; the disk copy (the human editing surface) was "
                    "committed up", slug)
    elif disk_facts is None and facts is not None:
        facts_path.write_text(facts, encoding="utf-8")

    # A ROADMAP DELETED FROM THE RECORD TAKES ITS DISK COPY WITH IT, on every machine and
    # not only the one that pressed delete.
    #
    # roadmap.delete_roadmap unlinks clients/<slug>/roadmap.csv itself, and states why: a
    # stale copy left behind "would be picked up by the NEXT generation's validate step as
    # though that session had written it, silently resurrecting the sheet the operator just
    # deleted". That unlink reaches exactly one filesystem. A teammate's laptop, or a delete
    # performed from the hosted dashboard where there is no filesystem at all, leaves the
    # stale sheet sitting there waiting to be resurrected.
    #
    # So the check moves to where every session already passes: the record is asked whether a
    # sheet exists, and a disk copy with no sheet behind it is removed before any agent can
    # read it. roadmap_gen.py is the reader that matters (it validates the file at
    # roadmap_path after a generation), and load_roadmap/has_roadmap already read the record,
    # so nothing legitimate depends on the orphan.
    #
    # Deliberately NOT symmetric with canonical-facts.md above: a roadmap.csv is generation
    # scratch that the app writes, never a human editing surface, so there is nothing here to
    # commit up and losing the orphan costs nothing.
    if not db.q("select 1 from roadmap_sheets where client_id = %s", (cid,), fetch="val"):
        stale_sheet = cdir / "roadmap.csv"
        if stale_sheet.is_file():
            stale_sheet.unlink()
            log.info("materialize_client: %s has no roadmap in the record; removed the "
                     "orphaned roadmap.csv so it cannot resurrect the deleted sheet", slug)
        stale_report = cdir / "roadmap-report.md"
        if stale_report.is_file():
            stale_report.unlink()

    rdir = cdir / "Resources"
    rdir.mkdir(exist_ok=True)
    import hashlib
    for name, sha, size, object_path, _ctype in db.resource_list(slug):
        target = rdir / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == sha:
            continue
        target.write_bytes(db.storage_get(object_path.split("/", 1)[1]))


def materialize_topic(client_slug, topic_slug):
    """Re-lay a topic's prior artifacts for a resumed or revised run.

    Agent W reads the frozen dossier every draft and every revise, reads
    links-verified.txt to skip already-verified URLs, and Edit-tools blog.md on
    revise. A topic stopped last week and resumed today must find all three on
    disk exactly as the record holds them. Existing scratch is left alone when
    the record has nothing (a mid-run crash leaves disk ahead of the record,
    and the reconciler, not this function, resolves that direction).
    """
    tid = db.topic_id(client_slug, topic_slug)
    if not tid:
        return
    tdir = _topic_dir(client_slug, topic_slug)
    tdir.mkdir(parents=True, exist_ok=True)

    # status.jsonl is re-laid from the record FIRST, and this is load-bearing,
    # not a convenience. commit_topic keys status_events on (topic_id, line_no)
    # with ON CONFLICT DO NOTHING, which is only idempotent while disk ordinals
    # continue where the record left off. A reclaimed scratch whose new
    # status.jsonl restarted at line 0 would collide with the old run's rows and
    # every new line, including a stop verdict, would be silently swallowed.
    # Re-laying the feed makes the next session append at the record's
    # high-water mark, so ordinals never collide and the runner's baseline
    # slicing (lines[baseline:]) keeps meaning "this session's lines".
    sj = tdir / "status.jsonl"
    if not sj.is_file():
        rows = db.q(
            """select ts, coalesce(slug_reported, %s), stage, event, iter,
                      score, status, note
               from status_events where topic_id = %s order by line_no""",
            (topic_slug, tid))
        if rows:
            lines = []
            for ts, slug, stage, event, iteration, score, status, note in rows:
                lines.append(json.dumps({
                    "ts": ts.isoformat() if hasattr(ts, "isoformat") else ts,
                    "slug": slug, "stage": stage, "event": event,
                    "iter": iteration, "score": score, "status": status,
                    "note": note or "",
                }, ensure_ascii=False))
            sj.write_text("\n".join(lines) + "\n", encoding="utf-8")

    dossier, links = db.q(
        "select dossier, links_verified from topics where id = %s",
        (tid,), fetch="one")
    if dossier is not None and not (tdir / "dossier.md").is_file():
        (tdir / "dossier.md").write_text(dossier, encoding="utf-8")
    if links is not None and not (tdir / "links-verified.txt").is_file():
        (tdir / "links-verified.txt").write_text(links, encoding="utf-8")

    latest = db.q(
        """select body, eval_body, committed_at from blog_versions
           where topic_id = %s order by version_no desc limit 1""",
        (tid,), fetch="one")
    if latest:
        body, eval_body, committed_at = latest
        blog = tdir / "blog.md"
        # THE MIRROR OF reconcile_all's MTIME GUARD, and it closes the other half of the
        # same hole. That sweep refuses to commit scratch that is OLDER than the record, so
        # a stale disk cannot revert a teammate. Nothing, until this, refreshed a stale disk
        # FROM the record, and "leave an existing blog.md alone" is only correct while scratch
        # is the newer copy.
        #
        # What it costs when it is missing: a version committed by any writer that does not
        # touch THIS machine's scratch (the hosted dashboard's admin edit, or another
        # teammate's engine) leaves this disk holding an older article. The next revise here
        # materializes, finds blog.md present, keeps the stale bytes, and Agent W edits the
        # wrong draft. The newer version is never read and the edit that produced it is
        # silently discarded, with no error anywhere.
        #
        # The original intent is preserved exactly: scratch that is AHEAD of the record (a
        # mid-run crash) is still left alone for the reconciler to resolve in that direction.
        # Only scratch strictly OLDER than the latest committed version is replaced.
        stale = (
            blog.is_file()
            and committed_at is not None
            and blog.stat().st_mtime < committed_at.timestamp()
            and blog.read_text(encoding="utf-8") != body
        )
        if not blog.is_file() or stale:
            blog.write_text(body, encoding="utf-8")
            if stale:
                log.info("materialize: refreshed stale blog.md for %s/%s from the record",
                         client_slug, topic_slug)
        # eval.md rides the same rule. It is the artifact the score describes, so leaving a
        # stale one beside a refreshed blog.md would pair an article with another draft's
        # audit, which is the exact mismatch the stop contract's artifact-set restore exists
        # to prevent.
        ev = tdir / "eval.md"
        if eval_body is not None and (not ev.is_file() or stale):
            ev.write_text(eval_body, encoding="utf-8")


def materialize_answers(client_slug, topic_slug):
    """Write questions.json + answers.json into the topic dir before an
    answer-driven revise. Agent E reads answers.json as a file; the lead's
    check-area CLI reads questions.json. Both are rebuilt from review_notes."""
    tid = db.topic_id(client_slug, topic_slug)
    if not tid:
        return
    rows = db.q(
        """select n.id, n.ref, n.area, n.body, n.why, n.asked_score, n.asked_iter,
                  r.body as answer
           from review_notes n
           left join review_notes r on r.parent_id = n.id
           where n.topic_id = %s and n.parent_id is null and n.author = 'evaluator'
           order by n.created_at, n.ref""", (tid,))
    if not rows:
        return
    tdir = _topic_dir(client_slug, topic_slug)
    tdir.mkdir(parents=True, exist_ok=True)
    asked_iter = next((r[6] for r in rows if r[6] is not None), 1)
    asked_score = next((r[5] for r in rows if r[5] is not None), None)
    # Both files mirror their disk writers KEY FOR KEY: questions.json matches
    # .claude/questions.py's payload, answers.json matches questions.py's
    # _write_answers_to_disk. The keys are load-bearing, not cosmetic:
    # is_answered() fires only when answers["iter"] equals the form's iter, so
    # a materialized answers.json missing "iter" would never read as answered
    # and the revise finally-arm's keep-vs-clear matrix would misfire.
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    form = {
        "slug": topic_slug,
        "asked": now,
        "iter": asked_iter,
        "score": asked_score,
        "questions": [
            {"id": ref, "area": area, "question": body, "why": why or ""}
            for _id, ref, area, body, why, _s, _i, _a in rows
        ],
    }
    (tdir / "questions.json").write_text(
        json.dumps(form, indent=2, ensure_ascii=False), encoding="utf-8")
    answers = [
        {"id": ref, "question": body, "answer": answer}
        for _id, ref, _area, body, _why, _s, _i, answer in rows
        if answer is not None
    ]
    if answers:
        payload = {
            "slug": topic_slug,
            "answered_at": now,
            "iter": asked_iter,
            "score_when_asked": asked_score,
            "answers": answers,
        }
        (tdir / "answers.json").write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# Commit: scratch -> record, after the terminal line
# ---------------------------------------------------------------------------

def _summarize_lines(lines):
    """Status, score, iterations from parsed status lines. Mirrors
    runner._summarize deliberately: last terminal line wins by ordinal, score is
    the last (eval, end) line carrying one, iterations is the high-water iter.
    Kept here rather than imported to avoid the runner<->sync cycle; the fold
    trigger in Supabase and this function were both verified against the same
    1,339-line corpus."""
    status, score, iters = "running", None, 0
    for line in lines:
        iters = max(iters, int(line.get("iter") or 0))
        if line.get("stage") == "eval" and line.get("event") == "end" \
                and line.get("score") is not None:
            score = line["score"]
        if line.get("status") and line["status"] != "running":
            status = line["status"]
    return status, score, iters


def commit_topic(client_slug, topic_slug, allow_new_version=True):
    """Push one topic's scratch to the record, in ONE transaction.

    Idempotent AND atomic, and both properties are load-bearing. Idempotent:
    status lines key on (topic_id, line_no) with ON CONFLICT DO NOTHING, a blog
    version inserts only when the bytes moved, everything else upserts, so the
    startup reconciler can re-commit blindly. Atomic: every statement runs on
    one transaction, so a process death mid-commit leaves either the whole
    commit or none of it. The single transaction is what keeps reconcile_all's
    "ahead" test sound: a partial commit that landed the status lines but not
    the dossier would read as up-to-date forever, and the stop contract's
    promise that the frozen dossier is kept would die silently with it.

    `allow_new_version` GATES ONE STATEMENT AND NOTHING ELSE: the INSERT of a
    new blog_versions row. Every other write here still runs when it is False,
    which is the whole point of it being a flag rather than an early return.
    A caller passes False when it knows the scratch body is not entitled to
    become the newest version, and the only such caller is reconcile_all, which
    holds the mtime evidence for that decision and nothing in this function
    does. Note carefully what it does NOT block: where the disk bytes already
    EQUAL the latest committed version, the eval_body, score and shipped
    bookkeeping below still lands, because that path writes no article bytes at
    all and suppressing it would lose a score for no gain.
    """
    tdir = _topic_dir(client_slug, topic_slug)
    if not tdir.is_dir():
        return
    cid = db.client_id(client_slug)
    if not cid:
        log.warning("commit_topic: unknown client %s, leaving scratch", client_slug)
        return
    tid = db.ensure_topic(client_slug, topic_slug)

    # THE APPROVED CHECK RUNS BEFORE THE TRANSACTION, AND THAT ORDERING IS THE
    # WHOLE FIX. Migration 013 put a BEFORE INSERT trigger on blog_versions that
    # raises on an approved topic, and it stays exactly where it is: it is the
    # backstop five write paths in two languages must all pass. But a trigger
    # firing inside THIS transaction is a catastrophe out of proportion to the
    # thing it refused. Everything below shares one tx, so the rollback that
    # discards the refused version ALSO discards the status lines, the frozen
    # dossier, links-verified.txt, the NEEDS_REVIEW marker and the question
    # form, none of which the lock has any objection to. The topic then commits
    # nothing at all, its scratch stays ahead of the record, and reconcile_all
    # re-tries it on every single boot from here to forever, raising the same
    # exception and logging the same traceback, because a rollback cannot change
    # the condition that caused it.
    #
    # So the version insert is skipped HERE, in Python, before the transaction
    # opens, and the rest of the commit proceeds normally. The article the client
    # approved is still untouchable, which is what the lock is for; what changes
    # is that a run against an approved topic now loses only the thing the lock
    # forbids instead of losing the entire commit around it.
    #
    # A DIRECT QUERY RATHER THAN blog_edit.approved_at, AND NOT BY PREFERENCE.
    # blog_edit imports sync at module scope (`from . import db, runner, sync`),
    # so importing blog_edit from here at module scope is a hard cycle. This
    # module already imports db at the top and reaches runner through a late
    # import for exactly that reason. One SELECT against the column the trigger
    # itself reads costs less than a third late import, and it cannot go stale
    # relative to blog_edit because there is no logic in it to drift.
    approved = db.q("select client_approved_at from topics where id = %s",
                    (tid,), fetch="val")

    lines = []
    sj = tdir / "status.jsonl"
    if sj.is_file():
        for i, raw in enumerate(sj.read_text(encoding="utf-8").splitlines()):
            raw = raw.strip()
            if not raw:
                continue
            try:
                lines.append((i, json.loads(raw)))
            except json.JSONDecodeError:
                log.warning("malformed status line %d in %s, skipped", i, sj)

    dossier = _read(tdir / "dossier.md")
    links = _read(tdir / "links-verified.txt")
    marker = _read(tdir / "NEEDS_REVIEW")
    body = _read(tdir / "blog.md")
    eval_body = _read(tdir / "eval.md")
    status, score, iters = _summarize_lines([e for _, e in lines])
    mtime = sj.stat().st_mtime if sj.is_file() else None

    with db.tx() as cur:
        # 1. Status lines, keyed by ordinal. Append-only on disk, and
        # materialize_topic re-lays the file from the record on reclaimed
        # scratch, so disk ordinals always continue the record's and the
        # conflict clause only ever suppresses genuine re-pushes.
        for line_no, e in lines:
            cur.execute(
                """insert into status_events
                     (topic_id, client_id, line_no, ts, stage, event, iter,
                      score, status, note, slug_reported)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (topic_id, line_no) do nothing""",
                (tid, cid, line_no, e.get("ts"), e.get("stage"),
                 e.get("event"), e.get("iter"), e.get("score"),
                 e.get("status") or "running", e.get("note") or "",
                 e.get("slug")))

        # 2. Dossier, links, marker. The marker's three writers (engine
        # correction, mock cap-hit, the session lead) all land on one file, so
        # reading the file covers every writer without naming them.
        cur.execute(
            """update topics set
                 dossier = coalesce(%s, dossier),
                 dossier_at = case when %s::text is not null and dossier is distinct from %s
                                   then coalesce(dossier_at, to_timestamp(%s)) else dossier_at end,
                 links_verified = coalesce(%s, links_verified),
                 review_note = %s
               where id = %s""",
            (dossier, dossier, dossier, mtime, links, marker, tid))

        # 3. The blog version. Insert only when the bytes moved: retries,
        # stops, restores and reconciler re-runs then re-commit nothing,
        # because restored bytes ARE the previous version's bytes.
        #
        # TWO THINGS CAN VETO THE INSERT AND THEY ARE INDEPENDENT. `approved`
        # says the client signed off on these bytes and migration 013 forbids a
        # newer row; `allow_new_version` says the caller knows this scratch is
        # not the newer copy. Either one alone suppresses the insert, and
        # neither suppresses anything else in this transaction.
        vid = None
        if body:
            cur.execute(
                """select id, body from blog_versions
                   where topic_id = %s order by version_no desc limit 1""",
                (tid,))
            latest = cur.fetchone()
            blog_mtime = (tdir / "blog.md").stat().st_mtime
            if latest is not None and latest[1] == body:
                # Bytes unchanged: no new version exists to be forbidden, so
                # neither veto applies. This is the branch a reconciler re-run
                # lands on, and it is what makes re-commits free.
                vid = latest[0]
                cur.execute(
                    """update blog_versions
                       set eval_body = coalesce(%s, eval_body),
                           score = coalesce(%s, score),
                           shipped = shipped or %s
                       where id = %s""",
                    (eval_body, score, status == "done", vid))
            elif approved is not None:
                # ONE LINE AT WARNING, NEVER A TRACEBACK PER BOOT. The trigger's
                # exception told an operator nothing they could act on and cost
                # the whole commit; this says which topic diverged and stops.
                # The scratch stays on disk untouched, so nothing is lost and a
                # person can still read the divergent draft if they want it.
                log.warning(
                    "commit_topic: %s/%s was approved by the client on %s, so the "
                    "scratch blog.md is NOT committed as a new version; the rest "
                    "of the commit proceeds", client_slug, topic_slug, approved)
            elif not allow_new_version:
                # The caller's mtime evidence says this body is BEHIND the
                # record, so committing it would revert whoever wrote the newer
                # version. See reconcile_all for the full account of how a
                # stranded scratch file gets here.
                log.info(
                    "commit_topic: %s/%s scratch blog.md is not ahead of the "
                    "record, so no new version is committed", client_slug, topic_slug)
            else:
                h1 = next((l[2:].strip() for l in body.splitlines()
                           if l.startswith("# ")), None)
                cur.execute(
                    """insert into blog_versions
                         (topic_id, client_id, version_no, iteration, body, h1_title,
                          word_count, score, eval_body, shipped, committed_at)
                       values (%s, %s,
                               coalesce((select max(version_no) from blog_versions
                                         where topic_id = %s), 0) + 1,
                               %s, %s, %s, %s, %s, %s, %s, to_timestamp(%s))
                       returning id""",
                    (tid, cid, tid, max(min(iters, 8), 1), body, h1,
                     len(body.split()), score, eval_body, status == "done",
                     blog_mtime))
                vid = cur.fetchone()[0]
            # `vid is not None` is REQUIRED here now that the branches above can
            # leave it unset. Without it a suppressed insert would run this
            # statement with a null and CLEAR shipped_version_id, so a guard
            # against changing an approved article would be the thing that
            # detached the topic from its shipped version.
            if status == "done" and vid is not None:
                cur.execute(
                    "update topics set shipped_version_id = %s where id = %s",
                    (vid, tid))

        # 4. The question form, replacing whole, exactly as questions.py
        # rewrites the file whole per eval. Unanswered evaluator notes go, the
        # current form comes; answered notes are history and stay. The NOT
        # EXISTS guard evaluates in this statement, so an answer committed
        # before this transaction is seen and kept; an answer racing this
        # transaction hits the FK on a deleted parent and fails LOUDLY on the
        # operator's side, never silently.
        #
        # `vid` GATES THE INSERT AND STILL DOES, which now also covers the two
        # suppressed-insert branches above: a review note is keyed to the
        # blog_version it was asked about, so when no version was committed for
        # these bytes there is no honest row to hang the form on. Attaching it to
        # the previous version instead would file questions about a draft that
        # version is not, which is the stale-form dead end the engine contract
        # spends a section forbidding.
        qj = tdir / "questions.json"
        form = None
        if qj.is_file():
            try:
                form = json.loads(qj.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                form = None
        if form and isinstance(form.get("questions"), list) and vid:
            cur.execute(
                """delete from review_notes n
                   where n.topic_id = %s and n.author = 'evaluator'
                     and n.parent_id is null
                     and not exists (select 1 from review_notes r
                                     where r.parent_id = n.id)""",
                (tid,))
            for item in form["questions"]:
                cur.execute(
                    """insert into review_notes
                         (topic_id, client_id, blog_version_id, author,
                          ref, area, body, why, asked_score, asked_iter)
                       values (%s,%s,%s,'evaluator',%s,%s,%s,%s,%s,%s)
                       on conflict (blog_version_id, ref) do update
                         set body = excluded.body, why = excluded.why,
                             area = excluded.area,
                             asked_score = excluded.asked_score,
                             asked_iter = excluded.asked_iter""",
                    (tid, cid, vid, item.get("id"), item.get("area"),
                     item.get("question") or "", item.get("why"),
                     form.get("score"), form.get("iter")))
        elif form is None and not qj.is_file():
            # No form on disk: the lead deleted it pre-eval or the engine
            # cleared it post-revise. Unanswered notes for this topic follow
            # it, EXCEPT while the topic is held: a needs_review hold is the
            # operator's only door, and commit must never slam it because a
            # mid-run commit fired while the lead had the file deleted.
            if status != "needs_review":
                cur.execute(
                    """delete from review_notes n
                       where n.topic_id = %s and n.author = 'evaluator'
                         and n.parent_id is null
                         and not exists (select 1 from review_notes r
                                         where r.parent_id = n.id)""",
                    (tid,))


def commit_client_facts(client_slug):
    """Push clients/<slug>/canonical-facts.md to the record after a facts build.
    The stopped-facts contract holds because the runner deletes the half-written
    file on cancel BEFORE this runs: an absent file commits an absent record."""
    facts = _read(_client_dir(client_slug) / "canonical-facts.md")
    cid = db.client_id(client_slug)
    if not cid:
        return
    db.q("""update clients set
              canonical_facts = %s,
              canonical_facts_at = case
                when %s::text is null then null
                when canonical_facts is distinct from %s then now()
                else canonical_facts_at end
            where id = %s""",
         (facts, facts, facts, cid), fetch="none")


# ---------------------------------------------------------------------------
# Reconcile: startup sweep for anything a crash stranded on disk
# ---------------------------------------------------------------------------

def reconcile_all():
    """Commit every topic whose scratch is ahead of the record.

    'Ahead' means: more status lines on disk than events in the record, or blog
    bytes that differ from the latest committed version AND ARE NEWER THAN IT.
    Cheap to test, and commit_topic is idempotent, so false positives cost one
    no-op commit. Returns the list of (client, topic) committed, for the startup
    log.

    THE TWO HALVES OF 'AHEAD' ARE NOT INTERCHANGEABLE and this sweep never
    treats them as one boolean. Either half is enough to COMMIT the topic, since
    the dossier, the links file and the status feed all want pushing on either
    signal. Only the blog half may create a VERSION, and it is handed to
    commit_topic as allow_new_version so the decision travels with the evidence
    instead of being re-derived from bytes at the far end. The call site carries
    the full account of what an `or` cost here.

    THE MTIME GUARD IS NOT AN OPTIMISATION, it is what stops this sweep from
    reverting a teammate. Differing bytes were read as "scratch is ahead", which
    is only true when scratch is the NEWER copy. Two engines share one record:
    machine B holds a stale blog.md from a run weeks ago, machine A's operator
    edits the article through the stage page, and B's next boot sees bytes that
    differ and commits its old copy over A's edit, silently, as a new version. An
    older file is BEHIND the record, not ahead of it, so nothing commits it, which
    is the whole of the fix (materialize_topic leaves an existing blog.md alone,
    so the stale copy stays on B's disk; it is scratch, and the apply path already
    reads the record's bytes rather than it). The status-line count stays an
    ahead-signal on its own: status.jsonl is append-only, so more lines can only
    mean this disk saw events the record has not.
    """
    if not OUTPUTS_ROOT.is_dir():
        return []
    committed = []
    for cdir in sorted(OUTPUTS_ROOT.iterdir()):
        if not cdir.is_dir() or cdir.name.startswith("."):
            continue
        slug = cdir.name
        cid = db.client_id(slug)
        if not cid:
            # Case-hazard fold: outputs/BLR-Brewing vs clients/blr-brewing.
            match = db.q(
                "select slug from clients where lower(slug) = lower(%s)",
                (slug,), fetch="val")
            if not match:
                log.warning("reconcile: outputs/%s has no client row, skipped", slug)
                continue
            slug = match
        for tdir in sorted(cdir.iterdir()):
            if not tdir.is_dir():
                continue
            sj = tdir / "status.jsonl"
            disk_lines = 0
            if sj.is_file():
                disk_lines = sum(
                    1 for l in sj.read_text(encoding="utf-8").splitlines()
                    if l.strip())
            tid = db.topic_id(slug, tdir.name)
            db_lines = 0
            db_body = None
            db_committed = None
            if tid:
                db_lines = db.q(
                    "select count(*) from status_events where topic_id = %s",
                    (tid,), fetch="val")
                version = db.q(
                    """select body, committed_at from blog_versions where topic_id = %s
                       order by version_no desc limit 1""", (tid,), fetch="one")
                if version:
                    db_body, db_committed = version
            blog = tdir / "blog.md"
            body = _read(blog)
            # A record with no version at all cannot be ahead of anything, so any
            # blog.md on disk is the only copy and commits. Otherwise the file has
            # to be newer than the version it disagrees with. Clock skew between
            # two machines is real and this comparison cannot see it: a machine
            # running minutes fast can still commit a stale file, and one running
            # minutes slow defers a genuine commit to a later boot. Both are small
            # next to the gap being closed, which is weeks wide (a scratch file
            # left over from an old run against an edit made today), and the
            # sound fix is a version the writer carries, not a tighter clock.
            body_ahead = (
                body is not None and body != db_body
                and (db_committed is None
                     or blog.stat().st_mtime > db_committed.timestamp()))
            # THE TWO AHEAD-SIGNALS ARE SEPARATE FACTS AND THEY MUST STAY
            # SEPARATE, because they are evidence about DIFFERENT artifacts.
            # `lines_ahead` is evidence about status.jsonl and nothing else:
            # the file is append-only, so more lines on disk than in the record
            # can only mean this disk saw events the record has not. It says
            # NOTHING about blog.md, which is not append-only and carries no
            # ordinal to compare.
            #
            # Reading them as one condition is how a stale body committed. The
            # mtime guard lives inside `body_ahead`, so an `or` let the
            # status-line branch call a commit that wrote the body too, and
            # commit_topic's own insert test compares BYTES ONLY: it asks
            # whether the bytes moved, never in which direction or when. A
            # machine holding a blog.md stranded from a run weeks ago, whose
            # status.jsonl happened to carry one line the record lacked, would
            # commit that ancient draft over an admin edit made today as the new
            # latest version, silently, with the guard written to prevent
            # exactly that sitting one operand away and never consulted.
            #
            # So the signals are passed through separately: `lines_ahead` gets
            # the topic committed, `body_ahead` decides on its own whether that
            # commit may create a version. Neither can now authorize the other's
            # write.
            lines_ahead = disk_lines > db_lines
            if lines_ahead or body_ahead:
                # A LIVE topic is skipped: its session owns the scratch and will
                # commit at its own terminal line. Committing under it would
                # push a mid-session half-state into the record.
                try:
                    from . import runner
                    # run["topics"] is a list of dicts everywhere it is built
                    # (see app._live_run_slugs, which reads the same shape), so
                    # the match is on each dict's topic_slug and nothing else.
                    live = any(any(t.get("topic_slug") == tdir.name
                                   for t in (run.get("topics") or [])
                                   if isinstance(t, dict))
                               for run in runner.RUNS.values()
                               if run.get("live") and run.get("client") == slug)
                except Exception:
                    live = False
                if live:
                    log.info("reconcile: %s/%s is in a live run, skipped", slug, tdir.name)
                    continue
                # One topic's failure must not strand every later topic: the
                # sweep is the recovery path, and a recovery path that gives up
                # on its first obstacle recovers nothing behind it.
                try:
                    commit_topic(slug, tdir.name, allow_new_version=body_ahead)
                    committed.append((slug, tdir.name))
                except Exception:
                    log.exception("reconcile: commit failed for %s/%s, continuing",
                                  slug, tdir.name)
    return committed
