# report.json contract

The single input to `scripts/build_report.py`. You write data; the template owns everything else.

Two rules worth internalising before the field list, because they cause most build failures:

**Do not compute anything the script computes.** Presence rate, named and cited counts, the total number of runs, and the traffic-light colour on every Lighthouse score are all derived at render time. Hand-counting them means a chance of being wrong on a client-facing number for no benefit.

**No em dashes or en dashes, anywhere, in any string.** The build refuses. This is house style and the check is deliberate.

---

## Top level

| Key | Required | Notes |
|---|---|---|
| `site_name` | yes | Cover title. |
| `url` | yes | Confirmed live URL, per Hard Rule 1. |
| `audit_date` | yes | Human format: `16 July 2026`. |
| `snapshot` | yes | See below. |
| `modules` | yes | See below. |
| `priority_fixes` | yes | See below. |
| `deck_note` | yes | One sentence. The pitch this site hands you. |
| `brand` | no | `{"org_name": "Strategi", "accent": "#1A5FD4", "ink": "#0F1419"}`. Any key maps to a `--brand-*` CSS variable and overrides `report.css`. |
| `stack` | no | Cover metadata. From the digest's `stack_fingerprint`. |
| `tier` | no | Cover metadata. |
| `report_index` | no | `"1 of 3"` in a batch. |
| `metrics` | no (yes for a MONTHLY report) | The dashboard-facing KPI block. See below. |
| `lighthouse` | no (**yes for a MONTHLY report**) | Real Lighthouse. The Strategi Canon dashboard reads `lighthouse.scores`, and `server/report_gen.py` REJECTS a monthly report without them. Omit only for a standalone one-off audit where the lookup genuinely did not return; omitted prints a line saying nothing was inferred in its place. |
| `ai` | no | Omit only if genuinely not run. Hard Rule 6 says run it. |
| `root_causes` | no | Array of strings. Shared causes behind the fix list. |
| `verify_externally` | no | Array of `{check, tool, instruction}`. |

## `lighthouse`

```json
{
  "scores": [{"category": "Performance", "desktop": 61, "mobile": 34}],
  "metrics": [{"metric": "Largest Contentful Paint", "value": "4.2 s",
               "target": "under 2.5 s", "status": "High"}],
  "form_factor_note": "...",
  "seo_score_caveat": "..."
}
```
`desktop` and `mobile` accept `61` or `0.61`; both render as 61. `null` prints `n/a`, which is the right value when only desktop was run. Colour is automatic on Google's own thresholds (90+ green, 50 to 89 amber, below 50 red), so never state a verdict on a score in prose that the colour already gives.

`metrics.status` uses the severity vocabulary below, not a pass/fail word.

## `snapshot`

```json
{"lines": ["Two or three sentences.", "Each is its own string."],
 "verdict": "One line. Prints on the cover, so it is the first thing the client reads."}
```

## `metrics` (the monthly KPI block)

This is the block the Strategi Canon dashboard reads to draw the live Reports tab, and it is
what makes a report a MONTHLY report rather than a one-off audit. Emit it for every monthly
run. Every value is an absolute count for THIS month, measured now: month-over-month deltas and
the all-months trend line are DERIVED by the dashboard from the stored history of prior months,
so never compute a delta here and never invent a prior month's number.

```json
{
  "month_label": "July 2026",
  "ai_mentions": {
    "by_engine": [
      {"engine": "ChatGPT", "value": 87},
      {"engine": "Gemini", "value": 28},
      {"engine": "Claude", "value": 17}
    ]
  },
  "backlinks": 408,
  "referring_domains": 124,
  "note": "AI mentions measured via DataForSEO LLM mentions, ChatGPT, Gemini and Claude only."
}
```

- `ai_mentions.by_engine` is ONE object per engine, `engine` exactly `"ChatGPT"`, `"Gemini"`,
  `"Claude"` (the three the AI-standing section covers, in that order). `value` is the integer
  mention count for that engine this month, from the DataForSEO LLM-mentions endpoints.
