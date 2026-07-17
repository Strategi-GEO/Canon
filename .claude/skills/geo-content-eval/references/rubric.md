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
Every company, person, product, and framework named explicitly every time, no "the company" or "this approach." Key terms defined with standalone definitional sentences on first use.
- 0: vague references, terms undefined
- 1: inconsistent naming, some definitions missing
- 2: explicit naming throughout, key terms defined
- 3: above, with each definition independently extractable as a quotable sentence

**C2. Voice** (weight 2)
Plain, direct, knowledgeable. No corporate or AI-generic register. Varied sentence length. Active voice. Zero hedging.
- 0: corporate-blog or AI-generic register throughout
- 1: readable but formulaic rhythm or frequent hedging
- 2: sounds like a knowledgeable person, varied, active
- 3: above, and the generic-brand test passes cleanly (could not have been written about any other firm)

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

---

## Scoring math

```
weighted_total = sum(dimension_score * dimension_weight)   # weights total 25, max 75
normalised     = round(weighted_total / 75 * 100)
```

The house band is binary. There is no middle band.

| Band | Normalised score | Action |
|------|------------------|--------|
| Ship | 95 to 100 | Ship. The first score at or above 95 is final and terminal WHEN no current question is on disk |
| Reject | Below 95 | Revise the flagged areas, then re-eval on a fresh context |
| Reject | Any hard gate fail | Reject regardless of graded score |

First-score-is-final is narrowed by the questions, not deleted by them. A current, answerable question on disk holds the blog at ANY score, and the ONE licensed re-eval is the single answer-driven revise the operator's answers trigger. Every other confirmatory re-eval stays forbidden: "the draft changed", "eval.md and blog.md are inconsistent", "the run was stopped and restarted", "let me confirm". Those re-roll a stateless auditor whose score moves several points on an identical draft, and they can strand a blog that had already passed.

A held blog's score is still its verdict. A 96 with questions has ALREADY earned SHIP; it is waiting on a human, not on a better number. So never mark a draft down because it is held, and never sweeten one to get it out.

---

## Failure-area routing

Each gate and dimension belongs to one fix area, one of exactly four: Sourcing, Structure, Draft, Mechanics. Every fix-list item in `eval.md` must carry its Area, because the Area is what the lead routes on. Sourcing goes back to the researcher (Agent R) as a bounded top-up; Structure, Draft, and Mechanics go back to the writer (Agent W).

| Area | Routes to | Gates and dimensions |
|------|-----------|----------------------|
| Sourcing | Agent R (research top-up) | G3, G4, G8, B2, B3 |
| Structure | Agent W (revise) | A2, A3 (plan), A4 (plan), D1 |
| Draft | Agent W (revise) | A1, A3 (execution), B1, C1, C2, D1 |
| Mechanics | Agent W (revise) | G1, G2, G5, A5, C3 |
