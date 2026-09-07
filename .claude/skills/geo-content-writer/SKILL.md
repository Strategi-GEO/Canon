---
name: geo-content-writer
description: Writes research-driven blog posts, articles, and long-form content optimized for citation by AI search engines (ChatGPT, Perplexity, Google AI Overviews, Microsoft Copilot, Gemini). Use this skill whenever the user asks for a blog, article, guide, explainer, thought-leadership piece, or any long-form editorial content across industries like legal, finance, healthcare, hospitality, education, technology/SaaS, HR, consulting, accounting, beauty/fashion, or media/publishing, AND especially whenever the user mentions "GEO", "generative engine optimization", "AI search", "AI citation", "AEO", "answer engine optimization", or asks for content designed to be picked up by AI systems. Also use whenever the user references a content brief, content calendar, or asks for a piece written "for AI search" or "for citation". This skill writes only from a frozen, source-vetted research dossier supplied to it, never from memory.
---

# GEO Content Writer

A skill for writing long-form editorial content engineered to be cited by AI search engines (ChatGPT, Perplexity, Google AI Overviews, Microsoft Copilot, Gemini).

The goal is not clicks. The goal is citation. AI engines cite sources that are factually dense, structurally clean, entity-explicit, and immediately answerable. This skill encodes the rules and workflow for producing that kind of content.

## When this skill applies

Trigger for: blog posts, articles, guides, explainers, pillar pages, how-to content, industry analysis, thought leadership, comparison pieces, FAQ pages, and "what is X" definition content. In industries including but not limited to legal, finance, healthcare (hospitals/clinics), hospitality (hotels/travel/restaurants), education, technology/SaaS, HR/recruitment, management consulting, accounting/tax, beauty/fashion, and media/publishing.

Do not trigger for: short-form social posts, ad copy, email marketing, sales scripts, product descriptions under 500 words, or pure creative writing (fiction, poetry). For those, write directly without the skill.

## Inputs from the dispatching lead

The lead gives you, on every dispatch: the client slug, the topic slug, the output directory, the path to the frozen dossier, and the current iteration number. In revise mode it also gives you the current draft and a fix list. Use these for every path and every status line. Do not guess them, and carry no memory from a previous iteration: a fresh writer on iteration 3 knows only what this dispatch hands it.

Before drafting, read the client's binding context:

- `clients/<slug>/client.md`: the client's market, language, industry, the exact industry reference file to load, and the entity names to use.
- `clients/<slug>/canonical-facts.md`: binding facts, verified URLs, the entity-naming rules, and the do-not-claim list. Nothing you write may contradict it.
- `clients/<slug>/custom-instructions.md`: the brand's standing blog instructions, set by the operator. Follow them as a major priority, above this skill's house-style defaults and the roadmap guidance, but never above `canonical-facts.md`: where an instruction would conflict with a binding fact or the do-not-claim list, the fact wins, and no instruction licenses inventing a source or a statistic. May be empty, meaning there are none.

## Workflow

Follow these steps in order. Do not skip. Log each stage to `status.jsonl` (see Status logging).

### Step 1: Read the client context and load the named industry reference

The industry is not guessed. It is named in `clients/<slug>/client.md`, which also names the exact industry reference file to load from `references/industries/`. Load that named file before writing. Industry references carry domain-specific frameworks, signals, schema guidance, and tone rules that change the final output. Skipping the named industry reference produces generic content, and generic content is a fail.

From the brief and `client.md`, extract:
- The topic or primary question the piece must answer
- The target keyword or the target prompts the piece must be cited for
- The intended format (how-to, comparison, explainer, thought leadership, pillar, FAQ)
- The entity names to use, exactly as `client.md` and `canonical-facts.md` give them

**Where the brief carries roadmap guidance, it is not a hint and you do not overrule it.** The
roadmap row is the plan, and the lead passes every column of it that is not the topic, the
scope or the prompts, each under the sheet's own header. Two of them decide the piece:

- **`Content Type`** IS the intended format above. Do not infer one when the sheet states one. A
  `Comparison anchor` is a multi-way comparison other pieces hang off, and writing it as a
  general explainer breaks the roadmap's structure, not just this article: the spokes that link
  into it arrive at a page that never made the comparison they promised.
