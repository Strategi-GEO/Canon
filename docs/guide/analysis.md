# Analysis

**Analysis** is the deep monthly read for one brand. It merges up to six connected tools plus its own AI prompt tests into one dataset, and it answers a harder question than the monthly report does: for each buyer prompt, on each AI engine, are we cited, named, or absent, and what did that do for rankings, engagement and conversions.

Analysis and [Reports](reports.md) are two different products on two different tabs. Reports is the short monthly performance story you send to a client. Analysis is the internal read you work from. Nothing on the Analysis tab reaches a client.

| | Analysis | Reports |
|---|---|---|
| What it answers | Where we win or lose per prompt and per engine, and what that did for traffic and conversions | Are we visible in AI answers, is the site healthy, what do we fix |
| Data sources | Up to six tools plus its own prompt tests | DataForSEO plus Firecrawl against the live site |
| AI engines covered | ChatGPT, Claude, Gemini, Google AI Mode, Copilot, Perplexity | ChatGPT, Gemini, Claude |
| Button | **Run {month} analysis** | **Generate {month} report** |
| Can the client see it | No | Yes, once you press **Send to client** |

## Where it lives

Open a brand, then click **Analysis** in the left nav. The header reads **Analysis** with the line "The deep six-tool GEO and SEO visibility read for {brand}".

A brand holds at most one analysis per calendar month. The month picker at the top right lists every month the brand has, newest first, plus the current month marked **(current)**.

## The six tools, and what happens when one is not connected

DataForSEO and Firecrawl are the floor. They are always connected, and the prompt visibility matrix and the rankings are always producible from them alone. Firecrawl is the one that reads the actual AI answers and every external source in full, and it is the only tool the strip described below does not name.

The six the run counts, and what each is for:

| Tool | What it is best at | What it fills in |
|---|---|---|
| **DataForSEO** | Rankings, SERP and AI Overview features, Lighthouse, schema, backlinks, LLM mentions | The scorecard, the matrix, SEO visibility, technical health |
| **SEO Gets** | Striking distance queries and query movement | The quick wins table |
| **Google Search Console** | Google ground truth: clicks, impressions, position, CTR, index coverage | Google performance |
| **Bing Webmaster** | Bing performance and index coverage, a real leading indicator because Bing feeds Copilot and ChatGPT search | The Bing indicator and Bing performance |
| **Google Analytics (GA4)** | AI referral sessions, engaged sessions, conversions | AI referral traffic and outcomes |
| **Microsoft Clarity** | Scroll depth, rage and dead clicks, friction on money pages | Engagement and behaviour |

The last five may or may not be set up on your machine. A tool that is not connected costs you a section, never the report. The run probes each tool, records what it found, and then omits what it cannot measure. It never invents a number to fill a gap.

You see this in three places on the page:

- The strip at the very top reads **Tools 4/6** and lists all six by name. A connected tool carries a green dot; a missing one is greyed.
- Its scorecard card reads **n/a** with a note, usually **Not connected**.
- Its whole section is absent from the page and from the PDF.

!!! info "Connecting a tool is a setup job on the machine"
    There is no screen in the app for connecting Search Console, GA4, Bing, Clarity or SEO Gets. Their keys live in the engine's own configuration on the machine, and no blog session is ever handed them. Analysis gets all six. SEO Gets is also handed to a [roadmap generation](roadmap.md#generate-one-with-ai-instead), which uses its striking distance and query movement to decide what is worth writing next; the other five reach analysis alone. If a tool you expect reads **Not connected**, ask whoever set the machine up. The next analysis you run picks it up.

## Running this month's analysis

With the current month selected and no analysis for it yet, the page shows an empty card and one button, labelled with the month, for example **Run July 2026 analysis**.

1. Press the button.
2. A card appears reading **Running the July 2026 analysis**, with the note that it runs the prompt visibility matrix across six engines and pulls every connected tool, so it takes several minutes, and that it keeps running if you leave the page.
3. When it finishes the page fills in with the sections on its own.

!!! note "A running analysis is only visible on this tab"
    The brand **Overview** carries a card for a running report generation but not for a running analysis. If you navigate away and want to check on it, come back to the **Analysis** tab.

### When the button refuses

Three refusals arrive as a **Could not start** message in the corner of the screen, carrying the engine's own words:

- An analysis for this brand is already running. Watch that one instead of starting a second.
- A blog run for this brand is live. Wait for it to finish.
- An analysis for this month already exists. Delete it first to regenerate.

A fourth refusal reads as red text under the button instead of a message: the brand has no domain recorded. An analysis measures a live site, so add the domain on [Settings](settings.md) first.

