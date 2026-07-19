---
name: geo-research
description: Runs deep, source-vetted research before any long-form content is written, and produces a verified research dossier that the geo-content-writer skill drafts from. Use this skill whenever the user wants research done for a blog, article, guide, or any content piece, asks to "gather sources", "find credible sources", "research this topic", "build a research brief", or "fact-check before writing", or wants the Context Builder stage of the content pipeline. Also trigger automatically before geo-content-writer runs whenever a piece needs external statistics, studies, or cited sources, and whenever the user complains about hallucinated sources, broken links, outdated data, or wrong citations in past content. Do NOT trigger for writing or rewriting content (geo-content-writer) or for scoring a finished piece (geo-content-eval).
---

# GEO Research

A skill for producing a verified research dossier before a long-form piece is written. It does not write the piece. It hands a clean, source-vetted dossier to the geo-content-writer skill.

This skill exists to kill four specific failures that have shown up in delivered content:

1. Hallucinated sources. Citations to documents or pages that do not exist.
2. Shallow reads. A figure pulled from one line while the rest of the same source contradicts or qualifies it.
3. Dead links. Cited URLs that return 404 or have moved.
4. Stale data. Outdated statistics presented as current.

Every rule below traces back to one of those four. The dossier this skill produces should make it structurally impossible for the writer to cite something fake, broken, half-read, or out of date.

## When this skill applies

Trigger for: research ahead of a blog, article, guide, explainer, pillar page, or FAQ; the Context Builder stage of the autonomous content pipeline; any request to gather, vet, or fact-check sources for a piece; any time a brief requires external statistics or studies.

Do not trigger for: writing or rewriting content (use geo-content-writer), scoring a finished draft (use geo-content-eval), or short-form content that cites nothing.

## Inputs from the dispatching lead

The lead gives you four things on every dispatch: the client slug, the topic slug, the output directory, and the current iteration number. Use them for every path and every status line. Do not guess them.

Before any external search, read the client's binding context in this order:

- `clients/<slug>/client.md`: the client's market, language, industry, entity names, and the location and language code to pass to DataForSEO.
- `clients/<slug>/canonical-facts.md`: binding facts, verified URLs, and the do-not-claim list. Nothing you gather may contradict it.
- `clients/<slug>/Resources/` if it exists: the client knowledge base. Read it before searching the open web.

## The one rule that prevents hallucination

A source enters the dossier only if it was opened with firecrawl_scrape in this session and the fetched text actually contained the claim. No exceptions.

Search snippets are leads, not sources. A search result that looks perfect is not a source until it has been fetched and read. If firecrawl_scrape fails, returns nothing, or returns a page that does not contain the claim, the source is dead and is logged in the rejected list, never carried forward.

This single rule eliminates hallucinated citations and broken links at the same time. The URL written into the dossier is, by construction, a URL that resolved and a page that was read this session.

## The claim quota

The dossier is sized by the piece it feeds, not by what turned up. The writer spends one sourced claim every 150 to 200 words and may not invent one, so a dossier holding six claims cannot produce a piece that meets density. The writer then gets marked down for a gap the researcher left. Density is this skill's problem, and the quota is how it owns it.

Gather at least 12 verified claims, and never fewer than one per 150 words of the client's target length (`word_band.soft_max` in `clients/<slug>/gates.json`). At the house target of 2,000 words that is 14. Gather past the quota where the evidence is there. The quota is a floor, not a target: the writer selects from the dossier, and a writer that must spend every card it is handed has no way to leave the weak one out.

A claim counts only if its source card is complete: exact figure, named primary source, live URL fetched this session, publication date, data period, caveats from the full read. A half-filled card is not a claim. Nothing sitting in Do Not Claim, Rejected sources, or Coverage gaps counts toward the number.

Claims have two origins and there is no third:

1. The client knowledge base: `clients/<slug>/canonical-facts.md` and `clients/<slug>/Resources/`.
2. A claim carried by a real page fetched in full with `firecrawl_scrape` this session, or market data returned by DataForSEO for the market named in `client.md`.

