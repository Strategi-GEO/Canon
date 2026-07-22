---
name: geo-site-report
description: Produce a tech and GEO audit report as a branded, client-ready PDF per site, with real Google Lighthouse scores pulled via the DataForSEO MCP and schema findings read deterministically from page source. Use whenever the user supplies one or more client domains and asks for an audit report, a site report, a Lighthouse score plus review, a batch of reports ("one report each", "reports for all of these"), or "audit these and tell me what to fix for SEO and GEO". Produces one .pdf per site, never inline in chat. Do NOT use for UX or CRO audits, for writing content, or for building the pitch deck.
license: Proprietary.
---

# GEO Site Report (Strategi)

## Purpose

One domain in, one branded PDF out. Real Lighthouse numbers, source-verified findings, a severity-ranked fix list. Built to be run in batches where each site gets its own clean context and its own file.

This skill supersedes `website-audit`'s tool constraints. That skill was written for an environment with no Lighthouse and no reliable schema read. Both are now available. Do not carry its "mark Lighthouse as Verify" or "infer the schema baseline" rules into this one. `website-audit` remains correct for its own scope and is not modified by this skill.

## The shape of the job

You gather evidence, you make judgements, and you emit **data**. You do not write a document. `scripts/build_report.py` owns layout, branding, severity colours, pagination and every derivable number, and it produces an identical-looking artifact on every site forever. Your output is `report.json`.

This split is not bureaucracy. A client-facing deliverable that looks different each time it is generated is not a deliverable, it is a draft. And hand-writing report prose costs thousands of tokens per site to reproduce something a template already does better.

## Token discipline

A site audit is easy to run at ten times the cost it needs. The waste is concentrated in four places, and each has a fix that is also a quality improvement, which is why they are worth taking seriously rather than treating as penny-pinching.

1. **Raw HTML must never enter your context.** A client homepage is 100k to 500k tokens and the report needs none of the prose. Scrape it and run `scripts/page_digest.py` on the result. Never `view`, `cat`, `head`, or `grep` a scrape result. The digest answers every structural question the report asks in a few hundred tokens, and it answers them deterministically, which is a second reason to prefer it. If you find yourself reading HTML, you have already lost the run.
   - **Get the HTML onto disk without reading it.** Some harnesses spill a large Firecrawl result to `/mnt/user-data/tool_results/` and hand you a path; there, pass the path straight to the digest. If instead the scrape returns `rawHtml` inline in the tool result, do not print or expand it: write it to a file in one step (for example a tiny Python snippet that pulls `rawHtml` out of the tool-result JSON and writes it to `page.html`) and run the digest on that file. `page_digest.py` also accepts the raw tool-result JSON directly and hunts for the HTML payload itself, so either way you never eyeball the markup. Confirm which behaviour your environment has on the first scrape and proceed accordingly.
   - **`/robots.txt` is the one scrape you may read.** It is a few hundred bytes, there is no digest for it, and its whole content is the finding. Reading it does not violate this rule.
2. **Never write parsing code inline.** The digest script exists. Extending it in place beats reinventing a worse version per site.
3. **Cap LLM answers in the prompt.** `ai_optimization_llm_response` has no output-length parameter, so length is controlled by asking for it. "List names only, no descriptions, under 80 words" cuts the response by most of its bulk and makes absence unambiguous instead of buried in hedging. The cheap prompt and the good prompt are the same prompt.
4. **Ask for one format, not three.** `formats: ["rawHtml"]` only. The `links` array is large and nothing here reads it.

Budget for a standard run: 2 scrapes, 1 Lighthouse, 1 robots.txt, 1 organic lookup, 3 model-list lookups, and 30 LLM calls (5 prompts x 3 engines x 2 repeats, see Step 6). Roughly $0.48 per site in DataForSEO spend. The repeat is not waste: a presence rate built on one sample per prompt swings on the model's non-determinism, and the whole pitch rests on that number.

## Hard Rules

These exist because each one has already caused a wrong finding. Violating them produces confident, false, client-facing claims.

