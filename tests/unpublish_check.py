#!/usr/bin/env python3
"""Static checks for the unpublish path. Sends NOTHING over the network.

The WordPress driver is stubbed at the httpx seam, so every branch of the retraction is
asserted without a site, a credential, or a single request leaving the machine.

THE ASSERTION THAT MATTERS MOST is the branch ORDER inside wordpress.unpublish. The
already-draft check must come BEFORE the edited-on-site check, because our own status flip
bumps the post's modified stamp: if a record write fails after a successful flip, the retry
must recognise a post we already drafted rather than accusing the client of editing it.

  .venv/bin/python tests/unpublish_check.py
"""
import asyncio
import sys
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server.cms import gate, sites, wordpress  # noqa: E402
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


SITE = {"kind": "wordpress", "url": "https://acme.com", "rest_root": "https://acme.com/wp-json/",
        "post_type": "posts", "user": "u", "password": "p"}
REMOTE = {"post_id": "412", "pushed_at": None}


def _transport(get_json, get_status=200, write_status=200, seen=None):
    """One stubbed httpx transport. Records every request into `seen`."""
    def handler(request: httpx.Request):
        if seen is not None:
            seen.append((request.method, str(request.url)))
        if request.method == "GET":
            return httpx.Response(get_status, json=get_json)
        return httpx.Response(write_status, json={"id": 412, "status": "draft",
                                                  "slug": "s", "link": "https://acme.com/s"})
    return httpx.MockTransport(handler)


def run(get_json, *, get_status=200, write_status=200, remote=REMOTE, **kw):
    seen = []
    async def go():
        async with httpx.AsyncClient(
                transport=_transport(get_json, get_status, write_status, seen)) as c:
            return await wordpress.unpublish(SITE, remote, client=c, **kw)
    return asyncio.run(go()), seen


print("unpublish_check: driver branches, gate refusals, registry dispatch. No network.\n")

print("the four no-write branches")
res, seen = run(None, get_status=404)
check("a post already gone from their site is skipped, not an error",
      res.get("skipped") == "gone", f"got {res}")
check("  and nothing is written for it",
      not any(m != "GET" for m, _ in seen), f"got {seen}")

res, seen = run({"status": "draft", "modified_gmt": "2026-01-01T00:00:00"})
check("a post already drafted is skipped as already_draft",
      res.get("skipped") == "already_draft", f"got {res}")
check("  and nothing is written for it",
      not any(m != "GET" for m, _ in seen), f"got {seen}")

# published, and modified AFTER our push: the client edited it.
res, seen = run({"status": "publish", "modified_gmt": "2026-06-01T00:00:00"},
                remote={"post_id": "412", "pushed_at": __import__("datetime").datetime(2026, 1, 1)})
check("a post edited on their site since our push is skipped, not clobbered",
      res.get("skipped") == "edited_on_site", f"got {res}")
check("  and nothing is written for it",
      not any(m != "GET" for m, _ in seen), f"got {seen}")

print("\nORDER: already_draft is tested BEFORE edited_on_site")
# A post we already drafted, whose modified stamp our own flip bumped past pushed_at. If the
# order were reversed this would read as the client having edited it.
res, _ = run({"status": "draft", "modified_gmt": "2026-06-01T00:00:00"},
             remote={"post_id": "412", "pushed_at": __import__("datetime").datetime(2026, 1, 1)})
check("a retry after a failed record write sees already_draft, never edited_on_site",
      res.get("skipped") == "already_draft",
      f"got {res.get('skipped')!r} -- the retry would accuse the client of an edit nobody made")

print("\nthe write branch")
res, seen = run({"status": "publish", "modified_gmt": "2026-01-01T00:00:00"})
check("a live post is flipped, not deleted",
      res.get("skipped") is None and any(m == "POST" for m, _ in seen), f"got {res} {seen}")
check("  the flip is a status change to draft",
      any(m == "POST" for m, _ in seen), f"got {seen}")
check("  and it never issues a DELETE by default",
      not any(m == "DELETE" for m, _ in seen), f"got {seen}")

res, seen = run({"status": "publish", "modified_gmt": "2026-01-01T00:00:00"}, hard=True)
check("hard=True uses the trash, which is what DELETE means here",
      any(m == "DELETE" for m, _ in seen), f"got {seen}")

res, _ = run({"status": "publish", "modified_gmt": "2026-06-01T00:00:00"},
             remote={"post_id": "412", "pushed_at": __import__("datetime").datetime(2026, 1, 1)},
             force=True)
check("force=True writes through an edited-on-site post",
      res.get("skipped") is None, f"got {res}")

print("\nrefusals")
try:
    asyncio.run(wordpress.unpublish(SITE, {"post_id": None}, client=None))
    check("no post id is refused before any request", False, "did not raise")
except TransportError as e:
    check("no post id is refused before any request", e.status == 409, f"status {e.status}")

# The Strategi CMS used to be the second arm here, refused because nothing could retract what
# was filed through one ingest endpoint. Migration 038 removed it, so what is left is the one
# refusal: a brand with no website connected has nothing to take an article down from.
try:
    gate.assert_site_destination({"kind": ""}, "brand", "topic")
    check("an unconnected brand is refused", False, "did not raise")
except gate.PublishRefused as e:
    check("an unconnected brand is refused with a named reason",
          e.status == "no_destination", f"got {e.status}")

try:
    gate.assert_site_destination({"kind": "wordpress"}, "brand", "topic")
    check("a website destination is allowed", True)
except gate.PublishRefused as e:
    check("a website destination is allowed", False, str(e))

print("\nregistry")
check("unpublish is an OPTIONAL fifth driver name",
      getattr(wordpress, "unpublish", None) is not None)
try:
    asyncio.run(sites.unpublish({"kind": "nope"}, REMOTE))
    check("an unknown destination raises UnknownDestination", False, "did not raise")
except sites.UnknownDestination:
    check("an unknown destination raises UnknownDestination", True)
check("shopify is named as unsupported rather than falling through silently",
      "shopify" in sites.UNSUPPORTED)

print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
if FAILURES:
    print("FAILED: " + ", ".join(FAILURES))
    sys.exit(1)
