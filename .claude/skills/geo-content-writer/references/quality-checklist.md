# Quality Checklist: Pre-Delivery Verification

Run through this checklist before delivering any piece. Every item must pass. If any item fails, fix it before delivery.

## Opening checks

- [ ] The first paragraph directly answers the core question the article addresses
- [ ] The primary keyword or topic appears naturally in the first two sentences
- [ ] No preamble, no "in today's digital landscape," no warm-up
- [ ] The first 100-150 words contain a standalone citeable answer (the BLUF)
- [ ] For pieces over 1,500 words: a TL;DR or summary block of 3-5 sentences appears near the top

## Structural checks

- [ ] Exactly one H1
- [ ] All H2s and H3s are descriptive, answer-shaped statements or questions, not generic labels
- [ ] No heading uses "Overview," "Introduction," "Benefits," "Conclusion," "Key Points," or similar
- [ ] Paragraphs are 2-4 sentences each
- [ ] No wall-of-text paragraphs anywhere
- [ ] Lists are used for processes, comparisons, and multi-point coverage
- [ ] Every list item is 2-4 sentences, not a phrase
- [ ] Tables are used for side-by-side comparisons where applicable
- [ ] A FAQ section with 5-10 Q&A pairs appears for any piece covering a substantive topic

## Factual density checks

- [ ] Every paragraph contains at least one specific, verifiable claim
- [ ] At least one sourced statistic appears every 150-200 words
- [ ] Every statistic includes the specific figure, the source name, and the date or time period
- [ ] Every external source is named, no "studies show," no "experts say," no "research indicates"
- [ ] At least 3 standalone quotable statements appear in the piece
- [ ] No invented statistics, no false precision, no made-up percentages

## Entity clarity checks

- [ ] Every company, product, person, framework, and technology is named explicitly
- [ ] No "the company" or "this approach" or "the product" substitutions
- [ ] Key terms are defined using standalone definitional sentences ("X is the practice of...")
- [ ] Every definition could be extracted and quoted independently
- [ ] Proprietary frameworks or methodologies are given distinctive names

## Voice and style checks

- [ ] Reads like a knowledgeable person explaining something, not a corporate blog generator
- [ ] Sentence length varies naturally
- [ ] Active voice throughout (passive only where the actor is unknown or irrelevant)
- [ ] Zero hedging language ("might," "could," "possibly," "perhaps") unless expressing genuine uncertainty
- [ ] Concrete examples and specific numbers wherever possible
- [ ] No listicle thinking, every list item is substantially developed

## Banned pattern checks

- [ ] No em dashes or en dashes anywhere in the text (search for both dash characters and replace with commas, colons, or periods)
- [ ] None of these phrases appear: "in today's digital landscape," "leveraging cutting-edge," "robust solution," "game-changer," "unlock potential," "seamless integration," "transformative," "revolutionary," "paradigm shift," "synergy," "best-in-class," "world-class," "next-generation," "at the forefront of," "cutting-edge," "bleeding-edge"
- [ ] No generic phrases that could apply to any company or industry
- [ ] No keyword stuffing, target keywords appear naturally where they fit meaning
- [ ] No buried insights, the most important information appears first

## Industry-specific checks

The piece belongs to one industry, named in the client's `client.md`. Load the matching file from `references/industries/` and verify its industry-specific checks were applied before delivery.

- [ ] The single industry reference named in `client.md` was loaded
- [ ] The credentials that reference tells you to surface are surfaced
- [ ] The jurisdiction, market, or location specifics that reference requires are stated explicitly
- [ ] The disclaimers that reference requires are present and date-stamped where it says so
- [ ] The segmentation, schema, and factual-density notes for that field are applied
- [ ] No piece in a covered industry ships without confirming these against the loaded reference

## Output format checks

- [ ] Piece is within the client word band (`python3 .claude/gates.py --client <slug>` is the authority; do not eyeball it)
- [ ] Markdown hierarchy is clean (# for H1, ## for H2, ### for H3)
- [ ] Lists use `-` for bullets and `1.` for numbered items
- [ ] Bold is used for emphasis on key terms only, not decoratively
- [ ] A Sources and References section at the end lists every external source cited
- [ ] The piece is saved to `clients/<slug>/output/<topic-slug>/blog.md`

## Quotable statement check

Pick any 3 sentences at random from the piece. Each one, removed from context, should:
- Make complete sense on its own
- Contain a specific, verifiable claim
- Be something an AI engine could cite in response to a relevant query

If any of the 3 fails this test, the piece is not dense enough with citeable content. Rewrite until it passes.

## The generic-brand test

Read the piece once through and ask: "Could this have been written about any company in this industry, or is it specifically about the brand / topic in the brief?"

If it reads generic, rewrite with:
- More specific entity mentions
- More brand-specific or client-specific data
- More named examples
- More industry-specific terminology from the industry reference

## Final gut check

Would a human expert in this industry be proud to publish this piece with their name on it?

If no, the piece is not ready. Revise until the answer is yes.
