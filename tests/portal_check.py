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
# 6. The client's surfaces are exactly: the brand space (overview + read-only roadmap tab)
#    and the blog page, plus its own /api. No create, repurpose, resources, settings, or new
#    routes may exist for clients: the operator's requirement, stated as a directory rule the
#    same way dashboard-check bans global route dirs.
# ---------------------------------------------------------------------------
CLIENT_APP = DASH / "app" / "(client)"
FORBIDDEN_ROUTES = ("create", "repurpose", "resources", "settings", "new", "generate", "upload")
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
# 7. The client write surface: exactly the four SECURITY DEFINER functions, one per act a
#    client may perform (answer the evaluator, suggest a change, reply in a comment thread,
#    approve the article). A fifth RPC appearing means the client write surface grew
#    without this file hearing about it, and a missing one means a client act silently lost
#    its door.
# ---------------------------------------------------------------------------
CLIENT_WRITES = {"portal_submit_answers", "portal_suggest_change", "portal_reply_comment",
                 "portal_approve_blog"}
rpc_calls = []
for path in FILES:
    body = code_only(path.read_text(encoding="utf-8"))
    rpc_calls += [
        (str(path.relative_to(REPO)), m)
        for m in re.findall(r"rpc[<(]\s*[^,]*,\s*[\"']([a-z_]+)[\"']", body)
    ]
names = {name for _, name in rpc_calls}
if names != CLIENT_WRITES and rpc_calls:
    fail(f"unexpected rpc surface: {sorted(names)} (expected {sorted(CLIENT_WRITES)})")
for expected in sorted(CLIENT_WRITES):
    if not any(name == expected for _, name in rpc_calls):
        fail(f"no client route calls {expected} any more")

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
print("  ok  no create/repurpose/resources/settings routes; roadmap is GET-only")
print("  ok  write surface is exactly the four portal definer functions")
print("  ok  author_email never crosses the client wire")
print("\nall portal checks passed")
