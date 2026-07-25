"""blog.md + the client slug -> the CMS ingest body.

PURE AND DETERMINISTIC BY CONTRACT. No network, no disk, no clock, no LLM: every
function here takes text in and returns data out, so the same draft always builds
the same payload. That is not a style preference. The blog that passed the
evaluator must be the blog that lands in the CMS, and a second model pass over a
scored artifact would mean shipping prose no evaluator ever saw.

THE INGEST IS MINIMAL BY CONTRACT. The CMS wants exactly five fields:

    ingest_schema_version, client, source_run_id, title, body_markdown

and nothing else. `client` is the brand slug and it is what ROUTES the draft to
the right tenant: one general write key authenticates every push, so the key no
longer names the destination and the payload must. That is the whole reason a
single shared key is safe now where it was a cross-tenant leak before (see
server/cms/client.py). No SEO, citation, tag or category metadata is derived or
sent: the schema is strict and an unknown key is a 422, so the builder emits from
an allowlist and the allowlist IS the five fields.

The body is the draft byte for byte, minus its H1: the H1 becomes `title`, and
sending it in both places renders the headline twice.
"""
import re
import uuid

# Generated once, hard-coded forever. CHANGING THIS VALUE ORPHANS EVERY DRAFT
# ALREADY IN THE CMS: every source_run_id shifts, so the next push of an existing
# blog creates a duplicate instead of updating the draft a reviewer is holding.
# It is an arbitrary constant and there is never a reason to "refresh" it.
NAMESPACE = uuid.UUID("b4b28127-f117-4129-bba6-c716e6efe5ae")

SCHEMA_VERSION = 1

# The schema is strict and an unknown key is a 422, so the builder emits from an
# allowlist rather than trusting itself to remember what is forbidden. status,
# published_at, slug, body_html, body_json and org_id are the CMS's to own.
ALLOWED_KEYS = frozenset({
    "ingest_schema_version",
    "client",
    "source_run_id",
    "title",
    "body_markdown",
})

_H1_RE = re.compile(r"^#\s+(.+?)\s*$")


class PayloadError(ValueError):
    """The draft is missing something the CMS requires (title or body)."""


def source_run_id(client_slug, topic_slug):
    """The idempotency key: uuid5 over "<client_slug>/<topic_slug>".

    Scoped to the BRAND, not the topic alone. One org can hold several brands, and
    two of them generating "second-home-buying-guide" would derive the same UUID
    from the topic by itself, and the second push would silently overwrite the
    first brand's draft instead of creating its own. The brand prefix costs nothing
    and makes that collision impossible.

    Deterministic on purpose. A random UUID would create a fresh duplicate draft
    on every re-push, which is exactly what the idempotency key exists to stop.
    """
    client_slug = (client_slug or "").strip()
    topic_slug = (topic_slug or "").strip()
    if not client_slug or not topic_slug:
        raise PayloadError("source_run_id needs both a client slug and a topic slug")
    return str(uuid.uuid5(NAMESPACE, f"{client_slug}/{topic_slug}"))


def split_title(blog_md):
    """(title, body) from a draft: the first H1, and everything after it.

    The H1 line itself is dropped from the body because `title` carries it and
    the CMS renders that heading itself. Every other byte survives untouched.
    """
    lines = blog_md.splitlines()
    for index, line in enumerate(lines):
        match = _H1_RE.match(line)
        if match:
            title = match.group(1).strip()
            body = "\n".join(lines[index + 1:]).strip("\n")
            return title, body
    raise PayloadError("draft has no H1, so there is no title to send")


def build_payload(client_slug, topic_slug, blog_md):
    """The full ingest body for one finished blog: exactly five fields.

    `client_slug` is the brand slug and rides in the payload as `client`, which is
    what routes the draft to the right tenant now that one key serves every brand.
    """
    client_slug = (client_slug or "").strip()
    if not client_slug:
        raise PayloadError("a client slug is required to route the draft")

    title, body = split_title(blog_md)
    # BOTH are spec-required non-empty strings, so both are checked. _H1_RE's `(.+?)`
    # matches a space, so an H1 of "#" plus whitespace yields a title of "" that would
    # sail into the payload and earn a 422 the operator would have to decode.
    if not title.strip():
        raise PayloadError("draft's H1 is empty, so there is no title to send")
    if not body.strip():
        raise PayloadError("draft has an H1 and nothing else, so there is no body to send")

    payload = {
        "ingest_schema_version": SCHEMA_VERSION,
        "client": client_slug,
        "source_run_id": source_run_id(client_slug, topic_slug),
        "title": title,
        "body_markdown": body,
    }

    unknown = set(payload) - ALLOWED_KEYS
    if unknown:
        # Unreachable unless this module grows a key the CMS never agreed to. It
        # fails here, in a test, rather than as a 422 an operator has to decode.
        raise PayloadError(f"payload carries keys the CMS forbids: {sorted(unknown)}")
    return payload
