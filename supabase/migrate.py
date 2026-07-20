#!/usr/bin/env python3
"""Migrate the GEO Factory corpus from disk into Supabase.

    python3 supabase/migrate.py --check          # read + report, touch nothing
    python3 supabase/migrate.py --schema --apply # build schema, then load data

READ-ONLY against the source tree. This script never writes, renames, or deletes
anything under the source repo. `outputs/` and `clients/*/uploads/` are
gitignored, so there is NO version-control copy of the corpus to recover from;
the only safe posture is to not touch it.

Idempotent. --schema drops and rebuilds the public content schema, and the data
load is keyed so a re-run replaces rather than duplicates.

WHY IT IMPORTS THE APP'S OWN PARSERS INSTEAD OF RE-READING THE FILES
-------------------------------------------------------------------
Every count ever quoted for this corpus by hand has been wrong, in the same way.
"147 ledger rows" is 153 physical lines minus 6 headers; the real number is 72,
because 69 rows carry newlines inside quoted cells. "115 roadmap lines" is 49
rows. CLAUDE.md warns about exactly this and the warning was not enough. So this
script does not parse a CSV. It calls roadmap.load_roadmap() and csv.DictReader
and lets the app say what its own data is.

That has a live consequence: server/roadmap.py is currently DIRTY in the source
tree (a concurrent session is editing it), so the parser here is the working-tree
parser, not the committed one. This script therefore MEASURES and reports counts
rather than asserting hardcoded ones. EXPECTED below is a tripwire, not a
contract: a mismatch prints and, without --force, stops. If the corpus legitimately
changed, re-check the number and update it deliberately.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

# --------------------------------------------------------------------------
# Paths. The corpus lives in the MAIN repo, never in this worktree: outputs/ is
# gitignored, so a git worktree of this branch has no copy of it at all.
# --------------------------------------------------------------------------
HERE = pathlib.Path(__file__).resolve().parent          # <worktree>/supabase
WORKTREE = HERE.parent
DEFAULT_SOURCE = WORKTREE.parent / "geo-factory"        # the engine + the data

# Tripwires, measured with the app's own parsers. Not contracts: see the docstring.
#
# UPDATED 2026-07-17, deliberately, after the tripwire fired and caught a live
# repair in progress. status_events moved 1339 -> 1343 and ledger_entries moved
# 72 -> 68, and the two deltas are one event: the engine's "asking holds the
# blog at any score" rule change was applied to the four blr-brewing blogs that
# had shipped at 95/96 over their own unanswered questions. Each got one
# appended needs_review line (+4 events) and had its ledger row removed
# (-4 rows), un-shipping it. The four are liquid-journey,
# the-best-places-to-celebrate-a-birthday, where-to-get-ramen, and
# where-to-host-a-large-company-party: the same four every audit of this corpus
# independently flags as its only real mess.
#
# These numbers were re-measured after the tree went quiet, not overridden with
# --force while it was moving. If they drift again, find out why before touching
# them: the number is not the point, knowing what changed is.
EXPECTED = {
    "orgs": 1,            # EXPLICIT orgs only; the other 4 are derived by org_membership
    "clients": 6,
    "client_resources": 5,
    "roadmap_uploads": 39,
    "roadmap_sheets": 5,  # acme-north has no roadmap.csv
    "roadmap_rows": 49,   # BUILT rows; read_sheet's raw preview is 50 (acme-south's blank)
    "topics": 50,
    "blog_versions": 50,
    "status_events": 1343,
    "ledger_entries": 68,
    "review_notes": 16,   # 16 question items across 9 questions.json; 0 answers.json
}

RESOURCE_BUCKET = "resources"


def log(msg=""):
    print(msg, flush=True)


def die(msg):
    print(f"\nFATAL: {msg}", file=sys.stderr)
    sys.exit(1)


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------
def load_env(source_root):
    """Read server/.env from THIS worktree.

    The secret key must never reach an agent session: runner.py hands
    env=dict(os.environ) to the Claude CLI subprocess under acceptEdits, and its
    allowed_tools list is a skip-the-prompt list, not a sandbox. This process is
    the server side of that boundary and holds the key legitimately; it must not
    export it into anything it spawns. This script spawns nothing.
    """
    env = {}
    envfile = WORKTREE / "server" / ".env"
    if envfile.is_file():
        for line in envfile.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    for k in ("SUPABASE_URL", "SUPABASE_SECRET_KEY", "DATABASE_URL"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def import_app(source_root):
    """Import the engine's own parsers from the SOURCE tree."""
    sys.path.insert(0, str(source_root))
    try:
        from server import clients as clients_mod
        from server import roadmap as roadmap_mod
    except Exception as exc:
        die(f"cannot import the app's parsers from {source_root}: {type(exc).__name__}: {exc}")
    return clients_mod, roadmap_mod


