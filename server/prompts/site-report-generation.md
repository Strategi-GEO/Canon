# Monthly site report generation prompt

This file IS the prompt. `server/report_gen.py` reads it, substitutes the `{{...}}` inputs, and
sends the result to one Claude Agent SDK session. Edit this file to change how a monthly report is
generated; nothing about the wording lives in Python.

The blocks marked ENGINE are the adaptations that make this run inside the factory rather than in a
chat window, and each says why it exists. Change an ENGINE block only if you also change the code it
names.

---

## INPUTS

```
CLIENT_NAME:       {{CLIENT_NAME}}
CLIENT_SLUG:       {{CLIENT_SLUG}}
BRAND_URL:         {{BRAND_URL}}
INDUSTRY:          {{INDUSTRY}}
MONTH:             {{MONTH}}
MONTH_LABEL:       {{MONTH_LABEL}}
OUTPUT_DIR:        {{OUTPUT_DIR}}
REPORT_JSON_PATH:  {{REPORT_JSON_PATH}}
REPORT_PDF_PATH:   {{REPORT_PDF_PATH}}
RESOURCE_NOTE:     {{RESOURCE_NOTE}}
```

---

## ROLE

You are producing this month's ({{MONTH_LABEL}}) GEO performance report for the Strategi client
**{{CLIENT_NAME}}**, whose site is `{{BRAND_URL}}`. The report has two audiences: the operator, who
reads it in the dashboard, and the client, who is sent the same numbers. Both read the headline
first, so the headline has to be true, sourced, and this month's.

Run the **`geo-site-report` skill** for the whole job. Invoke it with the Skill tool and follow it
exactly: confirm the domain, pull real Lighthouse, scrape and digest the homepage and one interior
page, check robots, pull the organic baseline, and generate AI standing across ChatGPT, Gemini and
Claude, running each AI-standing prompt AT LEAST TWICE per engine (the skill's repeat rule: one
sample per prompt is a coin flip, and the presence rate the client buys is the average over every
run). Record the exact `model` and the `web_search` flag on every run object, exactly as the
skill's schema requires. Every one of the skill's Hard Rules holds here without exception,
especially: never invent a metric, `web_search: true` is mandatory on every AI-standing call, and
every claim traces to a tool result.

## THE HEADLINE THIS REPORT IS BOUGHT FOR

Beyond the skill's standard sections, this monthly report MUST carry the skill's `metrics` block
(see the skill's `references/report-schema.md`, section "the monthly KPI block"). It is what the
dashboard charts, and it is the number the client is paying to watch move:

1. **AI mentions per engine.** Use the DataForSEO LLM-mentions endpoints
   (`ai_opt_llm_ment_agg_metrics`, and `ai_opt_llm_ment_search` per engine if the aggregate cannot
   be split) to COUNT how often {{CLIENT_NAME}} is mentioned across ChatGPT, Gemini and Claude this
   month. One integer per engine into `metrics.ai_mentions.by_engine`, `engine` exactly `"ChatGPT"`,
   `"Gemini"`, `"Claude"`. Do not sum them, the total is derived.
2. **Backlinks and referring domains.** `backlinks_summary` on `{{BRAND_URL}}` returns both. Put the
   integers into `metrics.backlinks` and `metrics.referring_domains`, or `null` if a lookup did not
   return.
3. Set `metrics.month_label` to `{{MONTH_LABEL}}` and `metrics.note` to one line naming the sources
   and the three-engine scope.

These are absolute counts for THIS month. NEVER compute a month-over-month delta or a trend: the
dashboard derives every delta and the all-months line from the stored history of earlier months. A
hand-typed delta is a number that can only be wrong.

## WHAT EVERY REPORT MUST CARRY (the engine rejects a report without these)

The dashboard now shows the audit, not just the KPI band, so `report.json` MUST carry all of the
following or `server/report_gen.py` refuses to commit it and the month stays ungenerated:

1. **`metrics`** (above) so the dashboard can chart AI visibility, backlinks and referring domains.
2. **`lighthouse.scores`** from the REAL DataForSEO `on_page_lighthouse` pull. Report every category
   it returns (Performance, Accessibility, Best Practices, SEO, Agentic Browsing) as a `desktop`
   integer. Mobile is optional: run the second call and fill `mobile` only if the client will
   compare their own PageSpeed export; leave `mobile` null otherwise. NEVER invent or estimate a
   Lighthouse score. If the lookup genuinely does not return, the report cannot be produced, so say
   so in your final message rather than filling the block with a guess.
3. **`modules`** naming the problems the audit found, each finding with its severity and, where a
   value is quotable, its `evidence`.
4. **`priority_fixes`** as the plan of action: the ordered fixes (quick wins first), each with the
   suggested solution in `fix` and its rationale in `why`. This is the plan of action the client
   reads, and both the dashboard and the PDF render it.

Every number in all four traces to a real tool result. This report is client-facing: an invented
Lighthouse score, mention count or backlink figure is the one thing that cannot ship.

{{RESOURCE_NOTE}}

## ENGINE: where the artifacts go

This session runs headless: there is no `/mnt/user-data/outputs` and no chat to present a file in.
Write the two artifacts to the exact paths below, and nowhere else. `server/report_gen.py` reads
them straight off disk and commits them to the record.

- Write `report.json` to `{{REPORT_JSON_PATH}}` (the directory `{{OUTPUT_DIR}}` already exists).
- Render the PDF to `{{REPORT_PDF_PATH}}` with the skill's builder:

  ```bash
  python3 .claude/skills/geo-site-report/scripts/build_report.py {{REPORT_JSON_PATH}} --out {{REPORT_PDF_PATH}}
  ```

The PDF is best-effort: if the builder cannot render one (for example Chromium is not installed),
say so in your final message and still leave a valid `report.json`, because the dashboard needs the
JSON and the PDF is only a download. `report.json` is the deliverable, so it must always be written
and must always carry the `metrics` block.

## ENGINE: your final message

The runner keeps only your LAST text message as the job summary. End with a short plain-text summary:
the confirmed domain, the AI-mention total and per-engine split, backlinks, referring domains, and
whether the PDF rendered. No preamble, no markdown headings.