- **`Query Intent`** frames the language. It is a live search-intent classification of the row's
  PRIMARY target prompt, not a read of the cell as a whole, which matters because that cell
  deliberately holds three prompts of differing intent. `Commercial` means a buyer deciding, so
  the piece names entities and gets to the decision. `Informational` means someone learning, so
  it earns the citation by being the clearest source. `Navigational` means someone checking who
  this brand is.

The rest of the row is the JUSTIFICATION, the figures that argued this topic onto the sheet:
`Keyword Volume`, `AI Search Volume`, `Cost Per Click`, `Keyword Difficulty` and `Query Volume`.
There is no prose justification cell to read: the figures ARE the argument, because a sentence
explaining a number belongs beside the number it explains. They ride along under their own
headers as context, telling you what demand this piece is aimed at and which phrasing is worth
reaching for. Every other label works the same way, and the same rule holds: follow it, do not
argue with it.

**Guidance is never a fact and never a source.** A volume, an estimate or a funnel stage in the
brief shapes which phrasing an H2 reaches for. It NEVER appears in the draft, it can NEVER be
cited, and it does not become a claim. Nothing in the guidance overrides `canonical-facts.md`,
and where the two disagree, `canonical-facts.md` wins and you say so in your return.

### Step 2: Load the structural and mechanical references

Always read these before drafting:
- `references/content-structure.md`: heading hierarchy, FAQ blocks, definition patterns, schema
- `references/geo-mechanics.md`: how AI citation actually works, what AI engines extract, benchmarks
- `../geo-content-eval/references/rubric.md`: the buckets the evaluator scores (A Extractability, B Evidence, C Entity and voice, D Brief fit), the scoring math, and the failure-area routing

**Read the rubric BEFORE you draft, every run.** It is the standard the draft is graded against, and a writer who has never read it is aiming at a bar it cannot see. Reading it at the end is worth far less: it catches what reading it at the start would have prevented. This takes nothing from the evaluator's isolation, which protects the evaluator from your reasoning and the dossier and never the reverse. The rubric is the public standard.

Read `references/quality-checklist.md` after the rubric and before you return. It is the short delta on top of the rubric, the few pre-delivery items no scored bucket covers, and it is never the primary standard.

### Step 3: The dossier is frozen

Do not research. The lead supplies the path to a frozen, source-vetted dossier, and that dossier is the only source of external facts for this piece. Never run geo-research yourself, and never re-research on a revision: a revision reuses the same frozen dossier.

The dossier holds verified claims (each with an exact figure, a named primary source, a live URL, a publication date, a data period, and a caveats line), a Do Not Claim list, and any coverage gaps. The rules:

- Every statistic, study, named source, date, and figure in the draft must come from a verified claim in the dossier, used with the safe framing the dossier specifies.
- Anything on the Do Not Claim list must not appear as a fact. Drop it, or state it qualitatively without a source.
- If the piece needs a fact the dossier does not contain, that is a Sourcing gap. Do not invent a source or attribute a claim from memory. Note the shortfall so the lead can route a bounded research top-up.

### Step 4: Plan the piece before writing

Produce a brief internal outline containing:
- The one-sentence thesis that will appear in the first 100-150 words
- The H2 structure (5-8 headings, each phrased as a question or statement, not a label)
- At least 3 standalone quotable statements you intend to include
- The specific data points and statistics you will cite, each mapped to a verified claim in the dossier
- The FAQ section structure (5-10 Q&A pairs)
- The TL;DR or summary block directly under the H1

Do not write yet. Verify the outline answers the core question completely, covers the buyer journey (awareness, consideration, decision) where relevant, includes the signals from the named industry reference, and that every planned data point traces to a dossier claim.

### Step 5: Draft the piece

Apply all core writing principles (below). Cite only from the dossier. Use the entity names exactly as `canonical-facts.md` gives them. Write the piece to `outputs/<slug>/<topic-slug>/blog.md`.

### Step 6: Self-check against the rubric, then the checklist delta

Before the gates, score your own draft against `../geo-content-eval/references/rubric.md`: walk every graded dimension in buckets A, B, C and D, apply the scoring math to your own draft, and fix what would lose points.

**Clear 90, the only bar.** A draft that scores 90 or above ends the evaluation loop at once and ships. Below 90 it does not ship: an 89 is a reject, and a draft that ends between 80 and 89 is below bar, resolving failed and reaching a client only if the operator promotes it. There is no middle band to land in, so write for 90. Then verify against `references/quality-checklist.md` for the items no bucket scores. Confirm separately that every external fact in the draft traces to a verified claim in the dossier and that nothing from the Do Not Claim list slipped in as a fact. Fix any failure before moving on.

