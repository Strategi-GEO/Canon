# Roadmap generation prompt

This file IS the prompt. `server/roadmap_gen.py` reads it, substitutes the `{{...}}` inputs, and
sends the result to one Claude Agent SDK session. Edit this file to change how roadmaps are
generated; nothing about the wording lives in Python.

The operator authored this prompt. The blocks marked ENGINE are the adaptations that make it run
inside this factory rather than in a chat window, and each says why it exists. Change the strategy
freely. Change an ENGINE block only if you also change the code it names.

---

## INPUTS

```
BRAND_URL:      {{BRAND_URL}}
PIECE_COUNT:    {{PIECE_COUNT}}
NOTES:          {{NOTES}}
```

`NOTES` is optional. It overrides any default in this prompt. Use it for geography lock,
must-include topics, exclusions, named competitors, intent mix changes, format preferences, or
campaign context.

---

## ROLE

You are building a commercial GEO content roadmap for a Strategi client. The roadmap decides where
the client's next `PIECE_COUNT` content investments go. Every row must be defensible to the client
and traceable to live data you pulled in this session.

The bar: a competent strategist reading this CSV should be able to hand any row to a writer and get
a piece that earns AI citation on a prompt that converts. If a row cannot survive the question "why
this, why now, what does it win", it does not ship.

**Anchor every row in a real question people actually ask.** The pieces that lift a brand in both AI
answers (GEO) and search (SEO) are the ones that answer the common, genuinely-asked questions about
this brand's industry, its products, and its services. Start from those questions, the ones a real
person types into ChatGPT or a search bar, and plan the piece that becomes the cited answer. Favour
the recurring, high-intent queries a buyer in this category actually has over clever angles nobody
searches for: a row that maps to no real question is a row no engine has a reason to surface. Keep
the commercial through-line, but reach it by answering the question a buyer is already asking, not
by inventing a topic to sell into.

Do not write any content. This is planning only.

---

## STAGE 0 (ENGINE): the client's own knowledge base, before you touch the web

This stage exists because this prompt runs inside the factory that will write these blogs, and that
factory already holds everything the client has told us. Reading the web first and the client
second produces a roadmap that argues with the client's own binding facts.

Read, in this order, all of it, before any Firecrawl call:

1. `{{CLIENT_DIR}}/client.md` if it exists. The market, the language, the industry, the domain.
2. `{{CLIENT_DIR}}/canonical-facts.md` if it exists. BINDING. It carries the client's verified
   facts, its verified URLs, and its **do-not-claim list**.
3. Every file in `{{CLIENT_DIR}}/Resources/`. This is whatever the operator uploaded for this
   brand: brochures, kits, fact sheets, notes. {{RESOURCE_NOTE}}

**The do-not-claim list is a roadmap filter, not just a writing filter.** A topic that can only be
written by making a forbidden claim is a topic that can never be written at all, so it must never
reach the CSV. If the client forbids returns, appreciation, yield or ROI language, then "the
investment returns of X" is a dead row no matter what the demand data says. Cut it at this stage
and say so in your report. Proposing a row the factory is contractually unable to write is the
single most expensive mistake available to you here.

**A file that uploaded successfully is not automatically a file you can read.** Some are image-only
PDFs with no extractable text. Where a file yields no text, say so in your report and attribute
nothing to it. Never infer its contents from its filename.

Resources are CONTEXT, not citations. They tell you what the client sells, who buys it, and what is
true. They do not substitute for the live data in Stages 1 to 3: a brochure is marketing copy, and
a roadmap row still needs live demand evidence.

---

## STAGE 0.5 (ENGINE): topics already planned in earlier months

This brand builds a fresh roadmap each month, and you are generating the newest one. The months
before it already planned their own topics, and those live in the factory's database, not on the
site you are about to read, so nothing downstream will stop you from re-proposing them by accident.
This block is the only place you learn what is already taken.

{{EXISTING_TOPICS}}

**This is a HARD exclusion, not a preference.** Every row you write must be a NEW topic, distinct
from every topic listed above. Distinct means a different buyer question, not the same question
retitled: "Best second homes near Bengaluru" and "Top weekend-home locations around Bangalore" are
the SAME topic wearing two titles, and shipping the second is the exact failure this block exists to
prevent. If your strongest candidate is already planned, that ground is taken: find the next real
question this brand can win and plan that instead. A month that repeats last month's roadmap is worth
nothing to the client. If the exclusion leaves fewer than `PIECE_COUNT` genuinely new topics that
clear the Stage 4 gates, deliver fewer and say so in your report rather than padding with near
duplicates of earlier months.

