#!/usr/bin/env python3
"""Static checks for publishing to a client's own website. Sends NOTHING over the network.

WordPress is stubbed at the httpx seam, so this asserts the whole connect-and-publish
behaviour without a site, a credential, or a single real article reaching anybody's domain.

The assertions that matter most, in the order they would hurt:

  1. A post type is RESOLVED from the site's own discovery header, never assumed. Posting a
     blog into a post type the client's theme does not render succeeds, records an id, and is
     invisible from every surface: it is the one silent failure in this pipeline.
  2. A page type is REFUSED. This door must never create pages on a client's site.
  3. An article edited on their side after our last push is NOT overwritten.
  4. The published URL is the one the site reported, never one built from a slug.

  .venv/bin/python tests/site_check.py
"""
import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server.cms import sites, wordpress  # noqa: E402
from server.cms.http import TransportError  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


# ---------------------------------------------------------------------------
# Fixtures: a small WordPress, answering the four routes connect and push touch
# ---------------------------------------------------------------------------
ARCHIVE_HTML = """<html><head>
<link rel="https://api.w.org/" href="https://acme.com/wp-json/" />
</head><body>
<nav><a href="https://acme.com/about/">About</a></nav>
<article><a href="https://acme.com/insights/q3-outlook/">Q3 outlook</a></article>
</body></html>"""

# The header that carries the answer. A singular page names its own REST route, and the post
# type is the segment after wp/v2. This is the whole of how the destination is resolved.
ARTICLE_HEADERS = {
    "Content-Type": "text/html",
    "Link": '<https://acme.com/wp-json/>; rel="https://api.w.org/", '
            '<https://acme.com/wp-json/wp/v2/insights/412>; rel="alternate"; '
            'type="application/json"',
}

TYPES = {
    "post": {"rest_base": "posts", "name": "Posts", "hierarchical": False, "viewable": True},
    "page": {"rest_base": "pages", "name": "Pages", "hierarchical": True, "viewable": True},
    "insight": {"rest_base": "insights", "name": "Insights",
                "hierarchical": False, "viewable": True},
    "internal": {"rest_base": "internal", "name": "Internal",
                 "hierarchical": False, "viewable": False},
}


def wp_site(*, types=None, article_headers=None, archive=ARCHIVE_HTML, me_status=200):
    """A stub WordPress. `seen` records every request so a test can assert what was called."""
    seen = []

    def handler(request):
        seen.append(f"{request.method} {request.url}")
        path = request.url.path
        if path.startswith("/wp-json/wp/v2/users/me"):
            return httpx.Response(me_status, json={"name": "Editor"})
        if path.startswith("/wp-json/wp/v2/types"):
            return httpx.Response(200, json=types if types is not None else TYPES)
        if path == "/insights/q3-outlook/":
            return httpx.Response(
                200, text="<html>an article</html>",
                headers=article_headers if article_headers is not None else ARTICLE_HEADERS)
        if path == "/about/":
            return httpx.Response(200, text="<html>a page</html>",
                                  headers={"Content-Type": "text/html"})
        if path in ("/blog", "/blog/"):
            return httpx.Response(200, text=archive, headers={"Content-Type": "text/html"})
        return httpx.Response(404, json={"code": "rest_no_route", "message": "No route"})

    return httpx.AsyncClient(transport=httpx.MockTransport(handler)), seen


CREDS = {"user": "strategi", "password": "abcd efgh ijkl mnop"}


