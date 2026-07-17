"""The HTTP call to the Strategi CMS ingest endpoint.

httpx, not requests: FastAPI already brings httpx and it speaks async, so the
push does not block the event loop the SSE run feed is tailing on.

THE KEY IS SERVER-SIDE ONLY. It is read from the environment, it is never
returned in a response body, never written to an artifact, and never logged, not
even truncated. A key in a log line is a key in whatever ships those logs.
"""
import asyncio
import logging
import os
import socket

import httpx

log = logging.getLogger("geo-factory")

# The CMS lives at client.strategi.is. This default is VERIFIED against the live endpoint,
# not copied from a document: it answers POST /api/v1/ingest with {"error":"Missing API key"}
# unauthenticated, and 422s a bad payload naming the field.
#
# STRATEGI_CMS_URL must be the FULL endpoint including /api/v1/ingest, not a bare host: this
# value is POSTed to verbatim. The bare host 307s to /login, the operator UI, so a host-only
# value would silently push a blog at a login page and never say so.
CMS_URL = os.environ.get("STRATEGI_CMS_URL", "https://client.strategi.is/api/v1/ingest")

# One key = one org, so there is ONE variable per org and NO shared fallback.
#
# A shared STRATEGI_CMS_WRITE_KEY used to exist here for single-org convenience, and it was
# a cross-client leak waiting to happen. This engine holds several orgs at once. The CMS
# derives the destination org FROM THE KEY, and the payload is forbidden from carrying
# org_id, so the key is the only thing routing a draft. One shared variable therefore
# answers for every org: set it to BLR Brewing's key, press Post on a Vacation Village
# blog, and Vacation Village's content lands in BLR Brewing's CMS. Nothing in the request
# names the intended org, so neither side can catch the mismatch and the leak is silent.
#
# A missing per-org variable is a 503 that names the variable it wanted. That is a worse
# error message and a much better failure: it stops, instead of guessing wrong quietly.
#
# The key does NOT live in gates.json: that file is operator-visible and checked in, and a
# write credential in it is a credential in the repo.
KEY_VAR_PREFIX = "STRATEGI_CMS_WRITE_KEY_"

MAX_ATTEMPTS = 5
REQUEST_TIMEOUT = 30.0
# A guessed Retry-After of "3600" from a confused proxy must not hang the request
# for an hour with an operator watching a spinner.
MAX_BACKOFF_SECONDS = 30.0


class CmsError(Exception):
    """The CMS refused, or was unreachable after retries.

    `status` is the HTTP status when there was one, else None for a transport
    failure. The endpoint maps it; nothing here decides how it renders.
    """

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def key_var_for_org(org_slug):
    """The env var name for an org's write key: STRATEGI_CMS_WRITE_KEY_<ORG>.

    Raises on an empty org rather than returning a bare prefix. An org slug is
    the whole of a key's identity here, so an empty one is a caller bug, and
    resolving it to some default variable is how one org's key becomes another
    org's key.
    """
    normalised = (org_slug or "").strip().upper().replace("-", "_")
    if not normalised:
        raise ValueError("an org slug is required to resolve a CMS write key")
    return f"{KEY_VAR_PREFIX}{normalised}"


def resolve_key(org_slug):
    """The write key for THIS org, or None. Never another org's key.

    Returns None rather than raising so a caller can render "no key configured"
    as a setup problem, which it is, instead of a CMS failure, which it is not.
    """
    return os.environ.get(key_var_for_org(org_slug), "").strip() or None


def _is_dns_failure(error):
    """True when a transport error is really "that hostname does not exist".

    httpx wraps the resolver's socket.gaierror rather than exposing it, so the
    cause chain is the only honest way to tell an unresolvable host from a
    connection that was refused or reset. Matching on the message text would
    break on a different resolver or a non-English locale.
    """
    seen = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, socket.gaierror):
            return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


def _retry_delay(response, attempt):
    """Honour Retry-After when the CMS sends one, else exponential backoff."""
    raw = response.headers.get("Retry-After", "") if response is not None else ""
    try:
        delay = float(raw)
    except (TypeError, ValueError):
        delay = float(2 ** attempt)
    return max(0.0, min(delay, MAX_BACKOFF_SECONDS))


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
            "No CMS write key is configured for this org. Set the key in the "
            "engine's environment, not in gates.json."
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
