#!/usr/bin/env python3
"""Static checks for server/cms/. Sends NOTHING over the network.

The CMS is stubbed at the httpx seam, so this suite can assert the retry policy and the
refusals without a key, a server, or a single real draft reaching client.strategi.is.

The assertion that matters most is the first block: a blog that is not `done` must never
produce a payload, let alone a request. A CMS draft is directly approvable by an editor, so
that gate is the only thing standing between a needs_review piece and a client.

  .venv/bin/python tests/cms_check.py
"""
import asyncio
import json
import sys
import tempfile
from pathlib import Path

import httpx

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server.cms import gate, payload  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


BLOG = """# Buying a Second Home in Your 40s

**TL;DR:** A second home works when the loan closes before retirement, per
[Aditya Birla Capital](https://example.com/loan) (August 2025).

## Should you buy one?

Yes, when the purchase rests on usable years [not a promise](https://example.com/loan).

## Sources and References

- Aditya Birla Capital, "Age Limit For Home Loan," 18 August 2025. https://example.com/loan
- Reserve Bank of India, "Housing Loans" FAQ. https://example.com/rbi
"""


class FakeRunner:
    """The runner seams gate.py touches, and nothing else.

    Deliberately not the real runner: this suite is about the gate's decision, and importing
    the SDK-spawning module to test a status check would be testing the wrong thing.

    fetch_status_lines and fetch_blog are the gate's Supabase-era injection seams: a runner
    that carries them answers instead of the record, which is what keeps this suite off the
    live database while the fixtures stay plain files in a temp root.
    """

    def __init__(self, root, status_lines):
        self.root = Path(root)
        self.status_lines = status_lines

    def fetch_status_lines(self, client_slug, topic_slug):
        return list(self.status_lines)

    def fetch_blog(self, client_slug, topic_slug):
        path = self.root / client_slug / topic_slug / "blog.md"
        if not path.is_file():
            return None
        return path.read_text(encoding="utf-8")

    def _summarize(self, topic_slug, lines):
        terminal = None
        for line in reversed(lines):
            if line.get("status") in {"done", "needs_review", "failed"}:
                terminal = line
                break
        return {"topic_slug": topic_slug, "status": terminal["status"] if terminal else "running"}


class FakeLedger:
    def __init__(self, rows):
        self.rows = rows

    def ledger_slugs(self, client_slug):
        return self.rows


def _seed(root, slug, topic_slug, text=BLOG):
    out = Path(root) / slug / topic_slug
    out.mkdir(parents=True, exist_ok=True)
    (out / "blog.md").write_text(text, encoding="utf-8")
    return out


def _gate_for(root, status, slug="acme", topic_slug="second-home"):
    _seed(root, slug, topic_slug)
    lines = [] if status is None else [{"stage": "eval", "event": "end", "status": status}]
    return FakeRunner(root, lines), FakeLedger({topic_slug: {"prompts": "is it worth it"}})


def stub_transport(handler):
    """An httpx client whose every request is answered by `handler`, offline."""
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), timeout=1.0)


# ---------------------------------------------------------------------------
# The gate: only `done` may reach the CMS
# ---------------------------------------------------------------------------
print("\nGate: only a shipped blog is publishable")
with tempfile.TemporaryDirectory() as tmp:
    for status in ("needs_review", "failed", "running"):
        runner, led = _gate_for(tmp, status if status != "running" else None)
        try:
            gate.build_for_publish(runner, led, "acme", "second-home")
            check(f"{status} is refused", False, "it built a payload")
        except gate.PublishRefused as refused:
            check(f"{status} is refused", True)
            if status != "running":
                check(
                    f"{status} refusal names the state",
                    status in str(refused),
                    str(refused),
                )

    runner, led = _gate_for(tmp, "done")
    built = gate.build_for_publish(runner, led, "acme", "second-home")
    check("done builds a payload", built["title"] == "Buying a Second Home in Your 40s")

    # A blog directory with no blog.md is a topic that never got written.
    runner = FakeRunner(tmp, [{"status": "done"}])
    try:
        gate.build_for_publish(runner, FakeLedger({}), "acme", "ghost-topic")
        check("a missing blog.md is refused", False, "it built a payload")
    except gate.PublishRefused:
        check("a missing blog.md is refused", True)

    # A real blog for a real client must still publish.
    _seed(tmp, "vacation-village", "a-real-topic")
    runner = FakeRunner(tmp, [{"status": "done"}])
    real = gate.build_for_publish(runner, FakeLedger({}), "vacation-village", "a-real-topic")
    check("a REAL blog for the same client still publishes", real["title"] != "")