1. **Confirm the domain before auditing anything.** Never audit a domain recalled from memory. Web-search the brand, confirm the live URL, and state it. A plausible-looking domain is frequently wrong (`hotelivorytower.com` vs the real `ivorytowerhotel.com`). Auditing the wrong site invalidates the entire report.

2. **Never trust LLM-based extraction for schema questions.** Firecrawl's `json` format with a schema will confidently return contradictions (`jsonld_blocks: []` alongside `has_faqpage_schema: true` for the same page). Schema claims come from `page_digest.py` and nowhere else.

3. **Social embeds inject foreign meta tags and foreign schema.** Facebook and Instagram embeds get flattened into rendered `rawHtml`, carrying Meta's own `<meta name="bingbot" content="noarchive">`, `<meta name="referrer">`, and `SocialMediaPosting` schema into the client's page. None of it belongs to the client. Reporting a false `noarchive` is severe: per Microsoft's documentation it would mean the page is excluded from Copilot answers and grounding, so it reads as critical and is dramatically wrong.
   - `page_digest.py` settles this by DOM ancestry and reports its reasoning in `attribution_reason`. Read that field. Do not overrule it from intuition, and do not re-derive it by eye.
   - Embeds are still worth reporting for **weight**. `social_embed_containers` quantifies it.

4. **`firecrawl_agent` is prohibited.** Hidden source attribution. Never call it.

5. **Never invent a metric, score, or schema property that was not observed.** Every claim traces to a tool result. Label inferences as inferred.

6. **AI standing is generated, never requested, and never run without `web_search: true`.** The client supplies no visibility report. Build it. The silent failure mode: calling a model whose `web_search_supported` is `false`, or omitting `web_search: true`. The call succeeds, returns fluent text, and measures the model's training memory rather than what it retrieves today. That is a confident, wholly fictional visibility report. Check the flag, set the parameter, and confirm `annotations` came back populated. No annotations means no retrieval happened.

## Workflow

### 1. Confirm the domain
`web_search` the brand name plus "official website". Confirm. If two brands share a client row (e.g. "Ivory & Tranquil"), treat them as separate sites and separate reports. If the domain cannot be confirmed, stop and flag it rather than guessing.

### 2. Lighthouse
DataForSEO `on_page_lighthouse` on the homepage. Returns `categories` (performance, accessibility, best-practices, seo, agentic-browsing) and an `audits` block with real metric values.

- Report scores as integers. `build_report.py` will convert 0.61 to 61 and colour it, so pass either.
- Default to **desktop only**. Run mobile as a second call only when the client is going to screenshot their own PageSpeed export and compare, because that is the only time the second number earns its cost. The template has a mobile column that stays empty otherwise.
- **Always state the form factor** regardless. The desktop run uses 10 Mbps simulated throttling and no CPU slowdown; mobile is materially worse. The client's own export will not match, and they must be told why before they notice.
- Skip `full_data: true` unless the WebMCP breakdown is specifically the story. It is a large payload.
- `agentic-browsing` is new in Lighthouse 13, still under development by Google, and scores how cleanly AI agents can browse plus WebMCP correctness. Report the score, but do not hang a hard verdict on it in prose: the metric is experimental and its thresholds are not settled, so the traffic-light colour the template applies is a directional signal, not a graded result. Say "experimental" next to it. It is a talking point, not a finding to build the fix list on.

### 3. Scrape and digest the homepage
```
firecrawl_scrape  url=<homepage>  formats=["rawHtml"]  onlyMainContent=false
```
`onlyMainContent: false` is deliberate and is not negotiable: the digest decides schema ownership by DOM ancestry, and stripping the page to its main content destroys the embed containers that make that judgement possible. Trimming here does not save tokens, it silently corrupts Hard Rule 3.

Then, without reading the result:
```bash
python3 scripts/page_digest.py <path-to-tool-result-or-html> --url <homepage>
```
It returns title, meta description, canonical, robots-family meta with attribution, headings, alt-text quality with quotable samples, third-party script hosts, stack fingerprint, live analytics IDs, and every JSON-LD block split into first-party and embed artifact with reasons, invalid-JSON blocks named, and suspicious values pre-flagged.

