---
name: roadmap-generation
description: Build a content roadmap from scratch for a client or prospect: full Firecrawl site scrape, DataForSEO query and AI-citation data, a commercial-intent vs topical-authority split decided from that data, the topic titles, a cannibalisation gate against everything already published, and a spreadsheet. Use whenever the user asks for a content roadmap, content plan, content calendar, topic plan, blog plan, or "N blogs for [client]", and whenever a client domain is supplied with intent to plan what gets written. Trigger on "make a content roadmap for [URL]", "plan 24 articles for [client]", "what should we write for them", "build the roadmap", or a bare domain plus a piece count. Strongly prefer this over inventing topics freehand: a roadmap built without the scrape cannibalises existing posts, and one built without the data pull cannot justify a single row. Do NOT use to write the articles (geo-content-writer) or audit the site (geo-site-report).
---

# Roadmap Generation

Produces the list of pieces a client should publish next, with the evidence for each one.

The roadmap is titles only. Rewriting existing pages, briefs, outlines and drafts are separate jobs downstream. What this skill owns is: which pieces, in what shape, why those and not others, and proof that none of them collides with something the client already has.

Two failure modes kill a roadmap, and both are avoidable:

1. **Cannibalisation.** A topic that overlaps an existing post splits the client's own signal and wastes the slot. Every proposed piece is checked against the full published inventory before it ships, not after.
2. **Unjustifiable rows.** A client asks "why this one?" and the answer is a shrug. Every row carries a named metric, a real figure and where it came from. A row that cannot be justified from pulled data is dropped, not softened.

## What the roadmap is optimising for

AI citation, not blue links. That changes what the data pull is for. Google monthly search volume still matters as a demand proxy, but the roadmap is built around what buyers *ask*, full questions, comparisons, shortlists, and around which pages LLMs currently pull answers from in this category. `ai_search_volume` from the DataForSEO AI Optimization endpoints is the closer proxy for that, and where the two disagree, the AI figure wins on topic selection while the Google figure still gets reported.

Every roadmap balances two jobs, and the weighting between them is a data decision, not a default:

- **Commercial intent**: comparison, alternatives, pricing, "best X for Y", location and buyer-guide pieces. Wins revenue attribution fast, gets cited on shortlist queries, but does nothing for the entity understanding that makes an LLM name the client unprompted.
- **Topical authority**: definitional, explainer, mechanism, FAQ-entity and data pieces that make the model treat the client as a source on the subject. Slower, compounding, and the reason a brand gets recommended in answers it never targeted.

Skew commercial when the client already appears in LLM answers for category terms but is absent on comparison, pricing or shortlist queries, when the sales cycle is short, or when they have a deep informational archive and no bottom-funnel content. Skew topical when the client is absent from LLM mentions on the category-defining queries, when the category has low Google volume but high AI search volume (a sign buyers are asking rather than searching), when the products are technical enough to need explaining before they can be compared, or when the existing archive is thin. State the split as a ratio with the evidence behind it before writing a single title.

## Inputs

Ask only for what is missing, once, and then run:

- **Client domain** (required unless the user supplies a topic brief instead)
- **Number of pieces** (required: a roadmap without a count is a wish list)
- **Market and language** (default to India / `en` for a `.in` or India-facing site, otherwise infer from the site and say what was inferred; every DataForSEO call must use the same `location_name` and `language_code`)
- **Any topics or products already off-limits or mandatory** (optional)

If the user gives a count but no domain and no way to research the client, say so: the skill cannot run on nothing, and inventing topics is exactly what it exists to prevent.

## Workflow

### 1. Read the whole site (Firecrawl)

Firecrawl concurrency is 2. Never run more than two calls in parallel or the run stalls.

1. `firecrawl_map` the domain. Keep the full URL list: it is the cannibalisation baseline.
2. Scrape the money pages: home, every product and service page, pricing, about, any location pages. These give you what the company actually sells, in its own words.
3. Scrape **every** blog, resource, guide, case study and FAQ page. Not a sample. A roadmap that has only seen half the archive will duplicate the other half. If the archive is large, batch it and keep going: the cost of missing a post is a dead slot in the deliverable.
4. Build `inventory.json` as you go, one record per published piece:

```json
{"url": "...", "title": "...", "h1": "...", "primary_topic": "...", "queries_it_answers": ["..."], "published": "2025-04-11", "words": 1200, "type": "blog"}
```