# ---------------------------------------------------------------------------
# The payload: deterministic, allowlisted, and honest about what it lacks
# ---------------------------------------------------------------------------
print("\nPayload: deterministic and allowlisted")
built = payload.build_payload("acme", "second-home", BLOG, prompts="is it worth it\nbest age")

check("schema version is the literal 1", built["ingest_schema_version"] == 1)
# The routing slug. It was overridable per brand while the Strategi CMS existed, because that
# CMS could know a brand under a different slug and routed each draft by this field. The CMS is
# gone (migration 038) and the website driver reads none of it, so the brand slug is the only
# answer and there is no override left to test.
check("client is the brand slug", built["client"] == "acme")
check("title is the H1", built["title"] == "Buying a Second Home in Your 40s")
check("H1 is not repeated in the body", not built["body_markdown"].startswith("# Buying"))
check(
    "body is the draft minus the H1, byte for byte",
    built["body_markdown"] == BLOG.split("\n", 1)[1].strip("\n"),
)
check("suggested_slug is the topic slug", built["suggested_slug"] == "second-home")
check("source_system names this engine", built["source_system"] == "geo-factory")

check(
    "excerpt is the TL;DR as plain text",
    built["excerpt"].startswith("A second home works when the loan closes")
    and "**" not in built["excerpt"]
    and "https://" not in built["excerpt"],
    built.get("excerpt", ""),
)

check("target_queries split on newlines", built["target_queries"] == ["is it worth it", "best age"])
check(
    "target_queries split on pipes too",
    payload.build_payload("acme", "s", BLOG, prompts="a | b")["target_queries"] == ["a", "b"],
)

urls = [c["url"] for c in built["citations"]]
check("citations come from the Sources section", urls == ["https://example.com/loan", "https://example.com/rbi"])
check(
    "a source linked twice is cited once",
    len(urls) == len(set(urls)),
    str(urls),
)
check(
    "citation carries its full source line as the title",
    built["citations"][0]["title"].startswith("Aditya Birla Capital,"),
    built["citations"][0].get("title", ""),
)

# ---------------------------------------------------------------------------
# Citation parsing: the audit reproduced every one of these against REAL blogs
# ---------------------------------------------------------------------------
print("\nCitations: real source lines, parsed without corruption")

paren = payload.extract_citations(
    '## Sources and References\n\n- Wikipedia, "Coffee (beverage)," 2024. https://en.wikipedia.org/wiki/Coffee_(beverage)\n'
)
check(
    "a URL ending in a real ')' is NOT truncated",
    paren[0]["url"] == "https://en.wikipedia.org/wiki/Coffee_(beverage)",
    paren[0]["url"],
)
wrapped = payload.extract_citations(
    "## Sources and References\n\n- Coffee Board (see https://coffeeboard.gov.in/data)\n"
)
check(
    "a ')' belonging to the PROSE is still stripped",
    wrapped[0]["url"] == "https://coffeeboard.gov.in/data",
    wrapped[0]["url"],
)

two = payload.extract_citations(
    '## Sources and References\n\n- Board, "Report," 2025. https://a.example.com/one and https://b.example.com/two\n'
)
check("a source line with two URLs yields TWO citations", len(two) == 2, str(two))
check(
    "and neither citation's title leaks a raw URL",
    all("http" not in c.get("title", "") for c in two),
    str([c.get("title") for c in two]),
)