Anything else is not a source. Search snippets are leads. Model memory is not a source and never becomes one. A thin knowledge base is never a reason to invent the twelfth claim.

### When the client's own facts run out, fill the quota from third parties

The client will not carry 12 claims. It is one firm, and most of what it holds is firm fact: counts, dates, specifications, the things only it can state. The remainder comes from third-party data specific to the client's market, never from padding and never by stretching the client's own material into a market claim.

This is a feature, not a consolation. Rubric B2, third-party citation strength, carries weight 3, the heaviest dimension in the Evidence bucket. It scores the ratio of external citations to self-referential ones and permits self-citation only for firm-specific facts. A dossier that fills its quota from independent market data scores B2 higher, not lower. The thin fact base and the density gap cure each other, and the cure is research, not prose.

### When the quota cannot be met, say so up front

Declare the shortfall in the dossier before the writer starts: the count in the header block, what is missing in the Summary, each unsupported claim in Coverage gaps. Carry it in the research end note as well, because the lead never reads the dossier and that note is the only line that reaches it.

Name the gap in specifics. "Evidence is thin" is not actionable. "No independent source for X in this market after fetching A, B and C, a Y report would settle it" is a task the lead can pick up.

A shortfall declared in the dossier costs one line. The same shortfall found by the evaluator four iterations later has cost the whole blog.

## Tooling

All fetching and grounding use Firecrawl. Fetch every candidate with `firecrawl_scrape` using `formats: ['markdown']`, `onlyMainContent: true`, `waitFor: 6000`, and read the entire returned text. Avoid multi-URL extract and JSON-schema extraction; they fail silently. Fetched full text, or it is not a source.

Keyword validation uses DataForSEO. Call `kw_data_google_ads_search_volume` with the `location_name` and `language_code` named in `clients/<slug>/client.md`, never a hardcoded location. Batch 10 to 12 keywords at a time, and split informational from buyer-intent keywords into separate batches. Null or low volume on a target prompt is expected for AI-search-first pieces and is never a reason to drop the prompt; volume shapes phrasing only.

## Status logging

Append your progress to `status.jsonl` with the helper, never hand-written JSON. Log a start line before Step 1 and an end line after Step 9:

```
python3 .claude/status.py --out <output_dir> --slug <slug> --stage research --event start --iter <n> --status running
python3 .claude/status.py --out <output_dir> --slug <slug> --stage research --event end --iter <n> --status running --note "N passed / N rejected / N claims against quota N, shortfall: none"
```

The `<output_dir>` is `outputs/<slug>/<topic-slug>/`, the same directory the dossier is written to. The lead cannot see inside your context; this file is how it tracks the chain.

## Workflow

Follow these steps in order. Do not skip.

### Step 1: Read the client context and the brief, then define research questions

Read the client context above, then read the topic, target keyword or target prompts, and the industry from the brief and `client.md`. Break the piece into the specific factual claims it will need to support. Each becomes a research question.

A research question is a single checkable fact, not a theme. "AI search adoption in a market" is a theme. "What share of that market's search queries returned an AI Overview in 2025" is a research question. Aim for one research question per claim the brief will lean on, then set the count from the claim quota above plus headroom, because questions die during vetting. At the house target of 2,000 words the quota is 14 verified claims, so 18 to 20 questions is the honest starting number.

Plan the split between origins here, not at the end. Mark which questions the client's own knowledge base answers, and which need third-party market data. A plan where the client answers everything is a plan that misses the quota and scores B2 at 1.

Mark each research question as either a hard-fact question (statistics, dates, named studies, specifications, prices, regulations) or a context question (definitions, established principles, background). Hard-fact questions get the strictest vetting. Context questions can rest on lower tiers.

Flag which research questions need data local to the client's market, using the market named in `client.md`. Prefer primary sources from that market for those questions. A benchmark from a different market, presented as if it applies to the client's market, is a relevance failure.

### Step 2: Search broadly for candidates