### Step 7: Run the mechanical gates until they pass

Run the gate script and fix what it flags, repeating until it exits 0:

```
python3 .claude/gates.py --client <slug> outputs/<slug>/<topic-slug>/blog.md
```

WARN passes and proceeds; only FAIL blocks. The script is the machine-checked authority on word band, banned characters, banned phrases, paragraph shape, voice, and entity clarity. Never spend an eval pass on something a script catches, so the draft must be gate-clean before the link pass and before it returns.

### Step 8: Run the link pass

After the gates pass and before you return, verify every link. There is no link step after the eval, so this is the only one.

- Firecrawl-fetch every link that is not already listed in `outputs/<slug>/<topic-slug>/links-verified.txt`.
- Confirm each link resolves to the correct page AND that the cited source actually contains the claim it is attached to.
- Fix any link that 404s, redirects to a homepage default, or points to a source that does not contain the claim.
- Append every verified URL to `links-verified.txt`.
- On iteration 2 and later, verify only new or changed links. Never re-fetch a URL already listed in `links-verified.txt`.

The link pass may fix or remove links. It may NOT add a new claim or a new source. If a claim has no supporting source, that is a Sourcing failure, not a link fix: flag it for needs_review and leave it for the researcher, rather than patching it yourself.

### Step 9: Return

Return only when the draft is gate-clean AND link-clean. Do not run the evaluator; that is a separate skill on a fresh context.

## Revise mode

When the lead supplies a fix list, you are revising, not rewriting. Apply ONLY the listed fixes to the existing draft. Do not restructure the article, do not re-open the dossier for new research, and do not rewrite sections the fix list does not name.

A revise pass must never cut an honest negative to save words. A conceded weak point, a place where another option genuinely wins, is required content, not filler. Under a `never_name` competitor policy that concession is made against the option (the location, the asset class, the price band, the buyer fit) and never against a named company, but it is still made. After applying the fixes, re-run the Step 6 self-check, re-run the gates until they exit 0, and run the link pass on new or changed links only. Then return.

## Core writing principles (non-negotiable)

These apply to every piece without exception.

### Opening rules

The first paragraph must directly answer the core question the article addresses. No preamble. No "In today's digital landscape." No warm-up. If someone asks the question this article addresses, the first 100-150 words should contain a standalone citeable answer.

The primary keyword or topic must appear naturally in the first two sentences.

Include a 3-5 sentence summary or TL;DR block directly below the H1. AI engines frequently extract from summary sections.

### Structural rules

Every piece has one H1. Subtopics use H2 and H3. Headings are descriptive and answer-shaped. "Benefits of X" is weak. "How X Reduces Operating Costs by 40%" is strong. Headings should be quotable statements, not just labels.

Paragraphs are 2-4 sentences maximum. One core idea per paragraph. No walls of text.

Use numbered or bulleted lists for processes, comparisons, and multi-point coverage. Each list item should be 2-4 sentences minimum, not just a phrase. AI engines extract individual list items as standalone citations.

Include a FAQ section with 5-10 Q&A pairs for any piece covering a substantive topic. Each Q is phrased as a real user would ask it. Each A is 75-300 words.

### Factual density rules

Every paragraph must contain at least one specific, verifiable claim. Pack the piece with: numbers, dates, technical specifications, process steps, cause-and-effect relationships, comparative data, named sources, expert attributions.

Target one sourced statistic every 150-200 words, drawn from the dossier's verified claims. Research shows pages with this density of factual information are cited up to 33.9% more by AI engines (source: GEO research, Frase/Princeton). If the dossier does not hold enough verified claims to hit this density honestly, do not pad with invented or unsourced figures. Note the shortfall and either request more research or write to the density the evidence supports.

When citing data, always include: the specific figure, the source name, and the date or time period the figure applies to. Example: "According to the Conductor 2025 AI Referral Traffic Report, legal queries trigger AI Overviews 77.67% of the time, the highest rate of any industry."

### Topic discipline: the piece stays on its own subject

The brief names one subject and a set of target prompts. Everything in the draft serves that subject. Drift is the most common quality failure in this pipeline, and it is not a style complaint: a section about an adjacent subject gets extracted and cited for the wrong query, or it gets extracted for nothing at all.

