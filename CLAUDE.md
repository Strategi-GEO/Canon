# CLAUDE.md: GEO Blog Factory (brand-agnostic engine)

## What this file is
This is the engine contract. It describes HOW a blog is made and says NOTHING about WHO it
is for. Every brand-specific fact, URL, entity name, industry, market, and do-not-claim item
lives in `clients/<slug>/`, never here. Onboarding a new client is four files under
`clients/<slug>/`: `client.md`, `canonical-facts.md`, `gates.json`, `roadmap.csv`. It is
never a fork of this contract. Where this file and a client's `canonical-facts.md` genuinely
conflict, stop and flag it; do not guess.

## Standing order
A run is scoped to ONE topic for ONE client, identified by its `<slug>`. Given a topic and a
slug, execute the pipeline below without asking for further instruction. Stop of your own
accord only for a NEEDS_REVIEW condition or a genuine conflict between this file and
`clients/<slug>/canonical-facts.md`. An operator stop is not the lead's decision and does not
appear to the lead as a decision at all: the backend kills the session (see Stopping a run).
The session lead follows this contract; it does not manage a queue and does not launch other
blogs (see Execution model).

## Source of truth (precedence order)
1. **`clients/<slug>/canonical-facts.md`** is BINDING for that client's facts, verified URLs,
   and do-not-claim list. Never publish a claim that contradicts it. Where it records a
   resolved conflict, follow the resolution, not the raw source.
2. **The client's own live domain** (named in `clients/<slug>/client.md`) wins over internal
   docs on any conflict.
3. **`clients/<slug>/Resources/`** is the client knowledge base. Read it before any external
   search. Honor any per-file exclusions the client's `canonical-facts.md` records (for
   example an image-only PDF with no extractable text is not a citable source).
4. Model memory is NEVER a source. Never state a name, price, spec, approval, or URL from
   memory.

## Skill overrides
The skills in `.claude/skills/` are generic. These rules override their defaults. The
client-configurable bits are read from `clients/<slug>/gates.json` and
`clients/<slug>/client.md`, not hardcoded here.

| Skill default | Override |
|---|---|
| geo-content-writer: 2,500-word cap, 3,000-4,000 for pillars | **The client word band in `clients/<slug>/gates.json`.** House default is 1200-2000 target, hard FAIL above 2500, which `gates.json` may override. |
| geo-content-eval: Ship band 85-100 | **The house binary 95.** 95-100 SHIP, below 95 REJECT. No middle band. Any hard-gate failure is a REJECT regardless of score. An 88 is a REJECT, not a ship. |
| geo-content-writer Step 3: run geo-research before drafting | **The dossier is frozen.** If one exists for this topic, use it. Never re-research on revision. |

The fetch-before-cite rule is unchanged by any override: fetched full text, or it is not a
source.

## Execution model: a three-agent chain WITHIN one blog's session
The old prompt-level orchestrator that dispatched subagents and ran a batch queue is WRONG
and is deleted. Dispatch, concurrency, and retry are owned by the BACKEND (`server/runner.py`),
not by any prompt. The runner opens ONE SDK session per blog, never one per batch. A batch is
a barrier: five blogs would wait for the slowest, and because the revise loop runs 0 to 4
iterations the per-blog variance is huge. One session per blog also means one dead blog exits
its own process without touching the other four. There is NO queue logic in this file and NO
"run N topics in parallel" line: concurrency lives in `runner.py` and nowhere else.

Inside one blog's session, the **session lead** dispatches specialised subagents in sequence
for that single topic. The lead NEVER writes the blog itself. Each subagent carries a minimal
context, and each dispatch passes the subagent its **slug, output dir, and current iteration
number**, because a fresh Agent W on iteration 3 has no memory of iterations 1 and 2.

- **Agent R (researcher).** Input: the CSV row + `clients/<slug>/canonical-facts.md` +
  `clients/<slug>/Resources/`. Runs geo-research. Output:
  `outputs/<slug>/<topic-slug>/dossier.md`. Its fetch logs and rejected sources never
  leave its context.
- **Agent W (writer).** Input: the CSV row + the frozen dossier + `canonical-facts.md` + its
  iteration number. Runs geo-content-writer, then self-runs the gate command below until it
  exits 0 (WARN passes, only FAIL blocks). Then runs the link pass. Returns only when the
  draft is gate-clean AND link-clean. Output: `.../blog.md`. Never sees Agent R's reasoning.
- **Link pass (inside Agent W, BEFORE the eval).** Firecrawl-fetch every link not already in
  `.../links-verified.txt`. Confirm each resolves to the correct page and that the cited
  source contains the claim. Fix any that 404, default to a homepage, or point to a source
  lacking the claim. Append every verified URL to `links-verified.txt`. On iteration 2 and
  later, verify only new or changed links; never re-fetch a listed URL. The link pass may fix
  or remove links. It may NOT add new claims or sources: a claim with no supporting source is
  a Sourcing failure, so flag needs_review rather than patching it.
- **Agent E (evaluator).** Input: **`blog.md` + `geo-content-eval/references/rubric.md` +
  `clients/<slug>/canonical-facts.md` + `answers.json` WHEN ONE EXISTS, and nothing else.**
  Runs geo-content-eval as a hostile auditor. Never sees the dossier, Agent W's reasoning, or
  any prior eval, so the hostile isolation is intact: operator answers rank with
  `canonical-facts.md` and above any internal doc, and Agent E already reads
  `canonical-facts.md`, so an answer is an EXTENSION OF THE FACT BASE, not the writer's
  reasoning leaking across the wall. Withholding them punishes honesty: a negative answer
  forces the writer to CUT a claim, and an evaluator that cannot see the answer reads that cut
  as lost factual density and scores the draft DOWN for telling the truth. An answer is still
  NOT a source: it can never become a citation, and a claim needing a citation still needs a
  fetched source. Emits `SCORE: NN` on its
  own line plus the fix list with each item's Area, using HOUSE bands: 95-100 SHIP, below 95
  REJECT, any hard-gate failure a REJECT regardless of score. Output: `.../eval.md`.
