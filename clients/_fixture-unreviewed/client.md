# client.md: Fixture Unreviewed (TEST FIXTURE ONLY, NEVER SELECT FOR REAL WORK)

This client exists ONLY as a test fixture proving the preflight refusal, and it must never be
selected for real work. Its `canonical-facts.md` contains the literal token `PLACEHOLDER` on
purpose, so preflight refuses to start any topic against it and writes the terminal `failed`
status naming the reason. That refusal is a real safety property: every blog for a client
inherits its fact file, so an unreviewed one would silently poison the whole queue. Deleting
this fixture would leave that property untested.

The leading underscore in `clients/_fixture-unreviewed/` marks it as not a real client. It is a
test artifact living beside the real ones because preflight reads clients from disk, and a
fixture that lived anywhere else would not exercise the real code path.

It is deliberately NOT a demo_mode client. A demo_mode client skips preflight, so it cannot
prove a preflight refusal. This fixture must keep running the real preflight and must keep
failing it.

## Identity
Fixture Unreviewed is a fictional placeholder client with no brand, no product, and no content.
It never reaches Agent R, Agent W, or Agent E, because preflight stops it first.

## Domain
None. Nothing is ever fetched for this client.

## Do not claim
Everything. This client has no reviewed facts and establishes nothing.

## Resources
None.
