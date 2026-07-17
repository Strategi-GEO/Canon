# client.md: Vacation Village

The brand brief the engine loads for this client. Every fact here is derived from
`canonical-facts.md` (binding) and the source operating contract. Where this brief and
`canonical-facts.md` disagree, `canonical-facts.md` wins.

## Identity
Brand name: Vacation Village, and nothing else. There is no connection to any other client,
past or present. Vacation Village is a second-home and villa-plot developer. It has one
project: Vacation Village Chikkamagaluru, a plotted development in the Western Ghats, about
230 km from Bengaluru (a 4-hour drive).

## Domain
Primary domain: https://vacationvillage.co.in/ . The live site wins over internal docs on any
conflict. If a fact is not in `canonical-facts.md`, it is not established: fetch it, do not
infer it.

## Market
Market: India, Karnataka, Chikkamagaluru, with buyers driving in from Bengaluru. This is what
"prefer sources local to the client's market" resolves to for this client: Karnataka and
Chikkamagaluru local data, Indian property research, and RERA records. Prefer these over
generic or Western sources.

## Industry reference
Industry: real estate. Agent W MUST read
`.claude/skills/geo-content-writer/references/industries/real-estate.md` on every run.
Skipping this reference produces generic content that does not fit a real-estate client.

## Entity names (the only permitted ways to name things)
Name things only as one of: Vacation Village, Vacation Village Chikkamagaluru,
Agrocorp Landbase, ALPL 3 LLP, The Manor. Never use a generic stand-in such as "the company",
"the brand", "the developer", or "the product".

## Link architecture
- Every mention of Vacation Village Chikkamagaluru links to
  https://vacationvillage.co.in/projects.php .
- Other pages use the verified URLs in `canonical-facts.md` §3. Never fabricate or guess a
  slug.
- Honour the forbidden link targets in `canonical-facts.md` §3.1.
- Never cite a Vacation Village blog as evidence for a fact. The blog pages are marketing copy,
  and several contain claims `canonical-facts.md` forbids.
- Never link anything under `/blog/test/`.

## Do not claim (`canonical-facts.md` §6 is the binding list)
- No returns, appreciation, yield, ROI, or "guaranteed" / "assured" language anywhere,
  including FAQ answers and tables.
- Do not reuse ROI language from Vacation Village's own marketing, and do not reuse the
  market-growth stats in its press releases. Source any market-growth claim from an
  independent, India-specific third party instead.
- No title, conversion, DTCP, or khata claims, except the verbatim-permitted set in
  `canonical-facts.md` §6.2.
- No possession, handover, or completion dates.
- No maintenance, CAM, or club fees.
- No unsubstantiated superlatives: best, first, only, number one, India's leading, largest,
  most.
- The Manor is a separate entity (`canonical-facts.md` §4). It carries its disclaimer
  verbatim, and it is never counted among the project's 24+ amenities.
- Frame every Vacation Village projection as Vacation Village's own guidance, never as
  independent fact.
- Do not publish the project's geo coordinates (`canonical-facts.md` §7 #8, unresolved).

## Banned phrases (client-specific)
"seamlessly" is banned for this client because it appears in Vacation Village's own site copy
and must never be lifted. Paraphrase instead. The generic AI phrases are already covered by
the house banned-phrase list; the client `gates.json` list holds only this extra one.

## Resources
The brochure PDF in `Resources/` is image-only with zero extractable text
(`canonical-facts.md` §7 #10). No claim may be attributed to the brochure.

## Verbatim-claim note
`canonical-facts.md` §6.2 requires some claims to be reproduced EXACTLY. Those verbatim
strings contain passive voice and generic entity words (for example "The land is completely
owned by the Promoters. This is not a joint development."). That is why the gates exempt quoted
spans: a required verbatim claim must survive the passive-voice and entity-clarity checks
unchanged.
