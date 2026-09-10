# Discovery questions prompt

You are writing the question set a Strategi operator will send to **{{CLIENT_NAME}}**, so that the
brand's fact base carries what its website never said out loud.

## INPUTS

- **Brand**: {{CLIENT_NAME}} (`{{CLIENT_SLUG}}`)
- **Industry**: {{INDUSTRY}}
- **Site**: {{BRAND_URL}}
- **Client directory**: `{{CLIENT_DIR}}`
- **Uploaded resources**: {{RESOURCE_NOTE}}
- **Output path**: `{{OUTPUT_PATH}}`

---

## ROLE

`canonical-facts.md` is built from two sources with one shared blind spot: the brand's uploaded
documents and its live site. Both record what the brand has already **written down**. Neither
reaches what it simply **knows**: the price band it never published, the capacity it never listed,
the certification that predates the website, the reason a buyer picks it over the place next door.

Every one of those gaps costs the same way later. A fact that is real, held by the client, and
unrecorded is invisible-but-forbidden: the researcher finds it legitimately, the writer attributes
it honestly, and the evaluator fails it, because nothing in the fact base holds it. That discovery
then happens once per blog, at the price of a research pass and several grading rounds.

Your job is to make that discovery happen **once**, cheaply, by asking the person who already knows.

---

## STAGE 1: what is already established

Read these before you write a single question. A question whose answer is already on file wastes
the client's attention, and this form has exactly as much of that as it earns.

1. `{{CLIENT_DIR}}/client.md`, if it exists. Market, language, industry, domain.
2. `{{CLIENT_DIR}}/canonical-facts.md`, if it exists.

   **READ §7 AND §9 FIRST, AND SWEEP BOTH ROW BY ROW.** They are the two sections that already
   know what a person has to settle, and between them they are the highest-yield input you have.
   Nothing else in this prompt beats reading them properly.

   - **§7, "Known conflicts and their resolution".** Every row marked UNRESOLVED, or carrying the
     words "confirm with the client", is a question you MUST ask. These are not gaps the engine
     might close later: the fact base has already tried, failed, and written down that a human is
     needed. A missed §7 row is the worst failure this form has, because it leaves a caveat that
     every future blog for this brand inherits forever.
   - **§9, "UNVERIFIED: claims found but not confirmed".** Every row a person could settle in ten
     seconds, phrased so they can answer without opening anything.

   **Do not trust these section NUMBERS over the headings.** Find the section whose heading names
   conflicts or unverified claims and read that, whatever number it carries. An earlier version of
   this prompt named §9 alone and never mentioned §7, and a real run missed a recorded address
   conflict as a direct result: the section it needed was the one nobody had pointed at.

   Then read §1, §2, §5 and §6, so you do not ask what is already recorded, and so you do not ask
   about a claim §6.1 forbids outright.
3. `{{CLIENT_DIR}}/client-answers.md`. **This is what the brand has ALREADY answered**, from an
   earlier round of this same form. Never ask any of it again. A client who is asked a question
   they answered last month learns that answering changes nothing, and stops. Where an answer
   opens an obvious follow-up the earlier round did not think to ask, that follow-up is one of the
   best questions you can write.
4. `{{CLIENT_DIR}}/description.md`, if it exists.
4. Every file in `{{CLIENT_DIR}}/Resources/`. Use `Bash` with `pdftotext` on PDFs. A file that
   yields no extractable text is a finding, not a fact: note it and move on.

**Where no fact base exists yet, this stage is shorter, not skipped.** The site and the resources
are still the record of what is already known, and a question answered on the homepage is still a
wasted question.

---

## STAGE 2: the live site, read for what is MISSING

Fetch the site exactly as the fact base build does, and read it for the opposite purpose.

1. **`firecrawl_map`** on {{BRAND_URL}}. This is the inventory. Read it for what sections exist and,
   more importantly, **which ones do not**. No pricing page is a finding. No about page is a
   finding. No location or capacity page is a finding.
2. **`firecrawl_scrape`** the pages that carry meaning: homepage, about, products or services,
   pricing, FAQ, contact, locations, press. Use `formats: ['markdown']`, `onlyMainContent: true`,
   `waitFor: 6000`. Read the whole page.
3. As you read, keep two lists:
   - **Stated but vague.** "Competitive pricing", "years of experience", "trusted by many". Each of
     these is a real claim with the number filed off, and the number is what a blog needs.
   - **Absent entirely.** What a brand in {{INDUSTRY}} would normally publish and this one has not.

**Never use `firecrawl_agent`.** You need to know which page each gap came from.

---

## STAGE 3: write the questions

Two sets. Aim for **12 to 25 questions in total, scaled to what this brand actually needs**, split
roughly one third general and two thirds personalised. A brand with a thin site and no fact base
earns the upper end. A brand with a detailed site, full resources and a mature `canonical-facts.md`
earns the lower end, and padding to reach a number is a failure, not thoroughness.

**THE CEILING CAME DOWN FROM 50 AND THAT IS A QUALITY INSTRUCTION, NOT A BUDGET.** A set of 38 was
generated for a real brand and the operator's job became deleting most of it, which is the wrong
person doing the editing: you have read the site and the fact base, and they have not. A form of 38
also does not get answered, it gets closed. Every §7 and §9 row that needs a human still goes in,
however many that is; what comes out is the general question that was merely nice to know.

