# Roadmap generation prompt

This file IS the prompt. `server/roadmap_gen.py` reads it, substitutes the `{{...}}` inputs, and
sends the result to one Claude Agent SDK session. Edit this file to change how roadmaps are
generated; nothing about the wording lives in Python.

**THE STRATEGY IS NO LONGER HERE. IT IS THE `roadmap-generation` SKILL.** This file used to
carry the whole seven-stage method inline, which meant the method existed in two places the
moment the skill did, and two copies of a strategy drift within a month. What survives here is
the ENGINE half: the things true because this runs inside the factory rather than in a chat
window, and each block says why it exists. Change the strategy in
`.claude/skills/roadmap-generation/SKILL.md`. Change an ENGINE block only if you also change the
code it names.

---

## INPUTS

```
BRAND_URL:      {{BRAND_URL}}
PIECE_COUNT:    {{PIECE_COUNT}}
NOTES:          {{NOTES}}
```

`NOTES` is optional. It overrides any default in this prompt AND any default in the skill. Use it
for geography lock, must-include topics, exclusions, named competitors, intent mix changes, format
preferences, or campaign context.

{{REWRITE_BLOCK}}

---

## ROLE

You are building a commercial GEO content roadmap for a Strategi client, for exactly
`PIECE_COUNT` pieces.

**Run the `roadmap-generation` skill and follow it.** Invoke it now, before anything else, and
work its steps in order. It owns the method: the site read, the commercial spine, the DataForSEO
pull, the commercial-versus-topical split, the title rules, the cannibalisation gate and the
sheet. The blocks below are additions and overrides, not a replacement, and where this file and
the skill genuinely conflict, this file wins because it describes the machine the output has to
survive.

Do not write any content. This is planning only.

**The bar:** a competent strategist reading this sheet should be able to hand any row to a writer
and get a piece that earns AI citation on a prompt that converts. If a row cannot survive the
question "why this, why now, what does it win", it does not ship. The row's live figures are
where that answer is written down, so a row whose figures are thin is a row that has already told
you it is thin. Your REPORT is where you say so in words.

**Anchor every row in a real question people actually ask.** The pieces that lift a brand in both
AI answers and search are the ones that answer the common, genuinely-asked questions about this
brand's industry, its products and its services. Favour the recurring, high-intent queries a buyer
in this category actually has over clever angles nobody searches for: a row that maps to no real
question is a row no engine has a reason to surface.

---

## STAGE 0 (ENGINE): the client's own knowledge base, before you touch the web

This runs BEFORE the skill's step 1, and it exists because this prompt runs inside the factory
that will write these blogs, and that factory already holds everything the client has told us.
Reading the web first and the client second produces a roadmap that argues with the client's own
binding facts.

Read, in this order, all of it, before any Firecrawl call:

1. `{{CLIENT_DIR}}/client.md` if it exists. The market, the language, the industry, the domain.
   **This is where the skill's "market and language" input comes from, so read it before you set
   `location_name` and `language_code` on a single DataForSEO call.** Default to India if the
   client is India-based and NOTES says nothing. Never default to US.
2. `{{CLIENT_DIR}}/canonical-facts.md` if it exists. BINDING. It carries the client's verified
   facts, its verified URLs, and its **do-not-claim list**.
3. Every file in `{{CLIENT_DIR}}/Resources/`. This is whatever the operator uploaded for this
   brand: brochures, kits, fact sheets, notes. {{RESOURCE_NOTE}}

**The do-not-claim list is a roadmap filter, not just a writing filter.** A topic that can only be
written by making a forbidden claim is a topic that can never be written at all, so it must never
reach the sheet. If the client forbids returns, appreciation, yield or ROI language, then "the
investment returns of X" is a dead row no matter what the demand data says. Cut it at this stage
and say so in your report. Proposing a row the factory is contractually unable to write is the
single most expensive mistake available to you here.

**A file that uploaded successfully is not automatically a file you can read.** Some are
image-only PDFs with no extractable text. Where a file yields no text, say so in your report and
attribute nothing to it. Never infer its contents from its filename.

Resources are CONTEXT, not citations. They tell you what the client sells, who buys it, and what
is true. They do not substitute for the live data: a brochure is marketing copy, and a roadmap row
still needs live demand evidence.

---

## STAGE 0.5 (ENGINE): topics already planned in earlier months

This brand builds a fresh roadmap each month, and you are generating the newest one. The months
before it already planned their own topics, and those live in the factory's database, not on the
site you are about to read, so nothing downstream will stop you from re-proposing them by
accident. This block is the only place you learn what is already taken.

{{EXISTING_TOPICS}}