- **Revise (surgical, ELECTIVE and score-driven).** If SCORE < 95, spawn a FRESH Agent W with
  ONLY: the frozen dossier, the current `blog.md`, the fix list, and its iteration number. It
  applies **only the listed fixes** to the existing draft. It does not rewrite the article. Then
  re-run gates, the link pass on changed links only, and a FRESH Agent E. FOUR conditions stop
  this loop: the 4-iteration cap, two consecutive iterations showing no gain, **the above-90
  monotonic rule**, and **a Sourcing QUESTION on the form, which ends the loop at the iteration it
  is filed.** **ABOVE 90 THE LOOP ONLY CLIMBS:** once any iteration scores above 90, an iteration
  that does not STRICTLY beat the best so far ends the loop and the best draft is the result. A
  draft above 90 is close, and another revise is as likely to break it as to lift it, so a
  non-gain there is a reason to stop and keep it, not to spend another iteration; below 90 the
  ordinary rules run unchanged, and 95 still ships at once. The Sourcing-question condition ends
  the loop BEFORE the revise is dispatched, because
  Sourcing is the one area no rewrite can close: this contract already says the writer has no
  authority to invent a citation or URL, so iterating past a Sourcing question spends research
  and revise budget rediscovering what the evaluator already knew was terminal. The date-night
  blog filed Sourcing questions at iteration 1, ran a bounded research top-up and two full
  revises, and landed at iteration 3 on FOUR Sourcing questions about claims no rewrite could
  ever have fixed. Three iterations bought nothing.
  **Best-scoring selection is scoped to THIS elective loop and to nothing else, AND THE ENGINE
  NOW ENFORCES IT.** `.claude/status.py` snapshots each new high as it is scored, and
  `server/runner.py` `_install_best_draft` restores the highest-scoring draft, blog.md and eval.md
  together, and reports its score once the loop ends, so the peak can no longer be lost to the
  in-place edits that once shipped an 89 over a 92. The lead no longer hand-restores a draft; it
  writes each iteration and lets the stop rules decide. It is a guard on an optional improvement
  rerun, answering what makes such a rerun safe to accept. The answer-driven revise under Asking
  the operator is a MANDATORY correctness rerun and is EXEMPT, in the contract AND in the code
  (`revise_topic` never calls `_install_best_draft`): there the clarified draft always ships even
  if it scores lower, because keeping the higher-scoring draft there restores the original with
  its violation still in it.

The session lead branches on the numeric SCORE and never on the verdict word. **The lead's
IN-LOOP branch reads the SCORE and exactly ONE property of the form: whether it carries a
Sourcing question.** SCORE >= 95 ENDS THE LOOP and nothing about that changes. At SCORE < 95,
BEFORE dispatching a revise, the lead asks the form whether a Sourcing question is live:

```
python3 .claude/questions.py --out <output_dir> --slug <slug> --iter <current iteration> --check-area Sourcing
```

**`--iter` is REQUIRED and it is the whole staleness guard**, so pass the iteration the draft is
actually on. A form from an earlier iteration describes a draft the blog has moved past, and it
must not end anything. Omit the flag and the command is a usage error (exit 2), which is
deliberate: exit 1 already means "nothing live of that area, revise on", and a caller who forgot
the guard must never land on a meaningful answer by accident. Exit 2 also covers an unusable
form, so a failure can never be read as an absence.

Exit 0 means a live Sourcing question exists and **THE LOOP ENDS NOW**: write the terminal
`needs_review` line and stop. Do not revise, do not dispatch another evaluator, and do not
delete the form, because that form is the summons the operator answers. Exit 1 means no live
Sourcing question, so SCORE < 95 triggers a revise iteration while iterations remain, exactly as
before. The query never writes: a read that rewrote the form would destroy what it reports on.

**Questions of area Structure, Draft or Mechanics do NOT end the loop**, and the lead still
deletes `questions.json` before the next evaluator, so those are superseded by the next
iteration's form exactly as they always were. Reading them in-loop would hold a 93 that still had
three iterations of budget left, and a rewrite is precisely what closes them. Sourcing is
different because no rewrite closes it: this contract already says the writer has no authority to
invent a citation or URL, and a Sourcing QUESTION names a fact only a person has, so another
iteration cannot reach it. The date-night blog proved the cost: it filed Sourcing questions at
iteration 1, ran a bounded research top-up and two full revises, and landed at iteration 3 on
FOUR Sourcing questions about claims no rewrite could ever have fixed.

**THIS IS A LEAD INSTRUCTION AND THE ENGINE CANNOT ENFORCE IT.** The loop runs inside the SDK
session and the backend cannot reach into it to stop a revise, which is a real departure from this
file's principle that the check belongs in Python where nothing can argue with it, so it is named
here rather than papered over. **IT FAILS IN BOTH DIRECTIONS AND THEY ARE NOT SYMMETRIC.**
IGNORING the rule costs money and not correctness: the lead burns iterations, then hits terminal
resolution, where the final form still holds the blog in Python, so it cannot ship a blog it
should have held. OVER-APPLYING it costs a good blog: ending the loop on a form that is stale or
another topic's writes `needs_review` with iterations unspent, and terminal resolution then reads
that same form as non-holding and corrects the topic to `failed` by its score, so a draft that had
budget left to reach 95 dies instead. The required `--iter` above is the whole of what closes that
second direction, which is why it is required rather than advisory: an optional guard that every
caller omitted is how this rule shipped broken the first time.

**THE QUESTION STATE IS CHECKED FIRST AT TERMINAL RESOLUTION**, after the loop ends, which is
where the three-case table applies and where a >= 95 ships only if no current questions are on
disk. With current questions the blog is HELD for the operator's answer at any score (see Asking
the operator). The score runs the loop and the full four-valued question state decides the
terminal status; the in-loop branch borrows exactly ONE bit of the form, the Sourcing bit, and
borrows nothing else.

**THE FIRST SCORE >= 95 IS FINAL AND TERMINAL WHEN NO CURRENT QUESTIONS ARE ON DISK.** Record
it in `eval.md` and STOP. The single answer-driven revise is the ONE licensed re-eval, and it
is licensed because the operator's answer changed the fact base the score was computed
against. Every other confirmatory re-eval stays FORBIDDEN, including "the draft changed
since", "eval.md and blog.md are inconsistent", "the run was stopped and restarted, so let me
confirm", or "let me confirm". A confirmatory re-eval adds no rigor: it re-rolls a stateless
auditor whose score varies by several points on an identical draft, and it can strand a
shipping blog below the bar. Because gates and the link pass both run BEFORE the evaluator,
the scored artifact IS the shipped artifact, and the ONLY thing that touches the draft after
the eval is an operator answer arriving.

Route fixes by the Area the eval assigns: **Sourcing** goes back to Agent R as a bounded
top-up for that one claim; **Structure, Draft, Mechanics** go to Agent W. "Add a source"
NEVER routes to the writer alone; the writer has no authority to invent a citation or URL.

**A Sourcing FIX-LIST ITEM and a Sourcing QUESTION carry the same area word and opposite
implications for the loop, and this is the thing a reader gets wrong.** A Sourcing fix-list item
still routes to a bounded Agent R top-up and still does NOT end the loop; that routing is
unchanged and it works, because date-night's iteration 2 top-up sourced three Sourcing fix-list
items successfully. A Sourcing question ENDS THE LOOP at the iteration it is filed. The
difference is what each artifact asserts: a fix-list item says "a machine can find this source",
so another iteration is exactly the right spend, while a question says "only a person holds this
fact", so another iteration buys nothing. Read the artifact, never the word alone.