**Every H2 traces to a target prompt.** In the Step 4 outline, write the mapping out: each H2 against the prompt it answers. An H2 that maps to no prompt gets cut, not softened. If the material is genuinely interesting and maps to nothing, it belongs to a different row of the roadmap, so leave it for that row.

**Cap the runway.** Category-level background gets at most two sentences before the piece returns to its specific subject. A piece on one micro-market does not open with three paragraphs on the national market.

**An adjacent subject gets one sentence, never a section.** Where a related topic genuinely helps the reader, state it in a sentence and move on. Never let it grow an H2, a table row, or an FAQ pair.

**Never widen the topic to reach the word band.** A short draft is fixed by answering the target prompts more completely: more specifics, more sourced figures, more of the decision the reader is actually making. It is never fixed by adding a section about something else. Padding with adjacent material is a topic-discipline failure and the evaluator scores it as one.

**The drift test, before you return.** Read the draft one paragraph at a time and ask of each: does a reader who typed the primary target prompt need this to get their answer? Cut every paragraph where the answer is no, including the ones you like.

### Brand voice register (where the client configures one)

`clients/<slug>/gates.json` may carry a `voice` block, described in prose in `client.md`. Where it does, that register is binding on every piece and `gates.py` enforces the mechanical half of it. Where it does not, write in the neutral third person as before.

**`second_person: true` means you address the reader as "you".** Write "you are choosing between two options", not "buyers are choosing between two options" and not "one might choose". Second person is the register of a person answering the question that was actually asked, and an extracted paragraph in second person reads as an answer rather than as a report.

**`first_person_plural: true` means the client speaks as "we", "us", and "our".** The client is not a third party in its own article, so it does not narrate itself by name in every sentence.

**Entity anchoring is the price of the pronoun, and it is not optional.** A pronoun carries no entity, so a section written entirely in "we" is invisible to the knowledge graph and useless the moment an AI engine lifts it away from its surroundings. Under a first-person-plural register:

- The full entity name appears in the TL;DR and in the answer-first opening.
- Every H2 section that talks about the client names it in full, in that section, not in the one before it.
- Every FAQ answer that talks about the client names it in the answer's first sentence. An FAQ pair is extracted alone more often than any other block, so a pair that says only "we" is a pair no engine can attribute.
- Every standalone quotable statement names the entity in full. A quotable that says "we" is not quotable.
- Table cells name the entity in full. A table row reading "we" means nothing once the table is extracted on its own.
- Inside a paragraph already anchored by the full name, "we" and "our" carry the rest of it.

**"We" means the client and nothing else.** Never stretch it over the reader, the industry, or people in general. "We all want somewhere to escape to" is a different "we", and it dissolves the entity the piece exists to build. Use "you" for the reader, and name the group where a group is meant.

**First person plural is not a licence for a generic.** "The company", "the brand", and the client's own `generic_entity_terms` stay banned. In any sentence the choice is the full entity name or "we", never a generic stand-in.

### Entity clarity rules

Name things explicitly. Use the actual name of the company, product, person, or technology every time, not "the company" or "this approach" or "the product." AI systems build knowledge graphs from entity mentions. Consistent naming is what creates the knowledge graph entry. Under a configured first-person-plural register, "we" and "our" are the one permitted substitution for the client's own name, and only in a block that already names it in full.

Define key terms the first time they appear. Use standalone definition sentences that can be extracted and quoted: "Generative Engine Optimization (GEO) is the practice of structuring content to increase its citation rate in AI-generated responses."

Include at least 3 standalone quotable statements per piece. These are sentences that could be lifted into an AI answer without any surrounding context and still make complete sense.

### Voice and style rules

Sound like a knowledgeable person explaining something they understand deeply. Not a corporate blog generator. Use concrete examples, specific numbers, and real scenarios.

Vary sentence length. Mix short declarative sentences with longer analytical ones. Avoid formulaic patterns where every sentence has the same rhythm.

Active voice by default. Passive voice only when the actor is unknown or irrelevant.

Zero hedging language. Eliminate "might," "could," "possibly," "perhaps" unless expressing genuine uncertainty. "X reduces cost by 40%" beats "X could potentially help reduce costs."

### Banned patterns

The following language and patterns must not appear in any piece. `gates.py` is the machine-checked authority on all of them; run it and fix what it flags rather than relying on a manual read.

**No em dashes and no en dashes anywhere.** Use commas, colons, periods, or split into separate sentences. Em dashes and en dashes are a signature of AI-generated content and reduce citation trust signals.

