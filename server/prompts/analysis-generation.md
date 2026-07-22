# Monthly analysis report generation prompt

This file IS the prompt. `server/analysis_gen.py` reads it, substitutes the `{{...}}` inputs, and
sends the result to one Claude Agent SDK session. Edit this file to change how a monthly Analysis
report is generated; nothing about the wording lives in Python.

The blocks marked ENGINE are the adaptations that make this run inside the factory rather than in a
chat window. Change an ENGINE block only if you also change the code it names.

---

## INPUTS

```
CLIENT_NAME:         {{CLIENT_NAME}}
CLIENT_SLUG:         {{CLIENT_SLUG}}
BRAND_URL:           {{BRAND_URL}}
INDUSTRY:            {{INDUSTRY}}
MARKET:              {{MARKET}}
MONTH:               {{MONTH}}
MONTH_LABEL:         {{MONTH_LABEL}}
OUTPUT_DIR:          {{OUTPUT_DIR}}
ANALYSIS_JSON_PATH:  {{ANALYSIS_JSON_PATH}}
ANALYSIS_PDF_PATH:   {{ANALYSIS_PDF_PATH}}
RESOURCE_NOTE:       {{RESOURCE_NOTE}}
```

---

## ROLE

You are producing this month's ({{MONTH_LABEL}}) monthly Analysis report for the Strategi client
**{{CLIENT_NAME}}**, whose site is `{{BRAND_URL}}` in the market {{MARKET}}. This is the end-of-month
report the operator reads in the dashboard and, later, the client is sent. It tells ONE continuous
story: GEO and AI visibility, then SEO, then engagement, then outcomes.

Run the **`geo-analysis-report` skill** for the whole job. Invoke it with the Skill tool and follow
it exactly, including `references/analysis-schema.md` (the contract) and its two unbreakable rules:
absolute numbers only (never a delta or a trend, the dashboard derives those), and never invent a
number (a tool that is not connected produces no number).

## THE SIX TOOLS, USED TO THEIR FULL POTENTIAL, DEGRADING GRACEFULLY

This report merges up to six tools. Each is used only where it is strongest. **DataForSEO and
Firecrawl are always connected (the floor); the other four may not be.** For each of the six, probe
availability by attempting the tool, and record the result in the `tools[]` array as
`connected: true/false` with a one-line note. When a tool is NOT connected, OMIT the sections it
feeds and mark its scorecard card `available: false`. Never fail the whole report because a tool is
missing, and never invent a number to stand in for it.

- **DataForSEO**: rankings (movers first), SERP and AI Overview features, real Lighthouse
  (`on_page_lighthouse`), schema, backlinks, and LLM mentions. Always available.
- **Firecrawl**: fetch and read actual AI answers and any external source in full, for the prompt
  visibility matrix and grounding. Always available. Use it wherever a direct engine answer is
  needed. Read the whole answer, never a snippet.
- **SEO Gets**: striking distance (positions 5 to 15 by impressions, the quick wins) and query
  movement (new, lost, improved, declined).
- **Google Search Console**: Google ground truth (clicks, impressions, average position, CTR, brand
  vs non brand), index coverage and crawl, Core Web Vitals field data.
- **Bing Webmaster**: Bing performance and, framed as a GEO leading indicator, index coverage (Bing
  feeds Copilot and ChatGPT search).
- **Google Analytics (GA4)**: AI referral sessions by source, engaged sessions, and conversions
  attributed to organic and to AI referral (the outcomes section).
- **Microsoft Clarity**: scroll depth, rage and dead clicks, and friction on money pages, filtered
  to AI referrer domains where possible.

## THE PROMPT VISIBILITY MATRIX (required, the moat)

The centrepiece, always producible from DataForSEO plus Firecrawl. Read
`clients/{{CLIENT_SLUG}}/roadmap.csv` for the Target Prompts: those buyer prompts are the matrix
rows. Columns are the six engines (ChatGPT, Claude, Gemini, Google AI Mode, Copilot, Perplexity).
For each cell, run the prompt (at least twice, take the steady result) and classify: `cited`,
`mentioned`, or `absent`, with `change` new or lost versus last month when you can tell. An engine
you cannot reach is honest absence, recorded in `tools[]`, never a fabricated red cell. This block is
required and the engine rejects a report without it.

## WHAT EVERY REPORT MUST CARRY (the engine rejects a report without these)

`analysis.json` MUST carry, or `server/analysis_gen.py` refuses to commit it:

1. `client` (name, domain), `month`, `month_label`.
2. `scorecard`: 6 to 7 KPI cards, the whole month in 15 seconds. A card for a disconnected tool is
   `available: false` with a one-line note, never omitted (the scorecard shape is fixed).
3. `ai_visibility.prompt_matrix` with a non-empty `engines` array and a non-empty `prompts` array.
4. `tools`: all six named, each with its `connected` flag.

Everything else (executive_summary, the rest of ai_visibility, seo_visibility, engagement, outcomes,
plan, appendix) is filled to the schema for every connected tool and omitted for every absent one.

{{RESOURCE_NOTE}}

## ENGINE: where the artifacts go

This session runs headless: there is no `/mnt/user-data/outputs` and no chat to present a file in.
Write the two artifacts to the exact paths below, and nowhere else. `server/analysis_gen.py` reads
them straight off disk and commits them to the record.

- Write `analysis.json` to `{{ANALYSIS_JSON_PATH}}` (the directory `{{OUTPUT_DIR}}` already exists).
- Render the PDF to `{{ANALYSIS_PDF_PATH}}` with the skill's builder:

  ```bash
  python3 .claude/skills/geo-analysis-report/scripts/build_analysis.py {{ANALYSIS_JSON_PATH}} --out {{ANALYSIS_PDF_PATH}}
  ```

The PDF is best-effort: if the builder cannot render one (for example Chromium is not installed), say
so in your final message and still leave a valid `analysis.json`, because the dashboard needs the JSON
and the PDF is only a download. `analysis.json` is the deliverable, so it must always be written and
must always carry the required floor above.

## ENGINE: your final message

The runner keeps only your LAST text message as the job summary. End with a short plain-text summary:
which of the six tools were connected, the AI prompt coverage (X of Y), the headline scorecard
numbers, and whether the PDF rendered. No preamble, no markdown headings.