md_link = payload.extract_citations(
    "## Sources and References\n\n- [Coffee Board of India, 2025](https://coffeeboard.gov.in/x)\n"
)
check(
    "a markdown-link source yields a clean URL",
    md_link[0]["url"] == "https://coffeeboard.gov.in/x",
    md_link[0]["url"],
)
check(
    "and its title has no leftover '](' wreckage",
    "](" not in md_link[0].get("title", "") and md_link[0].get("title") == "Coffee Board of India, 2025",
    md_link[0].get("title", ""),
)

colon = payload.extract_citations(
    '## Sources and References\n\n- Publisher, "Title," 1 January 2026: https://x.example.com/a\n'
)
check(
    "a title does not end on a dangling colon",
    not colon[0]["title"].endswith(":"),
    colon[0]["title"],
)

check(
    "no forbidden key is ever emitted",
    not (set(built) & {"status", "published_at", "slug", "body_html", "body_json", "org_id"}),
)
check("every key is on the CMS allowlist", set(built) <= payload.ALLOWED_KEYS)
check(
    "per-piece topic tags are still not invented",
    built.get("tags") in (None, ["Acme Co"]),
    str(built.get("tags")),
)

check(
    "the same draft always builds the same payload",
    payload.build_payload("acme", "second-home", BLOG)
    == payload.build_payload("acme", "second-home", BLOG),
)


# ---------------------------------------------------------------------------
# Byline, SEO fields, category and tag: all DERIVED, never written
# ---------------------------------------------------------------------------
print("\nByline, SEO, category and tag: derived from gated text")

rich = payload.build_payload(
    "acme", "second-home", BLOG, prompts="a", industry="real-estate", brand_name="Acme Co",
)

check("the operator's byline is requested", rich["author_name"] == "Prasanna Kumar")
check("the industry maps to a category", rich["category_name"] == "Real Estate")
check("the brand is the only tag", rich["tags"] == ["Acme Co"])
check(
    "an unknown industry sends NO category rather than inventing one",
    "category_name" not in payload.build_payload("acme", "s", BLOG, industry="under-water-basket-weaving"),
)
check(
    "a client with no brand name sends no tag",
    "tags" not in payload.build_payload("acme", "s", BLOG, industry="legal"),
)
check(
    "the closed map never emits a humanised slug",
    payload.category_for("technology-saas") == "Technology & SaaS"
    and payload.category_for("hr-recruitment") == "HR & Recruitment",
)

# meta_title: cut on the colon seam, never mid-word, never below a useful floor.
LONG = "Best Microbreweries in Bangalore: How to Choose, and Where BLR Brewing Co. Fits by Occasion"
check("a long title cuts at the colon seam", payload.meta_title_from(LONG) == "Best Microbreweries in Bangalore")
check(
    "a short title is left untouched",
    payload.meta_title_from("Buying a Second Home in Your 40s")
    == "Buying a Second Home in Your 40s",
)
check(
    "a tiny head is not used as the SEO title",
    payload.meta_title_from("FAQ: " + "x" * 80) != "FAQ",
)
check(
    "a cut never leaves the title dangling on a preposition",
    payload.meta_title_from("Where to Get Ramen, Sushi and Craft Beer Under One Roof in Bangalore")
    == "Where to Get Ramen, Sushi and Craft Beer Under One Roof",
    payload.meta_title_from("Where to Get Ramen, Sushi and Craft Beer Under One Roof in Bangalore"),
)
check(
    "a SHORT title ending in a preposition is the writer's choice and is left alone",
    payload.meta_title_from("What Beer Goes With") == "What Beer Goes With",
)

no_colon = "A Very Long Title About Absolutely Everything That Simply Refuses To End Anywhere"
mt = payload.meta_title_from(no_colon)
check("a colonless long title is truncated", len(mt) <= payload.META_TITLE_MAX, f"{len(mt)}")
check("truncation never splits a word", no_colon.startswith(mt) and not mt.endswith(" "), mt)
check("meta_title is never longer than the source title", len(payload.meta_title_from("Hi")) == 2)

