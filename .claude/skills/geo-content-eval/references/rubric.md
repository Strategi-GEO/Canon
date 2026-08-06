# GEO Content Eval Rubric

The full scoring reference. Read this every time the skill runs.

Structure: 8 hard gates (binary, auto-fail) and 12 graded dimensions (0 to 3, weighted, normalised to 100).

Scoring meaning for the 0 to 3 scale: 0 is absent or broken, 1 is present but weak, 2 is solid and meets the house standard, 3 is exemplary.

---

## Hard gates

Any single gate failure rejects the piece regardless of graded score. If the client KB or brief is missing, mark the affected gate UNVERIFIED rather than passing it.

| ID | Gate | Pass condition |
|----|------|----------------|
| G1 | Em dashes | Zero em dash or en dash characters anywhere in the body |
| G2 | Banned AI phrases | None of the ban-list phrases below appear |
| G3 | Source attribution integrity | No claim attributed to unnamed "studies," "experts," or "research." Every statistic has a named source. No invented or false-precision numbers |
| G4 | Proper noun verification | Every person, firm name, registration number, project name, and partner name matches the client KB exactly. No hallucinated or transposed entities. UNVERIFIED if no KB |
| G5 | Internal consistency | No two statements contradict each other on a number, date, name, or fact |
| G6 | Source fidelity | No claim contradicts the source it cites. No source overstated to manufacture agreement with the client's positioning |
| G7 | Client alignment | Nothing contradicts the client's positioning, product, or prohibited-framing rules. UNVERIFIED if no brief |
| G8 | Unverified credential claims | No membership, certification, ranking, award, or "best / largest / only / first" claim stated as fact unless verifiable and confirmed in the KB. UNVERIFIED if no KB |
| G9 | Competitor silence | Applies ONLY where the client's `gates.json` sets `"competitor_policy": "never_name"`; mark it N/A and pass otherwise. Where it applies: no rival company, developer, project, brand, platform, agency, or operator named ANYWHERE, including tables, FAQ answers, and the Sources list. No unnamed competitor framing either: "other developers", "most vendors", "unlike other projects", "compared with the competition", "industry peers", "rivals". Comparisons are between OPTIONS (asset type, location, price band, ownership model, buyer situation), never between COMPANIES |

### Banned phrase list for G2

"in today's digital landscape," "leveraging cutting-edge," "robust solution," "game-changer," "unlock potential," "seamless integration," "transformative," "revolutionary," "paradigm shift," "synergy," "best-in-class," "world-class," "next-generation," "at the forefront of," "cutting-edge," "bleeding-edge."

---

## Graded dimensions

Twelve dimensions in four buckets. Score each 0 to 3, multiply by weight, sum, normalise to 100.

### Bucket A: Extractability

**A1. Answer-first opening** (weight 3)
The first 100 to 150 words must contain a standalone citeable answer to the core question, primary keyword in the first two sentences, no preamble.
- 0: preamble or no direct answer in the opening
- 1: answer present but buried below setup, or keyword absent
- 2: direct answer in the first paragraph, keyword placed naturally
- 3: opening is liftable verbatim as a complete AI answer with a sourced supporting fact

**A2. Answer-shaped headings** (weight 2)
H2 and H3 read as questions or claims a user would type, not labels. Banned labels: "Overview," "Introduction," "Benefits," "Conclusion," "Key Points."
- 0: generic labels throughout
- 1: mixed, some labels remain
- 2: all headings answer-shaped, loosely mapped to intent
- 3: every heading maps to a distinct buyer-intent prompt with no overlap

**A3. Section self-containment** (weight 3)
Each section answers its heading completely on its own. Pick any three sentences at random: each should make sense and carry a verifiable claim with no surrounding context.
- 0: sections depend on prior context to make sense
- 1: some sections standalone, others not
- 2: every section independently citeable
- 3: every section standalone, plus 3 or more sentences liftable verbatim into an AI answer

**A4. FAQ block quality** (weight 2)
5 to 10 Q&A pairs. Each question phrased as a real user query. Each answer opens with a one-sentence direct answer, then elaborates, 75 to 300 words.
- 0: no FAQ block, or fewer than 5 pairs
- 1: FAQ present but answers do not lead with a direct answer
- 2: 5 to 10 pairs, each answer leads direct then elaborates
- 3: above, plus questions are verbatim buyer-intent prompts and answers are schema-ready

**A5. Structured data use** (weight 1)
Lists and tables used for processes and comparisons. Every list item developed to 2 to 4 sentences, never a bare phrase.
- 0: walls of text, or listicle-thin bullets
- 1: lists present but under-developed
- 2: lists and tables used where they aid extraction, items developed
- 3: above, plus a comparison table an AI engine can extract row by row