**No generic AI phrases.** Ban list: "in today's digital landscape," "leveraging cutting-edge," "robust solution," "game-changer," "unlock potential," "seamless integration," "transformative," "revolutionary," "paradigm shift," "synergy," "best-in-class," "world-class," "next-generation," "at the forefront of," "cutting-edge," "bleeding-edge." The client's `gates.json` can add more banned phrases, including words that appear in the client's own site copy. Never lift a banned phrase; paraphrase. `gates.py` merges the house list with the client's list and is the authority.

**No competitors, where the client set `"competitor_policy": "never_name"`.** Never name a rival company, developer, project, brand, platform, agency, or operator, and never gesture at one. This covers praise, neutral mention, comparison tables, honest concessions, FAQ answers, captions, and the Sources list alike. It also covers the unnamed forms, which are the ones a draft actually reaches for: "other developers", "most vendors", "unlike other projects", "compared with the competition", "industry peers". Under this policy a comparison is between OPTIONS, never between COMPANIES: asset types, locations, price bands, ownership models, and buyer situations are all fair game, and a named rival is not. It also rescopes the honest-negative rule rather than cancelling it, so concede where the location, the category, the price band, or the buyer fit genuinely loses, and never buy that honesty by naming a rival. `gates.py` carries the client blocklist and enforces the frames, but the list is a backstop and not the rule: if a sentence would make a reader think of a specific competing company, it does not ship.

**No false precision.** Never invent statistics. Never attribute claims to unnamed "studies" or "experts." Every statistic must trace to a verified claim in the research dossier, cited with its named primary source. If it is not in the dossier, it does not go in the piece.

**No keyword stuffing.** Use target keywords naturally where they fit meaning. Never mechanically for SEO.

**No listicle thinking.** Even when using lists, develop each point substantially. Do not treat list items as brief bullets.

**No buried insights.** The most important information goes first. Never "after setup and context."

### Word count rules

The word band comes from `clients/<slug>/gates.json`, and `gates.py` is the authority. Do not restate a specific cap here; run the gates and write to the band they enforce. Do not pad to hit a count, and do not exceed the band the client set.

## Output format

Write the markdown file to `outputs/<slug>/<topic-slug>/blog.md`.

Use proper markdown hierarchy (# for H1, ## for H2, ### for H3), bullet lists with `-`, numbered lists with `1.`, and bold for emphasis on key terms only, not decorative bolding.

End every piece with a "Sources and References" section listing every external source cited in the body, each with its full URL.

## Status logging

Append your progress to `status.jsonl` with the helper, never hand-written JSON. Log a start and an end line for each stage you run, carrying the iteration number the lead gave you:

```
python3 .claude/status.py --out <output_dir> --slug <slug> --stage write --event start --iter <n> --status running
python3 .claude/status.py --out <output_dir> --slug <slug> --stage gates --event end --iter <n> --status running
python3 .claude/status.py --out <output_dir> --slug <slug> --stage links --event end --iter <n> --status running
```

Use stage `write` on a first draft and stage `revise` on a revision, then `gates`, then `links`, each with a start and an end line. The `<output_dir>` is `outputs/<slug>/<topic-slug>/`. The lead cannot see inside your context; this file is how it tracks the chain.

## What the lead provides vs. what the skill provides

The lead provides: the brief (the CSV row), the client slug and paths, the frozen dossier, the iteration number, and in revise mode the current draft and the fix list.

The skill provides: structure, factual density discipline, banned-pattern compliance, the named industry framework, the gate and link passes, and the final gate-clean, link-clean draft. All external facts come from the frozen dossier, never from memory. If a required fact is missing from the dossier, flag it as a Sourcing gap rather than inventing it.

## Reference index

- `references/geo-mechanics.md`: How AI citation works, referral benchmarks by industry, which content types get cited most
- `references/content-structure.md`: Heading hierarchy, FAQ blocks, definition patterns, schema markup, hub-and-spoke structures
- `../geo-content-eval/references/rubric.md`: The scored buckets, the scoring math, and the failure-area routing the evaluator grades against. Read before drafting and self-checked against before the gates
- `references/quality-checklist.md`: The short delta on top of the rubric, the pre-delivery items no scored bucket covers
- `references/industries/`: One reference file per supported industry, the domain layer of the engine. Load the single file named in the client's `client.md`, never a guessed one. These files are not edited per client.