- `ai_mentions.total` is DERIVED (the sum of `by_engine.value`). Do not send it; `build_report.py`
  computes it and the dashboard recomputes it, so a hand-typed total could only disagree.
- `backlinks` and `referring_domains` are integers from `backlinks_summary` for the domain, or
  `null` when the lookup did not return (the dashboard renders `null` as `n/a`).
- `month_label` is the human month, `"July 2026"`. `note` is one line naming the sources and the
  three-engine scope, so the caveat travels with the number.

## `ai`

```json
{
  "engines": ["ChatGPT", "Gemini", "Claude"],
  "not_covered": "Copilot and Google AI Overviews are not reachable through this endpoint and were not tested. Nothing is claimed about them.",
  "runs": [
    {"prompt": "Best luxury hotels in Trivandrum for a business trip",
     "engine": "ChatGPT", "model": "gpt-5.6-terra", "web_search": true,
     "named": false, "cited": false,
     "named_instead": "Taj, Hyatt Regency, Residency Tower"}
  ],
  "competitors_named": [{"name": "Hycinth by Sparsa", "mentions": 4, "engines": "ChatGPT, Gemini, Claude"}],
  "domains_cited": [{"domain": "tripadvisor.in", "citations": 5, "type": "OTA / review aggregator"}],
  "organic": {"keywords": "1,284", "top10": "97", "etv": "3,410",
              "movement": "New 44 / Up 112 / Down 209",
              "note": "Location set to India, not the United States default."},
  "limits": ["...", "..."]
}
```

`runs` is the whole basis of the scoreboard: one object per prompt per engine per repeat. Five prompts across three engines run twice each is thirty objects. `named` is whether the brand appears in the text. `cited` is whether the client's domain appears in the response's `annotations` array, which is the stronger signal and the one the client should be made to care about.

`model` and `web_search` are recorded per run for provenance. `model` is the exact model ID returned by the `ai_optimization_llm_models` lookup and used for the call. `web_search` is the boolean you passed. Both feed a derived provenance line in the report (see below); include them on every run.

`engines`, `total_runs`, `named_runs`, `cited_runs`, `presence_rate_pct`, `models_line` and `web_search_note` are all derived from `runs`. `engines` is inferred if you omit it. `models_line` reads `ChatGPT (gpt-5.6-terra), Gemini (...), Claude (...)` and prints in the coverage callout; supply your own `models_line` string only to override the derived one. `web_search_note` states plainly whether retrieval was on for every run, and turns into a warning if any run lacked it.

Because presence rate is now an average over repeats rather than a single sample, it is a measurement, not a coin flip. Keep the repeat count consistent across prompts so the rate is not weighted by accident.

`limits` is not boilerplate to be skipped. If the prompts were run once each, one of these strings says so plainly.

## `modules`

```json
[{"name": "Schema and entity graph", "status": "Failing",
  "findings": [{"severity": "High",
                "text": "addressCountry is the string 107 instead of IN.",
                "evidence": "\"addressCountry\": \"107\""}]}]
```

`status` is exactly one of `Strong`, `Weak`, `Failing`, `Verify`. `severity` is exactly one of `High`, `Medium`, `Low`, `Verify`. Anything else fails the build with the offending value named.

`evidence` renders in mono directly under the finding and is where the client's own broken value gets quoted verbatim. `null` or omit it when there is nothing to quote. Do not paraphrase a value into `evidence`; if it is not a real string from the site, it belongs in `text`.

Standard module set: Stack, GEO extractability, Schema and entity graph, Crawlability, On-page SEO, Security and hygiene, Authority and E-E-A-T. Drop one only when the site genuinely gave nothing to say about it.

## `priority_fixes`

```json
[{"fix": "Fix addressCountry to IN and populate telephone",
  "why": "One line of JSON. The cheapest change on this list, and it repairs the property's identity across every engine at once.",
  "effort": "Quick win", "severity": "High"}]
```

Ordered: quick wins first, strategic last. `effort` is free text and prints as the pill; `severity` colours it. `why` is what earns the ranking, so it carries the argument rather than restating the fix.