async def run_checks():
    # ---- connect: the post type is READ, not assumed -----------------------------------
    client, seen = wp_site()
    site = await wordpress.connect("https://acme.com/blog", CREDS, client=client)
    check("connect resolves the post type from the article's discovery header",
          site["post_type"] == "insights", site.get("post_type"))
    check("connect keeps the human label for the resolved type",
          site["post_type_label"] == "Insights", site.get("post_type_label"))
    check("connect marks a resolved type verified", site["verified"] is True)
    check("connect stores the origin, not the pasted path",
          site["url"] == "https://acme.com", site.get("url"))
    check("connect reads the REST root the site declares",
          site["rest_root"] == "https://acme.com/wp-json/", site.get("rest_root"))
    check("connect writes nothing to the site",
          all(entry.startswith("GET ") for entry in seen), str(seen))

    # A site whose blog IS the default post type must still resolve, without special-casing.
    client, _ = wp_site(article_headers={
        "Content-Type": "text/html",
        "Link": '<https://acme.com/wp-json/wp/v2/posts/412>; rel="alternate"',
    })
    plain = await wordpress.connect("https://acme.com/blog", CREDS, client=client)
    check("a standard blog resolves to posts", plain["post_type"] == "posts")

    # ---- connect: the refusals ---------------------------------------------------------
    # A page type must never be publishable. This is the guard, not the dropdown.
    client, _ = wp_site(article_headers={
        "Content-Type": "text/html",
        "Link": '<https://acme.com/wp-json/wp/v2/pages/9>; rel="alternate"',
    })
    try:
        await wordpress.connect("https://acme.com/blog", CREDS, client=client)
        check("a hierarchical (page) type is refused", False, "connect succeeded")
    except wordpress.ConnectError as exc:
        check("a hierarchical (page) type is refused", "page type" in str(exc), str(exc))

    # A type WordPress will not render on the front end is where an article goes invisible.
    client, _ = wp_site(article_headers={
        "Content-Type": "text/html",
        "Link": '<https://acme.com/wp-json/wp/v2/internal/9>; rel="alternate"',
    })
    try:
        await wordpress.connect("https://acme.com/blog", CREDS, client=client)
        check("a non-viewable type is refused", False, "connect succeeded")
    except wordpress.ConnectError as exc:
        check("a non-viewable type is refused", "front end" in str(exc), str(exc))

    # The single most common real failure, and it must not read as a wrong password.
    client, _ = wp_site(me_status=401)
    try:
        await wordpress.connect("https://acme.com/blog", CREDS, client=client)
        check("a 401 names the stripped Authorization header", False, "connect succeeded")
    except wordpress.ConnectError as exc:
        check("a 401 names the stripped Authorization header",
              "HTTP_AUTHORIZATION" in str(exc), str(exc))

    # A site with the REST API switched off by a security plugin.
    client, _ = wp_site()

    def no_rest(request):
        return httpx.Response(404, text="not found")
    blocked = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, text=ARCHIVE_HTML,
                                 headers={"Content-Type": "text/html"})
        if r.url.path in ("/blog", "/blog/") else no_rest(r)))
    try:
        await wordpress.connect("https://acme.com/blog", CREDS, client=blocked)
        check("a disabled REST API says so", False, "connect succeeded")
    except wordpress.ConnectError as exc:
        check("a disabled REST API says so", "REST API is not reachable" in str(exc), str(exc))

    # http is refused before a request is made: WordPress does not offer application
    # passwords on a non-SSL site, so such a credential cannot exist.
    try:
        await wordpress.connect("http://acme.com/blog", CREDS, client=client)
        check("a non-https site is refused", False, "connect succeeded")
    except wordpress.ConnectError as exc:
        check("a non-https site is refused", "https" in str(exc), str(exc))

    # ---- connect: an empty site still connects -----------------------------------------
    # A brand-new client has nothing published, so there is no article to read a type off.
    # This must fall back rather than fail: it is the ordinary onboarding case.
    empty = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: (
        httpx.Response(200, json={"name": "Editor"})
        if r.url.path.startswith("/wp-json/wp/v2/users/me") else
        httpx.Response(200, json=TYPES)
        if r.url.path.startswith("/wp-json/wp/v2/types") else
        httpx.Response(200, text='<html><head><link rel="https://api.w.org/" '
                                 'href="https://acme.com/wp-json/" /></head><body/></html>',
                       headers={"Content-Type": "text/html"}))))
    fresh = await wordpress.connect("https://acme.com/blog", CREDS, client=empty)
    check("a site with nothing published still connects",
          fresh["post_type"] == "posts", fresh.get("post_type"))
    check("and is marked unverified rather than claiming confidence",
          fresh["verified"] is False)

    # ---- push --------------------------------------------------------------------------
    article = {"title": "Q3 Outlook", "body_html": "<p>Body</p>",
               "excerpt": "A summary", "slug": "q3-outlook"}
    posted = {}

    def push_handler(request):
        if request.method == "POST":
            import json as _json
            posted.update(_json.loads(request.content))
            return httpx.Response(201, json={
                "id": 412, "link": "https://acme.com/insights/q3-outlook/",
                "slug": "q3-outlook", "status": "publish",
                "modified_gmt": "2026-08-28T10:00:00"})
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(push_handler))
    receipt = await wordpress.push(article, site, None, client=client)
    check("push returns the URL the site reported",
          receipt["url"] == "https://acme.com/insights/q3-outlook/", str(receipt))
    check("push returns the remote id as a string",
          receipt["post_id"] == "412", str(receipt))
    check("a first push reports created", receipt["created"] and not receipt["updated"])
    check("push publishes live rather than filing a draft",
          posted.get("status") == "publish", str(posted.get("status")))
    check("push sends the converted HTML body", posted.get("content") == "<p>Body</p>")
    check("push does not send an author, so the byline is theirs",
          "author" not in posted, str(sorted(posted)))

    # ---- push: the update path and the edit guard ---------------------------------------
    pushed_at = datetime(2026, 8, 28, 10, 0, tzinfo=timezone.utc)

    def existing(modified):
        def handler(request):
            if request.method == "GET":
                return httpx.Response(200, json={
                    "id": 412, "link": "https://acme.com/insights/q3-outlook/",
                    "slug": "q3-outlook", "status": "publish", "modified_gmt": modified})
            return httpx.Response(200, json={
                "id": 412, "link": "https://acme.com/insights/q3-outlook/",
                "slug": "q3-outlook", "status": "publish", "modified_gmt": modified})
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    remote = {"post_id": "412", "pushed_at": pushed_at}

    # Untouched since our push: updating is safe and is what a second press must do.
    untouched = await wordpress.push(article, site, remote,
                                     client=existing("2026-08-28T10:00:00"))
    check("a second push updates the same article rather than duplicating",
          untouched["updated"] and not untouched["created"], str(untouched))
    check("and reports no skip", untouched["skipped"] is None)

    # Edited on their side afterwards: overwriting would destroy their work silently.
    edited = await wordpress.push(article, site, remote,
                                  client=existing("2026-08-29T12:00:00"))
    check("an article edited on their site is NOT overwritten",
          edited["skipped"] == "edited_on_site", str(edited))
    check("and the skip is reported as a success, not an error",
          edited["url"] == "https://acme.com/insights/q3-outlook/", str(edited))

    # No stamp on our side is not evidence of an edit: it must not block every update.
    unknown = await wordpress.push(article, site, {"post_id": "412", "pushed_at": None},
                                   client=existing("2026-08-29T12:00:00"))
    check("an unknown push time does not block an update", unknown["updated"], str(unknown))

    # The pinned type disappearing (a theme change) must name itself, not read as a outage.
    gone = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(404, json={"code": "rest_no_route", "message": "No route"})))
    try:
        await wordpress.push(article, site, None, client=gone)
        check("a vanished post type says reconnect", False, "push succeeded")
    except TransportError as exc:
        check("a vanished post type says reconnect", "reconnect" in str(exc), str(exc))

    # ---- detect ------------------------------------------------------------------------
    wp = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(
        200, text="<html>x</html>",
        headers={"Content-Type": "text/html", "Link": '<https://acme.com/wp-json/>; '
                 'rel="https://api.w.org/"'})))
    check("detect recognises WordPress from its own REST relation",
          await sites.detect("https://acme.com/blog", client=wp) == "wordpress")

    shop = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(
        200, text='<html><script src="https://cdn.shopify.com/x.js"></script></html>',
        headers={"Content-Type": "text/html"})))
    check("detect recognises Shopify", await sites.detect("https://acme.com/blogs/news",
                                                          client=shop) == "shopify")

    sqs = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(
        200, text='<html><div class="sqs-block"></div></html>',
        headers={"Content-Type": "text/html"})))
    detected = await sites.detect("https://acme.com/blog", client=sqs)
    check("detect recognises Squarespace", detected == "squarespace")
    check("and Squarespace is named as unconnectable rather than half-offered",
          "no public API" in sites.UNSUPPORTED.get(detected, ""))

    plain_site = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(
        200, text="<html>a hand built site</html>",
        headers={"Content-Type": "text/html"})))
    check("an unrecognised site answers empty rather than guessing",
          await sites.detect("https://acme.com", client=plain_site) == "")


