"""The retry rules every destination shares, and nothing about any destination.

WHY THIS WAS LIFTED OUT OF client.py RATHER THAN COPIED INTO THE NEW DRIVER. client.py had
already earned four rules the hard way: honour Retry-After but cap it, retry 429 and 5xx only,
retry a refused or reset connection because the request is idempotent, and fail an unresolvable
host IMMEDIATELY because DNS will not start working during a backoff. A second HTTP caller that
reimplements those gets three of them right and discovers the fourth in production. So the rules
live here once, and each destination keeps only the part that is genuinely its own: which status
codes are permanent for it, and how to read an error out of its response body.

NOTHING HERE KNOWS ABOUT A CMS, A PAYLOAD OR A CREDENTIAL. It takes a request and returns a
response or raises. That is what makes it testable without a server and reusable by a driver
that speaks GraphQL as easily as one that speaks REST.
"""
import asyncio
import logging
import socket

import httpx

log = logging.getLogger("geo-factory")

MAX_ATTEMPTS = 5
REQUEST_TIMEOUT = 30.0
# A guessed Retry-After of "3600" from a confused proxy must not hang the request for an hour
# with an operator watching a spinner.
MAX_BACKOFF_SECONDS = 30.0


class TransportError(Exception):
    """The destination refused, or was unreachable after retries.

    `status` is the HTTP status when there was one, else None for a transport failure. Callers
    map it to something an operator can act on; nothing here decides how it renders.
    """

    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def is_dns_failure(error):
    """True when a transport error is really "that hostname does not exist".

    httpx wraps the resolver's socket.gaierror rather than exposing it, so the cause chain is
    the only honest way to tell an unresolvable host from a connection that was refused or
    reset. Matching on the message text would break on a different resolver or a non-English
    locale.
    """
    seen = set()
    while error is not None and id(error) not in seen:
        if isinstance(error, socket.gaierror):
            return True
        seen.add(id(error))
        error = error.__cause__ or error.__context__
    return False


def retry_delay(response, attempt):
    """Honour Retry-After when the destination sends one, else exponential backoff."""
    raw = response.headers.get("Retry-After", "") if response is not None else ""
    try:
        delay = float(raw)
    except (TypeError, ValueError):
        delay = float(2 ** attempt)
    return max(0.0, min(delay, MAX_BACKOFF_SECONDS))


async def send(method, url, *, client=None, label="destination", **kwargs):
    """One request, retried under the shared rules. Returns the httpx.Response.

    RETURNS THE RESPONSE EVEN WHEN IT IS A 4xx, and raises only when there is no response to
    hand back: an unreachable host, or a 429/5xx that survived every attempt. The caller owns
    what a 404 or a 422 MEANS, because that differs per destination and per endpoint, and a
    helper that decided it here would force every caller to unwrap an exception to find a
    status it was expecting anyway.

    `label` names the destination in the error text. An operator reading "cannot reach the
    destination" learns nothing; one reading "cannot reach acme.com" knows where to look.
    """
    owned = client is None
    http = client or httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True)
    try:
        last = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                response = await http.request(method, url, **kwargs)
            except httpx.HTTPError as cause:
                # An unresolvable hostname is a CONFIGURATION fact, not a blip: it will not
                # start resolving during a backoff, so retrying buys the operator 31 seconds
                # of spinner before the same error. Fail now and name the host, because the
                # fix is DNS or a typo in the stored URL and neither is worth waiting for.
                if is_dns_failure(cause):
                    raise TransportError(
                        f"Cannot reach {label}: that hostname does not resolve. Check the "
                        f"site address on the brand's blog destination."
                    )
                # Every other transport failure IS worth a retry: a refused or reset
                # connection is the same class of problem as a 5xx.
                last = TransportError(f"Cannot reach {label}: {cause}")
                if attempt == MAX_ATTEMPTS - 1:
                    break
                await asyncio.sleep(min(float(2 ** attempt), MAX_BACKOFF_SECONDS))
                continue

            if response.status_code == 429 or response.status_code >= 500:
                last = TransportError(
                    f"{label} answered {response.status_code}.", status=response.status_code)
                # The final attempt has nothing left to wait for: sleeping after it burns up to
                # MAX_BACKOFF_SECONDS of an operator's spinner and then raises anyway.
                if attempt == MAX_ATTEMPTS - 1:
                    break
                # No credential here, and no payload: the body is a whole blog.
                log.warning("%s %s -> %s, retrying (attempt %s of %s)",
                            method, label, response.status_code, attempt + 1, MAX_ATTEMPTS)
                await asyncio.sleep(retry_delay(response, attempt))
                continue

            return response

        raise last or TransportError(f"{label} did not answer after retries.")
    finally:
        if owned:
            await http.aclose()