# meta_description: whole sentences only.
two = "First sentence here. Second sentence here."
check("short TL;DRs are used whole", payload.meta_description_from(two) == two)
# The CMS field's limit is HARD: an over-length value shows as 211/160 in red and the operator
# hand-edits it before every push. A long first sentence used to be exempt; it no longer is.
long_first = "word " * 60 + "end. Second."
fitted = payload.meta_description_from(long_first)
check("a long first sentence is CUT to the field's hard limit",
      len(fitted) <= payload.META_DESCRIPTION_MAX, f"{len(fitted)} chars")
check("the cut is marked, so it does not read as a writer stopping mid-thought",
      fitted.endswith("…"), fitted[-30:])
check("the cut lands on a word boundary", "  " not in fitted and not fitted.endswith(" …"),
      fitted[-30:])

# A trailing source parenthetical is a third of the field and buys nothing in a search snippet.
cited = ("Suede is the flesh side of a hide buffed into a soft nap, while full grain leather "
         "comes from the tough outer grain (Leather Working Group; Leather Naturally, March 2026).")
trimmed = payload.meta_description_from(cited)
check("a trailing citation is dropped from the description",
      "Leather Working Group" not in trimmed, trimmed)
check("dropping it leaves a real sentence, not a dangling clause",
      trimmed.endswith("."), trimmed[-30:])
check("and the live 211-character case now fits", len(trimmed) <= payload.META_DESCRIPTION_MAX,
      f"{len(trimmed)} chars")

# But NOT when the sentence grammatically governs the bracket: lifting it strands the connector.
governed = "The loan closes before retirement, per (Reserve Bank of India, 2025)."
check("a citation its sentence governs is KEPT rather than stranding 'per'",
      payload.meta_description_from(governed).endswith("2025)."),
      payload.meta_description_from(governed))
many = " ".join(f"Sentence number {i} padding padding padding." for i in range(10))
desc = payload.meta_description_from(many)
check("sentences stop near the target", len(desc) <= payload.META_DESCRIPTION_TARGET + 60, str(len(desc)))
check("the description ends on a sentence boundary", desc.endswith("."), desc[-30:])
check("no TL;DR means no description", payload.meta_description_from("") is None)

check(
    "the description is DERIVED from the excerpt, so it inherits the gates",
    rich["meta_description"] in rich["excerpt"] or rich["meta_description"] == rich["excerpt"],
    rich["meta_description"],
)
check(
    "the SEO fields are still deterministic",
    payload.build_payload("acme", "s", BLOG, industry="legal", brand_name="B")
    == payload.build_payload("acme", "s", BLOG, industry="legal", brand_name="B"),
)
check("every key is still on the allowlist", set(rich) <= payload.ALLOWED_KEYS, str(set(rich) - payload.ALLOWED_KEYS))
check(
    "no forbidden key crept in with the new fields",
    not (set(rich) & {"status", "published_at", "slug", "body_html", "body_json", "org_id"}),
)
check("the payload is JSON serialisable", isinstance(json.dumps(built), str))

no_tldr = "# Title\n\nJust prose, no summary line.\n"
check(
    "a draft with no TL;DR sends no excerpt rather than a guess",
    "excerpt" not in payload.build_payload("acme", "t", no_tldr),
)
check(
    "a draft with no sources sends no citations",
    "citations" not in payload.build_payload("acme", "t", no_tldr),
)
try:
    payload.build_payload("acme", "t", "No heading here, just prose.")
    check("a draft with no H1 is rejected", False, "it built a payload")
except payload.PayloadError:
    check("a draft with no H1 is rejected", True)

# The spec requires a non-empty title. _H1_RE's `(.+?)` matches a space, so an H1 of a hash
# plus whitespace produced title:"" and a 422 the operator would have to decode.
try:
    payload.build_payload("acme", "t", "#  \n\nReal body prose here.\n")
    check("a whitespace-only H1 is rejected here, not by a 422", False, "it built a payload")
except payload.PayloadError:
    check("a whitespace-only H1 is rejected here, not by a 422", True)