asyncio.run(run_checks())


# ---------------------------------------------------------------------------
# The registry and the payload adapter: pure, no network
# ---------------------------------------------------------------------------
check("the CMS is a kind with no driver, so routes.py branches on it",
      sites.driver_for(sites.STRATEGI_CMS) is None)
check("wordpress has a driver", sites.driver_for("wordpress") is wordpress)
check("an unknown kind has no driver", sites.driver_for("geocities") is None)
check("published_to for the CMS is its name, not a host",
      sites.host_of({"kind": sites.STRATEGI_CMS}) == "strategi-cms")
check("published_to for a website is its host",
      sites.host_of({"kind": "wordpress", "url": "https://acme.com/x"}) == "acme.com")

# The secret marking is what server/clients.py strips before any HTTP body, so a field that
# stopped being marked would leak a live publishing credential to every admin surface.
check("the application password is marked secret",
      [f["secret"] for f in sites.fields_for("wordpress") if f["key"] == "password"] == [True])
check("the username is not marked secret",
      [f["secret"] for f in sites.fields_for("wordpress") if f["key"] == "user"] == [False])

PAYLOAD = {
    "title": "Q3 Outlook",
    "body_markdown": "## Heading\n\nA para with a [link](https://x.com).\n\n"
                     "| A | B |\n|---|---|\n| 1 | 2 |\n",
    "excerpt": "A summary",
    "suggested_slug": "q3-outlook",
    "meta_title": "Q3 Outlook 2026",
    "tags": ["Acme"],
    "category_name": "Finance",
}
adapted = sites.article_from_payload(PAYLOAD)
check("the adapter converts the body to HTML", "<h2>Heading</h2>" in adapted["body_html"])
check("the comparison table every draft carries survives the conversion",
      "<table>" in adapted["body_html"] and "<td>1</td>" in adapted["body_html"])
check("links survive the conversion",
      '<a href="https://x.com">link</a>' in adapted["body_html"])
# Tags and categories are term IDs in WordPress, not names, so the CMS's brand tag would 400.
check("taxonomy the destination cannot take is dropped rather than sent",
      "tags" not in adapted and "category_name" not in adapted, str(sorted(adapted)))
check("the adapter passes the scored title through unchanged",
      adapted["title"] == "Q3 Outlook")


print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)
print("site_check OK")
