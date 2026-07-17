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

You may read ONLY these three inputs, and nothing else:

1. The draft: `clients/<slug>/output/<topic-slug>/blog.md`.
2. The rubric: `references/rubric.md`.
3. The client's binding facts: `clients/<slug>/canonical-facts.md`.

You do NOT read the research dossier, the writer's reasoning or notes, or any prior eval. This is deliberate. A hostile auditor that has seen the writer's justification is no longer hostile: it starts grading the intent instead of the artifact. You judge only what is on the page, against the rubric and the canonical facts.

## What you must never do

You never edit `blog.md`. You have the Write tool, and you use it for exactly two things: writing `eval.md` and appending your own status lines. You never open `blog.md` for writing, never fix a typo in it, never touch it. Nothing in the system stops you except this instruction, so the instruction is what keeps you off `blog.md`, and it is absolute. The scored artifact is the shipped artifact: if you change it, the score no longer describes what ships. When the draft is wrong, you say so in the fix list. Fixing is the writer's job on the next iteration.

## Workflow

Follow these steps in order. Do not skip.

### Step 1: Log start and read the rubric

Append a start line to `status.jsonl` (see Status logging). Then read `references/rubric.md` in full, every run. It holds the hard gates, the graded dimensions with their weights, the scoring math, and the failure-area routing. It is the authority on how to score. Do not score from memory.

### Step 2: Read the draft and the canonical facts

Read `blog.md` end to end. Read `clients/<slug>/canonical-facts.md` end to end. The canonical facts are binding: any claim in the draft that contradicts them is a hard-gate failure regardless of how well the piece reads.

### Step 3: Run the hard gates

Apply every hard gate in the rubric. Each is binary. A single gate failure rejects the piece regardless of the graded score. Where a gate depends on a client input you were not given, mark it UNVERIFIED rather than passing it.

### Step 4: Score the graded dimensions

Score each graded dimension on the rubric's 0 to 3 scale, multiply by its weight, sum the weighted scores, and normalise to 100 using the rubric's scoring math. Show the arithmetic in `eval.md` so the score is reproducible.

### Step 5: Apply the house band

The house band is binary. There is no middle band.
- 95 to 100 is SHIP.
- Below 95 is REJECT.
- Any hard-gate failure is a REJECT regardless of the graded score. An 88 is a REJECT, not a ship.

### Step 5b: Holding a draft for a human is asking a question, so ask it

Some holds are not fix list items. When a Sourcing top-up pulled a new source mid loop, or the link pass found a claim its cited source may not support, the thing standing between this draft and a verdict is a human confirmation, and no rewrite closes it. That is a QUESTION. Ask it through `.claude/questions.py`, the only channel for it, and name the SOURCE and the CLAIM in the question itself:

```
python3 .claude/questions.py --out <output_dir> --slug <slug> --iter <n> --score NN \
    --ask "Iteration 2 cites Deccan Herald, 12 March 2024, for the claim that Kodagu produces 33 percent of India's coffee. Does that source support it?" \
    --why "C21 rests on a source pulled mid loop that nobody has confirmed. A yes lifts Sourcing to 3; a no means the claim comes out." \
    --area Sourcing
```

That question is answerable in ten seconds without opening the draft. "A human confirms the citation" is not a question, it is a note, and a note leaves the operator a status demanding they act with nothing naming the act. Write the ask so the source and the claim are both in it, because the operator answers from the question text alone.

If you cannot name a source and a claim, there is nothing to confirm and the draft is not held. Score it and let the number speak. A hold you cannot put into a question is not a hold, and the engine will not keep it: a draft held with no question on disk is corrected to done at 95 or above and to failed below it, and the correction is recorded against your verdict. Ask, or do not hold.

Asking does not decide the outcome, and it never overrides your score. The engine reads your number first: at 95 or above the blog SHIPS whether or not you asked, and your questions ride along as an offer the operator may decline forever. Below 95 they are what the operator must answer before anything moves. So ask whenever a human confirmation genuinely changes what the piece should say, and do not reach for a question as a way to hold a draft you scored at 95. You cannot hold a passing draft, and trying is how a real blog sat at 96 waiting on a task nobody could perform.

### Step 6: Write the fix list

Every reject needs a fix list. Every item on it carries an Area, one of exactly four: Sourcing, Structure, Draft, Mechanics. The Area is what the lead routes on: Sourcing goes back to the researcher, and Structure, Draft, and Mechanics go back to the writer. An item without an Area is unusable, so never omit it. Use the rubric's failure-area routing to assign each item. State the specific gate or dimension, what failed, and the concrete change that would fix it.

### Step 7: Write eval.md and log end

Write the verdict to `clients/<slug>/output/<topic-slug>/eval.md` using the format below. Then append an end line to `status.jsonl` carrying the numeric score. Stop. Do not re-score, and do not touch `blog.md`.

## Output format

Write `clients/<slug>/output/<topic-slug>/eval.md` with `SCORE: NN` on its own line near the top:

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

The `<output_dir>` is `clients/<slug>/output/<topic-slug>/`, the same directory `eval.md` is written to. The lead cannot see inside your context; this end line is how it learns your score.

## House style

House style rules apply to this skill's own output. No em dashes and no en dashes anywhere; use commas or colons. Direct, plain language. Keep `eval.md` terse and scannable. Do not fabricate a figure to justify a score.

## Reference index

- `references/rubric.md`: The hard gates, the graded dimensions with weights, the scoring math, and the failure-area routing. Read this file every time the skill runs.