Two things about the digest that keep findings honest. Headings, images and third-party scripts are **client-only**: any element inside a social-embed subtree is excluded by the same DOM-ancestry test the schema path uses, so a Facebook embed's alt-less images never inflate the client's missing-alt count and its `<h2>` never poses as the client's heading. `content_scope` states this. And schema `first_party_types` now lists **top-level entities only**; the deep list is `first_party_nested_types`. Report the site's schema from `first_party_types` so a lone LocalBusiness with a nested address does not read as a three-entity graph.

Read the digest. That is your evidence base for the stack, schema, crawlability and on-page modules.

### 4. robots.txt
`firecrawl_scrape` on `/robots.txt`. Check the wildcard permits AI crawlers and that GPTBot, ClaudeBot, PerplexityBot, CCBot are not blocked. Note the declared sitemap.

### 5. Organic baseline
DataForSEO `dataforseo_labs_google_domain_rank_overview`, `location_name` matching the client's actual market (`"India"` for Indian clients, not the `"United States"` default). Report keyword count, top-10 distribution, ETV, and the new/up/down split.

### 6. AI standing (run it, never ask for it)

Never mark AI standing "unverified" and never request a visibility report from the client. Generate it here. This section is the scoreboard and the reason the client buys.

**Three engines: `chat_gpt`, `gemini`, `claude`.** That is the top of the market and the whole of what is worth paying for. Perplexity is reachable through this endpoint and is deliberately not run: it sits near 1.3% of worldwide assistant traffic against ChatGPT's 54%, Gemini's 28% and Claude's 9%, so it costs a third of the budget to move a number almost nobody sees. Copilot and Google AI Overviews are not reachable through this endpoint at all. **Report three engines and name what is missing.** Never imply six.

If a client's own analytics show meaningful Perplexity referral traffic, add it back for that client and say why in the report. The default is three.

**Model selection.** Call `ai_optimization_llm_models` per `llm_type` and take the newest model carrying `web_search_supported: true`. The list moves and models are retired without notice, so the lookup is the source of truth and the table below is only a sanity check on whether the lookup returned something plausible. If they disagree, the lookup wins.

| llm_type | last seen (July 2026) |
|---|---|
| `chat_gpt` | `gpt-5.6-terra` |
| `claude` | `claude-opus-4-8` |
| `gemini` | `gemini-3.5-flash` |

**`web_search: true` is mandatory.** Without it you are testing frozen training weights, not retrieval. Several models in each list cannot search at all.

**Prompts.** Five high-intent buyer prompts, built on the `geo-visibility-prompts` skill's logic: target prompts where the client is plausibly **absent**, never brand-name prompts they trivially win. Absence is what sells the work. Under 500 characters each (a hard API limit). Always demand named specifics and cap the length: "Name specific hotels. List names only, no descriptions, under 80 words." Vague, padded answers make absence arguable, which is both expensive and useless.

**Repeat each prompt at least twice per engine.** LLM output is non-deterministic, so a single call per prompt is a coin flip, not a measurement, and the presence rate is the headline number the client buys. Two runs per prompt per engine is the floor; three if the answers disagree across the first two. Keep the repeat count equal across prompts so the derived rate is not accidentally weighted. `build_report.py` averages the rate over every run object, so more runs need no arithmetic from you, only more objects in `runs`.

Five prompts across three engines at two repeats is 30 calls, about $0.48. Record `model` and `web_search` on every run object.

**Record per run:** the exact `model` used and whether `web_search` was on (provenance, and the audit trail for Hard Rule 6); whether the client was **named**; whether the client's domain appears in the response's `annotations` array (**cited beats named**, since `annotations` is the actual source list the engine used); **who was named instead** (the real competitors AI surfaces, not the ones the client thinks it has); and **which domains were cited**. If OTAs, directories and listicles dominate the annotations, that is exactly where the client's absence is being filled, and it is the most actionable finding in the report.

Do not compute the presence rate by hand. Put the runs in `report.json` and let the script count them.

**Limits to state plainly:**
- These are API models with web search enabled, not the consumer apps. Retrieval approximates the products, it does not equal them.
- LLM output is non-deterministic. State the repeat count you actually ran, so the rate reads as the average it is. If a run count ever drops to one per prompt, say "one sample per prompt, not a measurement" in those words.
- Name the exact models and confirm web search was on. `models_line` and `web_search_note` render this from the run objects; do not also hand-write it.