check(
    "a slug with a trailing newline is not sent (Python's $ would have passed it)",
    "suggested_slug" not in payload.build_payload("acme", "my-topic\n", BLOG),
)

# meta_description must not split on an abbreviation. "Rs." is in every VV price.
rs = payload.meta_description_from(
    "Plots start from Rs. 46,02,000 at the project. A second sentence follows here."
)
check(
    "the description does not break on 'Rs.' and strand the number",
    not rs.endswith("Rs.") and "46,02,000" in rs,
    rs,
)
check(
    "abbreviations mid-sentence do not fragment it",
    payload.meta_description_from("Use approx. 20 units vs. the old way. Next sentence.")
    .startswith("Use approx. 20 units vs. the old way."),
    payload.meta_description_from("Use approx. 20 units vs. the old way. Next sentence."),
)
check(
    "a real sentence boundary still splits",
    len(payload._split_sentences("First one here. Second one here.")) == 2,
)


# ---------------------------------------------------------------------------
# source_run_id: stable, and scoped to the brand
# ---------------------------------------------------------------------------
print("\nsource_run_id: idempotent and collision-free")
first = payload.source_run_id("acme", "second-home")
check("it is stable across calls", first == payload.source_run_id("acme", "second-home"))
# The literal value, so a changed NAMESPACE fails HERE rather than in production as a wave
# of duplicate drafts. Every id shifts if that constant moves, which orphans every draft a
# reviewer is already holding. If this check fails, the namespace was edited: put it back.
check(
    "the namespace constant has not moved",
    first == "e4cfa996-97fd-5324-916a-c15c29ddea5f",
    first,
)
check(
    "two brands sharing a topic do not collide",
    payload.source_run_id("acme", "guide") != payload.source_run_id("other", "guide"),
)
check(
    "two topics in one brand do not collide",
    payload.source_run_id("acme", "a") != payload.source_run_id("acme", "b"),
)


# THE KEY RESOLUTION SECTION IS DELETED, and its subject with it. One shared
# STRATEGI_CMS_WRITE_KEY resolved from the process environment then server/.env, and it existed
# only to authenticate against the Strategi CMS. Migration 038 removed that destination and
# server/cms/client.py went with it, so there is no key to resolve. What the section ALSO pinned
# is not lost: that a secret read from server/.env never reaches os.environ and never reaches an
# agent session is db.agent_env()'s own rule, and tests/env_check.py holds it over the allowlist
# rather than over one variable that no longer exists.
import os  # noqa: E402

from server import db  # noqa: E402

# ---------------------------------------------------------------------------
# The org/brand slug uniqueness guard: refused at WRITE time
# ---------------------------------------------------------------------------
# orgs.slug and clients.slug are unique in SEPARATE tables, so a self-org brand and a real,
# unrelated org could share a slug. The write-time guards refuse that collision when a client
# or an org is created, keeping org identity unambiguous. The read-time CMS-key resolution that
# once also guarded this is GONE: one shared key now posts to every org and the payload's
# `client` slug routes each draft, so a slug collision no longer misroutes anything.
#
# No database is touched: the guards are asserted as pure decisions with their single query
# stubbed, the same way FakeRunner above tests the gate's decision rather than the runner.
print("\nOrg slug collision: refused at write time")

from server import clients as clients_mod  # noqa: E402

