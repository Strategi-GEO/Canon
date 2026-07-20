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

from server.cms import client as cms_client  # noqa: E402
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

    def __init__(self, root, status_lines, demo=False):
        self.root = Path(root)
        self.status_lines = status_lines
        self.demo = demo

    def is_demo_client(self, client_slug):
        return self.demo

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

    # A DEMO blog in the record can carry status "done" (the fixtures predate the engine's
    # demo refusal), and old demo artifacts are placeholder text a CMS editor could approve.
    # Status alone would pass it, so the client check must refuse it first.
    _seed(tmp, "demo", "demo-topic")
    runner = FakeRunner(tmp, [{"status": "done"}], demo=True)
    try:
        gate.build_for_publish(runner, FakeLedger({}), "demo", "demo-topic")
        check("a done DEMO blog is still refused", False, "it built a payload")
    except gate.PublishRefused as refused:
        check("a done DEMO blog is still refused", True)
        check("the demo refusal says why", "demo" in str(refused).lower(), str(refused))

    # The demo refusal is a check on the CLIENT, not the artifact, so it must fire before any
    # artifact or status is read: a demo client with no blog on disk at all still refuses as
    # demo, never as "no blog", and the endpoint gets the status it names the refusal with.
    runner = FakeRunner(tmp, [], demo=True)
    try:
        gate.build_for_publish(runner, FakeLedger({}), "demo", "never-written-topic")
        check("the demo refusal fires before any artifact is read", False, "it built a payload")
    except gate.PublishRefused as refused:
        check("the demo refusal fires before any artifact is read", True)
        check("the demo refusal carries status='demo' for the endpoint to name",
              refused.status == "demo", str(refused.status))

    # The mirror: a real blog for a real client must still publish, so the refusal cannot
    # have been implemented wider than the demo flag.
    _seed(tmp, "vacation-village", "a-real-topic")
    runner = FakeRunner(tmp, [{"status": "done"}], demo=False)
    real = gate.build_for_publish(runner, FakeLedger({}), "vacation-village", "a-real-topic")
    check("a REAL blog for the same client still publishes", real["title"] != "")


# ---------------------------------------------------------------------------
# The payload: deterministic, allowlisted, and honest about what it lacks
# ---------------------------------------------------------------------------
print("\nPayload: deterministic and allowlisted")
built = payload.build_payload("acme", "second-home", BLOG, prompts="is it worth it\nbest age")

check("schema version is the literal 1", built["ingest_schema_version"] == 1)
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
long_first = "A" * 200 + ". Second."
check(
    "a long first sentence is kept WHOLE, never cut mid-thought",
    payload.meta_description_from(long_first) == "A" * 200 + ".",
)
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


# ---------------------------------------------------------------------------
# The key: per-org, and no shared fallback in EITHER place it is read from
# ---------------------------------------------------------------------------
# This block covers the process environment. The block after it covers server/.env,
# which resolve_key reads second and which nothing tested until it was added.
print("\nKey resolution: per-org, from the environment")
import os  # noqa: E402

for var in ("STRATEGI_CMS_WRITE_KEY", "STRATEGI_CMS_WRITE_KEY_ACME", "STRATEGI_CMS_WRITE_KEY_OTHER"):
    os.environ.pop(var, None)

check("no key configured resolves to None", cms_client.resolve_key("acme") is None)

os.environ["STRATEGI_CMS_WRITE_KEY_ACME"] = "acme-key"
check("an org gets its own key", cms_client.resolve_key("acme") == "acme-key")
check(
    "a hyphenated org maps to an underscored var",
    cms_client.key_var_for_org("vacation-village") == "STRATEGI_CMS_WRITE_KEY_VACATION_VILLAGE",
)

# THE CROSS-CLIENT LEAK. The CMS routes a draft by its key alone and the payload may not
# carry org_id, so a key resolved for the wrong org files one client's blog into another
# client's CMS with nothing in the request able to catch it. An org with no key of its own
# must get None and a 503, NEVER a neighbour's key.
check(
    "an org with no key never inherits another org's key",
    cms_client.resolve_key("other") is None,
    "it resolved to something",
)

os.environ["STRATEGI_CMS_WRITE_KEY"] = "shared-key-that-must-not-be-used"
check(
    "a shared STRATEGI_CMS_WRITE_KEY is ignored, not used as a fallback",
    cms_client.resolve_key("other") is None,
    "the removed fallback is back: this is the cross-client leak",
)
check(
    "the shared key does not override a real per-org key either",
    cms_client.resolve_key("acme") == "acme-key",
)
os.environ.pop("STRATEGI_CMS_WRITE_KEY", None)

