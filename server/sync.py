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
    a zero-byte NEEDS_REVIEW marker is a real hold, and blr-brewing's zero-byte
    never-claim.md is a real file."""
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
        """select gates, client_md, canonical_facts, never_claim, description
           from clients where id = %s""", (cid,), fetch="one")
    gates, client_md, facts, never_claim, description = row

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
    if facts is not None:
        (cdir / "canonical-facts.md").write_text(facts, encoding="utf-8")
    else:
        # An absent record means absent scratch. Leaving a stale disk copy here
        # would let preflight pass on facts the record no longer holds.
        (cdir / "canonical-facts.md").unlink(missing_ok=True)
    if never_claim is not None:
        (cdir / "never-claim.md").write_text(never_claim, encoding="utf-8")

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

    dossier, links = db.q(
        "select dossier, links_verified from topics where id = %s",
        (tid,), fetch="one")
    if dossier is not None and not (tdir / "dossier.md").is_file():
        (tdir / "dossier.md").write_text(dossier, encoding="utf-8")
    if links is not None and not (tdir / "links-verified.txt").is_file():
        (tdir / "links-verified.txt").write_text(links, encoding="utf-8")

    latest = db.q(
        """select body, eval_body from blog_versions
           where topic_id = %s order by version_no desc limit 1""",
        (tid,), fetch="one")
    if latest:
        body, eval_body = latest
        if not (tdir / "blog.md").is_file():
            (tdir / "blog.md").write_text(body, encoding="utf-8")
        if eval_body is not None and not (tdir / "eval.md").is_file():
            (tdir / "eval.md").write_text(eval_body, encoding="utf-8")


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


def commit_topic(client_slug, topic_slug):
    """Push one topic's scratch to the record. Idempotent; safe to re-run."""
    tdir = _topic_dir(client_slug, topic_slug)
    if not tdir.is_dir():
        return
    cid = db.client_id(client_slug)
    if not cid:
        log.warning("commit_topic: unknown client %s, leaving scratch", client_slug)
        return
    tid = db.ensure_topic(client_slug, topic_slug)

    # 1. Status lines, keyed by ordinal. The file is append-only, so line N is
    # permanently the same event and re-pushing is a no-op.
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
    with db.tx() as cur:
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

    # 2. Dossier, links, marker. The marker's three writers (engine correction,
    # mock cap-hit, the session lead in-session) all land on the same file, so
    # reading the file at commit time covers every writer without naming them.
    dossier = _read(tdir / "dossier.md")
    links = _read(tdir / "links-verified.txt")
    marker = _read(tdir / "NEEDS_REVIEW")
    mtime = sj.stat().st_mtime if sj.is_file() else None
    db.q("""update topics set
              dossier = coalesce(%s, dossier),
              dossier_at = case when %s::text is not null and dossier is distinct from %s
                                then coalesce(dossier_at, to_timestamp(%s)) else dossier_at end,
              links_verified = coalesce(%s, links_verified),
              review_note = %s
            where id = %s""",
         (dossier, dossier, dossier, mtime, links, marker, tid), fetch="none")

    # 3. The blog version. Insert only when the bytes moved: retries, stops and
    # reconciler re-runs then re-commit nothing. Restores re-commit nothing
    # either, because the restored bytes ARE the previous version's bytes.
    body = _read(tdir / "blog.md")
    eval_body = _read(tdir / "eval.md")
    status, score, iters = _summarize_lines([e for _, e in lines])
    if body:
        latest = db.q(
            """select id, body from blog_versions
               where topic_id = %s order by version_no desc limit 1""",
            (tid,), fetch="one")
        blog_mtime = (tdir / "blog.md").stat().st_mtime
        if latest is None or latest[1] != body:
            h1 = next((l[2:].strip() for l in body.splitlines()
                       if l.startswith("# ")), None)
            vid = db.q(
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
                 blog_mtime), fetch="val")
        else:
            vid = latest[0]
            db.q("""update blog_versions
                    set eval_body = coalesce(%s, eval_body),
                        score = coalesce(%s, score),
                        shipped = shipped or %s
                    where id = %s""",
                 (eval_body, score, status == "done", vid), fetch="none")
        if status == "done":
            db.q("update topics set shipped_version_id = %s where id = %s",
                 (vid, tid), fetch="none")

        # 4. The question form, replacing whole. questions.py rewrites the file
        # whole per eval, so the record mirrors that: unanswered evaluator notes
        # go, the current form comes. Answered notes stay; answers are history.
        qj = tdir / "questions.json"
        if qj.is_file():
            try:
                form = json.loads(qj.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                form = None
            if form and isinstance(form.get("questions"), list):
                with db.tx() as cur:
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
        else:
            # No form on disk: the lead deleted it (pre-eval) or the engine
            # cleared it post-revise. Unanswered notes for this topic follow it.
            db.q("""delete from review_notes n
                    where n.topic_id = %s and n.author = 'evaluator'
                      and n.parent_id is null
                      and not exists (select 1 from review_notes r
                                      where r.parent_id = n.id)""",
                 (tid,), fetch="none")


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
    bytes that differ from the latest committed version. Cheap to test, and
    commit_topic is idempotent, so false positives cost one no-op commit.
    Returns the list of (client, topic) committed, for the startup log.
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
            if tid:
                db_lines = db.q(
                    "select count(*) from status_events where topic_id = %s",
                    (tid,), fetch="val")
                db_body = db.q(
                    """select body from blog_versions where topic_id = %s
                       order by version_no desc limit 1""", (tid,), fetch="val")
            body = _read(tdir / "blog.md")
            if disk_lines > db_lines or (body is not None and body != db_body):
                commit_topic(slug, tdir.name)
                committed.append((slug, tdir.name))
    return committed
