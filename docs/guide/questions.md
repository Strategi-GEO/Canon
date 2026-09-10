# Discovery questions

Canon builds a brand's fact base from two sources: the documents you upload, and the brand's live website. Both have the same blind spot. They record what the brand has already **written down**, and neither reaches what it simply **knows**: the price band it never published, the capacity it never listed, the certification that predates the site.

**Discovery questions close that gap by asking.** Canon reads the client's website for what it does *not* say, writes a set of questions, and you send them to the client's portal. Their answers land in the fact base every article for that brand is written against.

You reach it inside a brand, from the left nav, under **Questions**.

## Why this is worth a form

A fact that is real, held by the client, and unrecorded is **invisible but forbidden**. The researcher finds it legitimately, the writer attributes it honestly, and the evaluator fails it, because nothing in the fact base holds it. That discovery then happens once per blog, at the cost of a full research pass and several grading rounds.

One audit in this repository measured it on a real brand: **37 of 58** knowledge base sections never reached the fact base, and **6 of 10** planned topics were exposed to the gap. One article spent a research pass plus three grading rounds rediscovering what a person could have answered in ten seconds.

!!! info "These questions hold nothing"
    This is **not** the evaluator's question form. That one holds a blog at any score, is capped at five, and its answers are owed a rerun. These hold nothing at all: no article waits on them, no status turns on them, and a brand that never answers a single one generates exactly as it does today.

    That difference is why a form of twenty to fifty is reasonable here and would be indefensible there.

## Generating a set

Press **Generate questions**. One research session reads:

- the brand's existing `canonical-facts.md`, especially §9, which lists claims a previous session found and could not confirm
- anything the client has already answered, so nothing is asked twice
- every file in Resources
- the live site, mapped and scraped, read for what is **missing** rather than what is there

!!! danger "This press costs real money and real quota"
    It is one research session against a live site, and it spends your Claude subscription and Firecrawl credits, like every other Generate button in Canon.

It writes **20 to 50 questions, scaled to what the brand actually needs**. A brand with a thin site and no fact base earns the upper end. A brand with a detailed site, full resources and a mature fact base earns the lower end, and padding to reach a number is treated as a failure.

Questions come in two sets:

| Set | What it is |
| --- | --- |
| **General** | What any brand in that industry should be able to answer: pricing structure, capacity, credentials, service area, what they will not do. General in subject, never in wording. |
| **Personalised** | Written against **this** brand's own site, naming its own products, pages and claims. If the homepage says "award winning", it asks which award and which year. |

**Read the report when it lands.** It names the largest gaps it found and anything the site states vaguely that a number would fix. It is often worth more than the questions.

## Reviewing before you send

Questions land as **drafts**. The client cannot see them, and not merely because they are unlabelled: the database function the portal reads filters unsent questions out entirely.

On the bench you can:

- **Edit** the wording of any question
- **Delete** the weak ones
- **Generate more**, which adds a fresh set without re-asking anything already on the form

Then press **Send to client**. That releases the whole set at once, because a client answering a form that grows underneath them cannot tell what is left.

!!! warning "A model wrote these, so read them first"
    Sending is a deliberate press for the same reason sending a blog is. Nothing in Canon puts model-written text in front of a client without a person seeing it.

## What the client sees

A **Questions** tab in their portal, grouped by theme, with a count answered against the total.

The form is deliberately gentle:

- **Nothing is required.** There is no submit button and no completeness check. Six answers make the fact base six facts better, and that is a real outcome rather than a partial failure.
- **It saves as they type.** A form this long is answered across sittings, probably by more than one person, so nothing is lost to a closed tab.
- **A blank answer clears it.** That is how a client withdraws something they are no longer sure of, and a withdrawn uncertain answer is better for the fact base than one left standing.

Their answers appear on your bench as they arrive.

## What happens to the answers

They are written into `clients/<slug>/client-answers.md`, which every fact base build reads before it reads anything else. Answers rank **with** `canonical-facts.md` and above any internal document.

Three limits hold, and they are absolute:

- **An answer is never a citation.** It can tell a writer that a figure is confirmed or a claim is wrong. A claim that needs a source still needs a fetched one.
- **An unanswered question is not a fact.** Silence means nobody answered. It never means no.
- **An answer that contradicts the live site is a conflict**, recorded with both sides and a resolution, not quietly resolved in the answer's favour.

Nothing rebuilds automatically. To fold the answers into the fact base permanently, delete the fact base on the brand's Overview and let the next run draft a fresh one, which reads the answers as it goes.

## Once a question is answered

It **freezes**. You cannot edit its wording or delete it.

The reason is the one that locks an approved article: the client answered *those words*. Rewriting the question afterwards would make the record assert a pairing that never happened, and deleting it would discard something a person actually wrote.

## Who can do what

Anyone signed in can read the bench. Generating, editing, deleting and sending are admin only, and the engine refuses them from a non-admin account.

On the client's side, an `admin` or `commenter` account can answer; a `viewer` cannot, and the database refuses the write.
