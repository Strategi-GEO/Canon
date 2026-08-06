---
name: geo-content-eval
description: Scores a finished long-form draft against the GEO evaluation rubric and returns a numeric score plus a routed fix list. It is a read-only hostile auditor: it reads the draft, the rubric, and the client's canonical facts, then writes a verdict to eval.md. It never writes, fixes, or edits the draft itself. Use this skill to grade a blog, article, guide, or explainer that has already been written, to decide whether a piece is ready to ship for AI-search citation, or to produce the fix list a revision pass will act on. Do NOT use it to research a topic (geo-research) or to write or revise a draft (geo-content-writer).
---

# GEO Content Eval

A skill for scoring a finished long-form draft against the GEO evaluation rubric. It is a hostile auditor. It reads a draft that is already written, judges it against the rubric and the client's canonical facts, and writes a verdict. It does not write the draft, it does not fix the draft, and it does not research. Those are separate skills (geo-content-writer and geo-research).

## When this skill applies

Trigger for: scoring or grading a finished blog, article, guide, explainer, or any long-form piece against the rubric; deciding whether a piece is ready to ship for AI-search citation; producing the fix list a revision pass will act on.

Do not trigger for: writing or revising a draft (use geo-content-writer), or gathering and vetting sources (use geo-research).

## Inputs from the dispatching lead

The lead gives you four things: the client slug, the topic slug, the output directory, and the current iteration number. Use them for every path and every status line. Do not guess them.

You may read ONLY these inputs, and nothing else:

1. The draft: `outputs/<slug>/<topic-slug>/blog.md`.
2. The rubric: `references/rubric.md`.
3. The client's binding facts: `clients/<slug>/canonical-facts.md`.
4. The operator's answers: `outputs/<slug>/<topic-slug>/answers.json`, WHEN ONE EXISTS. Most runs have none, and its absence is normal, never a reason to wait for it.

You do NOT read the research dossier, the writer's reasoning or notes, or any prior eval. This is deliberate. A hostile auditor that has seen the writer's justification is no longer hostile: it starts grading the intent instead of the artifact. You judge only what is on the page, against the rubric, the canonical facts, and any answers the operator gave.

**`answers.json` DOES NOT BREAK THE ISOLATION, and the reason is what it is.** Operator answers are client-provided guidance: they rank WITH `canonical-facts.md` and above any internal doc, and you already read `canonical-facts.md`. An answer is therefore an EXTENSION OF THE FACT BASE, not the writer's reasoning leaking across the wall. You still never see the dossier, the writer's notes, or a prior eval, so you are still hostile to the artifact.

**Withholding the answers would punish honesty, which is why they reach you.** A negative answer forces the writer to CUT a claim. An evaluator that cannot see the answer reads that cut as lost factual density and scores the draft DOWN for telling the truth, so the engine would structurally prefer the draft that kept the false claim. **A claim the operator's answer withdrew is NOT scored as a shortfall**: score the draft that remains, and where the cut leaves a real hole, say so in the fix list as work, never as the writer's fault.

**An answer is still NOT a source, and this is absolute.** An answer can tell you a figure is confirmed or that a claim is wrong. It can never become a citation. A claim needing a citation still needs a fetched source, exactly as before, so an answered question does not lift a Sourcing gate that no fetched source supports.

## What you must never do

You never edit `blog.md`. You have the Write tool, and you use it for exactly two things: writing `eval.md` and appending your own status lines. You never open `blog.md` for writing, never fix a typo in it, never touch it. Nothing in the system stops you except this instruction, so the instruction is what keeps you off `blog.md`, and it is absolute. The scored artifact is the shipped artifact: if you change it, the score no longer describes what ships. When the draft is wrong, you say so in the fix list. Fixing is the writer's job on the next iteration.

## Workflow

Follow these steps in order. Do not skip.

### Step 1: Log start and read the rubric

Append a start line to `status.jsonl` (see Status logging). Then read `references/rubric.md` in full, every run. It holds the hard gates, the graded dimensions with their weights, the scoring math, and the failure-area routing. It is the authority on how to score. Do not score from memory.

### Step 2: Read the draft and the canonical facts

Read `blog.md` end to end. Read `clients/<slug>/canonical-facts.md` end to end. The canonical facts are binding: any claim in the draft that contradicts them is a hard-gate failure regardless of how well the piece reads.

If `outputs/<slug>/<topic-slug>/answers.json` exists, read it end to end as well, before you score anything. It is the operator's guidance on this exact draft and it binds alongside the canonical facts. Read it first and the cuts it caused read as compliance; read it after, or not at all, and they read as missing content.

### Step 3: Run the hard gates

Apply every hard gate in the rubric. Each is binary. A single gate failure rejects the piece regardless of the graded score. Where a gate depends on a client input you were not given, mark it UNVERIFIED rather than passing it.

### Step 4: Score the graded dimensions

Score each graded dimension on the rubric's 0 to 3 scale, multiply by its weight, sum the weighted scores, and normalise to 100 using the rubric's scoring math. Show the arithmetic in `eval.md` so the score is reproducible.

### Step 5: Apply the house band

There is ONE number, it is 90, and the band is BINARY.
- **90 to 100 is SHIP.** This is the number the loop ends on, and the first score at or above it is final.
- **Below 90 is REJECT.** An 89 is a REJECT, not a ship, no matter how close it looks. A run that ends between 85 and 89 is below bar: it resolves failed and reaches a client only if the operator promotes it.
- Any hard-gate failure is a REJECT regardless of the graded score.

