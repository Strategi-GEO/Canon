# DataForSEO playbook - what to pull and what it tells you

Read this before the data pull in step 3. It covers which endpoint answers which question, the parameters that matter, and the traps.

Strategi is on a paid credit-based plan, so all Labs and AI Optimization endpoints are available.

## Contents

- [Ground rules](#ground-rules)
- [Layer 1 - What buyers ask](#layer-1--what-buyers-ask)
- [Layer 2 - Intent](#layer-2--intent)
- [Layer 3 - Demand, both kinds](#layer-3--demand-both-kinds)
- [Layer 4 - The citation landscape](#layer-4--the-citation-landscape)
- [Layer 5 - Client and competitor standing](#layer-5--client-and-competitor-standing)
- [Optional layers](#optional-layers)
- [Reading the numbers together](#reading-the-numbers-together)
- [Traps](#traps)

---

## Ground rules

- **One location, one language, everywhere.** Pick `location_name` and `language_code` once from the client's actual market and use the same pair in every call. Mixed locations produce figures that cannot be compared to each other, and the roadmap's justifications become nonsense.
- **Read the endpoint's schema before calling.** Parameter names differ between endpoint families, so take the schema the MCP server gives for the endpoint rather than guessing the shape.
- **Batch.** Most of these take up to 1,000 keywords per call. One call for the set beats one call per row, in both time and credits.
- **Record provenance per figure.** Metric, value, endpoint, date. There is no prose `Justification` column and there never should be: the six data-point columns ARE the justification, and the prose about them belongs in the generation session's report, which is built from this bookkeeping and cannot be reconstructed afterwards. The figures themselves are only trustworthy because this was kept.

## Layer 1 - What buyers ask

| Endpoint | Use it for |
|---|---|
| `dataforseo_labs_google_keyword_ideas` | Broad expansion from a product or service term. Widest net, noisiest. |
| `dataforseo_labs_google_keyword_suggestions` | Long-tail phrases containing a seed. Where full buyer questions live. |
| `dataforseo_labs_google_related_keywords` | Adjacency. Surfaces the clusters next to the obvious one, which is usually where the unclaimed topical authority is. |
| `dataforseo_labs_google_top_searches` | Category-level volume when the client's own terms are too narrow to expand from. |

Seed from what the company actually sells (step 2 of the workflow), not from what the category is called. A seed list built from the category name returns the category's incumbents' vocabulary, and the roadmap ends up chasing them.

## Layer 2 - Intent

`dataforseo_labs_search_intent` takes up to 1,000 keywords and returns intent classification per keyword.

This is what decides the commercial/topical weighting per cluster rather than a judgement call, and it is what fills `Query Intent`, which classifies the row's PRIMARY target prompt. Map its output to the contract's three values: transactional and commercial both become `Commercial`; navigational stays `Navigational`; everything else is `Informational`. A prompt this call returned no classification for leaves the cell BLANK, on the same rule as every other data cell: an intent nobody pulled is a guess, and the sheet's commercial/topical mix is counted from this column, so a guess here mis-states the whole split.

Treat a cluster where intent is overwhelmingly informational as a topical-authority play even if the client would prefer it were commercial. Forcing a buyer-guide format onto an informational cluster produces a piece that ranks for nothing and gets cited for nothing.

## Layer 3 - Demand, both kinds

Two different questions, two different endpoints, and they disagree often enough that pulling only one is misleading.

**`kw_data_google_ads_search_volume`** - exact-match monthly Google volume, and the only acceptable source for two of the sheet's columns. Run against the row's primary KEYWORD it populates `Keyword Volume`; run against the row's primary TARGET PROMPT, the full conversational query, it populates `Query Volume`. Those two are usually an order of magnitude apart and the gap is the point: a head term with 1,000 searches and a buyer question with 20 are different arguments, and a roadmap that reports only the first is selling the client the wrong one. Integer or blank, never estimated.

The same response carries CPC, which populates `Cost Per Click`. CPC is what turns a volume into a commercial argument: a term with 90 searches and a $4 CPC is a term advertisers pay real money to reach, and that is a stronger case for a slot than a 2,000-volume term nobody bids on. Two decimals or blank.

**`ai_optimization_keyword_data_search_volume`** - estimated usage of the term inside LLMs. Required params: `keywords` (up to 1,000), `language_code`. `location_name` defaults to United States, so always set it explicitly.

The gap between them is the most useful signal in the whole pull:

| Pattern | What it means | Roadmap action |
|---|---|---|
| High AI volume, low Google volume | Buyers ask this conversationally rather than searching it. Almost never targeted by competitors. | Prime slot. Long-form question-shaped piece. |
| High Google volume, low AI volume | Established search demand, mature SERP, less likely to surface in answers. | Include for demand, but do not let it dominate the mix. |
| High on both | Contested. Worth a slot only with a genuine differentiator. | Include if the client has first-party proof to carry. |
| Low on both | Neither channel wants it. | Drop, unless it is structurally needed to complete a cluster. |

**`dataforseo_labs_bulk_keyword_difficulty`** - up to 1,000 terms in one call, and it populates `Keyword Difficulty`. Use it for SEQUENCING within a cluster, never as a reason to drop a topic the client has real authority to win: difficulty measures the incumbents' link profiles, which is a statement about the blue-link SERP and only loosely about whether an engine will cite you. A 70-difficulty term the client can answer better than anyone is still a good row, and the report should say so rather than the roadmap quietly avoiding it.

## Layer 4 - The citation landscape

This layer is the reason the roadmap targets AI citation rather than rankings.

**`ai_opt_llm_ment_top_domains`** - pass the category keywords in `target` as `{"keyword": "..."}` objects. Returns the domains that get pulled into LLM answers for those queries. `links_scope` switches between `sources` and `search_results`; `sources` is the citation set proper.

**`ai_opt_llm_ment_top_pages`** - the same, one level down: the individual pages that get cited. Read the *shape* of these pages, not just the domains. If the cited set is dominated by comparison pages, the roadmap should be comparison-heavy. If it is dominated by definitional explainers, that is what gets cited in this category and the format mix should follow.

`platform` takes `chat_gpt` or `google`. Pull both when the budget allows; they diverge, and the divergence is worth a line in the summary.

Filters use the array form: `[["ai_search_volume", ">", "1000"]]`. `ai_optimization_llm_mentions_filters` lists every available field, which is worth loading once rather than guessing field names.

## Layer 5 - Client and competitor standing

**`ai_opt_llm_ment_agg_metrics`** with `target: [{"domain": "client.com"}]` - aggregated mention metrics for the client. Run it again for each real competitor.

A client absent from mentions on their own category terms is the strongest single argument in the deliverable, and it is the line the client will repeat internally. Record the exact query set it was measured against so it can be re-measured in the monthly report and shown to move.

**`ai_opt_llm_ment_cross_agg_metrics`** compares 2 to 10 targets with aggregation keys in one call. Cleaner than running the single-target endpoint repeatedly when the competitor set is known.

**Competitor identification**, when the client's stated competitors are not the ones actually winning the queries:

- `dataforseo_labs_google_competitors_domain` - domains competing on the client's ranked keyword set
- `dataforseo_labs_google_serp_competitors` - domains ranking across a supplied keyword list
- `dataforseo_labs_google_domain_intersection` - queries a competitor wins and the client has nothing for. This produces roadmap rows almost directly, and each one comes with the competitor URL as evidence.
- `dataforseo_labs_google_ranked_keywords` - what the client already ranks for, which doubles as a cannibalisation input

## Optional layers

Pull these when the category warrants it, not by default:

- `kw_data_dfs_trends_explore` / `kw_data_google_trends_explore` - seasonality. Changes publish sequencing, not topic selection.
- `ai_optimization_llm_response` / `ai_optimization_chat_gpt_scraper` - a live answer to one category question. Expensive per call and slow; use for two or three flagship queries where seeing the actual answer changes the plan or gives the deck a screenshot.
- `content_analysis_search` / `content_analysis_phrase_trends` - where a brand or phrase is already being discussed, useful for off-site citation planning.
- `dataforseo_labs_google_historical_keyword_data` - whether a term is growing or dying. A declining term with good volume is a bad slot.

## Reading the numbers together

A row earns its place when at least two independent signals point at it. One number alone is a coincidence. Strong combinations:

- AI volume high + client absent from mentions + no existing page → the best rows in any roadmap
- Competitor wins the query + intent is commercial + client sells exactly this → direct revenue row
- Cited page shapes in the category match this format + cluster has no client coverage → topical authority row
- High Google volume alone, nothing else → the weakest case a row can make; use sparingly and say so in the report

## Traps

- **`location_name` defaults to United States on the AI Optimization endpoints.** Set it every time. An India-facing client with US figures produces a roadmap built on the wrong market, and the error is invisible in the output.
- **Volume figures are point-in-time.** Date-stamp them in the report. A roadmap reused six months later carries stale numbers presented as current.
- **Keyword ideas endpoints return the client's own brand terms.** Strip them before analysis; branded volume is not addressable demand.
- **Zero is a real figure. Blank means unknown.** They are different values and the contract treats them differently.
- **Do not average across locations or interpolate from a similar keyword.** If the exact term has no figure, the cell is blank.
