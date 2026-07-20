#!/usr/bin/env python3
"""Static house rules for the CLIENT portal surface, in the mold of dashboard-check.py:
each rule records the failure it prevents.

The client portal is now part of the ONE dashboard app, not a separate app: its code lives
under dashboard/src/portal/ (components + client libs), dashboard/src/app/(client)/ (the
client pages), the client-only API routes dashboard/src/app/api/{overview,blog,roadmap}/,
and the client-safe server builders in dashboard/src/lib/server/portal-data.ts. This file
scans EXACTLY those client surfaces and nothing else, because the admin dashboard legitimately
uses scores, evals and iterations, so scanning the whole app would be meaningless.

The client is the one surface EXTERNAL people use, so its rules are mostly about what must be
ABSENT. The client-safe boundary is a promise made in portal-data.ts; this file is what keeps
a later edit from quietly breaking it.

Run: .venv/bin/python tests/portal_check.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DASH = REPO / "dashboard" / "src"

# The client surface, and only it. Dirs are scanned recursively; single files are included
# as-is. The admin dashboard is deliberately OUT of scope.
CLIENT_ROOTS = [
    DASH / "portal",                          # client components + client libs
    DASH / "app" / "(client)",                # client pages (the catch-all)
    DASH / "app" / "api" / "overview",        # client API: overview
    DASH / "app" / "api" / "blog",            # client API: blog detail + answers
    DASH / "app" / "api" / "roadmap",         # client API: read-only roadmap
    DASH / "lib" / "server" / "portal-data.ts",  # client-safe builders
    # The shared comment rail. It lives outside portal/ because BOTH surfaces import it:
    # the client portal renders its own comments in it, and the admin dashboard renders
    # the same rail so an operator can see which passage each client comment annotates.
    # Shared code that reaches a client browser is client surface, and a rule that only
    # scanned portal/ would grade this directory by which folder it happens to sit in
    # rather than by who reads it. It is client-safe BY CONSTRUCTION: zero product
    # vocabulary, and every string it renders arrives as a prop or a child.
    DASH / "components" / "comments",
    # The blog state machine and its tag, for exactly the reason the comment rail is here:
    # BOTH surfaces import them as values, so both ship in the client bundle and both are
    # client surface no matter which folder they live in. This is stricter than the rail,
    # because unlike the rail these two DO carry product vocabulary: blog-state.ts holds
    # ADMIN_TAGS as well as CLIENT_TAGS, so "Internal review" and "Has questions" are
    # already in the client's JavaScript. That is not itself a leak, since no client code
    # path renders them, but it is exactly the ground on which this file refuses to guess:
    # a rule that never scanned the file could not have told anyone either way.
    DASH / "lib" / "blog-state.ts",
    DASH / "components" / "shell" / "blog-state-tag.tsx",
]

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def source_files() -> list[Path]:
    out: set[Path] = set()
    for root in CLIENT_ROOTS:
        if root.is_file():
            out.add(root)
        elif root.is_dir():
            out.update(
                p for p in root.rglob("*")
                if p.suffix in (".ts", ".tsx", ".css") and p.is_file()
            )
    return sorted(out)


def code_only(text: str) -> str:
    """Strip // and /* */ comments so prose about a rule cannot trip the rule."""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"(?<!:)//[^\n]*", "", text)
    return text


FILES = source_files()
if not FILES:
    sys.exit("portal_check: no client source files found under dashboard/src")

# ---------------------------------------------------------------------------
# 1. The client-safe boundary: admin-only record fields must never be selected or
#    typed anywhere on the client surface. A client must not receive scores, evals,
#    dossiers, status internals, or the raw artifact surface, and the cheapest place to
#    stop a regression is the column name itself.
# ---------------------------------------------------------------------------
FORBIDDEN_TOKENS = (
    "eval_body", "dossier", "asked_score", "topic_rollup",
    "status.jsonl", "links-verified", "iterations",
)
for path in FILES:
    body = code_only(path.read_text(encoding="utf-8"))
    for token in FORBIDDEN_TOKENS:
        if token in body:
            fail(f"{path.relative_to(REPO)}: forbidden admin-only token {token!r}")

# score needs word-boundary care (underscore fields above already cover asked_score):
SCORE_RE = re.compile(r"\bscore\b", re.IGNORECASE)
for path in FILES:
    body = code_only(path.read_text(encoding="utf-8"))
    if SCORE_RE.search(body):
        fail(f"{path.relative_to(REPO)}: the word 'score' appears in code; "
             "the client wire carries no scores")

# ---------------------------------------------------------------------------
# 2. No secret key, with zero exceptions. The client surface runs on the anon key plus the
#    user's own JWT; a secret-key read appearing anywhere is the architecture breaking.
# ---------------------------------------------------------------------------
for path in FILES:
    body = path.read_text(encoding="utf-8")
    if "SUPABASE_SECRET" in body or "SERVICE_ROLE" in body:
        fail(f"{path.relative_to(REPO)}: references a Supabase secret/service key")

