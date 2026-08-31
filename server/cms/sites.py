"""The destination registry: which platform a brand publishes to, and how to reach it.

ONE DICT, NOT A PLUGIN SYSTEM. A destination is a module exposing four names (`fields`,
`label`, `connect`, `push`) and adding one is a file plus a line in DRIVERS below. There is no
entry-point scanning, no base class and no registration decorator, because two destinations do
not need a framework and a framework is what stops the third from being cheap.

WHAT A DRIVER IS NOT ALLOWED TO CARE ABOUT. It receives the ARTICLE, a small dict of already
vetted strings, never the roadmap row, the dossier, the score, or the client record. Everything
upstream of `article_from_payload` is the existing pipeline (server/cms/payload.py builds the
neutral body from the draft the evaluator scored) and everything downstream is the existing
record (server/cms/record.py). A driver is the thin part in the middle that speaks one platform's
HTTP, and that is the whole reason a second platform costs one file.

THERE IS NO LONGER A DESTINATION WITHOUT A DRIVER. `strategi-cms` used to be a kind here that
had none, handled by a branch in routes.py, and it is gone: a brand publishes to its own website
or it publishes nowhere. So `driver_for` returning None now means exactly one thing, that this
build cannot reach the destination, and every caller may treat it as the error it is rather than
as a second path. Historic articles still carry 'strategi-cms' in topics.published_to, which is a
fact about where an article WENT and is never a destination anything writes again.
"""
import re
from urllib.parse import urlparse

from . import wordpress
from .http import send

# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------
DRIVERS = {
    wordpress.KIND: wordpress,
}

# Every destination a brand may be set to, for the settings dropdown.
KINDS = [
    {"kind": wordpress.KIND, "label": wordpress.LABEL},
]


class UnknownDestination(Exception):
    """A brand is set to a destination this build has no driver for."""


def driver_for(kind):
    """The module handling this kind, or None when this build cannot reach it.

    None IS AN ERROR NOW, not a branch. While the Strategi CMS existed it meant "take the other
    path"; there is no other path, so a None here is an unconfigured brand or a destination blob
    written by a newer build, and both are refusals.
    """
    return DRIVERS.get(str(kind or "").strip())


def fields_for(kind):
    """What the settings card must collect for this kind. [] when it collects nothing."""
    driver = driver_for(kind)
    return driver.fields() if driver else []


def label_for(site):
    """One line naming where this brand publishes, for a button and a card."""
    driver = driver_for((site or {}).get("kind"))
    return driver.label(site) if driver else ""


def host_of(site):
    """The destination's hostname, which is what the record stores as published_to."""
    kind = str((site or {}).get("kind") or "").strip()
    return urlparse((site or {}).get("url") or "").netloc or kind


async def connect(kind, url, creds, *, client=None):
    """Run one destination's setup and return the blob to store. Raises ConnectError."""
    driver = driver_for(kind)
    if driver is None:
        raise UnknownDestination(f"No connector for '{kind}'.")
    return await driver.connect(url, creds, client=client)


async def push(site, article, remote, *, client=None):
    """Publish one article to a brand's own website. Raises TransportError."""
    driver = driver_for((site or {}).get("kind"))
    if driver is None:
        raise UnknownDestination(
            f"No connector for '{(site or {}).get('kind')}'.")
    return await driver.push(article, site, remote, client=client)


async def unpublish(site, remote, *, force=False, hard=False, client=None):
    """Take one published article back off a brand's own website. Raises TransportError.

    UNPUBLISH IS AN OPTIONAL FIFTH NAME, resolved with getattr rather than assumed, and the
    optionality is the point. `fields`, `label`, `connect` and `push` are what a destination
    MUST have to be one at all; retraction is a capability some platforms simply do not offer,
    and a driver that cannot retract stays a perfectly good driver and answers here instead of
    being unwritable, which is what a required fifth name would have made it.
    """
    kind = str((site or {}).get("kind") or "").strip()
    driver = driver_for(kind)
    if driver is None:
        raise UnknownDestination(f"No connector for '{kind}'.")
    fn = getattr(driver, "unpublish", None)
    if fn is None:
        raise UnknownDestination(
            f"{label_for(site) or kind} articles cannot be taken down from here.")
    return await fn(site, remote, force=force, hard=hard, client=client)


# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
# Copied rather than imported from .claude/skills/geo-site-report/scripts/page_digest.py, which
# has the same fingerprints. That file is a SCRIPT inside a skill directory, not an importable
# package, and reaching into it would couple the server to a skill's file layout for six
# regexes. They are the stable, public signatures of each platform; if one ever changes, the
# two copies failing independently is a smaller problem than the import.
_FINGERPRINTS = [
    (wordpress.KIND, r"/wp-content/|/wp-includes/|wp-json|api\.w\.org"),
    ("shopify", r"cdn\.shopify\.com|shopify\.theme|myshopify\.com"),
    ("wix", r"static\.parastorage\.com|wixstatic"),
    ("squarespace", r"squarespace\.com|sqs-block"),
    ("webflow", r"\.webflow\.io|w-webflow|webflow\.com"),
]