Save it to the run folder. It is used twice: once now to find the gaps, and once at the gate in step 5.

Note what the site does **not** cover as explicitly as what it does. The gaps are where the roadmap lives.

**Never use `firecrawl_agent`.** It hides source attribution and you cannot verify what it returned. Use `map`, `scrape`, `search`, `crawl` only.

### 2. Fix the commercial spine

Before any keyword work, write down in plain language:

- What the company sells, product by product and service by service
- Who buys each one and what they are trying to decide
- The claims the company makes about itself that content could carry
- Which existing pages already serve which part of the funnel

Every row in the final roadmap has to connect back to something on this list. A topic with high volume and no line back to what the client sells is traffic, not a roadmap row.

### 3. Pull the data (DataForSEO MCP)

Endpoints, parameters and what each metric is actually good for: read `references/dataforseo-playbook.md`. Do not guess parameter shapes: read the schema the MCP server gives for the endpoint, then call it.

Firecrawl and DataForSEO are always present. Anything else is conditional on the machine holding a key for it, so use the tool a step names only when the run has told you it is connected, and never report a figure from a tool you do not have.

**Every one of the six data-point columns is a live figure or a blank cell, and there is no third option.** They are the argument the client reads, so a number nobody pulled is worse than no number at all: a blank says "we could not measure this", and a guess says "we measured this" untruthfully, and nobody downstream can tell them apart afterwards.

The minimum viable pull, in this order:

1. **Seed expansion**: `dataforseo_labs_google_keyword_ideas` and `dataforseo_labs_google_keyword_suggestions` from the service and product terms in step 2, plus `dataforseo_labs_google_related_keywords` for adjacency.
2. **Intent**: `dataforseo_labs_search_intent` across the full seed set. This is what decides the commercial / informational split per cluster instead of eyeballing it, and it populates the **Query Intent** column, which classifies the row's PRIMARY target prompt. It is a live classification and never an eyeball read of the prompt text, which is also why it is not redundant with the prompts cell: that cell deliberately holds three prompts of differing intent, and the sheet's commercial/topical mix is computed by counting this column. Where no live call returns a classification, the cell is blank, exactly like every other data cell.
3. **Google demand**: `kw_data_google_ads_search_volume` for the surviving terms, at the client's real location and language. Exact figures only. This populates **Keyword Volume** for the row's primary keyword, and, run against the primary target prompt itself, **Query Volume**.
4. **Cost and difficulty**: the same `kw_data_google_ads_search_volume` response carries CPC, which populates **Cost Per Click**; `dataforseo_labs_bulk_keyword_difficulty` populates **Keyword Difficulty**. Both are up to 1,000 terms per call, so one batched call covers the whole shortlist. CPC is the column that turns a volume into a commercial argument: a term with 90 searches and a high CPC is a term advertisers pay real money for, which is a stronger case for a slot than a high-volume term nobody bids on.
5. **AI demand**: `ai_optimization_keyword_data_search_volume` for the same terms. This is the LLM-usage figure, it populates **AI Search Volume**, and it frequently disagrees with Google. Where AI volume is high and Google volume is low, that is a roadmap opportunity, not a rounding error.
6. **Citation landscape**: `ai_opt_llm_ment_top_domains` and `ai_opt_llm_ment_top_pages` on the category keywords. This tells you which domains and which *page shapes* get pulled into answers in this category. Match the roadmap's format mix to what actually gets cited.
7. **Client standing**: `ai_opt_llm_ment_agg_metrics` with the client domain as target, and again with the two or three real competitors. Absence is the single strongest argument for a topical-authority skew, and it is the line the client will quote back to you.
8. **Competitor set**: `dataforseo_labs_google_competitors_domain` or `dataforseo_labs_google_serp_competitors` to confirm who the competitors actually are, then `dataforseo_labs_google_domain_intersection` to find the queries competitors win and the client has nothing for.