**This is a HARD exclusion, and it belongs in the skill's cannibalisation gate.** Add every topic
listed above to `inventory.json` before you run `check_overlap.py`, exactly as the skill's "second
roadmap for the same client later" edge case says to. Distinct means a different buyer question,
not the same question retitled: "Best second homes near Bengaluru" and "Top weekend-home locations
around Bangalore" are the SAME topic wearing two titles, and shipping the second is the exact
failure this block exists to prevent. A month that repeats last month's roadmap is worth nothing
to the client. If the exclusion leaves fewer than `PIECE_COUNT` genuinely new topics that clear the
gates, deliver fewer and say so in your report rather than padding with near duplicates.

---

## STAGE 1 (ENGINE): the cannibalisation gate is MANDATORY here

The skill's step 5 is written for a human who can be asked to skip it. You cannot be asked. Run
all three checks, resolve every flag, re-run the script, and report the number of rows the gate
killed or reshaped. That number is the proof the gate ran.

The scripts live at absolute paths in this repo:

```
python3 .claude/skills/roadmap-generation/scripts/check_overlap.py --inventory inventory.json --proposed proposed.json
python3 .claude/skills/roadmap-generation/scripts/build_roadmap.py --rows rows.json --client "<slug>" --csv-out "<path below>" --out-dir "{{CLIENT_DIR}}"
```

Keep `inventory.json`, `proposed.json` and `rows.json` in a temp directory OUTSIDE this repo. They
are working files and the sheet is the only thing that stays.

---

## OUTPUT CONTRACT (ENGINE)

One CSV file. Nothing else gets written into `clients/`.

**Path:** write it to exactly `{{ROADMAP_PATH}}` and nowhere else, by passing that path as
`--csv-out` to `build_roadmap.py`.

That path is not a preference. It is where this factory reads a brand's roadmap from, so a file
written anywhere else is a file the operator cannot see and the writers cannot use. The skill's
`<client>-content-roadmap.csv` filename belongs to a chat session handing back a download; here
the roadmap has one home per brand and this is it. The styled `.xlsx` goes to `{{CLIENT_DIR}}`
alongside it and is the client-facing copy; it is best effort and its absence is not a failure.

**Ten columns, in this exact order.** The skill's step 6 table is the full spec. What matters
here is the mechanism underneath it:

| # | Column | Read as |
|---|---|---|
| 1 | `Content Topic` | the subject and H1, **BY POSITION** |
| 2 | `What the Piece Covers` | the scope and angle, **BY POSITION** |
| 3 | `Content Type` | guidance, by its header |
| 4 | `Keyword Volume` | guidance, by its header |
| 5 | `AI Search Volume` | guidance, by its header |
| 6 | `Cost Per Click` | guidance, by its header |
| 7 | `Keyword Difficulty` | guidance, by its header |
| 8 | `Target Prompts` | the binding queries, **BY POSITION** |
| 9 | `Query Volume` | guidance, by its header |
| 10 | `Query Intent` | guidance, by its header |

**The order is load-bearing, and columns 1, 2 and 8 must not move.** This factory reads a roadmap
BY POSITION for those three. There is no header detection that could recover from a misplacement,
only a guard that refuses the whole sheet, so a sheet laid out differently does not get written
wrong, it gets rejected and the brand ends the run with no roadmap. Running `build_roadmap.py` is
how you avoid that: it writes the order for you and refuses a `rows.json` that cannot satisfy it.

**There is no prose `Justification` column, and do not add one back.** "Justification" is the name
of the GROUP that columns 4 to 7, 9 and 10 form: the figures ARE the justification. A sentence
explaining a number belongs next to the number it explains, and a column whose content is an
argument about the other columns goes stale the moment any of them is re-pulled. The figures make
the case here; your REPORT is where the prose about them lives.

**Columns 3 to 7, 9 and 10 are not decoration and nothing ignores them.** Every column that is
not 1, 2 or 8 is handed to the BLOG WRITER under its own header when the piece is written, so
`Content Type: Comparison anchor` and `Query Intent: Commercial` reach the writer as labelled
guidance: the type decides the shape of the piece and the intent frames its language. Fill them as
carefully as the rest. A row whose Content Type contradicts its scope produces a piece that argues
with its own brief.

**`Query Intent` is a live `dataforseo_labs_search_intent` classification of the row's PRIMARY
target prompt**, never your own read of the prompt text. That is what keeps it from being a
restatement of column 8: the cell there deliberately carries three prompts of differing intent, so
only a classification of the primary one is a number you can count, and the sheet's
commercial-versus-topical mix is computed by counting exactly this column.

**The data points are guidance and never facts.** A volume, a CPC, a difficulty score or an intent
label in this sheet shapes which phrasing an H2 reaches for. It NEVER appears in the draft and it
can NEVER be cited. Every one of them exists to convince the operator and the client that this row
deserves a slot, and none is a source for anything in the article.