try:
    cms_client.key_var_for_org("")
    check("an empty org slug raises rather than defaulting", False, "it returned a var name")
except ValueError:
    check("an empty org slug raises rather than defaulting", True)

os.environ.pop("STRATEGI_CMS_WRITE_KEY_ACME", None)


# ---------------------------------------------------------------------------
# The key, second place: server/.env, which had no test at all
# ---------------------------------------------------------------------------
# The block above exercises os.environ only, so the whole server/.env fallback in
# resolve_key could be deleted and this suite would stay green. That fallback is not
# a convenience: install.sh prompts for that file, the tray app reads it, and a
# Finder-launched .app reads no shell profile, so on the supported distribution it is
# the ONLY door a write key comes through. An untested only door is the one that
# regresses.
#
# EVERY BYTE HERE IS FAKE. db.SERVER_DIR is pointed at a temp directory holding a .env
# this block wrote, so the real server/.env is never opened and never printed, and the
# original SERVER_DIR and parsed config are put back in the finally.
print("\nKey resolution: the server/.env fallback, with a FAKE .env")

from server import db  # noqa: E402

_saved_server_dir = db.SERVER_DIR
_saved_cfg = dict(db._CFG)
_tmp_env = tempfile.TemporaryDirectory()
try:
    Path(_tmp_env.name, ".env").write_text(
        "STRATEGI_CMS_WRITE_KEY_ACME=acme-from-a-fake-dotenv\n"
        "STRATEGI_CMS_WRITE_KEY_BLR_BREWING=brewing-from-a-fake-dotenv\n",
        encoding="utf-8",
    )
    db.SERVER_DIR = Path(_tmp_env.name)
    db._CFG.clear()

    for var in ("STRATEGI_CMS_WRITE_KEY", "STRATEGI_CMS_WRITE_KEY_ACME",
                "STRATEGI_CMS_WRITE_KEY_BLR_BREWING", "STRATEGI_CMS_WRITE_KEY_OTHER"):
        os.environ.pop(var, None)

    check(
        "an org resolves its key from server/.env",
        cms_client.resolve_key("acme") == "acme-from-a-fake-dotenv",
        "the file fallback is gone",
    )

    os.environ["STRATEGI_CMS_WRITE_KEY_ACME"] = "acme-from-the-shell"
    check(
        "an exported var beats the file",
        cms_client.resolve_key("acme") == "acme-from-the-shell",
        "the file won, which lets a stale line beat a deliberate export",
    )
    os.environ.pop("STRATEGI_CMS_WRITE_KEY_ACME", None)
    check(
        "removing the export falls back to the file again",
        cms_client.resolve_key("acme") == "acme-from-a-fake-dotenv",
    )

    # THE ONE THAT MATTERS. A second place to look must not become a second chance to
    # answer with a neighbour's key. 'other' has no key in either place while two of its
    # neighbours have file keys, and it must still get None and its 503.
    check(
        "an org absent from BOTH places gets None even though a neighbour has a file key",
        cms_client.resolve_key("other") is None,
        "the file fallback reintroduced the cross-client leak",
    )

    db._CFG["STRATEGI_CMS_WRITE_KEY"] = "shared-key-that-must-not-be-used"
    check(
        "a shared STRATEGI_CMS_WRITE_KEY in the FILE is ignored, exactly as in the environment",
        cms_client.resolve_key("other") is None,
        "the removed shared fallback is back, in the file this time",
    )
    check(
        "the shared file key does not override a real per-org file key either",
        cms_client.resolve_key("acme") == "acme-from-a-fake-dotenv",
    )
    db._CFG.pop("STRATEGI_CMS_WRITE_KEY", None)

    check(
        "each org still gets its OWN file key and not the first one in the file",
        cms_client.resolve_key("blr-brewing") == "brewing-from-a-fake-dotenv",
        cms_client.resolve_key("blr-brewing") or "None",
    )

    # RULE 1 (server/db.py): a key read from the file must never reach os.environ, because
    # agent_env() filters os.environ and cannot filter what was never in it. Resolving is
    # the operation that would leak it, so the assertion is made straight after resolving.
    check(
        "resolving a file key exports nothing",
        "STRATEGI_CMS_WRITE_KEY_ACME" not in os.environ,
    )
    _agent_env = db.agent_env()
    check(
        "db.agent_env() carries no CMS key NAME",
        not [k for k in _agent_env if "CMS" in k.upper()],
        str(sorted(k for k in _agent_env if "CMS" in k.upper())),
    )
    check(
        "db.agent_env() carries no CMS key VALUE under some other name",
        "acme-from-a-fake-dotenv" not in _agent_env.values(),
    )
