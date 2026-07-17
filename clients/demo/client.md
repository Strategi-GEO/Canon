# client.md: Demo (FICTIONAL, THE DEMO ORGANISATION)

Demo is the demo organisation. Its blogs are precoded and short, generated with no research and
no API calls, and saved to `clients/demo/output/<topic-slug>/blog.md` exactly like a real blog,
so the preview drawer, the status table and the ledger can all be demonstrated end to end. No
Demo output may ever be published. Every demo blog carries a visible marker at the top saying
it is demo content generated without research or API calls.

## What makes this client mock
`"demo_mode": true` in `clients/demo/gates.json` is the single flag that makes this client mock.
The runner treats a demo_mode client as mock in EVERY environment, including a production
deployment holding real credentials, so this client can never spend an API call or a token.
Preflight is skipped for a demo_mode client, exactly as mock mode already skips it. That one
flag is the whole mechanism: remove it and this client would attempt a real run, which is why
it stays.

Any client without `demo_mode` is a real client. It runs the full pipeline (research, write,
gates, links, eval) and must have a human-approved `canonical-facts.md`.

## Identity
Brand name: Demo, and nothing else. There is no connection to any other client. Demo is a
fictional software company that exists only to demonstrate the pipeline.

## Domain
Primary domain: https://example.com . Nothing is ever fetched from it, because this client makes
no network calls.

## Market
Market: United Kingdom. This is recorded so the file demonstrates what onboarding asks a real
client for. No source is ever fetched for Demo, so the market shapes nothing at runtime.

## Industry reference
Industry: technology-saas. A real client's Agent W MUST read
`.claude/skills/geo-content-writer/references/industries/technology-saas.md` on every run,
because skipping the industry reference produces generic content. Demo never reaches Agent W:
its blogs come from the precoded template instead.

## Entity names (the only permitted ways to name things)
Name things only as: Demo. Never use a generic stand-in such as "the company", "the brand", or
"the product".

## Link architecture
No live links. Demo blogs cite nothing real, and their Sources line says exactly that. Never
fabricate or guess a slug here or anywhere.

## Do not claim
Claim nothing about Demo as fact outside a demo artifact. `canonical-facts.md` for this client
holds fictional demo facts, not reviewed facts, and it is honest about that on its first line.
Demo content is never evidence for anything and is never publishable.

## Resources
None. This is a fictional client with no source material.