## Status protocol
`outputs/<slug>/<topic-slug>/status.jsonl` is the ONLY progress feed. Each agent
appends its OWN lines, because the session lead cannot see inside a subagent and is forbidden
from reading subagent tool output into its own context.
- **Agent R** appends: research start / end.
- **Agent W** appends: write | revise, gates, links start / end.
- **Agent E** appends: eval start / end, plus the score on the end line.
- **The lead** appends: the terminal line ONLY (`done` | `needs_review` | `failed`), written last.
- **The backend** appends the terminal line the lead never writes when a stop lands: `stopped`,
  or `needs_review` in the one narrow case set out under Stopping a run. See that section. This
  is the one place a terminal line is written with the lead already dead, so a rule making the
  lead write it is a rule that never fires.
- **The app** appends exactly one further terminal line, the operator-promotion `done` (see
  Ship criteria), through the same `.claude/status.py` path as every other line, after the loop
  is long over. No agent writes it and no agent may ask for it.

Line shape, exactly:
```
{"ts":iso8601,"slug":str,"stage":"research|write|gates|links|eval|revise","event":"start|end",
 "iter":int,"score":int|null,"status":"running|done|needs_review|failed|stopped","note":str}
```
Agents append lines by running the helper, never by hand-writing JSON:
```
python3 .claude/status.py --out <output_dir> --slug <slug> --stage eval --event end --iter 2 --score 96 --status running --note "..."
```
`--score` and `--note` are optional; the helper stamps `ts` and validates the enum.

## Preflight
Before starting a topic, refuse to run if `clients/<slug>/canonical-facts.md` is missing or
still contains the literal token `PLACEHOLDER`. Every blog for that client inherits this
file, so an unreviewed one silently poisons the whole queue. On refusal, write the terminal
status `failed` with a note naming the reason.

## Tooling: Firecrawl and DataForSEO ONLY
No other fetch or search tool. If neither can confirm something, it is not a fact.

**Firecrawl** (all fetching, grounding, link verification)
- `firecrawl_map` on the client's domain with targeted `search` strings to find exact slugs.
  Never guess a slug.
- `firecrawl_scrape` with `formats: ['markdown']`, `onlyMainContent: true`, `waitFor: 6000`.
  Avoid `firecrawl_extract` multi-URL and JSON-schema extraction; they fail silently.
- Fetch every external source in FULL and read the whole text, not just the paragraph with
  the figure. Search snippets are leads, never sources.

**DataForSEO** (keyword validation only)
- `kw_data_google_ads_search_volume` with the location and language named in
  `clients/<slug>/client.md`.
- Batches of 10 to 12 keywords; split informational and buyer-intent into separate batches.
- Null or low volume on a target prompt is EXPECTED for AI-search-first pieces and is NEVER a
  reason to drop the prompt. Volume shapes H2 phrasing; target prompts still get answered
  verbatim.

## Reference files each agent must read
- Agent R: `geo-research/references/source-vetting.md`, every run.
- Agent W: `geo-content-writer/references/content-structure.md`,
  `references/geo-mechanics.md`, and the industry reference named by
  `clients/<slug>/client.md` (for example `references/industries/<industry>.md`), every run.
  Skipping the industry reference produces generic content. Then
  `references/quality-checklist.md` before returning.
- Agent E: `geo-content-eval/references/rubric.md`, every run.

## The pipeline (per topic)
Roadmap: `clients/<slug>/roadmap.csv`. The house sheet is five columns:

| Column | 0-indexed | Meaning | Reaches an agent as |
|---|---|---|---|
| 1 | 0 | **Content Topic** | the subject, BY POSITION |
| 2 | 1 | **What the Piece Covers** | the scope, BY POSITION |
| 3 | 2 | **Format** | an extra, BY ITS HEADER |
| 4 | 3 | **Search Intent** | an extra, BY ITS HEADER |
| 5 | 4 | **Target Prompts** | the prompts, BY POSITION |

**Columns 1, 2 and 5 are read BY POSITION and only by position.** That mapping is frozen. There
is NO header-text detection deciding which column is the topic: sheets are positionally stable,
so header text is noise there and matching on it only invents ways to map the wrong column.

**Every other column is REGISTERED, not dropped.** It is stored, shown, and passed to the
writer, labelled with its own header text. This reversed an earlier rule that discarded them,
and the reason it reversed is that the sheet plans real instructions the writer was never told:
a `Comparison anchor` is written differently from an `FAQ (entity)`, and Commercial intent
frames differently from Informational.

**An extra is labelled by its HEADER, never by its position, and this distinction is the whole
of the rule.** Position 3 is `Format` on a generated sheet, `Approx. Volume (IN/mo)` on one
operator sheet and `Est. Searches` on another. Hardcoding "column 3 is the format" fed a writer
`~1200` as its format. So the binding three are positional, the extras are labelled, and neither
rule is allowed to borrow the other's mechanism.

Parsing rules:
- Parse with a real CSV parser; cells contain commas and newlines inside quotes.
- The first row is ALWAYS a header row and is skipped. Do not try to detect whether a header
  exists: these sheets always have one. The header is also where every extra gets its label.
- **Target Prompts** holds several prompts in one double-quoted cell, separated by newlines OR
  by " | " (space pipe space). Split on both. Operator sheets use newlines; generated sheets use
  pipes, because `server/prompts/roadmap-generation.md` specifies pipes. On newlines alone a
  generated cell parsed as ONE run-on prompt, silently: the row kept working and the piece was
  written against the wrong query.
- A CSV with fewer than 5 columns cannot satisfy this mapping. Reject the upload with a clear
  message naming how many columns were found. Never silently map the wrong column.
- A row missing topic, covers, or prompts is incomplete: show it, but do not let it be
  selected, and name the missing fields. An extra is NEVER required: a blank Format is a sheet
  that did not plan one, not an incomplete row. Reject a submitted incomplete row at the API
  boundary with 422, never twenty minutes into a run.

**The app never EDITS the operator's CSV.** No agent and no endpoint rewrites a row, a cell, or
a status back into that file: progress lives only in `status.jsonl`. The app may CREATE the file
(roadmap generation writes it) and DELETE it whole (the operator's own delete, which is the only
way to replace a sheet). Creating and removing an input are not the same act as mutating it
under a run that is reading it, and the difference is why roadmap edits are 409'd while a run is
live. Separately, the app appends every shipped blog to `clients/<slug>/generated.csv`, an
append-only ledger the app owns. The ledger is a different artifact from the operator's roadmap
and never edits it.

The row is the brief:
- **Content Topic** -> subject and H1.
- **What the Piece Covers** -> scope and angle.
- **Target Prompts** -> BINDING. The exact AI-search queries this piece must be cited for.
  The answer-first opening answers the primary target prompt; H2s map to these prompts; the
  FAQ covers every one of them, phrased verbatim somewhere liftable.
- **Every extra column** -> handed to the writer verbatim, under its own header. `Format:
  Comparison anchor` and `Search Intent: Commercial` are instructions about the shape of the
  piece and the frame of its language, and the writer follows them.

