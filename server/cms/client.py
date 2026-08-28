"""The HTTP call to the Strategi CMS ingest endpoint.

httpx, not requests: FastAPI already brings httpx and it speaks async, so the
push does not block the event loop the SSE run feed is tailing on.

THE KEY IS SERVER-SIDE ONLY. It is read from the process environment or from
server/.env, it is never returned in a response body, never written to an
artifact, and never logged, not even truncated. A key in a log line is a key in
whatever ships those logs.
"""
import asyncio
import logging
import os

import httpx

from .. import db
from . import http as shared_http

log = logging.getLogger("geo-factory")

# The CMS lives at client.strategi.is. This default is VERIFIED against the live endpoint,
# not copied from a document: it answers POST /api/v1/ingest with {"error":"Missing API key"}
# unauthenticated, and 422s a bad payload naming the field.
#
# STRATEGI_CMS_URL must be the FULL endpoint including /api/v1/ingest, not a bare host: this
# value is POSTed to verbatim. The bare host 307s to /login, the operator UI, so a host-only
# value would silently push a blog at a login page and never say so.
CMS_URL = os.environ.get("STRATEGI_CMS_URL", "https://client.strategi.is/api/v1/ingest")

# ONE shared key posts to every organisation. There are no per-org variables.
#
# The CMS routes each draft by the `client` slug in the payload (server/cms/payload.py), not by
# the key, so a single write key is the whole of what this engine needs. This reverses an earlier
# per-org design, and the reversal is safe because the thing that made per-org necessary is gone:
# the CMS once derived the destination org FROM THE KEY, with the payload forbidden to name it, so
# one shared key would have filed one org's blog into another's silently. The payload now carries
# the org's slug in `client`, so routing is explicit in the request and the shared key cannot
# misroute: the slug says where every draft goes, and the key only authorises the write.
#
# The key does NOT live in gates.json: that file is operator-visible and checked in, and a write
# credential in it is a credential in the repo. It lives in the process environment or in
# server/.env, and resolve_key below says which wins and why.
KEY_VAR = "STRATEGI_CMS_WRITE_KEY"

# The retry rules now live in cms/http.py, because a second destination (a client's own
# website, server/cms/sites.py) needs the identical four: cap Retry-After, retry 429 and 5xx
# only, retry a reset connection, and fail an unresolvable host immediately. Re-exported under
# the names this module has always used so nothing importing them has to know they moved.
MAX_ATTEMPTS = shared_http.MAX_ATTEMPTS
REQUEST_TIMEOUT = shared_http.REQUEST_TIMEOUT
MAX_BACKOFF_SECONDS = shared_http.MAX_BACKOFF_SECONDS


class CmsError(Exception):
    """The CMS refused, or was unreachable after retries.

    `status` is the HTTP status when there was one, else None for a transport
    failure. The endpoint maps it; nothing here decides how it renders.
    """

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def resolve_key():
    """The one CMS write key, shared by every organisation, or None.

    There is a single key. The CMS routes each draft by the `client` slug in the
    payload, so the key never identifies a brand and one key posts anywhere.

    AN EXPORTED VAR WINS OVER server/.env, matching db.py. A var exported into this
    process is a deliberate act aimed at this process, while a file on disk is
    ambient, and reversing the order would let a stale line in a file silently beat
    the key an operator just exported to fix something. server/.env is read second
    because it is the credential store a teammate is actually given: install.sh
    prompts for it, the tray app reads it, and it is the file an operator reaches for.

    Returns None rather than raising so a caller can render "no key configured" as a
    setup problem, which it is, instead of a CMS failure, which it is not.
    """
    exported = os.environ.get(KEY_VAR, "").strip()
    if exported:
        return exported
    # db.config_value reads the parsed server/.env WITHOUT exporting anything, so a
    # key kept in that file never enters os.environ and agent_env() cannot carry it
    # into a Claude session. See the RULE 1 argument in server/db.py.
    return db.config_value(KEY_VAR) or None