**Rank before you cut.** Order your output so the questions that unblock the most go first: §7
UNRESOLVED rows, then §9 unverified claims, then gaps you found on the site, then the general set.
The operator reads top down and stops when it stops being worth asking.

### The general set

What any brand in {{INDUSTRY}} should be able to answer, and what a writer needs before it can write
anything specific. Pricing structure, capacity or scale, credentials and certifications, service
area, the buyer's real alternatives, what the brand will not do.

These are general in SUBJECT, never in wording. "Tell us about your pricing" is worthless.
"What is the lowest price a customer can actually pay to get started, and what does that include?"
is answerable in one line.

### The personalised set

Written against **this** brand's own site. Name its own products, pages, claims and wording. If the
homepage says "award-winning", ask which award and which year. If a page lists four locations, ask
which is the flagship and whether any has different hours. If §9 carries an unconfirmed number, put
that number in the question and ask whether it is right.

A reader must be able to tell, from the question alone, that somebody actually read their website.

---

## STAGE 4: the standard every question passes

Before a question goes in the file, it clears all six:

1. **Answerable in about ten seconds**, from memory, without opening a document.
2. **One fact per question.** Two questions bolted together get half an answer.
3. **The answer changes what a blog can say.** If neither a writer nor an evaluator would ever use
   it, cut it. This is not a survey and not a brand-strategy questionnaire.
4. **Not already answered** in the fact base, the resources or the site. You read all three.
5. **Not something a machine could fetch.** If Firecrawl can find it, Firecrawl should, and asking
   a person for it spends their goodwill on work the engine is meant to do.
6. **Specific enough to be uncomfortable to answer vaguely.** "Do you have good reviews?" invites
   "yes". "What is your current Google rating, and roughly how many reviews is it across?" does not.
7. **Shaped like the fact a blog has to state**, which is the standard this form kept missing.
   A blog does not cite a topic, it cites a NUMBER, a RANGE, a DATE, a YES or a NO, and usually
   per location, per product or per tier. So ask for that shape directly.

   A real failure, worth copying the shape of rather than the subject: this form asked a venue
   "What is the actual area of the Whitefield property?" and got a topic. Weeks later an evaluator
   BLOCKED a finished article needing "can this venue host a private party of 50 to 100 guests?"
   Same room, wrong question, and the blog stopped. Before you write a question about a capacity,
   a price, a size or a timeline, ask yourself what sentence a writer would build from the answer.
   If the answer would still leave them writing "varies" or "large", the question is not finished.

   - Capacity: seated AND standing, per space, not "how big is it".
   - Price: the actual lowest number a customer pays and what it includes, not "what is pricing
     like".
   - Range: the band, both ends, in the unit the client uses.
   - Per unit: where a brand has several outlets, products or tiers, ask which ones, by name. A
     question answered "some of them" is a question that blocks an article later.

**Ask nothing you cannot use.** No mission statements, no brand values, no "what makes you unique"
in those words, no questions about tone or target audience. Those produce paragraphs that no
evaluator can check and no writer can cite. Ask for facts: numbers, names, dates, yes or no.

**Never ask for something `canonical-facts.md` §6.1 prohibits.** A question about a forbidden claim
invites the client to authorise a claim the fact base already refuses, which is the one way this
form could make the engine less safe rather than more.

**`why` is not decoration.** One sentence naming what the answer unblocks, in the client's terms:
"lets us state your pricing in a comparison table instead of saying it varies". It is the line that
tells a reader whether they are even the right person to answer, and on the evaluator's own form it
is the most useful thing on the screen.

---

## STAGE 5: write the file

Write **exactly one** JSON file to `{{OUTPUT_PATH}}`, and nothing else. No prose around it, no
markdown fences, no trailing commentary. The shape is fixed:

```json
{
  "general": [
    {
      "theme": "Pricing",
      "question": "What is the lowest price a customer can actually pay to get started, and what does that include?",
      "why": "Lets us publish a real entry price instead of writing that pricing varies, which no AI engine will cite."
    }
  ],
  "personalised": [
    {
      "theme": "Credentials",
      "question": "Your homepage says award winning. Which award, from whom, and in what year?",
      "why": "An unnamed award is an unsubstantiated superlative and the gates reject it. A named one with a year is citable."
    }
  ]
}
```

Rules for the file:

- `theme` is a short label, two words at most: Pricing, Capacity, Credentials, Locations,
  Differentiators, Process, Guarantees, People. Group related questions under the same theme so the
  client's form reads in sections rather than as a wall.
- `question` and `why` are plain sentences. **No em dashes and no en dashes anywhere.** The house
  bans both, and these strings are shown to a client.
- Never invent a fact inside a question. "Your site says X" must mean the site actually says X.
- Both arrays are required. An empty one is allowed only where you genuinely have nothing worth
  asking, and if you write an empty array, say why in your report.

---

## YOUR REPORT

Your FINAL message is the report, and it is the only thing the operator reads besides the file.
Keep it short and make it about the GAPS, not about your process:

- What you read: pages scraped, resources readable, whether a fact base already existed.
- The three or four largest gaps you found, in one line each.
- Anything the site states vaguely that a number would fix.
- Any question you wanted to ask and did not, and why.

Do not restate the questions. The operator is about to read them.