An extra is guidance, never a fact. `Approx. Volume (IN/mo): ~1200` shapes which phrasing an H2
reaches for; it is NOT a statistic, it never appears in the draft, and it can never be cited.
Nothing in an extra column is a source, and no extra overrides `canonical-facts.md`.

## Mechanical gates
```
python3 .claude/gates.py --client <slug> outputs/<slug>/<topic-slug>/blog.md
```
It merges the house rules with `clients/<slug>/gates.json`. Exit 1 on any FAIL, 0 on WARN.
Agent W runs it until it exits 0, before the link pass and before the eval. Never spend an
eval pass on something the script catches. WARN passes and proceeds; only FAIL blocks. The
script is the authority on these rules:
- Word count: the client band (house default target 1200-2000, WARN above 2000, hard FAIL
  above 2500 or below 1200), measured after stripping markdown link syntax.
- ZERO em dashes, ZERO en dashes. Commas or colons.
- ZERO banned phrases. The house list plus any phrases the client's `gates.json` adds (a word
  in the client's own site copy is still banned; never lift it, paraphrase).
- No sentence opening with "And" or "But".
- Paragraphs 2 to 4 sentences, including around tables and inside bullets.
- Active voice. Zero hedging: might, could, possibly, perhaps, typically.
- Entity clarity: never generic references like "the company", "the brand", "the developer",
  "the product". Always the specific entity names listed in the client's `gates.json`. Quoted
  verbatim claims are exempt where `canonical-facts.md` requires exact wording.