def missing_key_detail():
    """What to tell an operator with no write key: the variable AND the place to put it.

    Naming only the variable is accurate and useless on the packaged app, which is the
    supported way Canon is distributed: a macOS GUI app opened from Finder reads no shell
    profile, so an `export` line in .zshrc reaches it never, and an operator following that
    advice watches the same 503 come back. server/.env is named first because it is the one
    location that works on every launch path, tray app and terminal alike. The export is still
    named, because it is what existing deployments run on and it still wins.
    """
    return (
        f"No CMS write key configured. Add the line {KEY_VAR}=<key> to server/.env in the "
        f"Canon folder, then restart the engine. Exporting {KEY_VAR} works too, and only for an "
        f"engine started from that same shell: an app launched from Finder never reads a shell "
        f"profile."
    )


# Both are cms/http.py's, under this module's own names. See the MAX_ATTEMPTS note above.
_is_dns_failure = shared_http.is_dns_failure
_retry_delay = shared_http.retry_delay


def _error_message(response):
    """The CMS's own words for a refusal.

    A 422 names the field it rejected, and that sentence is the entire value of
    the error to whoever has to fix it, so it is passed through rather than
    replaced with a status code.
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"])
    text = (response.text or "").strip()
    return text[:300] if text else f"HTTP {response.status_code}"


async def push_draft(payload, api_key, *, url=None, client=None):
    """POST one payload. Returns the CMS's JSON on 200/201, raises CmsError.

    The three success shapes (created, updated, and the frozen "skipped: already
    advanced past draft") all come back as-is. Frozen is a SUCCESS: a human moved
    that post past draft, so our content was correctly not applied, and retrying
    would be this engine trying to overwrite an editor's decision.

    Retries 429 and 5xx only. 400/401/403/422 are permanent, and retrying a bad
    payload four times just makes the same mistake at four times the rate limit.
    """
    if not api_key:
        raise CmsError(
            "No CMS write key is configured. Put STRATEGI_CMS_WRITE_KEY in server/.env, or "
            "export it in the shell that starts the engine. Never in gates.json."
        )

    target = url or CMS_URL
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    owned = client is None
    http = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT)
    try:
        last = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await http.post(target, headers=headers, json=payload)
            except httpx.HTTPError as cause:
                # An unresolvable hostname is a CONFIGURATION fact, not a blip: it
                # will not start resolving during a backoff, so retrying it just
                # buys the operator 31 seconds of spinner before the same error.
                # Fail immediately and name the host, because the fix is DNS or
                # STRATEGI_CMS_URL and neither is something to wait for.
                if _is_dns_failure(cause):
                    raise CmsError(
                        f"Cannot reach the CMS: the host in {target} does not resolve. "
                        f"Check the CMS is deployed, or point STRATEGI_CMS_URL at the "
                        f"right address."
                    )
                # Every other transport failure IS worth a retry: a refused or reset
                # connection is the same class of problem as a 5xx, and the request
                # is idempotent, so retrying is safe.
                last = CmsError(f"Cannot reach the CMS: {cause}")
                if attempt == MAX_ATTEMPTS - 1:
                    break
                await asyncio.sleep(min(float(2 ** attempt), MAX_BACKOFF_SECONDS))
                continue

            if response.status_code in (200, 201):
                try:
                    body = response.json()
                except ValueError:
                    raise CmsError(
                        "The CMS accepted the draft but its response was not JSON.",
                        status=response.status_code,
                    )
                # A bare string, list or null is valid JSON and would sail through, then
                # blow up in the endpoint on .get() as a 500: the push SUCCEEDED and the
                # operator would be told the engine crashed. Fail here, where the message
                # can say what actually happened.
                if not isinstance(body, dict):
                    raise CmsError(
                        "The CMS accepted the draft but its response was not a JSON object, "
                        "so the draft may exist despite this error.",
                        status=response.status_code,
                    )
                return body

            if response.status_code == 429 or response.status_code >= 500:
                last = CmsError(_error_message(response), status=response.status_code)
                # The final attempt has nothing left to wait for: sleeping after it burns up
                # to MAX_BACKOFF_SECONDS of an operator's spinner and then raises anyway.
                if attempt == MAX_ATTEMPTS - 1:
                    break
                # No key material here, and no payload: the body is a whole blog.
                log.warning(
                    "CMS push got %s, retrying (attempt %s of %s)",
                    response.status_code, attempt + 1, MAX_ATTEMPTS,
                )
                await asyncio.sleep(_retry_delay(response, attempt))
                continue

            raise CmsError(_error_message(response), status=response.status_code)

        raise last or CmsError("The CMS did not answer after retries.")
    finally:
        if owned:
            await http.aclose()