### Bucket B: Evidence

**B1. Factual density** (weight 2)
One sourced statistic or specific verifiable claim every 150 to 200 words. Every paragraph carries at least one verifiable claim.
- 0: padding paragraphs, vague generalities
- 1: density below cadence, some empty paragraphs
- 2: cadence met, every paragraph carries a claim
- 3: cadence met with every figure carrying figure, source, and date

**B2. Third-party citation strength** (weight 3)
The ratio of externally verifiable citations to self-referential ones. Self-citation is fine for firm-specific facts (registration number, transaction count) but not for market, cycle, or industry claims.
- 0: every citation is self-referential, no external source
- 1: one or two external anchors, market claims still self-cited
- 2: market and industry claims carry named third-party sources, self-citation limited to firm facts
- 3: above, with tier-1 sources (government, peer-reviewed, named industry reports) and dates throughout

**B3. Local evidence** (weight 2)
Where the topic warrants it, data specific to the client's market or micro-market rather than global proxies.
- 0: no local data where the topic clearly needs it
- 1: generic global stats used as a stand-in
- 2: market-specific or city-specific data present and sourced
- 3: local data granular to the micro-market or segment in the brief

### Bucket C: Entity and voice

**C1. Entity explicitness** (weight 2)
Every company, person, product, and framework named explicitly, no "the company" or "this approach." Key terms defined with standalone definitional sentences on first use.

**Where the client configures a first-person-plural register, "we" for the client is CORRECT and is not an entity failure.** Do not score such a draft down for using it. What you score is ANCHORING: whether each independently extractable block (the opening and TL;DR, each H2 section, each FAQ pair, each table, each quotable) names the entity in full somewhere inside ITSELF. A pronoun carries no entity, so a section that says only "we" is exactly the failure this dimension exists to catch. A section that says "we" three times after naming the client in full in its first sentence is the register working as specified.
- 0: vague references, terms undefined, or blocks that reference the client only by pronoun
- 1: inconsistent naming, some definitions missing, or some extractable blocks unanchored
- 2: every extractable block anchored by the full entity name, key terms defined
- 3: above, with each definition independently extractable as a quotable sentence

**C2. Voice** (weight 2)
Plain, direct, knowledgeable. No corporate or AI-generic register. Varied sentence length. Active voice. Zero hedging.
- 0: corporate-blog or AI-generic register throughout
- 1: readable but formulaic rhythm or frequent hedging
- 2: sounds like a knowledgeable person, varied, active
- 3: above, and the generic-brand test passes cleanly (could not have been written about any other firm)

**C4. Voice register** (weight 2)
The register is whatever `clients/<slug>/gates.json` configures, and this dimension scores how consistently the draft holds it. THE HOUSE DEFAULT IS `second_person` AND `first_person_plural` TOGETHER, and it applies to every client whose `gates.json` carries no `voice` key at all: the reader is addressed as "you", the client speaks as "we", "us", "our", and "we" means the client and never the reader, the industry, or people in general. A client opts OUT by writing the key explicitly, so `"voice": {}` is neutral third person and this dimension scores that instead, and a half-set block scores only the half it sets. An ABSENT key is the house register and never neutral third person: reading it as neutral would grade a draft against a standard `gates.py` is simultaneously failing it for missing, which no rewrite can satisfy.
- 0: the configured register is absent, or "we" is used generically ("we all want a place to escape")
- 1: register applied unevenly, the piece slips between "you" and "buyers", or between "we" and the client narrating itself by name
- 2: the configured register held consistently across body, table, and FAQ
- 3: above, and the register earns its keep: the answers read as a person answering the question asked, with every extractable block still anchored by the full entity name

**C3. Concision** (weight 1)
No repetition beyond useful entity reinforcement. A fact stated once with weight beats the same fact stated four times.
- 0: heavy repetition, same facts and framing recycled
- 1: noticeable repetition, criteria or numbers restated needlessly
- 2: tight, entity facts reinforced only where it aids the knowledge graph
- 3: every paragraph earns its place, nothing cuttable

### Bucket D: Brief fit

**D1. Brief and industry adherence** (weight 2)
Covers the target topic and prompt fully, addresses the right audience, applies the industry-specific signals named in the client's industry reference, respects prohibited-framing rules. UNVERIFIED if no brief.
- 0: off-brief, wrong audience, or industry signals absent
- 1: on-topic but thin on industry signals or audience fit
- 2: on-brief, right audience, industry signals applied
- 3: above, and the piece would need no structural change from the brief owner

