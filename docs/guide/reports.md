# Reports

**Reports** is the monthly performance report for one brand. It answers a simple client question: are we showing up in AI answers, is the site healthy, and what should we fix next. You generate one per calendar month, read it on the tab, and send it to the client when you are happy with it.

**Analysis** is a different product on a different tab. Reports is the short monthly performance story you send to a client. [Analysis](analysis.md) is the deeper internal read across six connected tools. They share nothing but a shape: separate tabs, separate records, separate buttons.

| | Reports | Analysis |
|---|---|---|
| What it answers | Are we visible in AI answers, is the site healthy, what do we fix | Where exactly we win or lose per prompt and per engine, and what that did for traffic and conversions |
| Where the data comes from | DataForSEO plus Firecrawl against the live site | Up to six tools plus its own AI prompt tests |
| AI engines covered | ChatGPT, Gemini, Claude | ChatGPT, Claude, Gemini, Google AI Mode, Copilot, Perplexity |
| Button | **Generate {month} report** | **Run {month} analysis** |
| Can the client see it | Yes, once you press **Send to client** | No, there is no sharing on the Analysis tab |

## Where it lives

Open a brand, then click **Reports** in the left nav. The page header reads **Reports** with the line "Coverage, links and AI visibility for {brand}".

A brand holds at most one report per calendar month. The month picker at the top right shows every month the brand has, newest first, plus the current month marked **(current)**.

## Generating this month's report

With the current month selected and no report for it yet, the page shows an empty card and one button, labelled with the month, for example **Generate July 2026 report**.

1. Press the button.
2. A card appears reading **Generating the July 2026 report**, with the note that it runs a full audit across DataForSEO and the live site, takes a few minutes, and keeps running if you leave the page.
3. When it finishes, the page fills in with the charts on its own. You do not refresh anything.

The brand **Overview** also shows a card while a report is generating, with the time elapsed and a button reading **Open the Reports tab**. That is there so a report started on one tab is visible from the brand's front page instead of looking like a press that never happened.

!!! note "Only the current month"
    Generation always targets the current calendar month, taken from the engine's own clock and never from your browser. The numbers are measured now, so stamping them with a past month would be a false label. Selecting an older month with no report shows "This month has no report. Reports are generated for the current month." and offers no button.

### When the button refuses

Three refusals arrive as a **Could not start** message in the corner of the screen, carrying the engine's own words:

- A report generation for this brand is already running. Watch that one instead of starting a second.
- A blog run for this brand is live. Wait for it to finish.
- A report for this month already exists. Delete it first to regenerate.

A fourth refusal reads as red text under the button instead of a message: the brand has no domain recorded. A report audits a live site, so add the domain on [Settings](settings.md) first.

### What it costs

!!! warning "Generating a report spends real money"
    A report run scrapes the site, pulls a real Google Lighthouse audit, runs an organic lookup, and puts five buyer prompts through three AI engines twice each, which is thirty live model calls. The skill budgets roughly $0.48 of DataForSEO spend per site for that part, on top of the Claude usage the session itself burns. Generate deliberately, and delete a month only when you actually intend to pay for a fresh one.

## What the report is built from

The session works through the same list every time:

- **Google Lighthouse**, pulled for real through DataForSEO on the homepage, desktop by default.
- **The homepage and one interior page**, fetched with Firecrawl and read through a digest so the findings come from the page source rather than a guess.
- **`/robots.txt`**, checked for whether AI crawlers such as GPTBot, ClaudeBot, PerplexityBot and CCBot are allowed.
- **An organic baseline** from DataForSEO for the brand's own market.
- **AI standing**: five high intent buyer prompts, run across ChatGPT, Gemini and Claude with web search on, each prompt run at least twice because a single sample of a model is a coin flip.
- **The monthly numbers**: AI mention counts per engine, backlinks, and referring domains.

Every figure traces to a tool result. Nothing in the report is written from memory.

## What you see on the page

**AI visibility** is the headline card. It shows the month's total AI mentions as one large number, a change pill against the previous month, a bar per engine with that engine's own change, and a trend line across every month you have generated. Hovering the line names the month and its value.

**Google Lighthouse** draws one gauge per category, coloured on Google's own bands: 90 and above green, 50 to 89 amber, below 50 red. A category with no score shows a dash rather than a zero, because "not measured" is not the same claim as "scored zero". Where a mobile run was done, each gauge carries a **Mobile** figure under it. The `agentic-browsing` category is experimental and reads as a direction, not a grade.

**Backlinks** and **Referring domains** sit side by side as two tiles, each with its month over month change and a small trend line.

**Plan of action** is the numbered fix list, quickest wins first, each item carrying a pill for effort or severity and a line on why it earns its place.

!!! info "The changes are calculated here, not written by the model"
    The report stores this month's absolute counts only. Every change pill and every trend line is worked out by the dashboard from the months you already hold. The first month you generate shows "no prior month" instead of a fabricated zero.

The full audit detail, including the module findings and the quoted evidence, is in the PDF. The tab shows the headline numbers, Lighthouse and the plan of action.

## When a generation fails

A failed run shows a card reading **The report generation failed.** with the engine's own explanation, plus **Try again** and **Dismiss**.

A machine with no Firecrawl or DataForSEO credentials fails here rather than at the button, before the session fetches anything, because there would be no way to measure a mention or a backlink.

Nothing is saved unless the session wrote a usable report. The engine re-reads the file off disk and refuses to commit one that is missing the per engine mention numbers, the Lighthouse scores, the module findings, or the plan of action. A thin report is rejected at that point rather than discovered empty later, and the message on the card names which part was missing.

## Sending a report to the client

Once a month has a report, the header carries **Send to client**. Pressing it opens a confirm dialog titled "Send the July 2026 report to the client?", with **Not yet** and **Send to client**.

After sending, a green banner reads "Shared with the client on {date} by {you}. They are seeing this exact report." The button becomes **Share again**.

Before you send, the banner reads "Not shared with the client yet. Send it when you are happy, and they will see it in their portal." Nothing reaches a client on its own. Sending is always a press.

### What the client then sees

The client opens **Reports** in [their portal](../client-portal/index.md) and sees the same charts you see, drawn from the copy you sent. They see shared months only. A month you generated but never sent reads "Report not available yet" with the line that it will appear as soon as their team publishes it.

The client's view is on screen. The PDF download is on your side of the app, not theirs.

Sending again after you regenerate replaces the version they were looking at. The dialog says so: they are currently seeing an earlier version, and sharing replaces it with the report on screen now.

## Deleting a report

**Delete** sits next to **Send to client**. The dialog is titled "Delete the July 2026 report?" and offers **Keep it** and **Delete report**.

Deleting is how you regenerate a month. A brand holds one report per month, so the **Generate** button is not offered again until the existing one is gone.

!!! danger "Deleting your copy cannot be undone"
    There is no way to see the working report again once it is deleted. Getting it back means generating a new one, which spends the tool and model budget again.

Deleting does not remove the report from the client. If you had shared that month, the client keeps seeing the version you sent until you generate a new one and share that. The tab then shows an amber banner saying exactly that, so you can tell at a glance that the client is looking at something you no longer hold.

Delete is refused while a generation is running for that brand.

## The PDF

When a month's PDF rendered, a **PDF** button appears in the header. It downloads the file as `{brand-slug}-{month}-report.pdf`, for example `acme-2026-07-report.pdf`.

The PDF is best effort. The report itself is the deliverable the dashboard needs, so a run that could not render a PDF still saves the report and still shows every chart. You notice only by the **PDF** button not being there.

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

    Reports generated before you install it keep their missing PDF. Generate a fresh month to get one.
