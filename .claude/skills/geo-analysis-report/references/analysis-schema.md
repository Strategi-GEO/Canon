# analysis.json schema

This is the ONE contract. `scripts/build_analysis.py` renders it to the branded PDF, the dashboard
Analysis tab renders it to the on-screen metrics, `server/analysis_gen.py` validates it before it
commits, and `dashboard/src/types/index.ts` types it. If a field is not here, nothing downstream can
draw it. Keep the four in sync.

## The one principle: absolute numbers, derived deltas

Every metric is an ABSOLUTE value for THIS month. Never hand a month-over-month delta or a trend: the
dashboard derives every delta and the all-months line from the stored history of earlier analyses,
exactly as the Reports tab does. The ONE exception is a per-card `prev_value` a tool gives you
directly (GSC and GA4 return last month's number in the same call), which the UI prefers over derived
history when present. A hand-typed delta is a number that can only be wrong.

## Graceful degradation is the schema, not an error path

Six tools feed this report and they arrive incrementally: DataForSEO and Firecrawl are always present
(the floor), the other four (GSC, GA4, Bing Webmaster, Microsoft Clarity, SEO Gets) may not be
connected yet. A section whose tool is absent is simply OMITTED, and its scorecard card carries
`available: false` with a one-line `note`. Never invent a number to fill a gap. Never fail the whole
report because one tool is missing. The `tools` array records what was connected so the UI and the
PDF appendix can both show it.

## Required floor (the validator rejects anything less)

The report cannot ship without these, because they are producible from the floor tools alone:

- `client` object with `name`, `domain`.
- `month` (`YYYY-MM`) and `month_label` (`"July 2026"`).
- `scorecard`: a non-empty array of KPI cards (Section 0).
- `ai_visibility.prompt_matrix` with a non-empty `engines` array and a non-empty `prompts` array
  (the GEO centrepiece, always producible with DataForSEO + Firecrawl).
- `tools`: a non-empty array naming each of the six and whether it was connected.

Everything else is optional and omitted when its tool is absent.

## Top-level shape

```jsonc
{
  "client": { "name": "Acme", "slug": "acme", "domain": "acme.com", "industry": "SaaS" },
  "month": "2026-07",
  "month_label": "July 2026",

  // Optional PDF branding. Maps to --brand-* CSS vars; org_name is the wordmark.
  "brand": { "org_name": "Strategi", "accent": "#1A5FD4" },

  // SECTION 0 - Snapshot scorecard. 6-7 cards, the whole month in 15 seconds. REQUIRED, non-empty.
  "scorecard": [
    {
      "key": "ai_prompt_coverage",          // stable id, used by the UI
      "label": "AI Prompt Coverage",
      "value": "11/18",                     // string or number (string keeps "11/18")
      "prev_value": "7/18",                 // OPTIONAL: last month, if the tool gave it directly
      "unit": null,                          // OPTIONAL: "%", "sessions", etc.
      "spark": [4, 6, 7, 11],                // OPTIONAL: 3-6 month trend for a sparkline
      "tool": "Prompt-test runs",           // which tool produced it (appendix + provenance)
      "available": true,                     // false => "Not connected", greyed on the UI
      "note": null                           // OPTIONAL: one line, e.g. "Add GA4 key to enable"
    }
    // ...AI Referral Sessions (GA4), Google Clicks (GSC), Bing Clicks (Bing),
    //    Organic Sessions (GA4), Conversions (GA4), Engagement (Clarity)
  ],

  // SECTION 1 - Executive summary. Pure prose, the forwardable page. OPTIONAL.
  "executive_summary": {
    "paragraphs": ["GEO paragraph ending in its key number.", "SEO paragraph.", "Engagement paragraph."],
    "did": ["Shipped 4 pillar pages", "Fixed schema on 12 templates"],
    "next": ["Close the 3 red prompts in 2b", "Target the 5 striking-distance queries"]
  },

  // SECTION 2 - GEO / AI visibility. The moat. prompt_matrix is REQUIRED; the rest optional.
  "ai_visibility": {
    // 2a. Prompt Visibility Matrix. rows=prompts, cols=engines. REQUIRED.
    "prompt_matrix": {
      "coverage_pct": 61,
      "engines": ["ChatGPT", "Claude", "Gemini", "Google AI Mode", "Copilot", "Perplexity"],
      "prompts": [
        {
          "prompt": "best invoice software for freelancers",
          "cells": [
            { "engine": "ChatGPT", "state": "cited", "change": "new" },   // state: cited|mentioned|absent
            { "engine": "Claude",  "state": "mentioned", "change": null }, // change: new|lost|null
            { "engine": "Gemini",  "state": "absent", "change": "lost" }
            // one cell per engine; a missing engine cell renders neutral
          ]
        }
      ]
    },
    // 2b. Citation detail + gaps. OPTIONAL.
    "citations": [ { "prompt": "...", "engine": "ChatGPT", "snippet": "...Acme is a top pick..." } ],
    "gaps": [ { "prompt": "...", "play": "Publish a comparison page targeting this query" } ],
    // 2c. AI referral traffic - GA4. OPTIONAL (omit if GA4 absent).
    "referral_traffic": {
      "by_source": [ { "source": "chatgpt.com", "sessions": 142, "engaged": 120, "conversions": 6 } ],
      "series": [ { "month": "2026-05", "sessions": 60 }, { "month": "2026-06", "sessions": 98 } ]
    },
    // 2d. AI engagement quality - Clarity filtered to AI referrers. OPTIONAL.
    "engagement": [ { "page": "/pricing", "scroll_pct": 74, "rage_clicks": 2, "dead_clicks": 5 } ],
    // 2e. Bing as GEO leading indicator - Bing Webmaster. OPTIONAL.
    "bing_indicator": { "impressions": 8400, "clicks": 210, "indexed": 142, "key_pages": 150,
                        "series": [ { "month": "2026-06", "impressions": 6300, "clicks": 150 } ] },
    // 2f. AI Overview presence - DataForSEO. OPTIONAL.
    "ai_overview": [ { "keyword": "invoice software", "aio_present": true, "client_cited": false } ]
  },

  // SECTION 3 - SEO visibility. All optional; each block omitted when its tool is absent.
  "seo_visibility": {
    "google": {                                    // GSC
      "clicks": 3200, "prev_clicks": 2800,
      "impressions": 91000, "prev_impressions": 84000,
      "avg_position": 14.2, "prev_avg_position": 15.1,
      "ctr": 3.5, "prev_ctr": 3.3,
      "brand_vs_nonbrand": {
        "series": [ { "month": "2026-06", "brand": 900, "nonbrand": 1900 } ]
      }
    },
    "striking_distance": [ { "query": "...", "position": 8, "impressions": 1200, "url": "/x" } ],  // SEO Gets
    "query_movement": { "new": ["..."], "lost": ["..."], "improved": ["..."], "declined": ["..."] }, // SEO Gets
    "bing": { "clicks": 210, "impressions": 8400, "avg_position": 12.0 },                            // Bing
    "serp_features": [ { "feature": "Featured snippet", "owned_this": 4, "owned_last": 2 } ],        // DataForSEO
    "rankings": [ { "keyword": "...", "position": 5, "delta": 3, "volume": 1200, "url": "/x" } ],    // DataForSEO
    "index_health": {
      "google": { "indexed": 480, "errors": 3, "dropped": 1 },
      "bing":   { "indexed": 142, "errors": 0, "dropped": 0 }
    },
    "tech_health": {                                // DataForSEO Lighthouse + schema, GSC CWV
      "lighthouse": { "scores": [ { "category": "Performance", "desktop": 88, "mobile": 61 } ] },
      "schema_coverage_pct": 72,
      "cwv_status": "needs-work"                    // good|needs-work|poor
    }
  },

  // SECTION 4 - Engagement & behaviour - Clarity. OPTIONAL.
  "engagement": {
    "landing_pages": [ { "page": "/pricing", "scroll_pct": 74, "avg_time": "1m 42s", "top_click": "Start free" } ],
    "friction": [ { "page": "/checkout", "type": "rage clicks", "count": 18, "delta": 5 } ]
  },

  // SECTION 5 - Outcomes - GA4. OPTIONAL.
  "outcomes": {
    "organic_sessions": 5400, "prev_organic_sessions": 4900,
    "engaged_sessions": 3800,
    "conversions_organic": 44, "conversions_ai": 9,
    "series": [ { "month": "2026-06", "organic": 4900, "engaged": 3300, "conversions": 40 } ],
    "summary": "Visibility turned into 5,400 organic sessions and 53 conversions this month."
  },

  // SECTION 6 - What we did / what's next. OPTIONAL.
  "plan": {
    "did": ["Shipped 4 pillars", "Fixed schema coverage to 72%"],
    "next": [ { "item": "Close the 3 red prompts", "source": "2b prompt gap" },
              { "item": "Target 5 striking-distance queries", "source": "3b" } ]
  },

  // Appendix / methodology notes. OPTIONAL.
  "appendix": {
    "notes": ["Prompt-testing runs each buyer prompt >=2x per engine.",
              "Clarity is filtered to AI-referrer domains, not true session stitching."]
  },

  // The data-sources table - the ONE place all six tools are named. REQUIRED, non-empty.
  "tools": [
    { "name": "DataForSEO",       "connected": true,  "note": "Rankings, SERP/AIO, Lighthouse, backlinks" },
    { "name": "SEO Gets",         "connected": false, "note": "Not connected" },
    { "name": "Google Search Console", "connected": false, "note": "Not connected" },
    { "name": "Bing Webmaster",   "connected": false, "note": "Not connected" },
    { "name": "Google Analytics", "connected": false, "note": "Not connected" },
    { "name": "Microsoft Clarity","connected": false, "note": "Not connected" }
  ]
}
```

## Hard formatting rule

ZERO em dashes (`—`) and ZERO en dashes (`–`) anywhere in any string. Commas, colons, periods,
parentheses. `build_analysis.py` scans every string and exits 1 on a hit, same as the site report.

## Cell state colours (fixed, both surfaces)

- `cited`    -> green  (`--sev-good`)  the client is cited/linked in that engine's answer.
- `mentioned`-> amber  (`--sev-mid`)   named but not linked.
- `absent`   -> red    (`--sev-bad`)   not present.
- a missing cell for an engine renders neutral (no data that engine this month).
- `change`: `new` shows a small up glyph, `lost` a down glyph, `null` nothing.