- Competitor silence, where the client sets `"competitor_policy": "never_name"`: zero rival
  names from its `competitor_terms` and zero competitor framing ("other developers", "most
  vendors", "unlike other projects", "the competition", "industry peers"). Quoted spans are NOT
  exempt: a rival named inside a quotation is still named.
- Brand voice, where the client configures a `voice` block: the reader addressed as "you", the
  client speaking as "we/us/our", no generic "we", and every block that uses "we" also naming
  the entity in full. See Voice and topic discipline below.

## Voice and topic discipline (every article)
The register is per-client and the engine stays brand-agnostic: `clients/<slug>/gates.json`
carries the `voice` block and `client.md` describes it in prose. Where a client configures none,
the piece is written in neutral third person exactly as before. Where one is configured:

- **Second person to the reader.** The reader is "you", never "buyers" and never "one".
- **First person plural for the client.** The client speaks as "we", "us", and "our", not about
  itself in the third person in every sentence. "We" means the client and never the reader, the
  industry, or people in general.
- **Entity anchoring is the price of the pronoun.** A pronoun carries no entity, and AI engines
  extract per block, so every block that can be lifted alone names the entity in full inside
  itself: the opening, the TL;DR, each H2 section, each FAQ answer, each table, each quotable.
  Inside a block already anchored by the full name, "we" and "our" carry the rest. A section
  that says only "we" is unattributable, which is worse than a generic. `gates.py` enforces
  this alongside the pronoun checks and it cannot be enabled separately, because the register
  without the anchoring trades away the entity mentions the whole engine exists to produce.

Topic discipline is a HOUSE rule and applies to every client, configured or not:

- **Every H2 traces to a target prompt.** Write the mapping in the outline. An H2 that maps to
  no prompt is cut, not softened, because it gets extracted for a query this piece was never
  meant to win, competing with the roadmap row that should have answered it.
- **Stay on subject.** Category-level background gets at most two sentences before the piece
  returns to its own topic. An adjacent subject gets one sentence, never a section, a table
  row, or an FAQ pair. Never widen the topic to reach the word band: length is earned by
  answering the target prompts more completely.

## Structural requirements (every article)
- **Answer-first opening.** The first 100-150 words contain a standalone citeable answer to
  the primary target prompt, keyword in the first two sentences. No preamble.
- **TL;DR block**, 3 to 5 sentences, directly under the H1.
- **5 to 8 H2s**, answer-shaped statements or questions, never labels. Built from the target
  prompts, phrased with DataForSEO-validated language. Every target prompt must be reachable
  from an H2 or an FAQ question, never buried inside body prose.
- **Factual density:** one sourced statistic every 150-200 words, each carrying its figure,
  named primary source, and date. If the dossier lacks the claims to hit this honestly, write
  to the evidence and note the shortfall. Never pad with invented figures.
- **3+ standalone quotable statements** that make full sense lifted without context.
- **Feature development:** every named feature, spec, amenity, or advantage gets 1 to 2
  sentences on the concrete buyer benefit. Any factual claim inside a benefit still needs its
  own cited source.
- **At least one Markdown comparison table**, plus bullets for feature or step lists. List
  items run 2 to 4 sentences, never bare phrases.
- **FAQ block, 6+ pairs**, covering every target prompt. Each answer opens with a direct
  definitive sentence, then 75 to 300 words of context.
- **"Sources and References"** section last, every cited source with its full URL.

## Hyperlink architecture
- Every mention of the client's primary project or entity links to the canonical project URL
  named in `clients/<slug>/canonical-facts.md`. Other pages use the verified URLs in that same
  file. Never fabricate or guess a slug.
- Every data point, statistic, and market claim links to the specific source supporting it.
- Honor the forbidden link targets in `canonical-facts.md`. Never cite the client's own blog
  as evidence for a fact: it is marketing copy, and it can contain claims `canonical-facts.md`
  forbids.
- Link verification runs inside Agent W, before the eval, so every scored draft is already
  link-clean. The ONE exception is the answer-driven revise, which is itself an Agent W pass:
  it re-runs the link pass on changed links only, before its evaluator. There is no link step
  that runs after an eval on a draft nobody touched.

## Sourcing discipline
- Prefer sources local to the client's market (named in `client.md`) over generic or foreign
  data.
- Trace every statistic to its originator, not whoever last repeated it.
- Reject sources with a commercial stake in the claim: a competitor of the client, or a
  vendor writing on its own category's demand. Flag vendor research's commercial interest in
  the caveats line.
- No cited source may contradict `canonical-facts.md`.
- **Honest negatives are required, not optional.** Where another option genuinely wins,
  concede it plainly and earn the client's mention on documented ground instead. A puff piece
  scores lower, not higher. A revise pass must NEVER cut an honest negative to save words.
  Where the client sets `"competitor_policy": "never_name"`, this rule is RESCOPED and not
  cancelled: the concession is made against the option (the location, the asset class, the
  price band, the buyer fit) rather than against a named company, and it is still made. A
  client's competitor policy never buys it a puff piece.

## Do not claim
The binding list is `clients/<slug>/canonical-facts.md`. Never publish a claim that
contradicts it, including in FAQ answers and tables. Beyond the client's own list, these
house rules always hold:
- No unsubstantiated superlatives: best, first, only, number one, leading.
- Where the client set `"competitor_policy": "never_name"`, no competitor appears anywhere,
  named or implied, including in tables, FAQ answers, and the Sources list. Comparisons under
  that policy are between OPTIONS (asset type, location, price band, ownership model, buyer
  situation), never between COMPANIES. The client's `competitor_terms` list is a backstop and
  not the rule: if a sentence would make a reader think of a specific competing company, it
  does not ship.
- Frame every client projection as the client's own guidance, never as independent fact.
- Source any market-growth claim from an independent third party specific to the client's
  market, never from the client's own marketing or press releases.

## Output (per blog)
`outputs/<slug>/<topic-slug>/`:
- `dossier.md` (frozen after Agent R)
- `blog.md` (final, within the client word band)
- `eval.md` (`SCORE: NN` on its own line near the top, plus the fix list)
- `links-verified.txt` (working file: URLs already Firecrawl-verified, so later iterations
  skip them)
- `status.jsonl` (the append-only progress feed)
- `questions.json` (WRITTEN ONLY WHEN the evaluator asks: its questions for the human operator.
  Asking is optional; once the file exists, answering it is not, so this file holds the blog)
- `answers.json` (OPTIONAL: what the operator answered, written by the app, never by an agent)

Slug = topic lowercased, spaces to hyphens.

## Asking the operator
Some gaps no rewrite closes, because the missing thing is a fact only a person has. The fix list
cannot carry those: it routes to an agent, and no agent can confirm whether The Manor counts
among the amenities. Agent E may therefore ASK, by running the helper, never by hand-writing the
file:

```
python3 .claude/questions.py --out <output_dir> --slug <slug> --iter 2 --score 96 \
    --ask "Can you confirm a dated source for Kodagu's 4,106 sq km area?" \
    --why "B1 cites it undated, which caps Sourcing at 2. A dated source lifts it to 3." \
    --area Sourcing
```

The score in that example is 96 deliberately, because a question is asked and held at ANY score
and a passing score is NEVER a reason to withhold one.

**An evaluator asking a Sourcing question is ENDING THE LOOP, not annotating it.** Below 95 the
lead checks the form for a live Sourcing question before every revise and stops the loop where it
finds one, spending no further iteration (see the in-loop branch). That is correct, because
Sourcing is the one area no rewrite can close and the writer has no authority to invent a
citation or URL, so the remaining budget would rediscover what the question already established.
It also raises the bar on asking one: a Sourcing question surrenders every iteration the blog had
left, so ask it only where a person genuinely holds the missing fact, and file it as a fix-list
item instead wherever a bounded Agent R top-up can find the source. The at-most-5 and
answerable-in-ten-seconds standards below apply with FULL force here, because this question is
now the blog's only remaining path forward and not one signal among several.

Ask ONLY where a human answer changes the outcome: a fact only the client holds, a source that
needs confirming, an ambiguity `canonical-facts.md` does not resolve, or a suspected inaccuracy.
Never ask what the rubric already answers, and never ask for something the writer should simply
fix: "rephrase this H2" is a fix list item, not a question. **At most 5 questions, each
answerable in ten seconds, each carrying what answering it unblocks.** Those two standards are
LOAD-BEARING, not advice, because a question now HOLDS THE BLOG AT ANY SCORE and operator
silence strands it forever. A form of fifteen questions does not get answered, it gets closed,
and the blog it holds never ships. Every question you ask spends a person's attention against a
blog's only exit, so ask the fewest that clear the gap and make each one answerable without
opening the draft.

**`needs_review` MEANS "this blog has questions waiting for the operator that are current, on
disk, and answerable", at ANY score, and it means nothing else.** The score does NOT enter this
definition. The status is a summons, so it must name the act it summons someone for. A blog held
with no `questions.json` is a dead end: the app renders "A human has to confirm something before
this ships" and offers no door, and the operator can do nothing with it. Four of the five blogs
that sat on `needs_review` in live data were exactly that.

**Three cases, THREE terminal states, and no fourth verdict.** This table governs a loop that
RAN TO A VERDICT and nothing else. `stopped` is not a fourth row of it: the loop never ran, so
no score describes it and the table has nothing to say about it. Never add a row here for a run
that did not finish.

The QUESTIONS axis is checked FIRST and is the four-valued engine state
(`current` | `none` | `stale` | `unreadable`), never a binary, plus `answered`. The score is
DEMOTED: it decides the nothing-to-answer branch, and its ABSENCE is the one thing that outranks
the questions axis, for the reason stated under the table.

| Questions | Score | Status | What it means |
|---|---|---|---|
| `current` | any score, 96 included, and none at all | `needs_review` | HELD. A human owes an answer, and there is no dismiss and no proceed. |
| `none` / `stale` / `unreadable` / `answered` | >= 95 | `done` | It ships. |
| `none` / `stale` / `unreadable` / `answered` | < 95, or none at all | `failed` | The loop exhausted itself and cannot say what it needs, so there is no human task. |

`stale` and `unreadable` group with `none` because THE APP ALREADY REFUSES THEM: a form nobody can
submit summons nobody, so holding a blog on one is holding it for a person who will never be
asked. `answered` groups with them on a DIFFERENT ground, and the difference is worth stating
because the app does NOT refuse an answered form: its answers are already recorded and a revise
was already dispatched for them, so it summons nobody NEW. Grounding it on a refusal the app does
not perform would be a rule defended by a claim about the system that the system does not make
true, which is the exact defect this section removed elsewhere.

**A missing score falls to `failed` on the nothing-to-answer rows, and NEVER on the `current`
row.** With no form there is nothing to answer, so a run that never reached a verdict is a
machine's answer and not a human's task. On the `current` row THE QUESTIONS AXIS HOLDS WITHOUT
EXCEPTION, including where no score was ever written. An evaluator that asked and then died still
asked, and the answer is not wasted: it drives the surgical revise, whose fresh evaluator writes
the score the crashed one never did. That is a door, so the hold is not permanent, and the
questions axis stays absolute with no exception for a reader to reason around. An earlier draft of
this rule failed a scoreless hold on the ground that it stranded a human whose answer bought
nothing back; that ground was false, because answering is exactly what produces the missing score.
A gates FAIL is still `failed`.

**OPEN QUESTIONS HOLD THE BLOG AT ANY SCORE, AND ANSWERING IS A DEMAND, NEVER AN OFFER.** A 96
with current questions is HELD, not shipped. There is no dismiss and no proceed-anyway at any
score. The reason is what the old score-gated rule actually shipped: it put two
`canonical-facts` violations into published blogs at 96, one publishing a claim
`canonical-facts` records as NOT citable, the other citing a publication date from a source
recorded as never fetched in full. A question is the evaluator saying it cannot tell whether the
draft is true, and a draft that might be false does not ship because it scored well.

**`needs_review` IS A WORKFLOW STATE, NOT THE LOOP'S VERDICT.** A blog held at 96 HAS a verdict
and the verdict is SHIP: the loop finished, the score stands, and `eval.md` records it. What the
status says is that the blog is not out the door yet because a person owes it an answer. Read
this way, a hold and a passing score are not in tension and nothing needs reconciling: one
describes what the loop concluded, the other describes where the blog sits.

**OPERATOR SILENCE STRANDS THE BLOG, and this project CHOSE that cost with its eyes open.**
There is no timeout, no expiry, and no escalation. An unanswered hold never ships and never
enters `generated.csv`, for as long as it goes unanswered. The alternative is worse: any auto
release turns "we could not verify this" into "publish it anyway" on a schedule, which is the
exact failure the hold exists to prevent. The only mitigations are the two standards above, at
most 5 questions and answerable in ten seconds, which is why they are load-bearing rules here
and not style advice.

- **"A human confirms the citation" IS a question, so ask it as one**, naming the SOURCE and the
  CLAIM: "Iteration 2 cited <source> for <claim>. Does that source support it?" is answerable in
  ten seconds. "human confirms that citation" is not answerable at all, and it is what stranded a
  real blog. If the evaluator cannot name a source and a claim, there is nothing to confirm and
  the blog is not held.
- **When there is NOTHING to ask, the score decides and no human is involved.** At 95 or above the
  blog is done and it ships. Below 95 it is `failed`: the loop exhausted itself and cannot say
  what it needs, which is a machine's answer, not a human's task.
- **A gates FAIL is `failed`, never `needs_review`.** There is no question in it. It is a machine
  failure with a machine's fix.

**THE ENGINE ENFORCES THIS, NOT THIS FILE.** `server/runner.py` decides the terminal status after
the session ends, in `run_topic` and `revise_topic` both, from the table above and from
`_resolve_needs_review` alone. A run that was STOPPED never reaches that resolver: it has no
verdict to correct, and passing it through would launder it into `done` or `failed` by a score
that describes a loop which never ran. That exclusion is about the SCORE axis and only that axis.
The question axis needs no score at all, so a stop that lands on a current form is held at the
WRITE SITE, in `_stop_line_if_unterminated`, and never through this resolver. See Stopping a run
for the window and its boundaries. A `needs_review` with no question on disk, or with one the
app already refuses as stale, unreadable, or already answered, is corrected to `done` or `failed`
by its score, because such a form summons nobody. A `needs_review` WITH A CURRENT QUESTION is NOT
corrected, at ANY score including 96 and including no score at all: `needs_review` is no longer the
loop's verdict, so a score cannot overrule it, and the absence of one cannot either. The score
corrects ONLY the nothing-to-answer branch. The two sentences
partition on the QUESTIONS axis and never on the score axis, because a hold with no current form
is the dead end with no door the `needs_review` definition forbids, and a hold with one is a
person owing an answer that no score discharges. Either way the
override is appended to `status.jsonl` naming what the claim was missing, so the trail shows the
engine disagreeing with the lead rather than the lead's claim quietly vanishing. The session lead
may ASK for `needs_review`; whether it earned it is not the lead's call. A rule that lives only in
an agent's instructions is a rule that gets talked out of, which this project learned twice in one
day, so the check is in Python where nothing can argue with it.

**The lead DELETES `questions.json` before dispatching every evaluator, including the first.** An
evaluator that wants to ask writes a fresh file itself, so the questions on disk always belong to
the draft being scored right now. Skipping this stranded a real file: it asked about iteration 1's
draft, survived the revise, and iteration 2's evaluator did not re-ask, so the operator was left
answering questions about an article that no longer existed. The app refuses such a file as stale,
but a rule enforced only at the boundary is a rule that has already failed once by then.

**What the answers do does NOT depend on the score, and there is no split.** Answering is
BLOCKING at every score, because the questions are the evaluator saying it cannot tell whether
the draft is true, and truth does not become optional at 96.
- Answering triggers ONE surgical revise, the ANSWER-DRIVEN one, which is a different path from
  the elective score-driven Revise in the Execution model despite the shared word "surgical":
  that one keeps the best-scoring draft, this one never does. Here it is the answers plus the outstanding fix list applied to
  the EXISTING draft, dossier frozen, then gates, then the link pass on changed links only, then
  a fresh evaluator. No re-research, and no new iteration budget. That evaluator is the ONE
  licensed re-eval named in the first-score-is-final rule, licensed because the answer changed
  the fact base the earlier score was computed against.
- **THE CLARIFIED DRAFT ALWAYS SHIPS, EVEN IF IT SCORES LOWER. TRUTH BEATS SCORE.** The old
  higher-score-ships rule is GONE from this path. It was written as a guard on an ELECTIVE
  improvement rerun, answering "what makes an optional rerun safe to ACCEPT". Carried onto a
  MANDATORY correctness rerun it INVERTS into a correctness-suppression mechanism: a negative
  answer forces the writer to cut a claim, the score falls because the draft now carries less,
  the engine restores the original WITH THE VIOLATION STILL IN IT, and the machine structurally
  prefers the non-compliant draft over the true one. A lower score on a clarified draft is the
  truth costing points, not the draft getting worse.
- **The byte-for-byte restore SURVIVES ONLY ON THE CANCELLATION PATH.** A stop mid-revise still
  restores the original, because a half-applied revise is not a clarified draft: it is a draft
  that never finished being corrected, and it carries neither the old truth nor the new one.
- **The restore returns the ARTIFACT SET the score described, `blog.md` AND `eval.md` together,
  never the draft alone.** `eval.md` is part of what shipped: it carries the `SCORE: NN` that
  the terminal line and the ledger both rest on. Snapshotting only `blog.md` left the restored
  original sitting beside the DISCARDED draft's `eval.md` and its score, so the artifact on disk
  and the score describing it were about two different articles.
- **A SPENT FORM MUST NEVER HOLD A BLOG FOREVER.** An answered `questions.json` whose revise then
  crashed or was stopped before the form was cleared stays on disk, stays iteration-matched, and
  reads as `current`, so the resolver holds the blog AGAIN while the app refuses a second submit
  because the form is already answered. That is a blog with no exit, the exact dead end with no
  door the `needs_review` definition forbids. Two things prevent it, and BOTH are required: the
  question state carries an `answered` value that groups with `none` and `stale` for hold
  purposes, because an answered form summons nobody; and clearing the questions happens on a
  finally-arm, so a crashed or stopped revise cannot leave a spent form holding the blog.
- The engine owns all of this (`revise_topic`); the session lead does not make the call and does
  not write the terminal line for a revise.

Operator answers are client-provided guidance, ranking with `canonical-facts.md` and above any
internal doc. They are NOT a source: an answer can tell a writer that a claim is wrong or that a
figure is confirmed, and it still cannot become a citation. A claim needing a citation needs a
fetched source, exactly as before. An answer that establishes a durable fact about the client
belongs in `canonical-facts.md`, where every future blog inherits it, rather than in one topic's
`answers.json` where the next blog will ask the same question again.

## Stopping a run
The operator can stop a brand from the session view, behind a confirm. `DELETE
/api/clients/<slug>/runs` stops EVERY live run for that brand at once, because a run-scoped
stop would make the operator press it five times while the queue raced them.

**`stopped` MEANS the operator ended the run before the loop finished, so no score describes the
blog, and it means nothing else.** It is not a failure: `failed` says the engine could not produce the blog, and
conflating the two lies in the status tiles about work the engine did fine. It is not a
summons either, in every ordinary case: no question was asked, and the operator is the one who
acted. THE ONE EXCEPTION IS A FORM THE EVALUATOR HAD ALREADY WRITTEN THAT STILL READS `current`
WHEN THE STOP LANDS, set out in full below, and it is an exception to the summons and to nothing
else.

What a stop does, per topic:
- **Finished blogs are KEPT.** A topic that already wrote its terminal line keeps that line,
  its score, and its ledger entry. The backend writes a `stopped` line ONLY where no terminal
  line exists yet, so a topic that reached `done` microseconds before the stop landed stays
  done. "Whichever blogs have been created will be kept" is the operator's requirement, and
  this guard is the whole of what enforces it.
- **In-flight topics are DISCARDED, not deleted.** The backend appends the terminal `stopped`
  line, keeping the stage that was in flight with event `end` even though no `end` matches its
  `start`. Consumers read the STATUS field, never the stage. `score` is the last score actually
  seen, or `null`, and is NEVER inferred.
- **Partial artifacts stay on disk, byte for byte.** No `dossier.md`, `blog.md`,
  `links-verified.txt`, or `status.jsonl` is ever deleted by a stop. NOTHING IS DELETED. A
  frozen dossier is the expensive half of a blog, so a stopped topic is cheap to resume and
  deleting it would burn real quota to buy back what was already paid for.
- **A stopped blog is NEVER appended to `generated.csv`.** That ledger is shipped blogs only.
  A blog that shipped before the stop is already in it and stays in it.
- **Queued topics NEVER START.** The whole brand halts. Generate again to resume.

A stop after SCORE >= 95 does not un-ship the blog, and the reason is the TERMINAL LINE, not the
score. The backend writes `stopped` ONLY where no terminal line exists yet, so a topic whose lead
already wrote `done` keeps `done`, its score, and its ledger entry. A blog HELD at 96 has no
terminal `done` line to protect, so it is not shipped by a stop either: it keeps whatever line it
has and the hold stands or the `stopped` line lands, exactly as the guard above dictates.

A stop mid-revise restores the ORIGINAL artifact set, `blog.md` and `eval.md` both, byte for
byte, before writing anything. The reason is NOT higher-score-ships, which no longer governs a
clarified draft: it is that a half-applied revise is not a clarified draft at all. It carries
neither the claim the answer confirmed nor the claim the answer cut, so shipping it ships
something no one wrote and no evaluator scored. A cancel that skipped the restore left a half
revised draft where a 96 stood: no file was deleted and the blog was ruined anyway, which is
the outcome this rule exists to make impossible. Restoring only `blog.md` reproduces the same
ruin one level down, leaving the restored draft next to the discarded revise's `eval.md`.

**A STOP THAT LANDS ON A LIVE QUESTION FORM IS `needs_review`, AND IT IS THE ONLY STOP THAT IS.**
The window is narrow and exactly specified. The evaluator writes `questions.json` through
`.claude/questions.py` and the session lead appends its terminal line LAST, so every topic that
asks something spends real time carrying a current form and no verdict. A stop landing in that gap
finds no terminal line in its slice, which is the same condition under which the backend writes a
line at all. Where the form on disk is `current`, `server/runner.py` `_stop_line_if_unterminated`
writes `needs_review` and the `NEEDS_REVIEW` file beside it. Where the form is absent, stale,
unreadable or already answered, and on every other stop, it writes `stopped`. A second path
reaches the same arm and is governed by the same sentence: a topic that already ended
`needs_review` is offered back to the operator, because the roadmap withholds only `done` topics,
so re-queueing it and stopping the brand before the semaphore admits it would otherwise land a
`stopped` line on top of a hold that was correct an hour ago.

**THE STOP RULE'S GROUND FAILS INSIDE THAT WINDOW, WHICH IS WHY THE RULE DOES NOT REACH IT.** The
rule in Ship criteria reads "there is no question in it", and it is that ground, not the word
`stopped`, that does the work: a stop is not `needs_review` BECAUSE nobody was asked anything.
Inside this window somebody was asked, by the evaluator, before the operator acted, and nothing
about a stop un-asks a question. The prohibition the rule actually carries survives intact and is
not weakened by a syllable here: no agent writes `questions.json` on a stop's behalf, and the
engine on this path only READS a form that was already on disk. Nothing manufactures a question.
The `needs_review` definition is a definition BY THE FORM and never by the cause. It says the
status means questions that are current, on disk, and answerable, at ANY score, and that it means
NOTHING ELSE, so the cause of the halt cannot be what disqualifies a topic which satisfies that
definition word for word.

**THE ALTERNATIVE IS THE DEAD END WITH NO DOOR, ARRIVED AT FROM THE OTHER SIDE.** The definition
forbids a hold with no form because such a form summons nobody; this is its mirror, a form nobody
can be summoned to, and it is worse because the person is real and the task is live. Recording
`stopped` over a current form leaves a topic the engine still ACCEPTS an answer for, since
`api_answers` refuses a stale form, a live run and an approved article, and never
once reads the terminal status, while no surface offers that answer: `adminActions` grants
`answer` to `has_questions` alone, `blogState` maps a `stopped` status to the `stopped` state whose
bench is empty, and `clientCanSee` is false for `stopped`. The article's only remaining exit is a
full regeneration that discards the frozen dossier, the draft and the score, which are precisely
what a stop is documented above to KEEP.

**A THIRD ARGUMENT ONCE STOOD HERE AND IS WITHDRAWN. THE CARVE-OUT DOES NOT REST ON IT.** An
earlier draft of this section called the surface a witness, citing `adminAnswerTierReady` in
`dashboard/src/lib/blog-state.ts` as deriving the answer tier from the status alone, off a stated
invariant that `needs_review` holds exactly when a current, answerable form exists. That predicate
is DELETED, and the invariant under it was never true: `revise_topic`'s three restore arms append a
terminal line carrying `prev_terminal["status"]` without passing it through
`_enforce_terminal_status`, so a status copied forward from an earlier verdict can read
`needs_review` beside a form that is spent. A status copied forward is not a function of the form
at all. Do not reinstate the sentence, and do not reinstate the predicate: the replacement is
`dashboard/src/lib/gate-contract.ts`, which records the verbatim refusing source line rather than
restating the rule a third time.

**WHAT FAILED IS THE CONVERSE OF WHAT THE CARVE-OUT CLAIMS, WHICH IS WHY NOTHING ABOVE MOVES.** The
false half is `needs_review` implying a current form, and a copied-forward status is exactly its
counterexample. The carve-out asserts the other direction, that a form reading `current` when a
stop lands earns the hold, and no copied-forward status bears on that direction at all. The two
arguments above carry the rule without help: `api_answers` accepts an answer for a record whose
every surface offers no door to it, and a live form under a `stopped` status is the dead end with
no door read from the form's side. Both are properties of code anyone can run and neither is an
invariant anyone merely stated, which is the standard the withdrawn sentence failed to meet.
`tests/stop_check.py` pins all four arms.

**THIS LICENSES NOTHING ELSE, AND THE BOUNDARIES ARE THE RULE.** A stop on a topic with no form is
`stopped`. A stop on a stale, unreadable or already answered form is `stopped`, because the app
refuses all three and a form nobody can submit summons nobody. A stop on a topic that already
carries a terminal line writes no line at all, and that guard is checked BEFORE the form is ever
read, so a blog that reached `done` microseconds earlier stays `done`. The SCORE axis is untouched:
a stopped topic still never reaches `_resolve_needs_review`, no score is ever inferred for it, and
a held topic is held at whatever score it has or at none. A read of the form that raises costs the
topic its hold and never its line, falling back to `stopped`, because a topic with no terminal line
hangs the SSE stream forever and that is the larger harm. The lead's position is unchanged in both
directions: it never claims `stopped`, and it never claims `needs_review` for a stop either. This
carve-out is enforced at the write site in Python, where a rule that would otherwise live only in
an agent's instructions cannot be talked out of.

The stop line is also what releases liveness, so the 409 on roadmap edits lifts the moment it
is written. A killed session with no stop line leaves the SSE stream open forever and the
operator's sheet locked with no way to replace it.

A stop on an already-terminal topic is a no-op, never a second terminal line: the last line for
a topic is its terminal one, and that invariant holds through a stop. Stopping an
already-stopped or absent brand is a no-op, not an error. **The lead never claims `stopped`**,
exactly as it never decides `needs_review`. `server/runner.py` writes it through
`.claude/status.py`, the same code path as every other line, where nothing can argue with it.

## Ship criteria
DONE when the FIRST evaluator score is >= 95 on a draft that is already gate-clean and
link-clean AND has no current questions on disk. That score is final. Write the terminal `done`
status and stop. 95 ships. 96 ships. No score at or above 95 is borderline, and a better one is
never worth seeking.

**Operator promotion is the ONE post-run re-verdict, and it is the operator's, never the
loop's.** After a loop ends terminal `failed` with an evaluator-scored committed draft, the
operator may ship it anyway from the dashboard (`POST .../promote`, `blog_edit.promote_to_done`).
The engine appends a new terminal `done` line whose note names the operator and the score,
commits it, appends the ledger row, and sends the blog to the client in the same act. The
evaluator's number is never rewritten: the trail reads failed at 92, then promoted by a person,
which is the same appended-correction idiom `_enforce_terminal_status` already uses. This changes
NO rule the loop runs under. No agent may write it or ask for it, the resolver's table is
untouched, first-score-is-final is untouched (promotion re-rolls no evaluator), and every
done-gate keeps demanding the literal `done`: a promoted blog satisfies them because the fold
genuinely reads done afterward, never because a gate was widened. Scope is exact and the engine
refuses the rest: terminal `failed` only, never `needs_review` (a question holds at ANY score and
promotion is not a dismiss), never `stopped` (no verdict exists to promote), never mid-run, and
never without a scored committed draft, because gates and the link pass run before the eval, so
the scored draft is gate-clean and link-clean and the 95 bar is the ONLY thing being waived. A
promoted blog enters the ledger exactly as a 95+ ship does, so its roadmap row locks and a later
"failed row in the ledger" is a promotion, not a defect.

**A score is not a licence to ship past an open question.** Where the evaluator asked something
current, the blog is HELD at ANY score, including 96, until the operator answers. Answering is a
demand, never an offer, and there is no dismiss. If the operator never answers, THE BLOG NEVER
SHIPS and never enters `generated.csv`. That is a chosen cost, not an accident: releasing an
unverified draft on a timer would publish "we could not confirm this" as though it were
confirmed, which is what the old score-gated rule did twice at 96. The at-most-5 and
answerable-in-ten-seconds standards are what keep the cost payable, so honor them.

Write `outputs/<slug>/<topic-slug>/NEEDS_REVIEW` and the `needs_review` terminal status
ONLY where the evaluator has asked the operator a question that is on disk, current, and
answerable. The score is not part of the test, with the single exception that a run carrying NO
score never reached a verdict and is `failed`, because a form asking about a draft nobody scored
summons a person whose answer unblocks nothing. Nothing else earns the status, and the engine
checks it. The four old causes resolve like this:
- **A Sourcing top-up** (a new source pulled mid-loop) is a QUESTION, asked through
  `.claude/questions.py`, naming the source and the claim so the operator can answer it without
  opening the draft. Asked at ANY score, it is `needs_review` and it holds the blog. Unasked, it
  is nothing: the score decides.
- **The link pass finding a claim its cited source does not support** is the same, and it is the
  same question: name the source, name the claim, ask whether the source carries it.
- **`gates.py` still FAILing** is `failed`, never `needs_review`. It is a machine failure with no
  human question in it, so summoning a human for it summons them to nothing.
- **The 4-iteration cap** is `needs_review` only if the evaluator asked something. A loop that
  stalled below 95 and has nothing to ask is `failed`.
- **An operator stop** is `stopped`, never `failed`, and never `needs_review` EXCEPT where the
  form the evaluator wrote is on disk and reads `current` at the moment the stop lands. A form
  that is ABSENT, STALE, UNREADABLE or ALREADY ANSWERED is `stopped` like every other stop, and
  the exception does not stretch to cover it: the app refuses a stale or unreadable form outright,
  and an answered one has already summoned its person, so holding on any of them is the dead end
  with no door the `needs_review` definition forbids. There is never a failure
  in it, and in the ordinary case there is no question in it either, so no `NEEDS_REVIEW` file is
  written. No agent writes `questions.json` on a stop's behalf, and that holds without exception:
  the one carve-out is the engine READING a form the evaluator wrote before the operator acted,
  never anything creating one. It is set out in full under Stopping a run, it is the only stop
  that is not `stopped`, and its boundaries are stated there because they are the rule.

Never mark a blog done to clear the queue, and never mark a blog done to clear a question. A
passing blog WITH a current question is `needs_review`, and that is not a contradiction: the
verdict is ship, the workflow state is held.

## Reporting
Per blog, one line: slug, SCORE, iterations, status, links corrected. A stopped blog reports
the last score actually seen or none, the iterations it completed, and status `stopped`; its
score is never inferred from a loop that did not finish. The lead records only
these fields plus what the terminal status line carries. It MUST NOT read dossiers, drafts,
or tool output into its own context.