# --------------------------------------------------------------------------
# Reading the corpus
# --------------------------------------------------------------------------
def read_text(path):
    """Return file text, or None if absent.

    '' and None are DIFFERENT and the difference is load-bearing: one NEEDS_REVIEW
    marker is zero bytes. Collapsing empty into absent loses the fact that the file
    exists at all, which for a NEEDS_REVIEW marker is the entire signal.
    """
    p = pathlib.Path(path)
    if not p.is_file():
        return None
    return p.read_text(encoding="utf-8", errors="replace")


def resolve_output_dir(outputs_root, client_slug):
    """Find a client's output folder, casefold-matching, asserting one hit.

    THE CASE HAZARD: the folder on disk is outputs/BLR-Brewing while the client is
    clients/blr-brewing. They genuinely differ. The app resolves them only because
    APFS case-folds; on a case-sensitive filesystem the engine would not find them
    at all. 10 topics, 264 status lines, and all 9 questions.json hang off this.
    Match explicitly and refuse ambiguity rather than inheriting the accident.
    """
    if not outputs_root.is_dir():
        return None
    hits = [d for d in outputs_root.iterdir()
            if d.is_dir() and d.name.casefold() == client_slug.casefold()]
    if not hits:
        return None
    if len(hits) > 1:
        die(f"outputs/ holds {len(hits)} folders matching '{client_slug}' "
            f"case-insensitively: {[h.name for h in hits]}. Fold them by hand first.")
    return hits[0]