finally:
    db.SERVER_DIR = _saved_server_dir
    db._CFG.clear()
    db._CFG.update(_saved_cfg)
    _tmp_env.cleanup()


# ---------------------------------------------------------------------------
# The org slug collision: a synthesised org must never answer to a real org's key
# ---------------------------------------------------------------------------
# orgs.slug and clients.slug are unique in SEPARATE tables, so a brand with org_id
# null, whose org is synthesised from its own slug, can share that slug with a real
# and unrelated org. The key var is derived from the slug alone, so the brand resolves
# the other tenant's key, and client.py's no-shared-fallback comment is exact about why
# nothing downstream catches it: the CMS routes by the key and the payload may not carry
# org_id, so the wrong-tenant draft is created and reported as a success.
#
# No database is touched. The read-time net is asserted through routes._org_slug with the
# clients module's two answers stubbed, and the write-time guards are asserted as pure
# decisions with their single query stubbed, the same way FakeRunner above tests the
# gate's decision rather than the runner.
print("\nOrg slug collision: refuse to resolve rather than guess a tenant")

from fastapi import HTTPException  # noqa: E402

from server import clients as clients_mod  # noqa: E402
from server.cms import routes as cms_routes  # noqa: E402

_saved_read_client = clients_mod.read_client
_saved_collides = clients_mod.synthesised_org_collides
_saved_self_org_clients = clients_mod._self_org_clients
_saved_org_row_exists = clients_mod._org_row_exists
try:
    # A brand inside an explicit org: the org's slug selects the key, as it always did.
    clients_mod.read_client = lambda slug: {"organisation": {"slug": "acme-group"}}
    clients_mod.synthesised_org_collides = lambda slug: False
    check("an explicit org still selects that org's slug", cms_routes._org_slug("acme-north") == "acme-group")

    # A genuine single-brand org: synthesis is correct here and must keep working.
    clients_mod.read_client = lambda slug: {"organisation": {"slug": slug}}
    check("an uncontested self-org brand still resolves its own slug",
          cms_routes._org_slug("vacation-village") == "vacation-village")

    # The collision. read_client would answer happily, so only the explicit check stops it.
    clients_mod.synthesised_org_collides = lambda slug: True
    try:
        resolved = cms_routes._org_slug("acme")
        check("a colliding synthesised org REFUSES instead of resolving", False,
              f"it resolved to {resolved!r}, which is another tenant's key")
    except HTTPException as refused:
        check("a colliding synthesised org REFUSES instead of resolving", True)
        check("the refusal is a 503, the same as a missing key", refused.status_code == 503,
              str(refused.status_code))
        check("the refusal names the brand and the collision",
              "acme" in refused.detail and "organisation" in refused.detail,
              refused.detail)
        check("the refusal names the consequence, so nobody retries it blind",
              "CMS" in refused.detail, refused.detail)

    # Write-time guard, org side: an org may not take a slug a self-org brand answers to.
    clients_mod._self_org_clients = lambda org_slug: ["acme"]
    try:
        clients_mod._refuse_org_slug_collision("acme")
        check("an org colliding with a self-org brand is refused", False, "it was allowed")
    except clients_mod.InvalidClient as refused:
        check("an org colliding with a self-org brand is refused", True)
        check("that refusal explains the CMS key, not just the slug",
              "CMS write key" in str(refused), str(refused))
    check(
        "the brand being moved into that org in the same write is EXEMPT",
        clients_mod._refuse_org_slug_collision("acme", for_client="acme") is None,
    )
    clients_mod._self_org_clients = lambda org_slug: []
    check(
        "an org whose slug no self-org brand holds is allowed",
        clients_mod._refuse_org_slug_collision("acme-group") is None,
    )

    # Write-time guard, brand side: a brand may not become a self-org brand on a taken slug.
    clients_mod._org_row_exists = lambda org_slug: True
    try:
        clients_mod._refuse_self_org_collision("acme")
        check("a brand becoming a self-org on an org's slug is refused", False, "it was allowed")
    except clients_mod.InvalidClient as refused:
        check("a brand becoming a self-org on an org's slug is refused", True)
        check("that refusal explains the CMS key too",
              "CMS write key" in str(refused), str(refused))
    clients_mod._org_row_exists = lambda org_slug: False
    check(
        "a brand whose slug is no org's slug is allowed",
        clients_mod._refuse_self_org_collision("vacation-village") is None,
    )
