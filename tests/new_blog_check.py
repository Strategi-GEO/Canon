#!/usr/bin/env python3
"""The off-roadmap create endpoint (POST /blogs/new). Spawns NOTHING, calls NO model, touches
NO real DB: the heavy upload_blog is stubbed, so this drives only api_create_blog's OWN logic.

api_create_blog is the door for a blog the roadmap never planned. Unlike api_upload_blog it has
no roadmap row to read, so it does three things itself before delegating to the SAME upload_blog:
it derives the title from the article's first '# ' H1 (the exact line sync commits as h1_title,
so the two cannot drift and the label is never the ugly slug), it slugifies that title, and it
refuses a live run, a titleless article, and a slug that already exists. This pins each branch,
and pins that on the happy path it hands upload_blog empty covers, empty prompts and replace=False
so the article lands scoreless in internal review exactly like every other uploaded blog.

  .venv/bin/python tests/new_blog_check.py
"""
import asyncio
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import app as appmod  # noqa: E402
from fastapi import HTTPException  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


class FakeUser:
    email = "operator@example.com"


def run(body, *, live=False, existing_topic=None):
    """Drive api_create_blog with the heavy parts stubbed. Returns (result, upload_calls) or
    raises HTTPException, exactly as the endpoint does."""
    calls = []

    def fake_upload_blog(client_slug, topic_slug, title, covers, prompts, blog_body,
                         email, replace):
        calls.append(dict(client_slug=client_slug, topic_slug=topic_slug, title=title,
                          covers=covers, prompts=prompts, body=blog_body, email=email,
                          replace=replace))
        return {"topic_slug": topic_slug, "word_count": len(blog_body.split()),
                "version_no": 1, "replaced": False, "gates": {}}

    orig = {
        "_client_or_404": appmod._client_or_404,
        "_client_has_live_run": appmod._client_has_live_run,
        "topic_id": appmod.db.topic_id,
        "upload_blog": appmod.blog_upload.upload_blog,
    }
    appmod._client_or_404 = lambda slug, user: None
    appmod._client_has_live_run = lambda slug: live
    appmod.db.topic_id = lambda slug, topic_slug: existing_topic
    appmod.blog_upload.upload_blog = fake_upload_blog
    try:
        result = asyncio.run(appmod.api_create_blog(
            "acme", appmod.NewBlogRequest(body=body), FakeUser()))
        return result, calls
    finally:
        appmod._client_or_404 = orig["_client_or_404"]
        appmod._client_has_live_run = orig["_client_has_live_run"]
        appmod.db.topic_id = orig["topic_id"]
        appmod.blog_upload.upload_blog = orig["upload_blog"]


def status_of(fn):
    try:
        fn()
    except HTTPException as exc:
        return exc.status_code
    return None


# Happy path: title from the first '# ' line, slug derived, upload_blog fed off-roadmap defaults.
result, calls = run("# My New Title\n\nThe body of the article, with words.")
check("happy path returns upload_blog's result", result and result["topic_slug"] == "my-new-title",
      repr(result))
check("delegates exactly once", len(calls) == 1, repr(calls))
if calls:
    c = calls[0]
    check("title is the H1 text", c["title"] == "My New Title", repr(c["title"]))
    check("slug is slugified title", c["topic_slug"] == "my-new-title", repr(c["topic_slug"]))
    check("covers empty (no roadmap row)", c["covers"] == "", repr(c["covers"]))
    check("prompts empty (no roadmap row)", c["prompts"] == [], repr(c["prompts"]))
    check("replace is False (create, never overwrite)", c["replace"] is False, repr(c["replace"]))
    check("full body passed through incl. H1", c["body"].startswith("# My New Title"), repr(c["body"][:20]))
    check("uploader email threaded", c["email"] == "operator@example.com", repr(c["email"]))

# The H1 is the FIRST '# ' line, and '## ' is not an H1 (parity with sync's startswith('# ')).
_, calls = run("Intro line\n\n## Not the title\n\n# Real Title\n\nbody")
check("skips non-H1, takes first real '# '", calls and calls[0]["title"] == "Real Title",
      repr(calls[0]["title"]) if calls else "no call")

# Refusals: each is an HTTPException with the documented status, and none reaches upload_blog.
check("no H1 anywhere is 422", status_of(lambda: run("Just prose, no heading at all.")) == 422)
check("H1 present but empty is 422",
      status_of(lambda: run("#  \n\nbody")) == 422)
check("title with no alphanumerics (empty slug) is 422",
      status_of(lambda: run("# !!!\n\nbody")) == 422)
check("a live run is 409", status_of(lambda: run("# Title\n\nbody", live=True)) == 409)
check("an existing slug is 409",
      status_of(lambda: run("# Title\n\nbody", existing_topic="some-topic-id")) == 409)


def refused_never_delegates(body, **kw):
    calls_seen = []
    orig = appmod.blog_upload.upload_blog
    appmod.blog_upload.upload_blog = lambda *a, **k: calls_seen.append(a)
    try:
        try:
            run(body, **kw)
        except HTTPException:
            pass
    finally:
        appmod.blog_upload.upload_blog = orig
    return calls_seen


check("a refused create never writes anything",
      refused_never_delegates("no heading", ) == []
      and refused_never_delegates("# Title\n\nx", live=True) == [], "upload_blog was reached")

print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
sys.exit(1 if FAILURES else 0)
