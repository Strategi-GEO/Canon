#!/usr/bin/env python3
"""Static checks for the section a WordPress article is filed under. Sends NOTHING.

THE BUG THIS PINS. On a site whose permalinks are /%category%/%postname%/ the category IS the
URL. push() sent no category, so WordPress applied the site default and a real article landed at
/uncategorized/hi while every other article on that site sat at /blogs/<slug>. It was published,
it was reachable, and it was in a section the blog index does not list.

TWO HALVES, AND THE SECOND IS THE ONE THAT LOOKS OPTIONAL. connect pins the section off the very
article it already resolved the post type from; push sends it ON CREATE ONLY. Sending it on an
update too would move a live URL as a side effect of pressing Post, which is the outcome the
_edited_since guard exists to prevent, arrived at from the other side.

  .venv/bin/python tests/wp_category_check.py
"""
import asyncio
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server.cms import wordpress  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


ROOT = "https://example.test/wp-json/"
ARTICLE = "https://example.test/wp-json/wp/v2/posts/10283"
SITE = {"kind": "wordpress", "url": "https://example.test", "rest_root": ROOT,
        "post_type": "posts", "user": "u", "password": "p", "categories": [8],
        "category_label": "blogs"}
ARTICLE_DOC = {"title": "T", "body_html": "<p>b</p>", "slug": "hi"}


# --------------------------------------------------------------------------- connect half

def resolve(*, article_status=200, article_json=None, cat_status=200, cat_json=None,
            article_url=ARTICLE):
    def handler(request):
        if "wp/v2/categories" in str(request.url):
            return httpx.Response(cat_status, json=cat_json)
        return httpx.Response(article_status, json=article_json)
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await wordpress._resolve_categories(article_url, ROOT, ("u", "p"), client=c)
    return asyncio.run(go())


print("wp_category_check: where an article gets filed. No network.\n")

print("connect reads the section off the exemplar article")
ids, lab = resolve(article_json={"categories": [8]}, cat_json=[{"id": 8, "name": "blogs"}])
check("the exemplar's category ids are pinned", ids == [8], f"got {ids}")
check("the label names the section for the settings card", lab == "blogs", f"got {lab!r}")

ids, lab = resolve(article_json={"categories": [8, 12]},
                   cat_json=[{"id": 8, "name": "blogs"}, {"id": 12, "name": "news"}])
check("several sections are all carried", ids == [8, 12], f"got {ids}")
check("the label lists them", lab == "blogs, news", f"got {lab!r}")

print("\nevery uncertainty degrades to the old behaviour, never to a wrong section")
check("no exemplar (nothing published yet) pins nothing",
      resolve(article_url="") == ([], ""))
check("a post type carrying no categories pins nothing",
      resolve(article_json={"categories": []}) == ([], ""))
check("an article field WordPress omits pins nothing",
      resolve(article_json={}) == ([], ""))
check("a 401 on the article pins nothing rather than raising",
      resolve(article_status=401, article_json={"code": "x"}) == ([], ""))
check("an unreadable article body pins nothing rather than raising",
      resolve(article_json="not-a-dict") == ([], ""))
ids, lab = resolve(article_json={"categories": [8]}, cat_status=500, cat_json={})
check("a failed name lookup costs the label and never the ids",
      (ids, lab) == ([8], ""), f"got {ids} {lab!r}")

print("\nthe label shows the section, so it is visible without publishing one")
check("type and section are both named",
      wordpress.label(SITE) == "example.test (Posts -> blogs)"
      if SITE.get("post_type_label") else True)
check("post_type_label absent falls back to the rest_base",
      wordpress.label(dict(SITE, post_type_label="")) == "example.test (posts -> blogs)",
      wordpress.label(dict(SITE, post_type_label="")))
check("a connection made before this existed still labels cleanly",
      wordpress.label({"url": "https://example.test", "post_type": "posts"}) == "example.test (posts)")


# --------------------------------------------------------------------------- push half

def push(site, remote, existing_cats=(1,)):
    sent = []
    def handler(request):
        import json as _j
        if request.method == "GET":
            return httpx.Response(200, json={"id": 412, "status": "publish",
                                             "categories": list(existing_cats),
                                             "modified_gmt": "2020-01-01T00:00:00"})
        sent.append(_j.loads(request.content or b"{}"))
        return httpx.Response(200, json={"id": 412, "status": "publish", "slug": "hi",
                                         "link": "https://example.test/blogs/hi"})
    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await wordpress.push(ARTICLE_DOC, site, remote, client=c)
    asyncio.run(go())
    return sent[-1] if sent else {}

print("\npush sends the section on create and withholds it on update")
body = push(SITE, None)
check("a NEW article is filed in the pinned section",
      body.get("categories") == [8], f"got {body}")
check("the rest of the body is unchanged",
      body.get("title") == "T" and body.get("status") == "publish" and body.get("slug") == "hi",
      f"got {body}")

body = push(SITE, {"post_id": "412", "pushed_at": None}, existing_cats=(8,))
check("an UPDATE of an article already in the section leaves its URL alone",
      "categories" not in body, f"got {body}")

body = push(SITE, {"post_id": "412", "pushed_at": None}, existing_cats=(8, 12))
check("the client's own extra category is not fought over",
      "categories" not in body, f"got {body}")

print("\nan article filed OUTSIDE the section is moved back, or it is stuck forever")
body = push(SITE, {"post_id": "412", "pushed_at": None}, existing_cats=(1,))
check("an article stranded in Uncategorized is moved to the blog section",
      body.get("categories") == [8], f"got {body}")
check("and it is SET, not unioned, or term 1 would keep winning the permalink",
      body.get("categories") == [8] and 1 not in body.get("categories", []), f"got {body}")

body = push(SITE, {"post_id": "412", "pushed_at": None}, existing_cats=())
check("an article with no categories at all is left alone, not guessed at",
      "categories" not in body, f"got {body}")

body = push({k: v for k, v in SITE.items() if k != "categories"},
            {"post_id": "412", "pushed_at": None}, existing_cats=(1,))
check("a connection with nothing pinned never moves anything",
      "categories" not in body, f"got {body}")

body = push({k: v for k, v in SITE.items() if k != "categories"}, None)
check("a connection with nothing pinned behaves exactly as it did before",
      "categories" not in body, f"got {body}")

body = push(dict(SITE, categories=[]), None)
check("an empty pin is not sent either", "categories" not in body, f"got {body}")

print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} passed")
sys.exit(1 if FAILURES else 0)
