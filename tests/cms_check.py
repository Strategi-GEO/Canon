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
# The payload: the five fields the CMS ingest expects, and nothing else
# ---------------------------------------------------------------------------
print("\nPayload: exactly the five ingest fields")
built = payload.build_payload("acme", "second-home", BLOG)

check("schema version is the literal 1", built["ingest_schema_version"] == 1)
check("the client slug rides in the payload as `client`", built["client"] == "acme")
check("title is the H1", built["title"] == "Buying a Second Home in Your 40s")
check("H1 is not repeated in the body", not built["body_markdown"].startswith("# Buying"))
check(
    "body is the draft minus the H1, byte for byte",
    built["body_markdown"] == BLOG.split("\n", 1)[1].strip("\n"),
)
check(
    "the payload is EXACTLY the five allowed keys, no more",
    set(built) == payload.ALLOWED_KEYS,
    str(set(built) ^ payload.ALLOWED_KEYS),
)
check(
    "no forbidden key is ever emitted",
    not (set(built) & {"status", "published_at", "slug", "body_html", "body_json", "org_id",
                       "meta_title", "author_name", "citations", "tags"}),
)
check(
    "the same draft always builds the same payload",
    payload.build_payload("acme", "second-home", BLOG)
    == payload.build_payload("acme", "second-home", BLOG),
)
check("the payload is JSON serialisable", isinstance(json.dumps(built), str))

# The two required strings are guarded HERE, not as a 422 the operator must decode.
try:
    payload.build_payload("acme", "t", "No heading here, just prose.")
    check("a draft with no H1 is rejected", False, "it built a payload")
except payload.PayloadError:
    check("a draft with no H1 is rejected", True)

# _H1_RE's `(.+?)` matches a space, so an H1 of a hash plus whitespace produced title:"".
try:
    payload.build_payload("acme", "t", "#  \n\nReal body prose here.\n")
    check("a whitespace-only H1 is rejected here, not by a 422", False, "it built a payload")
except payload.PayloadError:
    check("a whitespace-only H1 is rejected here, not by a 422", True)

# `client` routes the draft, so an empty one is a caller bug, not a silent misroute.
try:
    payload.build_payload("", "second-home", BLOG)
    check("an empty client slug is rejected", False, "it built a payload")
except payload.PayloadError:
    check("an empty client slug is rejected", True)


# ---------------------------------------------------------------------------
# source_run_id: stable, and scoped to the brand
# ---------------------------------------------------------------------------
print("\nsource_run_id: idempotent and collision-free")
first = payload.source_run_id("acme", "second-home")
check("it is stable across calls", first == payload.source_run_id("acme", "second-home"))
check("the payload carries that same id", built["source_run_id"] == first)
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
# The key: ONE general key, from the environment then server/.env
# ---------------------------------------------------------------------------
# One key authenticates every brand's push, and the payload's `client` field routes the
# tenant. This reverses the old per-org model: the leak that model existed to prevent (a key
# was the only routing signal, so the wrong key filed one client's blog into another's CMS)
# is closed by `client` naming the destination in every request.
print("\nKey resolution: one general key, from the environment")
import os  # noqa: E402

os.environ.pop("STRATEGI_CMS_WRITE_KEY", None)
check("no key configured resolves to None", cms_client.resolve_key() is None)

os.environ["STRATEGI_CMS_WRITE_KEY"] = "the-general-key"
check("the exported general key is returned", cms_client.resolve_key() == "the-general-key")
os.environ.pop("STRATEGI_CMS_WRITE_KEY", None)


# ---------------------------------------------------------------------------
# The key, second place: server/.env, the only door on the packaged app
# ---------------------------------------------------------------------------
# install.sh prompts for that file, the tray app reads it, the desktop app writes the secrets
# it fetches at login into it (migration 028), and a Finder-launched .app reads no shell
# profile, so on the supported distribution it is the ONLY door a write key comes through. An
# untested only door is the one that regresses.
#
# EVERY BYTE HERE IS FAKE. db.SERVER_DIR is pointed at a temp directory holding a .env this
# block wrote, so the real server/.env is never opened and never printed, and the original
# SERVER_DIR and parsed config are put back in the finally.
print("\nKey resolution: the server/.env fallback, with a FAKE .env")

from server import db  # noqa: E402

_saved_server_dir = db.SERVER_DIR
_saved_cfg = dict(db._CFG)
_tmp_env = tempfile.TemporaryDirectory()
try:
    Path(_tmp_env.name, ".env").write_text(
        "STRATEGI_CMS_WRITE_KEY=key-from-a-fake-dotenv\n", encoding="utf-8"
    )
    db.SERVER_DIR = Path(_tmp_env.name)
    db._CFG.clear()
    os.environ.pop("STRATEGI_CMS_WRITE_KEY", None)

    check(
        "the key resolves from server/.env",
        cms_client.resolve_key() == "key-from-a-fake-dotenv",
        "the file fallback is gone",
    )

    os.environ["STRATEGI_CMS_WRITE_KEY"] = "key-from-the-shell"
    check(
        "an exported var beats the file",
        cms_client.resolve_key() == "key-from-the-shell",
        "the file won, which lets a stale line beat a deliberate export",
    )
    os.environ.pop("STRATEGI_CMS_WRITE_KEY", None)
    check(
        "removing the export falls back to the file again",
        cms_client.resolve_key() == "key-from-a-fake-dotenv",
    )

    # RULE 1 (server/db.py): a key read from the file must never reach os.environ, because
    # agent_env() filters os.environ and cannot filter what was never in it. Resolving is the
    # operation that would leak it, so the assertion is made straight after resolving.
    check(
        "resolving a file key exports nothing",
        "STRATEGI_CMS_WRITE_KEY" not in os.environ,
    )
    _agent_env = db.agent_env()
    check(
        "db.agent_env() carries no CMS key NAME",
        not [k for k in _agent_env if "CMS" in k.upper()],
        str(sorted(k for k in _agent_env if "CMS" in k.upper())),
    )
    check(
        "db.agent_env() carries no CMS key VALUE under some other name",
        "key-from-a-fake-dotenv" not in _agent_env.values(),
    )
finally:
    db.SERVER_DIR = _saved_server_dir
    db._CFG.clear()
    db._CFG.update(_saved_cfg)
    _tmp_env.cleanup()


# ---------------------------------------------------------------------------
# The onboarding slug-collision guards (server/clients.py) still hold
# ---------------------------------------------------------------------------
# orgs.slug and clients.slug are unique in SEPARATE tables, so a brand with org_id null,
# whose org is synthesised from its own slug, can share that slug with a real and unrelated
# org. These write-time guards refuse that collision at creation. No database is touched: the
# decisions are asserted with their single query stubbed, the same way FakeRunner tests the
# gate's decision rather than the runner.
print("\nOnboarding: a synthesised org and a real org may not share a slug")

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