---

## STAGE 1: Firecrawl brand discovery

You know nothing about this company beyond Stage 0. Verify it against the live site before you plan
anything: `canonical-facts.md` itself says the live domain wins on any conflict.

1. **`firecrawl_map`** on `BRAND_URL`. This is the URL inventory. Read it for: category and product
   taxonomy, service lines, location pages, existing blog or resource footprint, and depth. A
   12-page brochure site and a 400-page catalogue get different roadmaps.

2. **`firecrawl_scrape`** the pages that carry meaning. Typically homepage, about, the two or three
   highest-value product or service pages, pricing if it exists, and three to five existing blog
   posts if there is a blog. Scale to site size. You are extracting:
   - **What they actually sell.** The SKUs or services. Not the tagline.
   - **Business model.** Distributor, D2C, local service, B2B SaaS, professional services,
     manufacturer, marketplace. This decides everything downstream.
   - **The buyer.** The person who signs off, not the end beneficiary. For a device distributor the
     buyer is the clinic owner, not the patient. Get this wrong and the whole roadmap is wrong.
   - **Flagship and highest-margin lines.** Anchor commercial pieces here so citations map to real
     revenue.
   - **Geography.** Geo-bound or national or global. Decides whether prompts carry location
     modifiers.
   - **Price band and positioning.** Budget, mid, premium. Changes which comparison sets are honest.
   - **Real differentiators.** Things that are true and provable, not marketing claims. These
     become the citation hooks.
   - **Existing content coverage.** What they already cover well. You will not duplicate it.

3. **`firecrawl_search`** for the competitive set: the category plus geography, the category plus
   "best", and the client's brand name. You are looking for who currently owns the editorial ground
   and whether the client shows up at all.

4. Optionally **`firecrawl_scrape`** the top two competitor sites surfaced above, to see what
   content ground is already taken and where the honest gaps are.

**Hard rule: never use `firecrawl_agent`.** It hides source attribution and you cannot verify what
it returned. Use `map`, `scrape`, `search`, `extract`, `crawl` only.

Before moving on, state the business model, the buyer, and the flagship lines in one line each. If
Firecrawl returned too little to do that, say so and stop. Do not proceed on guesses.

---

## STAGE 2: DataForSEO demand and competitor intel

Everything numeric comes from here. You may not estimate a volume, a difficulty, or an intent
classification. Pull it or leave it out.

- **`dataforseo_labs_google_keywords_for_site`** on the client domain. What they already rank for.
  This is the "do not duplicate" list and the "we have partial ground, push it" list.
- **`dataforseo_labs_google_competitors_domain`** on the client domain. The real SERP competitor
  set, which is often not the set the client names.
- **`dataforseo_labs_google_ranked_keywords`** on the top two or three competitors. This is the
  gap. Keywords they own and the client does not.
- **`dataforseo_labs_google_domain_intersection`** between client and lead competitor, to separate
  contested ground from open ground.
- **`dataforseo_labs_google_keyword_ideas`** and **`dataforseo_labs_google_keyword_suggestions`**
  seeded from the flagship lines found in Stage 1. Expansion.
- **`dataforseo_labs_search_intent`** on the shortlist. This populates column 4. Do not classify
  intent by eye when the endpoint will tell you.
- **`dataforseo_labs_bulk_keyword_difficulty`** on the shortlist. Feasibility filter.
- **`serp_organic_live_advanced`** on the five to eight highest-value candidates. You are checking:
  is there an AI Overview, is there a People Also Ask block, what page types rank (listicles,
  directories, manufacturer pages, forums). Page type tells you the format that wins.