### 6b. Monthly KPI metrics (the dashboard numbers)

A monthly report carries a `metrics` block (see `references/report-schema.md`), and it is the
headline the client reads first: total AI mentions with the per-engine split, backlinks, and
referring domains. These are COUNTS, not the presence rate from 6, and they come from different
endpoints. Skip this block only for a one-off audit that is not a monthly report.

**AI mentions per engine.** Use the DataForSEO LLM-mentions endpoints to count how often the
brand is mentioned across each engine THIS month. `ai_opt_llm_ment_agg_metrics` returns
aggregated mention counts; filter or split per engine so you get one integer for ChatGPT, one
for Gemini, one for Claude. If the aggregate cannot be split per engine, run
`ai_opt_llm_ment_search` per engine and count. Record each into `metrics.ai_mentions.by_engine`
with `engine` exactly `"ChatGPT"`, `"Gemini"`, `"Claude"`. Do NOT sum them: the total is
derived. Three engines only, the same scope as section 6, and `metrics.note` says so.

**Backlinks and referring domains.** `backlinks_summary` on the confirmed domain returns both:
put `backlinks` and `referring_domains` as integers, or `null` if the lookup did not return.
Trace the domain, never a guess, and use the same confirmed host as section 1.

These are absolute counts for THIS month. NEVER compute a month-over-month delta or a trend here:
the dashboard derives every delta and the all-months line from the stored history of prior
months. A hand-typed delta is a number that can be wrong for no benefit.

### 7. Interior template
Scrape and digest one high-value interior page (a product, venue, or service page). Compare title quality, meta description, heading structure, FAQ presence and schema against the homepage. On most client sites the interior pages have had content work and the homepage has not, or the reverse. That gap is the finding.

### 8. Emit report.json and build
Write `report.json` per `references/report-schema.md`. For a monthly report the `metrics` block (section 6b) is REQUIRED: it is what the dashboard charts. Then:
```bash
python3 scripts/build_report.py report.json --out /mnt/user-data/outputs/NN-slug-audit.pdf
```
It validates before it renders and fails loudly on a missing key, an invalid status or severity, or an em dash. A failure is the script catching something, so fix the data rather than working around the script. Add `--keep-html` only when a layout problem needs eyes on it.

Deliver the PDF with the environment's file-delivery tool (`SendUserFile` in Cowork; whatever the host exposes elsewhere). Never inline the report in chat and never paste its prose into the message.

## House Rules

- **No em dashes anywhere.** Commas, colons, periods, parentheses. `build_report.py` enforces this and will refuse to build.
- Sparse and direct. Lead with the worst problem. Critique plainly.
- Quote the client's own broken values verbatim in the `evidence` field. `"addressCountry": "107"` lands harder than a description of it. The digest pre-flags these in `suspicious_values`.
- Flag contradictions between a client's own pages. AI engines cross-check and downweight sources that disagree with themselves. This is a real GEO finding, not pedantry.
- Competitors named only as the real names AI surfaces, stated factually, never attacked.
- Call out when Lighthouse SEO scores high while the entity graph is broken. That contrast is the product, and `deck_note` should usually be built from it.
- If a check cannot be run, say so in `verify_externally` and hand off the instruction. Never guess a result.

## Slots With

Takes prompt-design logic from `geo-visibility-prompts`: the prompts that matter are the ones where the client is likely absent, never the brand-name prompts they trivially win.

Runs before `strategi-geo-deck`. Findings ground the deck's standing slide and content map, and the AI standing section is the standing slide.

## Files

- `scripts/page_digest.py`: HTML to compact JSON digest. Settles embed attribution by DOM ancestry.
- `scripts/build_report.py`: `report.json` to branded PDF. Validates, derives, renders.
- `assets/report.css`: print stylesheet. Brand tokens are the first five lines.
- `assets/report.html.j2`: the locked report structure.
- `references/report-schema.md`: the `report.json` contract. Read before writing one.