# ---------------------------------------------------------------------------
# 3. dangerouslySetInnerHTML is confined to the markdown renderer's one safe sink.
#    markdown.ts escapes FIRST, then transforms; anywhere else it is an XSS waiting.
# ---------------------------------------------------------------------------
ALLOWED_DANGEROUS = {"dashboard/src/portal/markdown-view.tsx"}
for path in FILES:
    if "dangerouslySetInnerHTML" in code_only(path.read_text(encoding="utf-8")):
        rel = str(path.relative_to(REPO))
        if rel not in ALLOWED_DANGEROUS:
            fail(f"{rel}: dangerouslySetInnerHTML outside the markdown sink")

# The renderer keeps its escape-first property: escapeHtml must run inside renderMarkdown
# before any transform, which the first-line `escapeHtml(source` call pattern witnesses.
md = (DASH / "portal" / "markdown.ts").read_text(encoding="utf-8")
if "escapeHtml(source" not in md:
    fail("dashboard/src/portal/markdown.ts: renderMarkdown no longer escapes first")
# The scheme guard never names javascript: in code; its witness is the allowlist plus the
# drop-to-# arm that neutralizes every other scheme.
if "(https?:|mailto:|tel:)" not in md or 'return "#"' not in md:
    fail("dashboard/src/portal/markdown.ts: the unsafe-scheme guard looks removed")

# ---------------------------------------------------------------------------
# 4. localStorage is the shared session.ts's alone. No client component or lib reads it
#    directly (they import from @/lib/session), so any localStorage on the client surface
#    is a stale-identity bug waiting to happen.
# ---------------------------------------------------------------------------
for path in FILES:
    if "localStorage" in code_only(path.read_text(encoding="utf-8")):
        fail(f"{path.relative_to(REPO)}: localStorage on the client surface (use @/lib/session)")

# ---------------------------------------------------------------------------
# 5. House typography: no em or en dashes in client source, the same rule the content
#    gates and dashboard-check enforce everywhere else in this project.
# ---------------------------------------------------------------------------
for path in FILES:
    text = path.read_text(encoding="utf-8")
    for ch, name in (("—", "em dash"), ("–", "en dash")):
        if ch in text:
            fail(f"{path.relative_to(REPO)}: contains an {name}")

# ---------------------------------------------------------------------------
# 6. The client's surfaces are exactly: the brand space (overview, the read-only roadmap tab
#    and the resources tab) and the blog page, plus its own /api. No create, repurpose,
#    settings, new, generate or upload routes may exist for clients: the operator's
#    requirement, stated as a directory rule the same way dashboard-check bans global route
#    dirs.
#
#    RESOURCES USED TO BE ON THE FORBIDDEN LIST AND THE PRODUCT DECISION REVERSED, which is
#    named here because a future reader finding it gone will otherwise go hunting for the bug
#    that removed it. Resources is now the one surface the client owns outright: they are the
#    ONLY people who upload and manage the documents their brand's research reads, and an
#    admin can read those files and nothing more. portal/nav.ts carries the same reversal in
#    its own words, and it is the row's ownership running the opposite way from every other
#    row that earns it the place.
#
#    Leaving the name here would have been a trap rather than a guard. The rule passed only by
#    the accident that the resources tab is rendered by the (client) catch-all page, so no
#    directory named resources exists under it; the first person to give that tab a route of
#    its own would have been told they had leaked an admin capability when what they shipped
#    was the client's own surface.
#
#    THE TEETH DO NOT MOVE. Every remaining name is an ADMIN act and stays banned: `upload` is
#    the operator's upload-a-written-blog flow against a roadmap topic, not the client's
#    resource upload, which is a control and a dialog inside the resources tab rather than a
#    route of its own. The roadmap stays GET-only below, and rule 7 is what actually bounds
#    what a client may WRITE, resources included.
# ---------------------------------------------------------------------------
CLIENT_APP = DASH / "app" / "(client)"
FORBIDDEN_ROUTES = ("create", "repurpose", "settings", "new", "generate", "upload")
if CLIENT_APP.is_dir():
    for path in CLIENT_APP.rglob("*"):
        if path.is_dir() and path.name in FORBIDDEN_ROUTES:
            fail(f"{path.relative_to(REPO)}: forbidden client-facing route directory")

# The roadmap surface is read-only: its route module may export GET and nothing else.
roadmap_route = DASH / "app" / "api" / "roadmap" / "[brand]" / "route.ts"
if roadmap_route.is_file():
    body = code_only(roadmap_route.read_text(encoding="utf-8"))
    for verb in ("POST", "PUT", "PATCH", "DELETE"):
        if re.search(rf"export\s+(async\s+)?function\s+{verb}\b", body):
            fail(f"{roadmap_route.relative_to(REPO)}: roadmap must be read-only, found {verb}")
else:
    fail("dashboard/src/app/api/roadmap/[brand]/route.ts is missing")