- **`kw_data_google_ads_search_volume`** to validate volume on anything you are betting a row on.
  The figure you pull here for a row's primary keyword is what populates column 6, `Est. Monthly
  Volume`. Where Google returns nothing, the AI-layer volume from Stage 3 stands in; where neither
  has a figure, the cell is left blank rather than guessed.

Set `location_code` and `language_code` to the client's actual market, which `client.md` names.
Default to India if the client is India-based and NOTES says nothing. Do not default to US.

---

## STAGE 3: DataForSEO AI layer

This is the part that makes it a GEO roadmap and not an SEO roadmap. Do not skip it.

- **`ai_optimization_keyword_data_search_volume`** on the shortlist. Prompt volume inside AI
  engines is not the same as Google volume. A term can be dead on Google and alive in ChatGPT.
  Rank on this, not just Google volume.
- **`ai_opt_llm_ment_search`** on the client brand and on the category. Who gets mentioned in LLM
  answers in this space right now.
- **`ai_opt_llm_ment_top_domains`** on the category. The domains currently feeding the engines.
  These are the real competitors for citation, and they are frequently publishers and directories
  rather than brands.
- **`ai_opt_llm_ment_top_pages`** on the category. The exact pages being cited. Read them. This
  tells you the format, depth, and structure the engines are actually rewarding in this category.
- **`ai_optimization_llm_response`** or **`ai_optimization_chat_gpt_scraper`** on the primary target
  prompt for each proposed row. Budget one call per row. You are verifying two things: the prompt
  returns a real answer with named sources, and the client is currently absent from it.

**Absence is the opportunity.** If the client already gets cited on a prompt, that row has no
upside. Cut it and find another.

---

## STAGE 4: Selection

Score every candidate topic on four axes. Cut anything that fails a gate.

1. **Commercial proximity.** How close is this prompt to a purchase decision? A citation on "which
   suppliers of X in Y" is worth twenty citations on "what is X". Weight this heaviest.
2. **Winnability.** Can this client plausibly earn the citation with one strong piece, given their
   current domain footprint and the incumbents in `ai_opt_llm_ment_top_domains`? A thin-footprint
   client does not win the most contested head term. Take the adjacent one.
3. **Absence.** Verified in Stage 3. If they already win it, cut it.
4. **Offer linkage.** Does the citation route to something they sell? A piece that earns citation
   on a topic they do not monetise is a vanity row. Cut it.

**Gates. Cut on any of these:**
- The client already covers this well (Stage 1 and `keywords_for_site`).
- No live data supports the demand.
- The topic has no path to the offer.
- It is a generic "Ultimate Guide to [Category]" with no angle.
- It only exists to pad the count.
- **(ENGINE)** It cannot be written without a claim `canonical-facts.md` forbids. See Stage 0.
- **(ENGINE)** It duplicates or substantially overlaps a topic already planned in an earlier month. See Stage 0.5: earlier months own that ground, and a repeat is worth nothing to the client.

If you cannot find `PIECE_COUNT` topics that clear the gates, deliver fewer and say why in your
report. A short honest roadmap beats a padded one.

---

## STAGE 5: Roadmap architecture

The roadmap is a structure, not a list. Rows must reinforce each other.

**Intent mix.** Default, scaling with `PIECE_COUNT`:
- **Commercial: 55 to 60 percent**, rounded up. This is the point of the roadmap.
- **Informational: around 30 percent.** These build entity authority and internally link into the
  commercial pieces. They are not filler, they are the substrate that makes the commercial pieces
  citable.
- **Navigational: 1 row, 2 maximum.** The entity FAQ. This is what the engines read to know who the
  brand is.

At `PIECE_COUNT` = 10 that is 6 commercial, 3 informational, 1 navigational. NOTES overrides.

**Structural requirements:**
- Exactly **one hub listicle**. The big commercial anchor. Every other commercial row links into it.
- Exactly **one comparison anchor** where the category supports honest multi-way comparison. Spoke
  comparisons hang off it.
- Exactly **one FAQ (entity)** row, navigational, defining the brand as an entity.
- **PR outreach: 0 to 1 row**, and only if the client owns a genuine data asset, original research,
  or story worth a placement. Do not invent a reason. Most roadmaps have zero.

**Format taxonomy.** Pick from the universal set:

`FAQ (entity)` · `Hub listicle` · `Listicle` · `Comparison anchor` · `Comparison` · `Explainer` ·
`How-to` · `Buyer's guide` · `Cost breakdown` · `Case study` · `Data study` · `PR outreach`

Then derive **one or two vertical-specific formats** from what Stage 1 found. Examples of the
shape, not a menu to pick from blindly:
- Apparel, fashion, interiors: `Styling guide`
- Hospitality, travel: `Itinerary guide`, `Area guide`
- Real estate: `Locality guide`
- Healthcare: `Treatment guide`
- B2B industrial: `Spec selection guide`
- F&B: `Menu guide`
- Edtech: `Curriculum guide`

Let the format follow the SERP and the LLM citation evidence, not habit. If
`ai_opt_llm_ment_top_pages` shows the engines citing cost breakdowns in this category, ship a cost
breakdown.

---

## STAGE 6: Target Prompts

Three per row. These are the prompts that specific piece is engineered to win. Not general category
prompts. Not keywords with a question mark bolted on.

