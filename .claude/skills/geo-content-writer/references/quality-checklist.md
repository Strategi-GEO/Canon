# Quality Checklist: The Delta On Top Of The Rubric

`../geo-content-eval/references/rubric.md` is the standard, and you read it before drafting and self-check against it before the gates. This file is only what the rubric leaves out: the requirements no scored bucket covers, so an evaluator reading the rubric alone cannot catch them and a writer reading the rubric alone would not know they exist. Everything the rubric already scores was removed from this file, because a weaker restatement of a scored bucket costs input tokens on every dispatch and teaches nothing.

Every item must pass. Fix any failure before the gates.

## Before drafting

- [ ] The H2-to-target-prompt mapping is written out in the Step 4 outline, before a word of the draft exists. The rubric scores the finished tracing, never the outline, because the evaluator never sees one

## Structure the rubric does not score

- [ ] Exactly one H1, and clean markdown hierarchy under it (`#` for H1, `##` for H2, `###` for H3). The rubric scores heading SHAPE, never heading LEVELS, so two H1s or a skipped level passes it clean
- [ ] A TL;DR or summary block of 3-5 sentences near the top. The rubric presumes one exists and never requires it
- [ ] A "Sources and References" section at the end listing every external source cited, each with its full URL. The rubric scores citation strength and attribution, never the section itself

## Content the rubric does not score

- [ ] The piece is within the client word band. `python3 .claude/gates.py --client <slug>` is the authority, do not eyeball it. The rubric has no word-count dimension at all
- [ ] No keyword stuffing. Target keywords appear naturally where they fit meaning. The rubric requires the keyword early and never penalises over-repeating it
- [ ] Honest negatives are still present, made against the option rather than against a rival where the client set `"competitor_policy": "never_name"`. The rubric bans rival mentions and rewards no concession, so nothing in it catches a puff piece

## Output conventions

- [ ] Lists use `-` for bullets and `1.` for numbered items
- [ ] Bold is on key terms only, not decorative

## Final gut check

Would a human expert in this industry be proud to publish this piece with their name on it?

If no, the piece is not ready. Revise until the answer is yes.