Analyses, like reports, always target the current calendar month from the engine's own clock. An older month with no analysis shows "This month has no analysis. Analyses are run for the current month." and offers no button.

!!! warning "Running an analysis spends real money"
    The run puts every buyer prompt through six engines at least twice, pulls Lighthouse and rankings, and calls every connected tool. That is live API spend on DataForSEO and the other tools plus the Claude usage of a long session. Run it once a month per brand, on purpose.

## What you see on the page

The sections read as one story, from AI visibility down to business outcomes. Any section whose tool is missing is not on the page at all.

**The month in 15 seconds** is the scorecard: six or seven cards, each with the figure, its change against the previous month, a small trend line where there is history, and the name of the tool that produced it. A card for a disconnected tool is greyed and reads **n/a**.

**Executive summary** is plain prose, plus two lists, **What we did** and **What is next**.

**Prompt visibility matrix** is the centrepiece and is always present. Rows are the brand's buyer prompts, taken from the Target Prompts on the [Content Roadmap](roadmap.md) plus the queries the brand is already known for. Columns are the six AI engines. Each cell reads **Cited** in green, **Named** in amber, or **Absent** in red, with an arrow where the state is new or lost since last month. A **Coverage** percentage sits in the section header. Each prompt is run at least twice per engine and the steady result is what lands, because one sample of a model is a coin flip.

**Citations and priority gaps** sits underneath: where you were cited, with the snippet, next to the open gaps and the play for closing each one.

**AI referral traffic** lists real people arriving from AI engines by source, with sessions, engaged sessions and conversions.

**Bing as a GEO leading indicator** shows impressions, clicks and how many of your key pages are indexed, framed that way because Bing feeds Copilot and ChatGPT search.

**Google AI Overview presence** is a keyword table: whether an AI Overview appeared, and whether you were cited in it.

**SEO visibility** carries Google performance, the striking distance quick wins, rankings with movers first, SERP feature and AI Overview capture, Bing performance, and technical and GEO health with the Lighthouse scores, schema coverage and Core Web Vitals.

**Engagement and behaviour** shows landing page scroll depth, average time and top click, plus friction flags such as rage and dead clicks.

**Outcomes** ties it together: organic sessions, engaged sessions, conversions from organic and conversions from AI referral.

**What we did and what is next** closes with the shipped list and the plan for next month.

!!! info "The changes are calculated here, not written by the model"
    The analysis stores this month's absolute figures only. Every month over month change is worked out by the dashboard, either from a figure the tool handed over directly or from the same card in an earlier month you already hold. A card with nothing earlier to compare against says so rather than showing a fabricated zero.

## When a run fails

A failed run shows a card reading **The analysis failed.** with the engine's own explanation, plus **Try again** and **Dismiss**.

Nothing is saved unless the session wrote a usable dataset. The engine re-reads the file off disk and requires only the floor: the brand and month, the scorecard, the prompt visibility matrix with at least one engine and one prompt, and the tools table naming which of the six were connected. A missing optional tool is never a failure. A missing floor is, and the message names which part was absent.

## Sharing, and why there is none

There is no **Send to client** on this tab, and no Analysis section in the client portal. Analysis is internal. A client sees monthly Reports only, and only after you press **Send to client** there.

If a client should see something from an analysis, download the PDF and send it yourself, or work the finding into the monthly report you do share.

## Deleting an analysis

**Delete** sits in the header next to **PDF**. The dialog is titled "Delete the July 2026 analysis?" and offers **Cancel** and **Delete**.

Deleting is how you re-run a month. A brand holds one analysis per month, so **Run {month} analysis** is not offered again until the existing one is gone.

!!! danger "Deleting cannot be undone"
    Delete removes the working analysis and its PDF for that month. There is no way to get it back other than running a fresh one, which spends the tool and model budget again.

Delete is refused while an analysis is running for that brand.

## The PDF

When a month's PDF rendered, a **PDF** button appears in the header. It downloads the file as `{brand-slug}-{month}-analysis.pdf`, for example `acme-2026-07-analysis.pdf`. It carries the same data the tab shows, so the screen and the download cannot disagree.

The PDF is best effort. If it could not be rendered, the analysis still saves and the tab still shows every section. You notice only by the **PDF** button not being there.

!!! tip "No PDF button? The browser is missing"
    The PDF is printed through Playwright's own Chromium, which the launcher fetches automatically after any dependency install. If that fetch failed, install it by hand from the repo folder:

    === "macOS and Linux"

        ```bash
        .venv/bin/python -m playwright install chromium
        ```

    === "Windows"

        ```powershell
        .venv\Scripts\python.exe -m playwright install chromium
        ```

    Analyses run before you install it keep their missing PDF. Run a fresh month to get one.