For each research question, search to find candidate sources. Cast wide first, then narrow. Look past the first page of results, the best primary source is often not the top-ranked result.

For any statistic, search specifically for the original publisher, not the blogs repeating it. A figure that appears in ten marketing blogs almost always traces to one report. Find that report.

### Step 3: Fetch every candidate in full

Open each candidate with firecrawl_scrape and read the entire returned text, not just the paragraph with the figure.

If the fetch fails or the page does not contain the claim, discard the candidate and log it in the rejected list. Do not carry it forward on the strength of a search snippet.

Reading the full source is what catches the shallow-read failure. While reading, watch for: methodology limits, sample size, the date the underlying data refers to as distinct from the publication date, scope conditions (one country, one industry, one company), and any sentence that contradicts, caps, or qualifies the headline number. All of this goes in the caveats line of the source card.

### Step 4: Vet each fetched source

For every source that survived the fetch, run four checks. See `references/source-vetting.md` for the full tiering rules, the recency matrix, and the red-flag list. Read that file before vetting.

1. Credibility. Assign a tier. Tier A is primary evidence (peer-reviewed research, government and regulator data, official filings, original research reports from credible firms, standards bodies). Tier B is reputable secondary (established news and trade press, recognised analysts, reputable databases). Tier C is weak (vendor blogs with a stake in the claim, opinion pieces, undated explainers). Tier C is usable for color and framing, never for a hard fact. Anything below C is rejected.
2. Recency. Check the publication date and the data period against the recency matrix in the reference file. A hard fact older than the matrix allows is flagged or dropped. A definition or established principle does not expire.
3. Relevance. The source must serve a specific research question and a specific section of the piece. Interesting but off-brief sources are cut. A source whose scope does not match the client's market, industry, or audience does not count as support.
4. Full read. Confirm the caveats line is filled from the whole source, not the snippet.

### Step 5: Trace every statistic to its primary source

If a Tier B or C source states a figure it did not generate, find the source that did, fetch it, and cite that one instead. Stop only when the trail reaches the organisation that produced the data.

This is where most attribution errors come from. A stat gets pinned to whoever last repeated it. The dossier cites the originator, with the originator's exact framing.

### Step 6: Cross-check and resolve conflicts

Where two credible sources disagree on a fact, do not silently pick one. Record both in the dossier with a short note on why they differ (different years, different methodologies, different scope). Tell the writer which one to lead with and why, or tell the writer to present the range.

If a claim the brief wants cannot be supported by any Tier A or B source, it does not go in the dossier as a fact. It goes in the Do Not Claim list.

### Step 7: Build the dossier

Assemble the output using the format below. Every vetted claim becomes a source card. Everything that failed becomes a Do Not Claim entry, a rejected-source entry, or a coverage gap.

Count the cards before writing the header block. Below quota, go back to Step 2 for third-party market data on the questions the client cannot answer. Do not close the gap by promoting a card that failed vetting or by splitting one claim into two. If the second pass comes back empty, declare the shortfall.

### Step 8: Run the final verification pass

Before handing off, confirm every item on this checklist. If any item fails, fix it before delivering.

- Every URL in the dossier was opened with firecrawl_scrape this session and returned the cited claim.
- Every figure has an exact number, a named primary publisher, a publication date, and a data period.
- No claim rests on a source seen only as a search snippet.
- Every source card has a caveats line filled from a full read, even if it reads "none found after full read."
- Every statistic has been traced to its originating organisation.
- Every source's scope matches the client's market and audience, or the mismatch is stated.
- Anything wanted but unverifiable is in Do Not Claim, not in the cards.
- Nothing gathered contradicts `clients/<slug>/canonical-facts.md`.
- The verified claims meet the quota, or the shortfall is declared in the header block, the Summary, the coverage gaps, and the end note.
- Every market, industry, or category claim rests on a third-party source, not on the client's own material.

### Step 9: Hand off