**D2. Topic discipline** (weight 3)
Every section serves the piece's own subject and traces to a target prompt. No adjacent-subject excursions, no category-level runway beyond two sentences, no padding that widened the topic to reach the word band. Test it by reading each paragraph and asking whether a reader who typed the primary target prompt needs it.
- 0: whole sections about an adjacent subject, or the piece never settles on its topic
- 1: on topic overall, with a drifting section, a long runway, or paragraphs that serve no prompt
- 2: every section traces to a target prompt, no drift, background kept short
- 3: above, and every paragraph earns its place against the primary prompt with nothing cuttable

---

## Scoring math

```
weighted_total = sum(dimension_score * dimension_weight)   # weights total 30, max 90
normalised     = round(weighted_total / 90 * 100)
```

**THERE IS ONE NUMBER, IT IS 90, AND THE BAND IS BINARY.** The first score at or above 90 ends the revise loop at once and the piece ships, and it is what a draft is written to reach. Below 90 the piece does not ship. There is no middle band and no second threshold, and no other number is compared against a score anywhere. 90 is exactly attainable: 81 of the 90 available weighted points. **95 is NOT an attainable normalised value**, so do not pretend a draft can score it: 85 of 90 rounds to 94 and 86 of 90 rounds to 96, which skips 95 outright. **85 is not attainable either**, since 76 of 90 rounds to 84 and 77 of 90 rounds to 86.

The bar used to be a single 95, set by holding the percentage constant when C4 and D2 raised the weight total from 25 to 30, and holding the percentage constant is exactly what broke it. 95 was attainable before that change: `tests/concurrency-proof.md` records six topics ending done at 95, 95, 96, 97, 98 and 98 under the rubric as it stood then, when the weights totalled 25 and the maximum was 75. So the defect was not an ambitious bar, it was a percentage carried unchanged through a weight-total change. 95% of 30 weight units scored in integers means at most 4 weighted points lost across 14 dimensions, near-exemplary on everything, and the normalisation skips 95 anyway. A measured 12-blog run afterwards produced a score for only five of its twelve topics, with trajectories of 72 to 89 to 88, 84 to 84 to 87, 79 to 80, 82, and 73; the other seven died in research on iteration 1 and were never scored at all. Zero of the twelve ever reached 95, and the two that got furthest were inside their fourth iteration when the run died, so the bar was unreachable for every blog that lived long enough to be measured against it. Under a bar of 90 the best of them, 89, is one point short and does not ship on its own: it is below bar, it resolves failed, and it reaches a client only if the operator promotes it.

| Band | Normalised score | Action |
|------|------------------|--------|
| Ship | 90 to 100 | Ship. The first score at or above 90 ends the loop at once, and it is final and terminal WHEN no current question is on disk |
| Reject | Below 90 | Revise the flagged areas, then re-eval on a fresh context. A run that ends here resolves failed |
| Reject | Any hard gate fail | Reject regardless of graded score |

First-score-is-final is narrowed by the questions, not deleted by them. A current, answerable question on disk holds the blog at ANY score, and the ONE licensed re-eval is the single answer-driven revise the operator's answers trigger. Every other confirmatory re-eval stays forbidden: "the draft changed", "eval.md and blog.md are inconsistent", "the run was stopped and restarted", "let me confirm". Those re-roll a stateless auditor whose score moves several points on an identical draft, and they can strand a blog that had already passed.

A held blog's score is still its verdict. A 96 with questions has ALREADY earned SHIP; it is waiting on a human, not on a better number. So never mark a draft down because it is held, and never sweeten one to get it out.

---

## Failure-area routing

Each gate and dimension belongs to one fix area, one of exactly four: Sourcing, Structure, Draft, Mechanics. Every fix-list item in `eval.md` must carry its Area, because the Area is what the lead routes on. Sourcing goes back to the researcher (Agent R) as a bounded top-up; Structure, Draft, and Mechanics go back to the writer (Agent W).

| Area | Routes to | Gates and dimensions |
|------|-----------|----------------------|
| Sourcing | Agent R (research top-up) | G3, G4, G8, B2, B3 |
| Structure | Agent W (revise) | A2, A3 (plan), A4 (plan), D1, D2 (plan) |
| Draft | Agent W (revise) | A1, A3 (execution), B1, C1, C2, C4, D1, D2 (execution) |
| Mechanics | Agent W (revise) | G1, G2, G5, G9, A5, C3 |

G9, C4 and D2 route to the writer and NEVER to Sourcing. A competitor mention, a voice slip, and
a drifting section are all fixed by rewriting what is already on the page, so none of them needs
a new source, none justifies a Sourcing question, and none ends the loop.