9. **The brand's own Search Console data, when SEO Gets is connected** (`mcp__seogets__*`, and the run tells you whether it is): pull STRIKING DISTANCE, the queries this brand already ranks just off the money, and QUERY MOVEMENT since last month. Everything in steps 1 to 8 is inferred from the outside, from competitors and from category demand; this is the brand's own measured performance, so where the two disagree this one wins about THIS brand.

   **A striking-distance query is the strongest row a roadmap can carry.** The brand has already proved it can rank on that ground, so the piece finishes a job rather than starting one, and it converts sooner than any greenfield row in the sheet. Weigh those first when you allocate the count, and name the source in the report when a row comes from there. Query movement is the other half: a term that is climbing deserves reinforcement, and one that is falling is either a rewrite job (not this skill's) or a signal the ground is going.

   A brand SEO Gets holds no property for returns nothing. That is ordinary for a new client and is not an error: say the tool returned no data and plan from the rest.

Optional, when the category warrants it: `kw_data_dfs_trends_explore` for seasonality, `ai_optimization_llm_response` or `ai_optimization_chat_gpt_scraper` to see a real answer for a category question.

Keep every figure with the endpoint and the date it came from. There is no prose column to hold that bookkeeping: the figures ARE the justification, and the provenance behind them goes in the step 7 report, which is where prose about the numbers lives. Reconstructing it afterwards is guesswork, so keep it as you pull.

### 4. Decide the split, then write the titles

State the weighting first, in one line, with its evidence: *"60 commercial / 40 topical: client appears in zero of eight category LLM mentions but has nine existing explainers and no comparison content."* Then allocate the requested piece count across clusters against that ratio.

Title rules that hold regardless of category:

- One piece owns exactly one primary query. Two rows chasing the same query is cannibalisation you created yourself.
- The title has to be specific enough that a writer knows the piece without a brief.
- Qualify with the thing that makes it defensible: the market, the buyer, the constraint, the year where it genuinely matters. `Best CRM Software` is unwinnable; `Best CRM for Indian D2C Brands Under 20 Staff` is a piece.
- No `| Brand Name` suffix. That is a meta title, not a topic.
- Match the format mix to what step 5 of the data pull showed gets cited in this category. If comparison pages dominate the citations, the roadmap is comparison-heavy.
- Coverage over cleverness. Fifteen angles on one cluster is a hole in the roadmap, not depth.

Content types come from the taxonomy in `assets/format-taxonomy.json`, spelled exactly. That file also carries the structural quotas (exactly one hub listicle, one comparison anchor, one FAQ entity across the whole sheet) and the vertical-specific formats you may derive from what the scrape found. Query intent is one of `Navigational`, `Informational`, `Commercial`, or blank where no live call classified the primary prompt.

### 5. Cannibalisation gate (mandatory, second Firecrawl pass)

Titles are a draft until they clear this. Run all three checks:

**a. Deterministic overlap against the inventory**

```bash
python3 .claude/skills/roadmap-generation/scripts/check_overlap.py \
    --inventory inventory.json --proposed proposed.json
```

Scores every proposed title against every published piece on token overlap and sequence similarity, and prints anything above threshold with the URL it collides with. Fast, offline, and it catches the near-duplicates that a read-through misses at scale.

**b. Live search of the client's own domain**

For every proposed piece, not a sample, run `firecrawl_search` scoped to the client domain on the primary query. This catches pages the map missed: paginated archives, tag pages, anything JS-rendered. Two calls in parallel, maximum.

**c. Primary-query uniqueness within the roadmap itself**

Two proposed rows sharing a primary query is the same failure, committed in advance. The script flags these too.

Then resolve every flag, one of three ways:

| Situation | Resolution |
|---|---|
| Existing page already covers it well | Drop the row. Note it as an optimisation candidate for the separate rewrite job. |
| Existing page covers it thinly or is outdated | Either drop and flag for rewrite, or keep the new piece with an explicit differentiator stated in the summary. Never leave it ambiguous. |
| Overlap is superficial (shared words, different question) | Keep, and tighten the title so the difference is visible on the page. |

Re-run `check_overlap.py` after resolving. The gate passes when the script returns clean and every live-search flag has a stated resolution. Report how many rows were dropped or reshaped: that number is proof the gate ran, and clients notice when it is always zero.

### 6. Build the sheet

Write `rows.json`, then let the script write the CSV. Do not hand-write the CSV: the script is the column contract made mechanical, it refuses a file that breaks it, and it prints row numbers on failure so fixes are cheap.

```bash
python3 .claude/skills/roadmap-generation/scripts/build_roadmap.py \
    --rows rows.json --client "<slug>" --csv-out "<the output path you were given>" \
    --out-dir "<the client directory>"
```

`--csv-out` is the sheet of record. `--out-dir` gets the styled `.xlsx` alongside it, and is best effort: a machine without openpyxl still writes the CSV, which is the file that matters.

**Ten columns, in this exact order:**

| # | Column | What it holds |
|---|---|---|
| 1 | `Content Topic` | Working title, specific enough that a writer knows the piece |
| 2 | `What the Piece Covers` | 2 to 4 sentences: scope, angle, the proof it carries, commercial through-line |
| 3 | `Content Type` | One taxonomy value spelled exactly, or a format derived from what the scrape found |
| 4 | `Keyword Volume` | Google monthly volume for the row's primary keyword. Integer or blank. |
| 5 | `AI Search Volume` | LLM usage for the same term. Integer or blank. |
| 6 | `Cost Per Click` | CPC in the client's market. Two decimals or blank. |
| 7 | `Keyword Difficulty` | 0 to 100, or blank. |
| 8 | `Target Prompts` | Exactly 3, buyer-phrased, joined ` \| ` |
| 9 | `Query Volume` | Volume for the primary target prompt itself, which is usually far lower than the head keyword. Integer or blank. |
| 10 | `Query Intent` | `Navigational` / `Informational` / `Commercial`, or blank |

Three rules matter more than the rest:

- **Columns 1, 2 and 8 are read BY POSITION downstream and the order is frozen.** Nothing detects a misplacement. The script writes the order for you, which is the whole reason to use it.
- **Every data cell is a real figure or empty.** Blank is honest. A plausible guess is not, because nobody downstream can tell them apart. Zero is a real figure and is different from blank, and a blank `Query Intent` is the honest cell when no live call classified the primary prompt.
- **Columns 4 to 7, 9 and 10 ARE the justification, so there is no prose column arguing for the row.** A sentence explaining a number belongs next to the number it explains, and a column whose content is an argument about the other columns goes stale the moment any of them is re-pulled. A row whose every data cell is blank argues nothing for its slot, which the script warns on. The metric, the figure, the endpoint and the date go in the step 7 report: `"ai_search_volume 2,400 vs Google MSV 90 (ai_optimization_keyword_data_search_volume, 2026-09-07); client absent from all four category LLM mentions"` is the shape of that provenance, and it belongs in prose the operator reads once, not in a cell shipped beside the figures it describes.

Target prompts are three genuinely different angles, each answerable by this piece: one at peak commercial intent, one comparative, one situational. Three rewordings of one question waste two slots. No brand names in them, no definitional "what is X", and nothing a real buyer would not type.

### 7. Deliver

The reply is the receipt, not a walkthrough. Keep it to:

- The commercial/topical split and the one-line evidence for it
- How many pages were scraped and how many published pieces are in the inventory
- Which clusters the roadmap covers and roughly how the count is allocated
- How many proposed rows the cannibalisation gate killed or reshaped
- How many data cells are blank and why
- The provenance behind the figures: which endpoints they came from and on what date. This used to sit in a prose column beside them and now lives here, because a sentence explaining a number goes stale the moment the number is re-pulled and a report is read once
- Existing pages flagged as optimisation candidates, named, because that is the natural next engagement and the client should see it came out of the work

No walkthrough of the rows. The sheet is the deliverable.

Client-facing files carry no internal tooling names, no scope or upsell framing, and no undefined jargon. "Cannibalisation" and "GEO" get a half-sentence definition on first use in anything the client reads.

## Edge cases

- **No blog at all.** The gate still runs (product and service pages cannibalise too), and the roadmap skews toward foundational topical coverage. Say plainly that the archive is empty rather than reporting a clean gate as though it were an achievement.
- **Huge archive (200+ posts).** Scrape it all anyway, but scrape titles and H1s in bulk first and only pull full bodies for the pieces that collide with a proposed topic. `check_overlap.py` works on titles alone.
- **No domain, just a brief.** Skip step 1, run the data pull, and say in the summary that the cannibalisation gate could not run and the roadmap is unverified against existing content. Never imply the gate passed when it did not run.
- **DataForSEO returns nothing for the category** (common in narrow B2B and in Indian-language categories). Do not manufacture figures. Leave the data cells blank, justify from the citation-landscape and competitor-intersection data instead, and say in the summary that the demand data is thin: that is itself a finding about the category.
- **Client wants more pieces than the data supports.** Deliver the rows that are justifiable and say how many were requested versus how many cleared the bar. Padding a roadmap to hit a number is how the client discovers the whole thing was padded.
- **A second roadmap for the same client later.** The previous roadmap's rows are part of the cannibalisation baseline. Add them to `inventory.json` before running the gate, published or not.
