---
name: geo-analysis-report
description: >-
  Produce the end-of-month client Analysis report: one normalized dataset (analysis.json) merged
  from up to six tools (DataForSEO, SEO Gets, Google Search Console, Bing Webmaster, Google
  Analytics, Microsoft Clarity) plus own LLM prompt-test runs, rendered to a branded PDF and shown
  on the dashboard. Use whenever the user asks for a monthly GEO and SEO visibility analysis, a
  multi-tool performance report, an AI-visibility + rankings + engagement + outcomes report, or
  runs the Analysis tab. Each tool is used to its full potential and degrades gracefully when not
  connected. Do NOT use to write a blog (geo-content-writer), to score a draft (geo-content-eval),
  or for the single-site technical audit (geo-site-report).
---

# geo-analysis-report

The monthly Analysis report. It tells ONE continuous story, narrative first (GEO, then SEO, then
engagement, then outcomes), never tool first. Each tool is deployed only where it is genuinely best.
The output is a single normalized `analysis.json` that BOTH the dashboard and the branded PDF render,
so the on-screen numbers and the download can never disagree.

Read `references/analysis-schema.md` first, every run. It is the contract. Nothing you emit that is
not in the schema can be drawn by anything downstream.

## The two rules that never bend

1. **Absolute numbers only, never a delta or a trend.** Every value is this month's absolute figure.
   The dashboard derives month-over-month and the all-months line from stored history, exactly like
   the Reports tab. The one thing you may add is a per-card `prev_value` a tool hands you directly
   (Search Console and GA4 return last month in the same call). A hand-typed delta is a number that
   can only be wrong.
2. **Never invent a number.** Every figure traces to a real tool result. A tool that is not
   connected produces no number: omit its section and mark its scorecard card `available: false`.
   Degradation is the design, not a failure. A guessed metric is the one thing that cannot ship in a
   client-facing report.

## The six tools and where each is used

Each is used to its full potential where it is strongest, and skipped (gracefully) when its MCP is
not connected. Probe availability by attempting the tool; if the tool is unavailable, record it in
`tools[]` as `connected: false` and omit the sections it feeds.

| Tool | Best at | Feeds |
|---|---|---|
| **DataForSEO** | Rankings, SERP/AIO features, Lighthouse, schema, backlinks, LLM mentions | scorecard, 2a, 2f, 3d, 3e, 3g |
| **SEO Gets** | Striking distance, query movement, page/query mapping | 3b |
| **Google Search Console** | Google ground truth: clicks, impressions, position, CTR, index, CWV | scorecard, 3a, 3f, 3g |
| **Bing Webmaster** | Bing performance, index coverage (a real GEO leading indicator) | scorecard, 2e, 3c, 3f |
| **Google Analytics (GA4)** | AI-referral sessions, engaged sessions, conversions, outcomes | scorecard, 2c, 5 |
| **Microsoft Clarity** | Behavioural proof: scroll depth, rage/dead clicks, friction | scorecard, 2d, 4 |

Plus **own LLM prompt-test runs** (via the connected AI/search tools and Firecrawl) for the prompt
visibility matrix (2a), which is the moat and is REQUIRED. DataForSEO and Firecrawl are the floor:
they are always connected, and the matrix + rankings are always producible from them.

## The prompt visibility matrix (2a), the required centrepiece

Rows are the client's buyer prompts (from the roadmap Target Prompts and the brand's known queries),
columns are the six engines: ChatGPT, Claude, Gemini, Google AI Mode, Copilot, Perplexity. For each
(prompt, engine) run the prompt and read the answer:

- Use DataForSEO's LLM/AI endpoints where they cover an engine (for example the ChatGPT scraper and
  the LLM-mentions endpoints).
- Use **Firecrawl** to fetch and read the actual AI answer wherever a direct engine result is needed
  and DataForSEO does not cover it. Firecrawl is the fetch-and-ground tool: read the whole answer,
  not a snippet.
- Classify each cell: `cited` (client linked or named as a source), `mentioned` (named, not linked),
  `absent` (not present). Set `change` to `new` or `lost` versus last month when you can tell, else
  null. A prompt/engine you could not run this month leaves that engine cell out (renders neutral).

Run each prompt at least twice per engine and take the steady result: a single sample is a coin flip.
Never fabricate a cell. An engine you cannot reach is honest absence, recorded, not a red cell.

## Method

1. **Read** `references/analysis-schema.md`, the roadmap (Target Prompts are the matrix rows), and the
   client's `canonical-facts.md` for the domain and do-not-claim list.
2. **Probe each tool.** Build the `tools[]` array as you go: `connected: true/false` + one-line note.
3. **Gather, section by section**, using the table above. Fetch every external source in full with
   Firecrawl before citing it. Never let a tool's absence stop the rest.
4. **Assemble `analysis.json`** to the schema. The floor that must always be present: `client`,
   `month`, `month_label`, `scorecard` (6 to 7 cards, `available: false` for absent tools),
   `ai_visibility.prompt_matrix`, `tools`. Fill every other section a connected tool supports.
5. **Write the narrative fields** (executive_summary, gaps plays, outcomes.summary) as plain,
   headline-first prose. ZERO em dashes and en dashes anywhere: commas, colons, periods, parentheses.
6. **Render the PDF** with the builder (see below). It validates the schema, derives coverage and the
   Lighthouse traffic-light, and prints the branded document.

## Rendering the PDF

```bash
python3 .claude/skills/geo-analysis-report/scripts/build_analysis.py <ANALYSIS_JSON_PATH> --out <ANALYSIS_PDF_PATH>
```

The builder owns all layout, branding, colour and pagination, so every brand's report looks
identical. It exits non-zero on a schema violation or any em/en dash, which is your signal to fix the
JSON, not the layout. The PDF is best-effort: if Chromium is not installed the JSON still stands and
the dashboard shows the metrics; say so in your final message. `analysis.json` is the deliverable.

Self-check the builder any time with `--selfcheck` (no browser needed).

## Consistency

- One visual grammar everywhere: green up/good, amber partial, red down/bad.
- Every visual answers a question; the tool is named only in the small caption and the appendix.
- The appendix `tools` table is the ONE place all six tools are listed by name.