finally:
    clients_mod.read_client = _saved_read_client
    clients_mod.synthesised_org_collides = _saved_collides
    clients_mod._self_org_clients = _saved_self_org_clients
    clients_mod._org_row_exists = _saved_org_row_exists


# ---------------------------------------------------------------------------
# The HTTP client: what retries, what does not, and what counts as success
# ---------------------------------------------------------------------------
print("\nHTTP client: retries, refusals, and the frozen case")


async def run_http_checks():
    calls = []

    def created(request):
        calls.append(request)
        return httpx.Response(201, json={"post_id": "p1", "slug": "s", "status": "draft", "created": True})

    async with stub_transport(created) as http:
        result = await cms_client.push_draft({"title": "x"}, "k", client=http)
    check("201 returns the CMS body", result["created"] is True)
    check("the bearer key is sent", calls[0].headers["authorization"] == "Bearer k")
    check("the body is JSON", json.loads(calls[0].content) == {"title": "x"})

    def frozen(request):
        return httpx.Response(200, json={"post_id": "p1", "status": "published", "skipped": "already advanced past draft"})

    async with stub_transport(frozen) as http:
        result = await cms_client.push_draft({}, "k", client=http)
    check("a frozen post is a success, not an error", result["skipped"] == "already advanced past draft")

    attempts = []

    def flaky(request):
        attempts.append(1)
        if len(attempts) < 3:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "slow down"})
        return httpx.Response(201, json={"post_id": "p2", "created": True})

    async with stub_transport(flaky) as http:
        result = await cms_client.push_draft({}, "k", client=http)
    check("429 retries and then succeeds", result["post_id"] == "p2" and len(attempts) == 3)

    server_errors = []

    def dead(request):
        server_errors.append(1)
        return httpx.Response(503, json={"error": "down"})

    async with stub_transport(dead) as http:
        try:
            await cms_client.push_draft({}, "k", client=http)
            check("5xx eventually raises", False, "it returned")
        except cms_client.CmsError as cause:
            check("5xx eventually raises", cause.status == 503)
    check(
        "5xx retries to the attempt cap",
        len(server_errors) == cms_client.MAX_ATTEMPTS,
        str(len(server_errors)),
    )

    for status, label in ((422, "422"), (401, "401"), (403, "403"), (400, "400")):
        permanent = []

        def refuse(request, status=status, permanent=permanent):
            permanent.append(1)
            return httpx.Response(status, json={"error": f"{status} said no"})

        async with stub_transport(refuse) as http:
            try:
                await cms_client.push_draft({}, "k", client=http)
                check(f"{label} raises", False, "it returned")
            except cms_client.CmsError as cause:
                check(f"{label} raises with the CMS's own message", "said no" in str(cause))
        check(f"{label} is never retried", len(permanent) == 1, str(len(permanent)))

    try:
        await cms_client.push_draft({}, None)
        check("a missing key raises before any request", False, "it returned")
    except cms_client.CmsError as cause:
        check("a missing key raises before any request", "key" in str(cause).lower())

    # An unresolvable host must NOT burn five retries: the name will not appear during a
    # backoff, so retrying is 31 seconds of spinner ending in the same error.
    import socket as _socket

    dns_tries = []

    def no_such_host(request):
        dns_tries.append(1)
        raise httpx.ConnectError("nodename nor servname provided") from _socket.gaierror(
            8, "nodename nor servname provided, or not known"
        )

    async with stub_transport(no_such_host) as http:
        try:
            await cms_client.push_draft({}, "k", client=http)
            check("an unresolvable host raises", False, "it returned")
        except cms_client.CmsError as cause:
            check("an unresolvable host raises", True)
            check(
                "the DNS error names the fix, not just the errno",
                "does not resolve" in str(cause) and "STRATEGI_CMS_URL" in str(cause),
                str(cause),
            )
    check("an unresolvable host is tried ONCE, not retried", len(dns_tries) == 1, str(len(dns_tries)))

    # ...but a refused or reset connection is still worth retrying, and must stay retried.
    refused_tries = []

    def refused(request):
        refused_tries.append(1)
        raise httpx.ConnectError("connection refused")

    async with stub_transport(refused) as http:
        try:
            await cms_client.push_draft({}, "k", client=http)
        except cms_client.CmsError:
            pass
    check(
        "a refused connection is still retried to the cap",
        len(refused_tries) == cms_client.MAX_ATTEMPTS,
        str(len(refused_tries)),
    )


asyncio.run(run_http_checks())


print(f"\n{CHECKS[0]} checks, {len(FAILURES)} failed")
if FAILURES:
    for name in FAILURES:
        print(f"  - {name}")
    sys.exit(1)
print("cms_check OK")