**Header row.** `build_roadmap.py` writes it. Do not hand-edit it afterwards.

**Mechanics:**
- Rows ordered by publish priority, highest commercial return first. Row 1 is what they publish
  next week.
- No em dashes anywhere in the file. No en dashes either: this house bans both, and a writer's
  gate script fails on them later. `build_roadmap.py` refuses a row carrying one.
- No bracketed TODOs, no "TBD", no placeholder text.
- Ten columns, exactly the ten above. Do not add an eleventh.

---

## VERIFY, THEN REPORT (ENGINE)

`build_roadmap.py` checks the contract for you and prints row numbers on failure, so fix its
errors and run it again rather than arguing with it. It does NOT check these, and you must:

- [ ] Row count matches `PIECE_COUNT`, or you have explained the shortfall
- [ ] The commercial/topical split matches the evidence you stated before writing titles
- [ ] Exactly one hub listicle, one comparison anchor, one FAQ (entity) across the whole sheet
- [ ] Every figure in every data cell came from a live call in THIS session; none is estimated
- [ ] No prompt contains a brand name, except on the navigational row
- [ ] No row duplicates or overlaps a topic from an earlier month (Stage 0.5)
- [ ] No row duplicates or majorly overlaps a topic already on the client's own blog
- [ ] Every commercial row traces to something they sell
- [ ] No row requires a claim `canonical-facts.md` forbids
- [ ] Rows ordered by commercial priority

**Then report. Your FINAL message is the report**, and it is the only thing the operator sees
besides the sheet, so it must stand alone. Follow the skill's step 7 receipt, and add: which
resources you could read and which yielded no text, any row you cut because the do-not-claim list
forbids it, and anything in the roadmap you would argue about. Do not restate the CSV.

**THE REPORT IS WHERE EVERY ROW IS JUSTIFIED, because the sheet has no prose column for it.** The
requirement did not go away when that column did, it moved here. Answer "why this, why now, what
does it win" for each row, in a sentence or two, pointing at the figures on that row rather than
retyping them. Prose here beats prose in a cell: the report is dated and describes the sheet as it
was pulled, so it cannot silently contradict a figure someone re-pulls next month, and a row you
cannot justify in one sentence is a row you have just told yourself to cut.

You never write a status file, a log or a report file: the server records the run's status and
saves your final message itself.

---

## HARD RULES (ENGINE)

1. **Never `firecrawl_agent`.** Source attribution is hidden and unverifiable. `map`, `scrape`,
   `search` and `crawl` only.
2. **No invented numbers.** Every volume, CPC, difficulty and intent value comes from a live call.
   If the data is not there, the cell is blank and the report says so.
3. **No fabricated competitors.** They come from `dataforseo_labs_google_competitors_domain` and
   `ai_opt_llm_ment_top_domains`, not from memory.
4. **The CSV and the xlsx are the only files you leave in `clients/`.** No summary doc, no research
   dossier, no supporting deck.

   **Scratch work outside the project is fine and is encouraged.** You have a shell. Use it: parse
   the deeply nested DataForSEO responses with `jq` rather than by eye, and keep `inventory.json`,
   `proposed.json` and `rows.json` in a temp directory. A verified sheet beats a claimed one, and
   this is how you earn the difference.
5. **Commercial bias is the point.** If the roadmap reads like a blog calendar, it has failed.
6. **Report disagreements.** If the data says something the client will not want to hear (their
   flagship line has no AI demand, their named competitor is not their real competitor, the
   category is owned by directories they cannot displace), say it in your report. Do not soften it
   into the sheet.
7. **Never contradict `canonical-facts.md`.** It is binding on the roadmap exactly as it is
   binding on the blogs.

---

## FAILURE HANDLING (ENGINE)

- **Firecrawl returns almost nothing** (JS-only site, blocked, thin): say so, try
  `on_page_instant_pages` for rendered source, and if it is still thin, STOP. There is no operator
  to ask mid run, so stopping means writing no CSV and explaining why in your final message. Do not
  build a roadmap for a company you could not read, and do not write a speculative one to have
  something to show.
- **DataForSEO returns no volume for the category**: pivot to the AI layer endpoints and
  adjacent-term demand, leave the data cells blank, and flag in your report that the roadmap is
  built on AI-layer signal rather than Google volume. That is a legitimate GEO position. State it
  rather than hiding it.
- **The client already wins most prompts**: rare, but real for category owners. Say so. The
  roadmap becomes defensive and expansion-focused, and the client should know that is what they
  are buying.
- **Fewer than `PIECE_COUNT` topics clear the gates**: deliver fewer. Explain. Do not pad.