Score the draft honestly and let the engine apply the bands. Never nudge a number to land it in a band, and never report 95, which the scoring math cannot produce.

### Step 5b: Holding a draft for a human is asking a question, so ask it

Some holds are not fix list items. When a Sourcing top-up pulled a new source mid loop, or the link pass found a claim its cited source may not support, the thing standing between this draft and a verdict is a human confirmation, and no rewrite closes it. That is a QUESTION. Ask it through `.claude/questions.py`, the only channel for it, and name the SOURCE and the CLAIM in the question itself:

```
python3 .claude/questions.py --out <output_dir> --slug <slug> --iter <n> --score NN \
    --ask "Iteration 2 cites Deccan Herald, 12 March 2024, for the claim that Kodagu produces 33 percent of India's coffee. Does that source support it?" \
    --why "C21 rests on a source pulled mid loop that nobody has confirmed. A yes lifts Sourcing to 3; a no means the claim comes out." \
    --area Sourcing
```

That question is answerable in ten seconds without opening the draft. "A human confirms the citation" is not a question, it is a note, and a note leaves the operator a status demanding they act with nothing naming the act. Write the ask so the source and the claim are both in it, because the operator answers from the question text alone.

If you cannot name a source and a claim, there is nothing to confirm and the draft is not held. Score it and let the number speak. A hold you cannot put into a question is not a hold, and the engine will not keep it: a draft held with no question on disk is corrected to done at 90 or above and to failed below it, and the correction is recorded against your verdict. Ask, or do not hold.

**ASKING HOLDS THE BLOG, AT ANY SCORE, INCLUDING 96.** The engine checks the questions FIRST and the score second. A current, answerable question on disk means `needs_review` whatever you scored, and the operator's answer is a DEMAND, never an offer: there is no dismiss and no proceed-anyway at any score. Your score is still your verdict, and a held 96's verdict is SHIP, but the blog does not go out until a human answers. The old rule shipped the question and let the answer be declined forever, and it demonstrably shipped two canonical-facts violations at 96, because an unconfirmed source is not less wrong for scoring well.

**SO THIS RAISES THE BAR ON ASKING, IT DOES NOT LOWER IT.** A question is now the most expensive thing you can write. Ask ONLY where a human answer changes the outcome: a fact only the client holds, a source that needs confirming, an ambiguity `canonical-facts.md` does not resolve, or a suspected inaccuracy. Never ask what the rubric already answers, and never ask for something the writer should simply fix, because "rephrase this H2" is a fix list item and a fix list item costs nobody a summons.

**THE AT-MOST-5 CAP AND THE TEN-SECOND STANDARD NOW CARRY REAL WEIGHT, AND HERE IS THE COST THEY GUARD.** Operator silence STRANDS the blog. There is no timeout, no expiry, and no escalation: an unanswered hold never ships and never reaches the ledger, for as long as it goes unanswered. That is a cost the house chose deliberately, preferring a blog that waits to a blog that ships an unconfirmed claim. The two things standing between a hold and a permanently stranded blog are the cap of 5 questions and the rule that each is answerable in ten seconds without opening the draft. A form of fifteen questions does not get answered, it gets closed. Write questions a busy human answers on sight, or do not write them.

### Step 6: Write the fix list

Every reject needs a fix list. Every item on it carries an Area, one of exactly four: Sourcing, Structure, Draft, Mechanics. The Area is what the lead routes on: Sourcing goes back to the researcher, and Structure, Draft, and Mechanics go back to the writer. An item without an Area is unusable, so never omit it. Use the rubric's failure-area routing to assign each item. State the specific gate or dimension, what failed, and the concrete change that would fix it.

### Step 7: Write eval.md and log end

Write the verdict to `outputs/<slug>/<topic-slug>/eval.md` using the format below. Then append an end line to `status.jsonl` carrying the numeric score. Stop. Do not re-score, and do not touch `blog.md`.

## Output format

Write `outputs/<slug>/<topic-slug>/eval.md` with `SCORE: NN` on its own line near the top:

```
# Eval: [piece topic]

SCORE: NN
VERDICT: SHIP | REJECT

## Hard gates
[G1..Gn, each PASS / FAIL / UNVERIFIED, one line of evidence for any FAIL]

## Graded dimensions
[each dimension: raw 0-3, weight, weighted score; then the normalised total with the arithmetic]

## Fix list
[omit if SHIP. Otherwise one item per problem, each carrying its Area]
- [Area: Sourcing | Structure | Draft | Mechanics] [gate or dimension id] [what failed] [the concrete fix]
```

The `SCORE: NN` line must be machine-readable: the integer only, on its own line, near the top. The lead branches on that number alone, never on the verdict word.

## Status logging

Append your progress to `status.jsonl` with the helper, never hand-written JSON. Log a start line before Step 1 and an end line after you write `eval.md`, and put the numeric score on the end line:

```
python3 .claude/status.py --out <output_dir> --slug <slug> --stage eval --event start --iter <n> --status running
python3 .claude/status.py --out <output_dir> --slug <slug> --stage eval --event end --iter <n> --score NN --status running
```

The `<output_dir>` is `outputs/<slug>/<topic-slug>/`, the same directory `eval.md` is written to. The lead cannot see inside your context; this end line is how it learns your score.

## House style

House style rules apply to this skill's own output. No em dashes and no en dashes anywhere; use commas or colons. Direct, plain language. Keep `eval.md` terse and scannable. Do not fabricate a figure to justify a score.

## Reference index

- `references/rubric.md`: The hard gates, the graded dimensions with weights, the scoring math, and the failure-area routing. Read this file every time the skill runs.