# Detected, named, and refused. Each of these runs a real blog that Canon cannot post to, and
# saying so at connect time is the difference between an operator knowing and an operator
# promising a client something that cannot be built. Squarespace has no public API for creating
# posts at all; the other two need an app registered with the vendor before any credential
# exists, which is not a connection an operator can complete from this screen.
UNSUPPORTED = {
    # Detected by _FINGERPRINTS above but carrying no driver, which is why it needs a sentence
    # here: without one, a Shopify brand reached connect() and got the bare UnknownDestination
    # instead of being told what is actually missing.
    "shopify": "Shopify publishing needs a custom app created in the client's own Shopify "
               "admin before an Admin API token exists, which is not a connection an operator "
               "can complete from this screen. Canon cannot publish or unpublish there yet.",
    "squarespace": "Squarespace has no public API for creating posts, so Canon cannot "
                   "publish there. Their articles have to be pasted in by hand.",
    "wix": "Wix publishing needs an app registered with Wix before a credential exists, "
           "which Canon does not have yet.",
    "webflow": "Webflow publishing is not built yet.",
}


async def detect(url, *, client=None):
    """What platform runs this page: a kind, an UNSUPPORTED key, or "".

    ONE FETCH, AND IT IS ONLY EVER A HINT. Everything it decides is re-decided by connect(),
    which authenticates and reads the site's own API; this exists so the settings card can put
    the right credential fields in front of an operator without asking them to know. "" is an
    ordinary answer, not a failure: the card falls back to a dropdown.
    """
    target = url if re.match(r"^https?://", url or "", re.I) else f"https://{(url or '').strip()}"
    if not urlparse(target).netloc:
        return ""
    response = await send("GET", target, client=client, label=urlparse(target).netloc,
                          headers={"Accept": "text/html"})
    if response.status_code >= 400:
        return ""

    # The REST-root relation is WordPress declaring itself, which beats a body scan: a page
    # that merely MENTIONS wp-content (a migrated site, a screenshot) is not WordPress.
    if _REST_REL in (response.headers.get("Link", "") or ""):
        return wordpress.KIND

    body = (response.text or "")[:200_000]
    for kind, pattern in _FINGERPRINTS:
        if re.search(pattern, body, re.I):
            return kind
    return ""


_REST_REL = "https://api.w.org/"


# ---------------------------------------------------------------------------
# Payload -> article
# ---------------------------------------------------------------------------

def article_from_payload(payload):
    """The CMS payload, reduced to what a website driver can post.

    THE SAME BYTES THE EVALUATOR SCORED, and this function is where that promise is kept: it
    selects and converts, and it never writes. Everything in `payload` came from the scored
    draft through cms/payload.py, which is pure by contract, so the only transformation here is
    markdown to HTML. No field is generated, rephrased, or asked of a model.

    TAGS AND CATEGORY ARE STILL DROPPED. Both are term IDs in WordPress rather than names, so
    sending a tag by name would 400, and creating taxonomy on a client's site is a write nobody
    asked for. The section an article joins is pinned at connect time from an existing article
    instead, which is the same question answered without inventing terms.

    THE SEO FIELDS ARE NOT DROPPED ANY MORE. They used to be, on the ground that they need a
    specific plugin's post meta "which differs per site and is not knowable from here". The
    driver knows it now: connect() reads the site's own REST schema and pins the plugin's key
    pair, so a site that has one gets the title and description the writer produced and a site
    that has none is unaffected, exactly as before. They are passed as ordinary strings and the
    driver decides whether there is anywhere to put them, which keeps this adapter free of any
    one platform's meta layout.
    """
    return {
        "title": payload["title"],
        "body_html": to_html(payload["body_markdown"]),
        "excerpt": payload.get("excerpt") or "",
        "slug": payload.get("suggested_slug") or "",
        "meta_title": payload.get("meta_title") or "",
        "meta_description": payload.get("meta_description") or "",
    }


def to_html(body_markdown):
    """Markdown to HTML for platforms whose body field is HTML.

    WordPress `content` and Shopify `body` both render HTML and neither renders markdown: post
    a draft's markdown to either and the reader sees literal ## and pipe-delimited tables. The
    Strategi CMS is the exception and keeps taking body_markdown, which is why this conversion
    lives here in the website path and not in cms/payload.py.

    `extra` is what carries the comparison table every draft is required to have, plus fenced
    code and definition lists. `sane_lists` stops a numbered FAQ from swallowing the paragraph
    under it. Import is function-local so the whole cms package still imports on a machine that
    has not installed the dependency yet, which matters because the CMS path does not need it.
    """
    import markdown
    return markdown.markdown(body_markdown or "",
                             extensions=["extra", "sane_lists"],
                             output_format="html")
