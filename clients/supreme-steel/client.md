# client.md: Supreme Steel

The brand brief the engine loads for this client. It was generated at onboarding from the
operator's form. Every binding fact lives in `canonical-facts.md`, and where this brief and
`canonical-facts.md` disagree, `canonical-facts.md` wins.

## Identity
Brand name: Supreme Steel, and nothing else. There is no connection to any other client, past or
present. The operator-owned brand description is `clients/supreme-steel/description.md`. Read it as
context, never as a citable source.

## Domain
Primary domain: https://supremesteels.com/ . The live site wins over internal
docs on any conflict. If a fact is not in `canonical-facts.md`, it is not established: fetch
it, do not infer it.

## Market
Not recorded at onboarding. DataForSEO needs a location and language named here, so an
operator MUST fill this section in before the first real run. Do not guess a market from the
domain suffix.

## Industry reference
Industry: real-estate. Agent W MUST read `.claude/skills/geo-content-writer/references/industries/real-estate.md` on every run.
Skipping the industry reference produces generic content that does not fit this client.

## Entity names (the only permitted ways to name things)
Name things only as: Supreme Steel. Never use a generic stand-in such as "the company", "the brand",
or "the product". Add every further permitted entity name to `entity_names` in
`clients/supreme-steel/gates.json`, which is what the gates read.

## Link architecture
Every mention of this client's primary project or entity links to the canonical URL named in
`canonical-facts.md`. Never fabricate or guess a slug. Never cite this client's own blog as
evidence for a fact: it is marketing copy.

## Do not claim
The binding list is `canonical-facts.md`. Its do-not-claim section is authoritative for this
client, and no blog may make a claim it forbids.

## Resources
`clients/supreme-steel/Resources/` is this client's knowledge base. Read it before any external
search. Record any per-file exclusion in `canonical-facts.md`, for example an image-only PDF
with no extractable text is not a citable source.