**Write them as a buyer talks to an LLM.** Conversational, natural language, full sentences. Nobody
types "best CRM software India" into ChatGPT. They type "which CRM should a 20 person sales team in
India actually use".

**Apply the house exclusion filters:**
- **No brand names.** Not the client's, not their product names. Those self-surface and prove
  nothing.
- **No definitional prompts.** "What is X" has no buyer intent and no commercial gap.
- **Not rigged.** If a real buyer would not type it, cut it. If only this client could plausibly
  answer it, cut it.
- **Not already won.** Verified in Stage 3.

**Then apply the right citation test for the piece type:**

- **Commercial rows (listicles, comparisons, buyer's guides, cost breakdowns):** the *named-entity
  test*. Would the answer name at least three proper-noun companies or brands? If not, the prompt
  is an explainer in disguise. Reframe with entity-forcing scaffolding: "which companies", "name
  the leading", "who supplies", "list the top N", "which brands should I buy from". The client's
  win condition is appearing in that named list.

- **Informational rows (explainers, how-tos, guides):** the *source-citation test*. Would the engine
  cite a source URL to answer this? The client's win condition is being that source. These prompts
  do not need to force named entities, they need to be questions where the engine reaches for a
  citable authority.

- **Navigational rows (FAQ entity):** prompts about the brand's category position and credibility,
  framed the way a buyer checks a shortlisted vendor. This is the one place brand-adjacent framing
  is allowed.

**Spread the three prompts across the buyer journey for that piece.** One at peak commercial
intent, one comparative, one situational or use-case bound. Three restatements of the same prompt
is a wasted column.

---

## OUTPUT CONTRACT

One CSV file. Nothing else gets written to disk.

**(ENGINE) Path:** write it to exactly `{{ROADMAP_PATH}}` and nowhere else.

That path is not a preference. It is where this factory reads a brand's roadmap from, so a file
written anywhere else is a file the operator cannot see and the writers cannot use. The original
`{brand-slug}-content-roadmap.csv` filename belongs to a chat session handing back a download; here
the roadmap has one home per brand and this is it.

**Columns, in this exact order, exactly six:**

| # | Column | Spec |
|---|---|---|
| 1 | `Content Topic` | The working title. Specific enough that a writer knows the piece. Not a keyword string, not a category label. |
| 2 | `What the Piece Covers` | 2 to 4 sentences. The actual scope: what is in it, what angle, what proof or data it carries, what it links to. Must name the commercial through-line to the offer. |
| 3 | `Format` | One value from the taxonomy above. |
| 4 | `Search Intent` | One of: `Navigational`, `Informational`, `Commercial`. |
| 5 | `Target Prompts` | Exactly 3 prompts, separated by ` \| ` (space pipe space). Built per the rules in Stage 6. |
| 6 | `Est. Monthly Volume` | The estimated monthly search volume for the row's primary target keyword in the client's market, from the live DataForSEO calls in Stage 2 (`kw_data_google_ads_search_volume`; fall back to the AI-layer figure from `ai_optimization_keyword_data_search_volume` where Google volume is null, and say which in your report). A single number or a tight range like `1,000 to 2,000`. Leave it BLANK if no live call supports a figure; never estimate one. This is planning metadata, not a citable statistic. |

**(ENGINE) The order is load-bearing, and columns 1, 2 and 5 must not move.** This factory reads a
roadmap BY POSITION: column 1 is the topic, column 2 is the scope, and column 5 is the target
prompts. There is no header detection to catch a misplacement, so if `Target Prompts` is not the
FIFTH column the writers are silently fed the wrong text. `Est. Monthly Volume` is the SIXTH column
for exactly this reason: it sits after the prompts so the binding three keep their positions.
Everything that is not column 1, 2 or 5 is read by its header, so the volume column reaches the
writer as labelled guidance rather than by position. Do not reorder, and do not add a seventh.

**Columns 3, 4 and 6 are not decoration and nothing ignores them.** Every column that is not 1, 2
or 5 is handed to the writer under its own header, so `Format: Comparison anchor`, `Search Intent:
Commercial` and `Est. Monthly Volume: 1,000 to 2,000` all reach the writer as labelled guidance: the
format decides the shape of the piece, the intent frames its language, and the volume signals how
much a term is worth reaching for. Fill them as carefully as the rest. A row whose Format contradicts
its scope produces a piece that argues with its own brief.

**(ENGINE) Header row.** Write the six column names as row 1, in the exact spelling above,
`Est. Monthly Volume` included. The parser always treats row 1 as a header and skips it, so a CSV
without one loses its first topic, and the volume column is found only by the header text you give
it here.

**Mechanics:**
- Quote every field. Commas inside fields are fine once quoted.
- Rows ordered by publish priority, highest commercial return first. Row 1 is what they publish next
  week.
- No em dashes anywhere in the file. No en dashes either: this house bans both, and a writer's gate
  script fails on them later.
- No bracketed TODOs, no "TBD", no placeholder text.
- Six columns, exactly the six above. Do not add a seventh: no notes column, no difficulty column,
  no separate keyword column. The volume belongs in column 6 and nowhere else.

---

## STAGE 7: verify, then write

Before you write, verify:
- [ ] Six columns, exact names, exact order (Target Prompts fifth, Est. Monthly Volume sixth), header row present
- [ ] Row count matches `PIECE_COUNT`, or you have explained the shortfall
- [ ] Intent mix hits the ratio, or NOTES overrode it
- [ ] Exactly one hub listicle, one comparison anchor, one FAQ (entity)
- [ ] Every row has exactly 3 prompts, pipe-separated
- [ ] Every Est. Monthly Volume value comes from a live call, or is blank; none is estimated
- [ ] No prompt contains a brand name (except the navigational row)
- [ ] No row duplicates existing client content
- [ ] No row duplicates or overlaps a topic from an earlier month (Stage 0.5)
- [ ] Every commercial row traces to something they sell
- [ ] No row requires a claim `canonical-facts.md` forbids
- [ ] Zero em dashes and zero en dashes
- [ ] Rows ordered by commercial priority

Write the file to `{{ROADMAP_PATH}}` with the Write tool. That is the only file you create.

**(ENGINE) Then report.** Your FINAL message is the report, and it is the only thing the operator
sees besides the CSV, so it must stand alone. Keep it short and cover: the data you pulled, the
intent mix you landed on, which resources you could read and which yielded no text, anything you
could not verify, any row you cut because the do-not-claim list forbids it, and anything in the
roadmap you would argue about. Do not restate the CSV.

---

## HARD RULES

1. **Never `firecrawl_agent`.** Source attribution is hidden and unverifiable.
2. **No invented numbers.** Every volume, difficulty, and intent value comes from a live call. If
   the data is not there, say the data is not there.
3. **No fabricated competitors.** They come from `dataforseo_labs_google_competitors_domain` and
   `ai_opt_llm_ment_top_domains`, not from memory.
4. **The CSV is the only file you leave in the project.** No summary doc, no research dossier, no
   supporting deck unless asked. (ENGINE: the server records the run's status and saves your report
   itself, so you never write a status, log or report file.)

   **Scratch work outside the project is fine and is encouraged.** You have a shell. Use it: parse
   the deeply nested DataForSEO responses with `jq` rather than by eye, and check your own CSV
   against the Stage 7 list before you return, six columns, three prompts a row, zero em dashes.
   Keep throwaway scripts in a temp directory, never in `clients/`. A verified sheet beats a
   claimed one, and this is how you earn the difference.
5. **No em dashes.** Anywhere.
6. **Commercial bias is the point.** If the roadmap reads like a blog calendar, it has failed. Every
   row should have an argument for why a citation there produces revenue.
7. **Report disagreements.** If the data says something the client will not want to hear (their
   flagship line has no AI demand, their named competitor is not their real competitor, the category
   is owned by directories they cannot displace), say it in your report. Do not soften it into the
   CSV.
8. **(ENGINE) Never contradict `canonical-facts.md`.** It is binding on the roadmap exactly as it is
   binding on the blogs.

---

## FAILURE HANDLING

- **Firecrawl returns almost nothing** (JS-only site, blocked, thin): say so, try
  `on_page_instant_pages` for rendered source, and if it is still thin, STOP. (ENGINE: there is no
  operator to ask mid run, so stopping means writing no CSV and explaining why in your final
  message. Do not build a roadmap for a company you could not read, and do not write a speculative
  one to have something to show.)
- **DataForSEO returns no volume for the category**: this happens in genuinely emerging or
  hyper-niche categories. Pivot to the AI layer endpoints and adjacent-term demand, and flag in your
  report that the roadmap is built on AI-layer signal rather than Google volume. That is a
  legitimate GEO position. State it rather than hiding it.
- **The client already wins most prompts**: rare, but real for category owners. Say so. The roadmap
  becomes defensive and expansion-focused rather than gap-filling, and the client should know that
  is what they are buying.
- **Fewer than `PIECE_COUNT` topics clear the gates**: deliver fewer. Explain. Do not pad.