def collect(source_root, clients_mod, roadmap_mod):
    """Read the whole corpus into plain dicts. Touches nothing."""
    corpus = {"clients": [], "orgs": {}}
    clients_root = source_root / "clients"
    outputs_root = source_root / "outputs"

    for cdir in sorted(clients_root.iterdir()):
        if not cdir.is_dir():
            continue
        slug = cdir.name
        gates_path = cdir / "gates.json"
        gates = json.loads(gates_path.read_text()) if gates_path.is_file() else {}

        # EXPLICIT orgs only. clients.py deliberately does NOT write a
        # self-referencing org to gates.json, because storing it twice invites
        # the two copies to disagree after a rename. Self-orgs are derived by the
        # org_membership view, which is what reproduces the 4 orgs /api/orgs returns.
        org = gates.get("organisation")
        if org and org.get("slug"):
            corpus["orgs"][org["slug"]] = org.get("name") or org["slug"]

        rec = {
            "slug": slug,
            "name": gates.get("name") or slug,
            "domain": gates.get("domain") or "",
            "industry": gates.get("industry") or "",
            "description": gates.get("description") or "",
            "demo_mode": bool(gates.get("demo_mode", False)),
            "org_slug": (org or {}).get("slug"),
            # gates MINUS organisation: org_id models it, and two homes drift.
            "gates": {k: v for k, v in gates.items() if k != "organisation"},
            "client_md": read_text(cdir / "client.md"),
            "canonical_facts": read_text(cdir / "canonical-facts.md"),
            "resources": [],
            "uploads": [],
            "sheet": None,
            "rows": [],
            "ledger": [],
            "topics": [],
        }

        # Resources: capital R is deliberate. A lowercase variant would create a
        # folder that uploads land in and no agent ever reads.
        rdir = cdir / "Resources"
        if rdir.is_dir():
            for f in sorted(rdir.iterdir()):
                if not f.is_file() or f.name.startswith("."):
                    continue
                raw = f.read_bytes()
                rec["resources"].append({
                    "name": f.name,                    # verbatim: canonical-facts.md
                    "sha256": hashlib.sha256(raw).hexdigest(),   # cites the brochure by
                    "size": len(raw),                  # its exact filename, so the name
                    "path": f,                         # must never be sanitized away
                })

        udir = cdir / "uploads"
        if udir.is_dir():
            for f in sorted(udir.iterdir()):
                if not f.is_file() or f.name.startswith("."):
                    continue
                rec["uploads"].append({"filename": f.name, "raw": f.read_bytes()})

        # Roadmap: the app's parser is the authority on raw-vs-built.
        if (cdir / "roadmap.csv").is_file():
            raw_sheet = roadmap_mod.read_sheet(slug)      # raw preview rows
            built = roadmap_mod.load_roadmap(slug)        # ingestable rows
            built_rows = built["rows"] if isinstance(built, dict) else built
            rec["sheet"] = {
                "filename": raw_sheet.get("filename") or "roadmap.csv",
                "raw_csv": (cdir / "roadmap.csv").read_text(encoding="utf-8", errors="replace"),
                "columns": raw_sheet.get("columns") or [],
                "modified": raw_sheet.get("modified"),
                "raw_row_count": len(raw_sheet.get("rows") or []),
            }
            for r in built_rows:
                topic = r.get("topic") or ""
                rec["rows"].append({
                    "row_index": r.get("index"),
                    "topic": topic,
                    "covers": r.get("covers") or "",
                    "prompts": list(r.get("prompts") or []),
                    "extras": r.get("extras") or [],
                    # The app's OWN slugify. A second implementation of a slug
                    # rule is a second thing to drift.
                    "topic_slug": roadmap_mod.slugify(topic) if topic.strip() else None,
                })

        # Ledger: csv.DictReader, never line splitting.
        g = cdir / "generated.csv"
        if g.is_file():
            with g.open(newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    raw_score = (row.get("score") or "").strip()
                    rec["ledger"].append({
                        "topic_slug": row.get("topic_slug") or "",
                        "topic": row.get("topic") or "",
                        "covers": row.get("covers") or "",
                        # ledger.py newline-joins prompts on write; split them back.
                        "prompts": [p for p in (row.get("prompts") or "").split("\n") if p.strip()],
                        # record_success writes "" for a None score, so NULLIF at
                        # ingest. All 72 rows are numeric today, which is why a
                        # query-time cast has not thrown yet: latent, not safe.
                        "score": int(raw_score) if raw_score else None,
                        "generated_at": row.get("generated_at") or None,
                        # TEXT: 4 rows carry the literal 'retro-fix', and RUNS is
                        # an in-process dict so no run record exists regardless.
                        "run_id": row.get("run_id") or None,
                    })

        # Topics
        odir = resolve_output_dir(outputs_root, slug)
        if odir:
            rec["output_dirname"] = odir.name
            for tdir in sorted(odir.iterdir()):
                if not tdir.is_dir():
                    continue
                blog = tdir / "blog.md"
                if not blog.is_file():
                    continue
                events = []
                sj = tdir / "status.jsonl"
                if sj.is_file():
                    for i, line in enumerate(sj.read_text(encoding="utf-8").splitlines()):
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            events.append((i, json.loads(line)))
                        except json.JSONDecodeError:
                            die(f"malformed status line {i} in {sj}")
                questions = []
                qj = tdir / "questions.json"
                if qj.is_file():
                    qdata = json.loads(qj.read_text(encoding="utf-8"))
                    questions = qdata.get("questions", qdata) if isinstance(qdata, dict) else qdata
                    qscore = qdata.get("score") if isinstance(qdata, dict) else None
                    qiter = qdata.get("iter") if isinstance(qdata, dict) else None
                else:
                    qscore = qiter = None

                body = blog.read_text(encoding="utf-8", errors="replace")
                rec["topics"].append({
                    "slug": tdir.name,
                    "body": body,
                    "h1_title": next((l[2:].strip() for l in body.splitlines()
                                      if l.startswith("# ")), None),
                    "word_count": len(body.split()),
                    "eval_body": read_text(tdir / "eval.md"),
                    "dossier": read_text(tdir / "dossier.md"),
                    "links_verified": read_text(tdir / "links-verified.txt"),
                    "review_note": read_text(tdir / "NEEDS_REVIEW"),
                    "events": events,
                    "questions": questions,
                    "questions_score": qscore,
                    "questions_iter": qiter,
                    # mtime, NOT now(): the app's history falls back to blog.md's
                    # mtime for a blog's date, and now() re-sorts every migrated
                    # blog to today.
                    "mtime": blog.stat().st_mtime,
                })
        corpus["clients"].append(rec)
    return corpus


def summarise(corpus):
    """Fold the corpus into the counts the tripwires check."""
    n = {k: 0 for k in EXPECTED}
    n["orgs"] = len(corpus["orgs"])
    n["clients"] = len(corpus["clients"])
    for c in corpus["clients"]:
        n["client_resources"] += len(c["resources"])
        n["roadmap_uploads"] += len(c["uploads"])
        n["roadmap_sheets"] += 1 if c["sheet"] else 0
        n["roadmap_rows"] += len(c["rows"])
        n["ledger_entries"] += len(c["ledger"])
        n["topics"] += len(c["topics"])
        n["blog_versions"] += len(c["topics"])   # exactly one version per topic at migration
        for t in c["topics"]:
            n["status_events"] += len(t["events"])
            n["review_notes"] += len(t["questions"])
    return n


def report(corpus, counts):
    log("=" * 72)
    log("SOURCE CORPUS, as measured by the app's own parsers")
    log("=" * 72)
    log(f"{'client':<22} {'topics':>6} {'events':>7} {'ledger':>7} {'rows':>5} "
        f"{'res':>4} {'upl':>4}  docs")
    for c in corpus["clients"]:
        ev = sum(len(t["events"]) for t in c["topics"])
        docs = ",".join(k for k in ("client_md", "canonical_facts") if c[k] is not None)
        empty = [k for k in ("client_md", "canonical_facts")
                 if c[k] is not None and c[k] == ""]
        note = f"  (EMPTY: {','.join(empty)})" if empty else ""
        odir = c.get("output_dirname")
        case = f"  [outputs/{odir}]" if odir and odir != c["slug"] else ""
        log(f"{c['slug']:<22} {len(c['topics']):>6} {ev:>7} {len(c['ledger']):>7} "
            f"{len(c['rows']):>5} {len(c['resources']):>4} {len(c['uploads']):>4}  {docs}{note}{case}")
    log("")
    log(f"{'table':<20} {'found':>7} {'expected':>9}   status")
    drift = []
    for k, want in EXPECTED.items():
        got = counts[k]
        ok = "ok" if got == want else "DRIFT"
        if got != want:
            drift.append((k, got, want))
        log(f"{k:<20} {got:>7} {want:>9}   {ok}")
    for c in corpus["clients"]:
        if c["sheet"]:
            raw, built = c["sheet"]["raw_row_count"], len(c["rows"])
            if raw != built:
                log(f"\nnote: {c['slug']} sheet has {raw} raw rows and {built} built rows. "
                    f"Both are correct: _build_rows drops a row only when EVERY cell is "
                    f"blank, and it enumerates before skipping, so row_index legitimately "
                    f"has gaps. raw_csv preserves the preview; roadmap_rows holds the build.")
    return drift


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------
def connect(env):
    try:
        import psycopg
    except ImportError:
        die("psycopg is not installed. Run:\n"
            "  python3 -m venv .venv && .venv/bin/pip install 'psycopg[binary]'\n"
            "and re-run with .venv/bin/python")
    dsn = env.get("DATABASE_URL")
    if not dsn:
        die("DATABASE_URL is not set.\n\n"
            "The sb_secret_ key authenticates PostgREST and Auth, but it cannot run\n"
            "DDL. Loading this corpus needs a real Postgres connection.\n\n"
            "Supabase dashboard: Project Settings -> Database -> Connection string\n"
            "-> URI (use the Session pooler URI). Then append it to server/.env as:\n"
            "  DATABASE_URL=postgresql://...\n\n"
            "server/.env is gitignored. Do not paste it into a chat window.")
    return psycopg.connect(dsn)


def run_schema(conn, sql_path):
    log(f"\napplying {sql_path.name} ...")
    with conn.cursor() as cur:
        cur.execute(sql_path.read_text())
    conn.commit()
    log("schema applied")


def load(conn, corpus, env, do_storage=True):
    import psycopg
    from psycopg.types.json import Json

    org_id, client_id, topic_id = {}, {}, {}
    with conn.cursor() as cur:
        for slug, name in sorted(corpus["orgs"].items()):
            cur.execute("insert into orgs (slug,name) values (%s,%s) returning id", (slug, name))
            org_id[slug] = cur.fetchone()[0]
        log(f"  orgs               {len(org_id)}")

        for c in corpus["clients"]:
            cur.execute(
                """insert into clients
                     (org_id,slug,name,domain,industry,description,
                      client_md,canonical_facts,demo_mode,gates)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
                (org_id.get(c["org_slug"]), c["slug"], c["name"], c["domain"],
                 c["industry"], c["description"], c["client_md"], c["canonical_facts"],
                 c["demo_mode"], Json(c["gates"])))
            client_id[c["slug"]] = cur.fetchone()[0]
        log(f"  clients            {len(client_id)}")

        n_up = 0
        for c in corpus["clients"]:
            for u in c["uploads"]:
                cur.execute(
                    "insert into roadmap_uploads (client_id,filename,raw) values (%s,%s,%s)",
                    (client_id[c["slug"]], u["filename"], u["raw"]))
                n_up += 1
        log(f"  roadmap_uploads    {n_up}")

        n_sheet = n_row = 0
        for c in corpus["clients"]:
            if not c["sheet"]:
                continue
            s = c["sheet"]
            cur.execute(
                """insert into roadmap_sheets (client_id,filename,raw_csv,columns,modified)
                   values (%s,%s,%s,%s,%s) returning id""",
                (client_id[c["slug"]], s["filename"], s["raw_csv"], s["columns"], s["modified"]))
            sheet_id = cur.fetchone()[0]
            n_sheet += 1
            for r in c["rows"]:
                cur.execute(
                    """insert into roadmap_rows
                         (sheet_id,client_id,row_index,topic,covers,prompts,extras,topic_slug)
                       values (%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (sheet_id, client_id[c["slug"]], r["row_index"], r["topic"],
                     r["covers"], r["prompts"], Json(r["extras"]), r["topic_slug"]))
                n_row += 1
        log(f"  roadmap_sheets     {n_sheet}")
        log(f"  roadmap_rows       {n_row}")

        n_ver = n_ev = n_note = 0
        for c in corpus["clients"]:
            cid = client_id[c["slug"]]
            for t in c["topics"]:
                # dossier_at is stamped in the same statement, from mtime, because
                # the CHECK requires it to be present exactly when dossier is.
                cur.execute(
                    """insert into topics
                         (client_id,slug,title,dossier,dossier_at,links_verified,review_note)
                       values (%s,%s,%s,%s,
                               case when %s::text is null then null else to_timestamp(%s) end,
                               %s,%s)
                       returning id""",
                    (cid, t["slug"], t["h1_title"], t["dossier"],
                     t["dossier"], t["mtime"],
                     t["links_verified"], t["review_note"]))
                tid = cur.fetchone()[0]
                topic_id[(c["slug"], t["slug"])] = tid

                for line_no, e in t["events"]:
                    cur.execute(
                        """insert into status_events
                             (topic_id,client_id,line_no,ts,stage,event,iter,score,status,note,slug_reported)
                           values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (tid, cid, line_no, e.get("ts"), e.get("stage"), e.get("event"),
                         e.get("iter"), e.get("score"),
                         e.get("status") or "running", e.get("note") or "", e.get("slug")))
                    n_ev += 1

                # The score the fold would report, used for this version's score.
                cur.execute("select score from topic_rollup where topic_id = %s", (tid,))
                rollup_score = cur.fetchone()[0]
                cur.execute("select coalesce(max(iter),1) from status_events where topic_id=%s", (tid,))
                last_iter = cur.fetchone()[0]

                cur.execute(
                    """insert into blog_versions
                         (topic_id,client_id,version_no,iteration,body,h1_title,
                          word_count,score,eval_body,shipped,committed_at)
                       values (%s,%s,1,%s,%s,%s,%s,%s,%s,true,to_timestamp(%s)) returning id""",
                    (tid, cid, min(max(last_iter, 1), 8), t["body"], t["h1_title"],
                     t["word_count"], rollup_score, t["eval_body"], t["mtime"]))
                vid = cur.fetchone()[0]
                n_ver += 1
                cur.execute("update topics set shipped_version_id=%s where id=%s", (vid, tid))

                for i, q in enumerate(t["questions"], start=1):
                    if not isinstance(q, dict):
                        continue
                    body = (q.get("question") or "").strip()
                    if not body:
                        continue
                    cur.execute(
                        """insert into review_notes
                             (topic_id,client_id,blog_version_id,author,ref,area,body,why,asked_score)
                           values (%s,%s,%s,'evaluator',%s,%s,%s,%s,%s)""",
                        (tid, cid, vid, q.get("id") or f"q{i}", q.get("area"),
                         body, q.get("why"), t["questions_score"]))
                    n_note += 1
        log(f"  topics             {len(topic_id)}")
        log(f"  blog_versions      {n_ver}")
        log(f"  status_events      {n_ev}")
        log(f"  review_notes       {n_note}")

        n_led = 0
        for c in corpus["clients"]:
            for e in c["ledger"]:
                cur.execute(
                    """insert into ledger_entries
                         (client_id,topic_slug,topic,covers,prompts,score,generated_at,run_id)
                       values (%s,%s,%s,%s,%s,%s,coalesce(%s::timestamptz,now()),%s)
                       on conflict (client_id,topic_slug) do nothing""",
                    (client_id[c["slug"]], e["topic_slug"], e["topic"], e["covers"],
                     e["prompts"], e["score"], e["generated_at"], e["run_id"]))
                n_led += cur.rowcount
        log(f"  ledger_entries     {n_led}")

    conn.commit()

    if do_storage:
        upload_resources(conn, corpus, env, client_id)


def upload_resources(conn, corpus, env, client_id):
    """Push Resources bytes to a PRIVATE Storage bucket, then index them."""
    url = env.get("SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        log("\n  SKIPPING Storage: SUPABASE_URL / SUPABASE_SECRET_KEY not set")
        return

    def api(method, path, data=None, ctype="application/json"):
        req = urllib.request.Request(f"{url}{path}", method=method, data=data)
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("apikey", key)
        if data is not None:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # Private bucket. Private + no storage.objects policy = secret key only; the
    # portal gets signed URLs. A public bucket would serve every client's
    # knowledge base to anyone who guesses a path.
    #
    # file_size_limit is set AT CREATION so a fresh project is born with the 25 MiB
    # cap rather than acquiring it from a migration afterwards. It matters because
    # migration 015 grants authenticated members a direct INSERT into storage.objects,
    # which a 25 MiB browser upload past Vercel's 4.5 MB body cap requires, and from
    # that point no server of ours ever weighs the bytes: portal_resource_add's size
    # check runs after the upload has landed and reads a number the browser supplied.
    # storage-api checks this limit against the bytes themselves, during the upload and
    # before any SQL of ours runs, so it is the only statement of the cap a client
    # cannot route around. 26214400 is MAX_RESOURCE_BYTES in server/clients.py and the
    # bound on the client_resources.size_bytes check constraint; the three move together
    # or the smallest of them silently becomes the real limit.
    #
    # No allowed_mime_types, deliberately. A client knowledge base is heterogeneous by
    # design and an allowlist would reject documents a client is entitled to upload,
    # while the type itself is only a header the caller sends and can be relabelled at
    # will. Size is the one property of an upload that cannot be misdeclared, so it
    # carries this alone. Migration 015 states the same reasoning at more length.
    #
    # file_size_limit caps ONE object and nothing else, so it is not the whole story and
    # this comment must not read as though it were. Migration 017 adds the per-brand
    # AGGREGATE bound, a trigger on storage.objects reading resource_prefix_max_objects()
    # and resource_prefix_max_bytes(), because a write seat can otherwise PUT distinct
    # 25 MiB objects under its own prefix without end and never index one, and an object
    # nobody indexed is invisible to every reader this product has. That trigger governs
    # THIS push too: RLS bypass is not trigger bypass, so the secret key below is bounded
    # by the same numbers the portal is. The measured corpus is 5 files and about 12.8 MB,
    # far under both caps, so a Storage upload failing with "which is its limit of" means
    # the corpus outgrew a default nobody revisited, and the fix is the literal in
    # supabase/schema.sql rather than an exemption here.
    #
    # This payload governs CREATION only. Storage answers "already exists" for a bucket
    # that is already there and changes nothing about it, so a project that predates
    # this line gets its cap from migration 015's update rather than from here.
    status, body = api("POST", "/storage/v1/bucket",
                       json.dumps({"id": RESOURCE_BUCKET, "name": RESOURCE_BUCKET,
                                   "public": False,
                                   "file_size_limit": 26214400}).encode())
    if status not in (200, 201) and b"already exists" not in body:
        log(f"  bucket create -> {status} {body[:160]!r}")

    n = 0
    with conn.cursor() as cur:
        for c in corpus["clients"]:
            for r in c["resources"]:
                key_path = f"{c['slug']}/{r['sha256']}"
                raw = r["path"].read_bytes()
                st, bd = api("POST", f"/storage/v1/object/{RESOURCE_BUCKET}/{key_path}",
                             raw, "application/octet-stream")
                if st in (200, 201):
                    pass
                elif st == 409 or b"Duplicate" in bd or b"already exists" in bd:
                    log(f"    {c['slug']}/{r['name']}: already in Storage, content-addressed so identical")
                else:
                    die(f"Storage upload failed for {c['slug']}/{r['name']}: {st} {bd[:200]!r}")

                # Verify the bytes that landed are the bytes we sent. The key is
                # the sha256, so a mismatch means a different file is sitting at
                # this content address, which is the one thing content addressing
                # is supposed to make impossible.
                st, got = api("GET", f"/storage/v1/object/{RESOURCE_BUCKET}/{key_path}")
                if st != 200:
                    die(f"Storage read-back failed for {key_path}: {st}")
                if hashlib.sha256(got).hexdigest() != r["sha256"]:
                    die(f"Storage round-trip CORRUPTED {c['slug']}/{r['name']}: "
                        f"sha256 of the stored object does not match the source file")

                cur.execute(
                    """insert into client_resources
                         (client_id,name,object_path,sha256,size_bytes)
                       values (%s,%s,%s,%s,%s)
                       on conflict (client_id,name) do update
                         set object_path=excluded.object_path,
                             sha256=excluded.sha256,
                             size_bytes=excluded.size_bytes""",
                    (client_id[c["slug"]], r["name"],
                     f"{RESOURCE_BUCKET}/{key_path}", r["sha256"], r["size"]))
                n += 1
    conn.commit()
    log(f"  client_resources   {n}  (uploaded and sha256-verified)")


def verify(conn, corpus):
    """Assert the loaded database says what the disk says."""
    log("\n" + "=" * 72)
    log("VERIFY")
    log("=" * 72)
    ok = True
    with conn.cursor() as cur:
        for table, want in EXPECTED.items():
            cur.execute(f"select count(*) from {table}")
            got = cur.fetchone()[0]
            flag = "ok" if got == want else "MISMATCH"
            if got != want:
                ok = False
            log(f"  {table:<20} {got:>6} / {want:<6} {flag}")

        # The derived org count is what /api/orgs must return: 4, from 1 stored row.
        cur.execute("select count(distinct org_slug) from org_membership")
        got = cur.fetchone()[0]
        log(f"  {'org_membership':<20} {got:>6} / {4:<6} {'ok' if got == 4 else 'MISMATCH'}")
        ok &= got == 4

        # The fold must reproduce the engine's own summary.
        cur.execute("select status, count(*) from topic_rollup group by 1 order by 1")
        log(f"  topic_rollup       {dict(cur.fetchall())}")

        # The ledger's score must agree with the fold wherever a blog exists.
        cur.execute("""
            select count(*) from ledger_entries le
              join topics t on t.client_id = le.client_id and t.slug = le.topic_slug
              join topic_rollup r on r.topic_id = t.id
             where le.score is distinct from r.score""")
        bad = cur.fetchone()[0]
        log(f"  ledger vs fold     {bad:>6} disagreements {'ok' if bad == 0 else 'INVESTIGATE'}")
        ok &= bad == 0

        # RLS must be ON everywhere, or the portal's first publishable key opens
        # the whole corpus to the internet.
        cur.execute("""
            select count(*) from pg_tables
             where schemaname='public' and not rowsecurity""")
        norls = cur.fetchone()[0]
        log(f"  tables without RLS {norls:>6} {'ok' if norls == 0 else 'INSECURE'}")
        ok &= norls == 0
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", default=str(DEFAULT_SOURCE),
                    help="the geo-factory repo holding clients/ and outputs/")
    ap.add_argument("--check", action="store_true", help="read and report only; touch nothing")
    ap.add_argument("--schema", action="store_true", help="apply schema.sql first (DROPS the content schema)")
    ap.add_argument("--apply", action="store_true", help="actually write to Supabase")
    ap.add_argument("--no-storage", action="store_true", help="skip the Resources upload")
    ap.add_argument("--force", action="store_true", help="proceed despite count drift")
    args = ap.parse_args()

    source = pathlib.Path(args.source).resolve()
    if not (source / "clients").is_dir():
        die(f"no clients/ under {source}")
    log(f"source: {source}")
    if not (source / "outputs").is_dir():
        log("warning: no outputs/ here, so there are no blogs to migrate")

    clients_mod, roadmap_mod = import_app(source)
    corpus = collect(source, clients_mod, roadmap_mod)
    counts = summarise(corpus)
    drift = report(corpus, counts)

    if drift and not args.force:
        log("\nCOUNT DRIFT against the tripwires:")
        for k, got, want in drift:
            log(f"  {k}: found {got}, expected {want}")
        log("\nThe corpus is not what this script was written against. Re-measure and\n"
            "update EXPECTED deliberately, or re-run with --force if the change is\n"
            "understood and intended.")
        if not args.check:
            sys.exit(2)

    if args.check:
        log("\n--check: nothing was written.")
        return

    if not args.apply:
        log("\nDry run. Re-run with --apply to write. Add --schema to build the schema first.")
        return

    env = load_env(source)
    conn = connect(env)
    try:
        if args.schema:
            run_schema(conn, HERE / "schema.sql")
        log("\nloading ...")
        load(conn, corpus, env, do_storage=not args.no_storage)
        ok = verify(conn, corpus)
        log("\n" + ("MIGRATION COMPLETE, every check passed." if ok else
                    "MIGRATION FINISHED WITH MISMATCHES. Read the VERIFY block above."))
        sys.exit(0 if ok else 3)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
