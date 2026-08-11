#!/usr/bin/env python3
"""The bulk-selection routes: ordering, filtering, and the cover label. No DB, no model, no spawn.

The Blogs tab and the channel tabs each replaced their control row with a selection bar, and three
engine surfaces carry it: a `topics` filter on the blogs .docx, a channel .docx that never existed,
and a channel-post DELETE that never existed. What is pinned here is the part a DB test would not
reach anyway, and the part that fails SILENTLY:

  1. ROUTE ORDERING. `/channel/{channel}/download` must be declared before
     `/channel/{channel}/{topic}`, or FastAPI matches "download" as a topic slug. It slugifies
     cleanly, so `_channel_topic_guard` accepts it and the request 404s as an ungenerated post,
     which reads to an operator like their own selection was wrong rather than like a routing bug.
     `/blogs/download-all` has the same shape and the same guard, and it was already relied on.

  2. THE `topics` FILTER IS A FILTER, not a rename of the whole-brand export. An empty or absent
     list must still mean the whole brand on the blogs route, because that is the older call and
     the ledger and any script use it; a non-empty list must narrow.

  3. THE COVER LABEL. build_docx grew a `label` so a LinkedIn bundle does not say "Blog 1". The
     default has to stay exactly "Blog", because every existing caller passes nothing.

  .venv/bin/python tests/bulk_routes_check.py
"""
import io
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import docx_export  # noqa: E402

FAILED = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}{(': ' + detail) if detail else ''}")
        FAILED.append(label)


def route_order():
    """Every literal path segment must be declared before the {param} that would swallow it."""
    from server import app as app_mod

    paths = [r.path for r in app_mod.app.routes if getattr(r, "path", None)]

    def index_of(path):
        return paths.index(path) if path in paths else -1

    print("route ordering")
    for literal, wildcard in (
        ("/api/clients/{slug}/blogs/download-all", "/api/clients/{slug}/blogs/{topic}"),
        ("/api/clients/{slug}/channel/{channel}/download",
         "/api/clients/{slug}/channel/{channel}/{topic}"),
    ):
        li, wi = index_of(literal), index_of(wildcard)
        check(f"{literal} is registered", li >= 0)
        check(f"{wildcard} is registered", wi >= 0)
        check(f"{literal} is declared before {wildcard}", 0 <= li < wi,
              f"literal at {li}, wildcard at {wi}")

    # The DELETE the channel bulk bar calls. A missing method here is a bar with a dead button.
    methods = {
        (r.path, m)
        for r in app_mod.app.routes
        for m in (getattr(r, "methods", None) or ())
    }
    check("DELETE /channel/{channel}/{topic} exists",
          ("/api/clients/{slug}/channel/{channel}/{topic}", "DELETE") in methods)
    check("GET /channel/{channel}/download exists",
          ("/api/clients/{slug}/channel/{channel}/download", "GET") in methods)


def topics_is_a_filter():
    """`topics` narrows; absent and empty both still mean the whole brand on the blogs route."""
    import inspect

    from server import app as app_mod

    print("the topics filter")
    sig = inspect.signature(app_mod.api_blogs_download_all)
    check("blogs download-all takes `topics`", "topics" in sig.parameters)
    check("`topics` defaults to None (absent means the whole brand)",
          sig.parameters["topics"].default is not None
          and getattr(sig.parameters["topics"].default, "default", "unset") is None)

    src = inspect.getsource(app_mod.api_blogs_download_all)
    # The filter is `if wanted:` over a set built from the query, so an EMPTY list falls through
    # to the unfiltered rows. Anything that filtered unconditionally would return an empty
    # document for the whole-brand call.
    check("the row filter is guarded on a non-empty selection", "if wanted:" in src)
    check("it filters on the topic slug column", "row[0] in wanted" in src)

    ch_src = inspect.getsource(app_mod.api_channel_download)
    # The channel route has NO whole-brand form: an empty selection is a 404, never everything.
    check("the channel download 404s an empty selection",
          "if not pieces:" in ch_src and "status_code=404" in ch_src)


def cover_label():
    print("the docx cover label")

    def cover_of(data):
        return zipfile.ZipFile(io.BytesIO(data)).read("word/document.xml").decode()

    default = cover_of(docx_export.build_docx([("T", "body")]))
    check('the default cover still reads "Blog 1"', "Blog 1" in default)

    named = cover_of(docx_export.build_docx([("T", "body"), ("U", "b2")], "LinkedIn post"))
    check("a labelled bundle uses the label", "LinkedIn post 1" in named)
    check("and numbers sequentially over the document", "LinkedIn post 2" in named)
    check("and never says Blog", "Blog 1" not in named)


if __name__ == "__main__":
    route_order()
    topics_is_a_filter()
    cover_label()
    print()
    if FAILED:
        print(f"{len(FAILED)} check(s) failed")
        sys.exit(1)
    print("bulk_routes_check passed")