Save the dossier to `outputs/<slug>/<topic-slug>/dossier.md` and log the research end line. The lead freezes the dossier and passes it to geo-content-writer. The writer drafts only from the dossier. If the writer needs a claim the dossier does not contain, the answer is a bounded research top-up, not an invented source.

## Output format

ALWAYS use this exact structure. Save it as `outputs/<slug>/<topic-slug>/dossier.md`.

```
# Research Dossier: [piece topic]

**Brief:** [topic, target keyword, industry, client]
**Prepared for:** geo-content-writer
**Sources vetted:** [N fetched] / [N passed] / [N rejected]
**Claims verified:** [N] against a quota of [N] | Third-party: [N] | Client knowledge base: [N]
**Shortfall:** [none / the specific claims the quota is missing and what would settle them]

## Summary
[3 to 5 sentences: what the evidence supports, where it is thin, any quota shortfall and what is missing, the single biggest sourcing risk for this piece.]

## Verified claims

### C1: [the claim, stated the way the piece will use it]
- Fact: [exact figure or statement]
- Primary source: [publisher or organisation]
- Title: [document title]
- URL: [exact verified URL]
- Published: [date] | Data period: [what the data actually covers] | Verified live: yes, this session
- Tier: [A / B / C]
- Supports: [which section or H2 of the piece]
- Caveats from full read: [methodology, sample size, scope, contradictions. "None found after full read" only if genuinely checked.]
- Safe framing: [one sentence showing the writer how to state it without overreaching]

### C2: ...

## Conflicts
[Any fact where credible sources disagree. State both, explain the difference, recommend which to lead with or whether to present a range.]

## Do not claim
- [Claim]. Reason: [no primary source found / sources conflict with no resolution / only found in undated or low-tier content]

## Rejected sources
- [URL or title]. Reason: [dead link / content farm / outdated past matrix / re-cites without primary data / off-brief / scope mismatch]

## Coverage gaps
- [Claim the brief wants but research could not support]. Recommendation: [drop it / soften to qualitative / commission primary input from the client]
```

## Notes on specific situations

Paywalled sources. If the full text cannot be fetched, the source cannot be fully vetted and cannot be a Tier A anchor. Note it. Find an open primary source for the same fact, or move the claim to Do Not Claim.

Aggregators and "X statistics 2026" listicles. These are leads only. Never cite them. Use them to find the primary reports they pulled from, then cite those.

Vendor research. A vendor's own report can be Tier B for an industry benchmark if the methodology is disclosed, but flag the commercial interest in the caveats line so the writer frames it honestly.

Competitor research, where the client sets `"competitor_policy": "never_name"` in `gates.json`, is a DEAD END rather than a Tier B source. Such a client never names a rival, and a citation names its author, so a claim sourced to a competitor cannot be used no matter how good the number is. Do not carry one into the dossier expecting the writer to find a way: it arrives as an unusable claim and costs an iteration to discover. Find the same fact in an independent source, or record it as a coverage gap. Where the client sets no such policy, the vendor rule above applies to competitor research unchanged.

Thin evidence. If a topic genuinely lacks good sources, say so in the summary, the coverage gaps, and the end note. A short, honest dossier beats a padded one. Do not manufacture support to fill the template.

The quota does not override that, and the order matters. A count short of quota means search third-party market data for the questions the client cannot answer, because that is where the missing claims usually are. Only when that comes back empty is the dossier honestly short, and then it is declared, never filled. The quota exists to make research harder, not to make sourcing looser.

Copyright. The dossier paraphrases. Keep any verbatim anchor quote short. The dossier is an internal working document, not a place to reproduce source text at length.

## House style

House style rules apply to this skill's own output. No em dashes and no en dashes anywhere; use commas or colons. Direct, plain language. No corporate or AI-generic phrasing. The dossier is a working document, so write it terse and scannable.

## Reference index

- `references/source-vetting.md`: Full credibility tiering with examples, the recency matrix by claim type, the fake and unreliable source red-flag list, and the statistic-tracing protocol. Read this file every time the skill runs.
