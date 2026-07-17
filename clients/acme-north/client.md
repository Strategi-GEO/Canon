# client.md: Acme North

The brand brief the engine loads for this client. It was generated at onboarding from the
operator's form. Every binding fact lives in `canonical-facts.md`, and where this brief and
`canonical-facts.md` disagree, `canonical-facts.md` wins.

## Identity
Brand name: Acme North, and nothing else. There is no connection to any other client, past or
present. The operator-owned brand description is `clients/acme-north/description.md`. Read it as
context, never as a citable source.

## Domain
Primary domain: https://example.com . The live site wins over internal
docs on any conflict. If a fact is not in `canonical-facts.md`, it is not established: fetch
it, do not infer it.

## Market
Not recorded at onboarding. DataForSEO needs a location and language named here, so an
operator MUST fill this section in before the first real run. Do not guess a market from the
domain suffix.

## Industry reference
Industry: technology-saas. Agent W MUST read `.claude/skills/geo-content-writer/references/industries/technology-saas.md` on every run.
Skipping the industry reference produces generic content that does not fit this client.

## Entity names (the only permitted ways to name things)
Name things only as: Acme North. Never use a generic stand-in such as "the company", "the brand",
or "the product". Add every further permitted entity name to `entity_names` in
`clients/acme-north/gates.json`, which is what the gates read.

## Link architecture
Every mention of this client's primary project or entity links to the canonical URL named in
`canonical-facts.md`. Never fabricate or guess a slug. Never cite this client's own blog as
evidence for a fact: it is marketing copy.

## Do not claim
The binding list is `canonical-facts.md`. The operator's own rules are in
`clients/acme-north/never-claim.md`, one per line, and they seed that file at review time.

## Resources
`clients/acme-north/Resources/` is this client's knowledge base. Read it before any external
search. Record any per-file exclusion in `canonical-facts.md`, for example an image-only PDF
with no extractable text is not a citable source.
