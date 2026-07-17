# Source Vetting Reference

The detailed rules behind Step 4 and Step 5 of the skill. Read this before vetting sources.

Contents:
1. Credibility tiers
2. Recency matrix
3. Red flags: fake and unreliable sources
4. Statistic-tracing protocol
5. Relevance and scope test

---

## 1. Credibility tiers

Every fetched source gets exactly one tier. The tier decides what the source is allowed to support.

### Tier A: primary evidence

The organisation that produced the data, or the body with direct authority over the fact.

- Peer-reviewed journals and conference papers.
- Government bodies, regulators, and official statistics agencies (the client's national statistics agency, financial and market regulators, sector authorities, and company or land registries, as named for the client's jurisdiction in `client.md`).
- Original research reports from credible research firms and analysts where the methodology is disclosed (Gartner, McKinsey, Pew, Princeton, Stanford HAI, and similar).
- Official company sources for facts about that company: filings, audited reports, official press releases.
- Standards bodies and industry associations publishing their own data.
- Court records, legislation, and regulatory orders for legal facts.

Tier A can support any claim, including the hard statistics the piece is built on.

### Tier B: reputable secondary

Established outlets with editorial standards and a track record, reporting on facts they did not generate.

- Recognised national and trade press with named authors and a corrections policy.
- Well-known industry analysts and consultancies summarising a field.
- Reputable databases and data aggregators that disclose their sources.
- Vendor research reports where the methodology is fully disclosed. Flag the commercial interest in the caveats line.

Tier B can support context and most factual claims. For a headline statistic, prefer to trace through Tier B to the Tier A original (see section 4). If the original cannot be found, Tier B is acceptable but the caveats line must say the primary source was not located.

### Tier C: weak

Usable for framing, tone, and illustration. Never for a hard fact.

- Vendor and company blogs making claims that serve their own sales case.
- Opinion columns, podcasts, and bylined think-pieces.
- Undated explainer pages with no author.
- Wikipedia and general reference wikis. Useful to find primary sources in the footnotes, not to cite directly.

A Tier C source can appear in the dossier only to support a context question, never a hard-fact question. If a claim has only Tier C support, it moves to Do Not Claim.

### Below C: reject on sight

Never cite. Log in the rejected list.

- Content farms and SEO listicles ("Top 50 X stats 2026").
- AI-generated articles with no author, no date, and no original data.
- Forums, comment threads, and social posts as a source of fact.
- Press-release reprints with no editorial layer.
- Any page that states a figure with no attribution at all.
- Sites that exist to sell a product and present marketing copy as research.

---

## 2. Recency matrix

Check the publication date and the data period against the claim type. The data period matters more than the publication date: a report published in 2026 can still rely on 2022 fieldwork.

| Claim type | Maximum acceptable age | Notes |
|---|---|---|
| Market size, adoption rates, traffic and search benchmarks | 18 months | This data moves fast. Older than 18 months, flag it or drop it. AI search behaviour data should be the most recent available. |
| Pricing, fees, plans, rates | 12 months | Verify against the source's current live page where possible. |
| Regulations, laws, compliance rules, tax rates | Must be current | Confirm the rule has not been amended or repealed. A superseded regulation is a factual error. |
| Industry surveys and "state of" reports | 24 months | Use the latest edition. If a newer edition exists, the older one is rejected. |
| Technology capabilities and product specifications | 12 months | Fast-moving. Confirm the feature still exists as described. |
| Company facts (leadership, headcount, locations, registration) | Must be current | Verify against an official current source. |
| Scientific and medical consensus | 5 years, with judgement | Prefer recent reviews. A settled mechanism does not expire; an evolving area does. |
| Established definitions, principles, history, frameworks | No limit | Age is not a defect for a stable concept. |

When a hard fact exceeds its window and no newer source exists, do not present it as current. Either attribute it explicitly to its year ("as of the 2023 report") and note the staleness in caveats, or move it to a coverage gap.

---

## 3. Red flags: fake and unreliable sources

If a fetched page shows any of these, treat the claim as unsupported and reject the source.

- The URL 404s, redirects to a homepage, or the page no longer contains the claimed content. Dead link.
- A statistic with no named source on the page. "Studies show" and "experts say" with no link or citation.
- A figure that traces in a circle: A cites B, B cites C, C cites A, and no one holds the original data.
- A round number that appears identically across many low-quality pages with no traceable origin. Often invented and then copied.
- A date mismatch: the page claims recent data but the underlying study or fieldwork is years old and not disclosed up front.
- A quote attributed to a person or institution that cannot be found in any primary source.
- A report whose methodology section is missing, vague, or refuses to state sample size or method.
- A page that has clearly been AI-generated to rank: generic structure, no author, no original reporting, padded with the same facts seen everywhere else.
- A claim that contradicts the consensus of Tier A sources, supported only by lower tiers.

When in doubt, the safe move is to reject the source and record the claim as a coverage gap. An honest gap is recoverable. A confident wrong citation damages the client.

---

## 4. Statistic-tracing protocol

Every hard number must be traced to the organisation that produced it.

1. Note where the figure first appeared in your search results.
2. Read that page. Find the attribution: who is it citing.
3. If it cites another source, fetch that source.
4. Repeat until the trail reaches the body that ran the study, survey, or dataset.
5. Cite that body, with its exact figure and its exact framing. Use the data period it states, not the year the figure was re-quoted.

If the trail goes cold (a marketing blog states a number and cites nothing, or links to a page that no longer has it), the statistic is unverified. It does not enter the dossier as a fact. It goes to Do Not Claim.

A figure is only as trustworthy as the last verifiable link in its chain. If you cannot reach the originator, say so in the caveats line and treat the figure with caution, or drop it.

---

## 5. Relevance and scope test

A credible, current source can still be wrong for the piece. Before a source enters the dossier, confirm:

- It answers a specific research question from Step 1, not just the general theme.
- Its scope matches the client's market. A benchmark from a different country, used for a client in another market, is a scope mismatch. Either find the local equivalent for the client's market or state the mismatch plainly in the caveats line so the writer does not present it as local.
- Its industry matches. Cross-industry data can be useful as context but must be labelled as such, never presented as specific to the client's sector.
- Its subject matches the entity the piece is about. Data about a parent company is not data about a subsidiary. Data about a category is not data about one product.
- It maps to a section the piece will actually contain. If no section needs it, cut it. The dossier is scoped by the brief, not by what is interesting.

A source that passes credibility and recency but fails scope is logged in the rejected list with the reason "scope mismatch", so the writer does not rediscover it and use it wrongly.