# ---------------------------------------------------------------------------
# 7. The client write surface: the vetted allowlist of SECURITY DEFINER functions, one per
#    act a client may perform. A function outside the list means the write surface grew
#    without this file hearing about it, and a missing door means a client act silently lost
#    the route that reached it.
#
#    THIS USED TO SAY "EXACTLY THE FOUR" AND IT MISSED THE FIFTH, which is worth stating
#    because the shape of the miss is what the rule now defends against. The surface grew in
#    SQL, not in TypeScript: portal_resource_add arrived as a migration, and a rule that only
#    reads rpc() call sites cannot see a function that has no caller in this app yet. So the
#    allowlist below is checked from BOTH ends. The call sites may not name anything off it,
#    and the SQL may not DECLARE a portal_ function that is not on it, and the second half is
#    the one that would have caught the fifth on the day it landed.
#
#    THE LIST IS SIX AND TWO OF THE SIX HAVE NO DOOR IN SCOPE, which is expected rather than
#    broken. The four blog-loop writes are called from app/api/blog/<brand>/<topic>/, squarely
#    inside CLIENT_ROOTS, so each of those must still be reachable and CLIENT_WRITE_DOORS
#    demands it. The two resource writes are called from app/api/clients/<slug>/resources/,
#    which serves BOTH surfaces and is deliberately out of this file's scope, so requiring a
#    door for them here would fail on a route this scan cannot read. They are allowed and
#    bounded, not asserted present.
# ---------------------------------------------------------------------------
CLIENT_WRITES = {
    # The blog review loop: answer the evaluator, suggest a change to a passage, reply in a
    # comment thread, approve the article as sent.
    "portal_submit_answers",
    "portal_suggest_change",
    "portal_reply_comment",
    "portal_approve_blog",
    # The client's own fact base, and the reason rule 6 no longer forbids a resources route:
    # the client is the only person who uploads and removes these documents, so these two are
    # client writes in a way no admin_ function is. Both arrive in migration 016, and their
    # callers are the POST on app/api/clients/<slug>/resources/ and the DELETE on that route's
    # [name] child.
    "portal_resource_add",
    "portal_resource_remove",
}
CLIENT_WRITE_DOORS = {"portal_submit_answers", "portal_suggest_change", "portal_reply_comment",
                      "portal_approve_blog"}
rpc_calls = []
for path in FILES:
    body = code_only(path.read_text(encoding="utf-8"))
    rpc_calls += [
        (str(path.relative_to(REPO)), m)
        for m in re.findall(r"rpc[<(]\s*[^,]*,\s*[\"']([a-z_]+)[\"']", body)
    ]
# The teeth: anything the client surface calls that is not on the allowlist. An admin_
# function reaching a client route lands here, and so does an unvetted portal_ one.
for where, name in sorted(set(rpc_calls)):
    if name not in CLIENT_WRITES:
        fail(f"{where}: calls {name!r}, which is not on the client write allowlist")
for expected in sorted(CLIENT_WRITE_DOORS):
    if not any(name == expected for _, name in rpc_calls):
        fail(f"no client route calls {expected} any more")

# The SQL half: a portal_ function that exists in the schema and is not on the allowlist is
# the client write surface growing where the call-site scan cannot see it, which is exactly
# how portal_resource_add went unnoticed. Migrations are read alongside schema.sql because a
# function is real to a reviewer the moment its migration is written, not when it is applied.
sql_files = [REPO / "supabase" / "schema.sql"]
sql_files += sorted((REPO / "supabase" / "migrations").glob("*.sql"))
DEFINED_RE = re.compile(r"create\s+or\s+replace\s+function\s+(portal_[a-z_]+)")
for path in sql_files:
    if not path.is_file():
        continue
    for name in sorted(set(DEFINED_RE.findall(path.read_text(encoding="utf-8")))):
        if name not in CLIENT_WRITES:
            fail(f"{path.relative_to(REPO)}: declares {name!r}, a client write function this "
                 "check has never vetted; add it to CLIENT_WRITES once it is reviewed")

# ---------------------------------------------------------------------------
# 8. blog_comments.author_email never crosses the client wire. The column carries whoever
#    filed the comment, and on operator rows that is a Strategi email: a select that reaches
#    for it would hand every portal login the team's addresses. The DB grant already blocks
#    it; this catches the select before it 500s in production.
# ---------------------------------------------------------------------------
for path in FILES:
    body = code_only(path.read_text(encoding="utf-8"))
    if "author_email" in body:
        fail(f"{path.relative_to(REPO)}: selects or names author_email on a client surface")

# ---------------------------------------------------------------------------

if failures:
    for msg in failures:
        print(f"  FAIL  {msg}")
    print(f"\n{len(failures)} portal check(s) failed")
    sys.exit(1)

print(f"  ok  client-safe boundary: no admin-only tokens across {len(FILES)} files")
print("  ok  no secret key anywhere")
print("  ok  dangerouslySetInnerHTML confined to the markdown sink; renderer escapes first")
print("  ok  no localStorage on the client surface")
print("  ok  no em or en dashes")
print("  ok  no create/repurpose/settings/upload routes; resources are the client's own; "
      "roadmap is GET-only")
print(f"  ok  write surface is within the {len(CLIENT_WRITES)} vetted portal definer "
      "functions, and every blog-loop door is reachable")
print("  ok  author_email never crosses the client wire")
print("\nall portal checks passed")