_saved_self_org_clients = clients_mod._self_org_clients
_saved_org_row_exists = clients_mod._org_row_exists
try:
    # Org side: an org may not take a slug a self-org brand answers to.
    clients_mod._self_org_clients = lambda org_slug: ["acme"]
    try:
        clients_mod._refuse_org_slug_collision("acme")
        check("an org colliding with a self-org brand is refused", False, "it was allowed")
    except clients_mod.InvalidClient:
        check("an org colliding with a self-org brand is refused", True)
    check(
        "the brand being moved into that org in the same write is EXEMPT",
        clients_mod._refuse_org_slug_collision("acme", for_client="acme") is None,
    )
    clients_mod._self_org_clients = lambda org_slug: []
    check(
        "an org whose slug no self-org brand holds is allowed",
        clients_mod._refuse_org_slug_collision("acme-group") is None,
    )

    # Brand side: a brand may not become a self-org brand on a slug an org already holds.
    clients_mod._org_row_exists = lambda org_slug: True
    try:
        clients_mod._refuse_self_org_collision("acme")
        check("a brand becoming a self-org on an org's slug is refused", False, "it was allowed")
    except clients_mod.InvalidClient:
        check("a brand becoming a self-org on an org's slug is refused", True)
    clients_mod._org_row_exists = lambda org_slug: False
    check(
        "a brand whose slug is no org's slug is allowed",
        clients_mod._refuse_self_org_collision("vacation-village") is None,
    )
finally:
    clients_mod._self_org_clients = _saved_self_org_clients
    clients_mod._org_row_exists = _saved_org_row_exists


# THE HTTP CLIENT SECTION IS DELETED with server/cms/client.py: its retries, its backoff and
# its already-advanced-past-draft success were all the Strategi CMS ingest endpoint's contract.
# The one destination left is a client's own website, whose transport is server/cms/http.py and
# whose behaviour is pinned in tests/site_check.py and tests/unpublish_check.py.

# ---------------------------------------------------------------------------
# The five WRITTEN editorial fields, and the deterministic guards over them.
#
# payload.py stays pure: the model runs in cms/meta_gen.py, before it, and hands its result in as
# an argument. What is pinned here is that the payload VALIDATES that argument rather than
# trusting it, and that every rejection falls back to the derived field instead of failing the
# push. The generation itself is not tested here and cannot be: it is a model call, and this file
# spawns nothing and calls no model.
# ---------------------------------------------------------------------------
from server.cms import meta_gen  # noqa: E402

DRAFT = """# Corporate Gifting Suppliers in Bangalore: A Buyer's Guide

**TL;DR:** Bengaluru has many gifting vendors and few manufacturers. This guide explains the
difference (Acme, 2026).

## What changes

Some prose about sourcing.

## Sources and References

- Example, "A source," 2026. https://example.com/a
"""

WRITTEN = {
    "excerpt": "Most Bengaluru corporate gifting vendors do not make anything. Here is how to "
               "tell a real manufacturer from a reseller, and why it changes your price and "
               "timeline.",
    "seo_title": "Corporate Gifting Suppliers in Bangalore: A Buyer's Guide",
    "seo_description": "How to tell a real manufacturer from a reseller when sourcing corporate "
                       "gifts and branded apparel in Bangalore, and what to verify before you "
                       "order.",
    "category": "Buyer's Guides",
    "tags": ["Corporate Gifting", "Bengaluru", "Bulk Ordering", "Procurement", "Branded Apparel"],
}

built = payload.build_payload(
    "acme", "corporate-gifting-suppliers", DRAFT,
    industry="hospitality", brand_name="Acme Gifting", meta=WRITTEN,
)

check("the written excerpt is sent, not the TL;DR",
      built["excerpt"] == WRITTEN["excerpt"], built.get("excerpt", "")[:60])
check("the written SEO title is sent whole when it fits",
      built["meta_title"] == WRITTEN["seo_title"], built.get("meta_title"))
check("the SEO title is within the limit",
      len(built["meta_title"]) <= payload.META_TITLE_MAX, str(len(built["meta_title"])))
check("the written SEO description is sent",
      built["meta_description"] == WRITTEN["seo_description"], built.get("meta_description"))
check("the SEO description is within the CMS hard limit",
      len(built["meta_description"]) <= payload.META_DESCRIPTION_MAX,
      str(len(built["meta_description"])))
check("the per-piece category replaces the client's industry",
      built["category_name"] == "Buyer's Guides", built.get("category_name"))
check("the brand tag is KEPT and leads, with the topic tags behind it",
      built["tags"] == ["Acme Gifting"] + WRITTEN["tags"], str(built.get("tags")))

# An over-length written title and description are CUT here, not trusted. The model is told the
# limit and mostly obeys it; "mostly" is not something to publish against.
long_meta = dict(WRITTEN,
                 seo_title="Corporate Gifting And Branded Apparel Suppliers Across Bengaluru "
                           "For Procurement Teams",
                 seo_description="How to tell a real manufacturer from a reseller when sourcing "
                                 "corporate gifts and branded apparel anywhere in Bangalore, "
                                 "what to verify before you order, and which questions expose a "
                                 "middleman on the first call.")
cut = payload.build_payload("acme", "t", DRAFT, brand_name="Acme Gifting", meta=long_meta)
check("an over-length written title is cut to the limit",
      len(cut["meta_title"]) <= payload.META_TITLE_MAX, str(len(cut["meta_title"])))
check("the cut title does not end mid-word",
      long_meta["seo_title"].startswith(cut["meta_title"].rstrip("…")), cut["meta_title"])
check("an over-length written description is cut to the CMS hard limit",
      len(cut["meta_description"]) <= payload.META_DESCRIPTION_MAX,
      str(len(cut["meta_description"])))

# Every field is optional and independent: a rejected one falls back, the rest still ship.
partial = payload.build_payload("acme", "t", DRAFT, industry="hospitality",
                                brand_name="Acme Gifting", meta={"category": "Buyer's Guides"})
check("a meta carrying only a category still gets the derived excerpt",
      partial["excerpt"].startswith("Bengaluru has many gifting vendors"), partial.get("excerpt"))
# The H1 here is 57 characters, already inside META_TITLE_MAX, so the derived title is the H1
# whole: meta_title_from splits on the colon only when it has to.
check("and the derived SEO title",
      partial["meta_title"] == "Corporate Gifting Suppliers in Bangalore: A Buyer's Guide",
      partial.get("meta_title"))

none_meta = payload.build_payload("acme", "t", DRAFT, industry="hospitality",
                                  brand_name="Acme Gifting", meta={})
check("an EMPTY meta reproduces the old derived behaviour exactly",
      none_meta["category_name"] == "Hospitality" and none_meta["tags"] == ["Acme Gifting"],
      f"{none_meta.get('category_name')} {none_meta.get('tags')}")

# The house screen, which is what stands between a model and a client's CMS.
check("a superlative is rejected before it reaches the payload",
      meta_gen.house_violation("The best corporate gifting suppliers") is not None)
check("an ordinary editorial phrase passes",
      meta_gen.house_violation("Corporate gifting suppliers in Bangalore") is None)
screened = meta_gen.clean({
    "seo_title": "The Best Gifting Suppliers in Bangalore",
    "seo_description": "How to tell a manufacturer from a reseller before you order.",
    "category": "Buyer's Guides",
    "tags": ["Corporate Gifting", "Bengaluru"],
})
check("clean() drops ONLY the offending field, never the whole reply",
      "seo_title" not in screened and screened.get("seo_description") and screened.get("category"),
      str(sorted(screened)))

# get-or-create pollution: a near-duplicate snaps to the casing the brand already uses.
check("a tag matching the brand's vocabulary snaps to the existing casing",
      meta_gen.normalise_tags(["bengaluru", "BULK ORDERING"], ["Bengaluru", "Bulk Ordering"])
      == ["Bengaluru", "Bulk Ordering"])
check("tags are capped so a keyword dump cannot become a taxonomy",
      len(meta_gen.normalise_tags([f"Tag {i}" for i in range(20)])) == meta_gen.MAX_TAGS)

# An em dash is substituted rather than rejected: it is a house rule the model is told and
# sometimes forgets, and swapping punctuation invents no words.
dashed = meta_gen.clean({"excerpt": "Vendors do not make anything — resellers rarely say so."})
check("an em dash in written copy is substituted, not shipped",
      "—" not in dashed.get("excerpt", "x—x"), dashed.get("excerpt"))

check("a reply that is not JSON at all is simply no metadata",
      meta_gen.parse_reply("I could not do that") is None)


print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)
print("cms_check OK")
