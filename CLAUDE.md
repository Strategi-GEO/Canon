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
  `clients/<slug>/canonical-facts.md` ONLY.** Runs geo-content-eval as a hostile auditor.
  Never sees the dossier, Agent W's reasoning, or any prior eval. Emits `SCORE: NN` on its
  own line plus the fix list with each item's Area, using HOUSE bands: 95-100 SHIP, below 95
  REJECT, any hard-gate failure a REJECT regardless of score. Output: `.../eval.md`.
- **Revise (surgical).** If SCORE < 95, spawn a FRESH Agent W with ONLY: the frozen dossier,
  the current `blog.md`, the fix list, and its iteration number. It applies **only the listed
  fixes** to the existing draft. It does not rewrite the article. Then re-run gates, the link
  pass on changed links only, and a FRESH Agent E. Cap at 4 iterations, keep the best-scoring
  draft, stop early if two consecutive iterations show no gain.

The session lead branches on the numeric SCORE only, never on the verdict word. SCORE < 95
always triggers a revise iteration. SCORE >= 95 always ships.

**THE FIRST SCORE >= 95 IS FINAL AND TERMINAL.** Record it in `eval.md` and STOP. Never run
the evaluator again on a draft that has already passed, for ANY reason, including "the draft
changed since", "eval.md and blog.md are inconsistent", "the run was stopped and restarted, so
let me confirm", or "let me confirm". A confirmatory
re-eval adds no rigor: it re-rolls a stateless auditor whose score varies by several points
on an identical draft, and it can strand a shipping blog below the bar. Because gates and the
link pass both run BEFORE the evaluator, the scored artifact IS the shipped artifact. There
is no step after the eval that touches the draft.

Route fixes by the Area the eval assigns: **Sourcing** goes back to Agent R as a bounded
top-up for that one claim; **Structure, Draft, Mechanics** go to Agent W. "Add a source"
NEVER routes to the writer alone; the writer has no authority to invent a citation or URL.

## Status protocol
`outputs/<slug>/<topic-slug>/status.jsonl` is the ONLY progress feed. Each agent
appends its OWN lines, because the session lead cannot see inside a subagent and is forbidden
from reading subagent tool output into its own context.
- **Agent R** appends: research start / end.
- **Agent W** appends: write | revise, gates, links start / end.
- **Agent E** appends: eval start / end, plus the score on the end line.
- **The lead** appends: the terminal line ONLY (`done` | `needs_review` | `failed`), written last.
- **The backend** appends exactly one terminal line the lead never writes: `stopped`. See
  Stopping a run. It is the one terminal state whose defining condition is that the lead is
  already dead, so a rule making the lead write it is a rule that never fires.

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
status `failed` with a note naming the reason. Mock mode may skip preflight.

## Demo mode
A client whose `gates.json` says `"demo_mode": true` is ALWAYS mock: in every environment,
including a production deployment holding real credentials. A topic runs mock when `GEO_MOCK=1`
(the global test switch) OR when the client's `gates.json` says demo_mode. Such a client skips
preflight, exactly as mock already does, and it can never spend an API call or a token.

Its blogs are precoded: short, deterministic, generated with zero API calls, and templated from
whatever topic the operator uploads, so demo mode works with an arbitrary CSV rather than a
fixed list. They are saved to `outputs/<slug>/<topic-slug>/blog.md` exactly like a real
blog, so the preview drawer, the status table and the ledger all behave identically. Determinism
comes from a hash of the topic slug, never from randomness.

Every demo blog carries a visible marker at the top naming it demo content generated without
research or API calls and not for publication, and the status table shows the client is in demo
mode. A demo artifact must never be mistakable for a researched blog. A client WITHOUT demo_mode
is a real client: full pipeline, human-approved `canonical-facts.md`, no exceptions.

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
- Link verification runs inside Agent W, before the eval. There is no post-eval link step.

## Sourcing discipline
- Prefer sources local to the client's market (named in `client.md`) over generic or foreign
  data.
- Trace every statistic to its originator, not whoever last repeated it.
- Reject sources with a commercial stake in the claim: a competitor of the client, or a
  vendor writing on its own category's demand. Flag vendor research's commercial interest in
  the caveats line.
- No cited source may contradict `canonical-facts.md`.
- **Honest negatives are required, not optional.** Where a competitor or rival option
  genuinely wins, concede it plainly and earn the client's mention on documented ground
  instead. A puff piece scores lower, not higher. A revise pass must NEVER cut an honest
  negative to save words.

## Do not claim
The binding list is `clients/<slug>/canonical-facts.md`. Never publish a claim that
contradicts it, including in FAQ answers and tables. Beyond the client's own list, these
house rules always hold:
- No unsubstantiated superlatives: best, first, only, number one, leading.
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
- `questions.json` (OPTIONAL: the evaluator's questions for the human operator)
- `answers.json` (OPTIONAL: what the operator answered, written by the app, never by an agent)

Slug = topic lowercased, spaces to hyphens.

## Asking the operator
Some gaps no rewrite closes, because the missing thing is a fact only a person has. The fix list
cannot carry those: it routes to an agent, and no agent can confirm whether The Manor counts
among the amenities. Agent E may therefore ASK, by running the helper, never by hand-writing the
file:

```
python3 .claude/questions.py --out <output_dir> --slug <slug> --iter 2 --score 93 \
    --ask "Can you confirm a dated source for Kodagu's 4,106 sq km area?" \
    --why "B1 cites it undated, which caps Sourcing at 2. A dated source lifts it to 3." \
    --area Sourcing
```

Ask ONLY where a human answer changes the outcome: a fact only the client holds, a source that
needs confirming, an ambiguity `canonical-facts.md` does not resolve, or a suspected inaccuracy.
Never ask what the rubric already answers, and never ask for something the writer should simply
fix: "rephrase this H2" is a fix list item, not a question. At most 5, each carrying what
answering it unblocks. A form of fifteen questions does not get answered, it gets closed, and
the blog sits in review forever.

**`needs_review` MEANS "this blog scored below 95 AND has questions waiting for the operator", and
it means nothing else.** The status is a summons, so it must name the act it summons someone for.
A blog held with no `questions.json` is a dead end: the app renders "A human has to confirm
something before this ships" and offers no door, and the operator can do nothing with it. Four of
the five blogs that sat on `needs_review` in live data were exactly that, one of them held at 96
for a Sourcing top-up that had already resolved itself.

**Four cases, THREE terminal states, and no fourth verdict.** This table governs a loop that
RAN TO A VERDICT and nothing else. `stopped` is not a fourth row of it: a stopped run reached
no verdict, so it never enters the table. Never add a row here for a run that did not finish.

| Score | Questions | Status | What it means |
|---|---|---|---|
| >= 95 | none | `done` | It ships. |
| >= 95 | one or more | `done` | It ships ANYWAY, tagged with its open questions. Answering is an OFFER, never a demand. |
| < 95 | one or more | `needs_review` | Blocked. The operator must answer, and there is no dismiss. |
| < 95 | none | `failed` | The loop exhausted itself and cannot say what it needs, so there is no human task. |

**THE BOUNDARY IS 95 AND 95 SHIPS**, questions or not. 94 does not. This is the same rule Ship
criteria states, and an earlier draft of this feature broke it by holding a 95 open until someone
answered. A passing draft is never held: at or above the band the blog has already shipped, so an
outstanding question is the operator's option and their answer changes nothing about whether it
goes out.

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
that describes a loop which never ran. A `needs_review` claimed at 95 or above is corrected to `done`,
because a passing blog is never held. A `needs_review` with no question on disk, or with one the
app already refuses as stale, is corrected to `done` or `failed` by its score. Either way the
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

**What the answers do depends on the score, and the split is the house rule, not a preference.**
- **Score >= 95:** answering is OPTIONAL and the blog IS ALREADY SHIPPED at that score. The
  operator is offered an answer-and-rerun and may decline it forever. This is the 95-ships rule:
  the blog went out the moment it scored, so nothing about it waits on a human.
- **Score < 95:** answering is BLOCKING. There is no proceed option, because the questions are
  the evaluator saying the draft cannot be fixed by rewriting it.
- **`server/questions.py` computes `blocking` from the blog's CURRENT score, never from the score
  stored in `questions.json`.** That file records the score AT ASKING TIME and the blog moves
  after: one live blog was asked at 85 and now scores 96, and reading the 85 demanded an answer
  for a blog that had already shipped. The current score comes from `runner._summarize`, the same
  way everything else in the app reads one.
- Either way, answering triggers ONE surgical revise: the answers plus the outstanding fix list
  applied to the EXISTING draft, dossier frozen, then gates, then the link pass on changed links
  only, then a fresh evaluator. No re-research, and no new iteration budget.
- **THE HIGHER SCORE SHIPS.** If the clarified draft scores lower than the draft it replaced, the
  ORIGINAL is restored byte for byte and ships. This is what makes an optional rerun safe to
  accept and what keeps it inside the first-score-is-final rule: a rerun cannot lose the score the
  blog already had, so the contract's real prohibition, regenerating a passing draft into a worse
  one, is enforced by the engine rather than by an agent's restraint. The engine owns that
  comparison (`revise_topic`); the session lead does not make it and does not write the terminal
  line for a revise.

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

**`stopped` MEANS the operator ended the run before the loop reached a verdict, and it means
nothing else.** It is not a failure: `failed` says the engine could not produce the blog, and
conflating the two lies in the status tiles about work the engine did fine. It is not a
summons either: no question was asked, and the operator is the one who acted.

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

A stop after SCORE >= 95 does not un-ship the blog. First-score-is-final wins, and there is no
step after the eval that touches the draft, so a late stop has nothing left to interrupt.

A stop mid-revise restores the ORIGINAL draft byte for byte before writing anything, because
THE HIGHER SCORE SHIPS holds on every exit path. A cancel that skipped the restore left a half
revised draft where a 96 stood: no file was deleted and the blog was ruined anyway, which is
the outcome that rule exists to make impossible.

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
link-clean. That score is final. Write the terminal `done` status and stop. 95 ships. 96
ships. No score at or above 95 is borderline, and a better one is never worth seeking.

Write `outputs/<slug>/<topic-slug>/NEEDS_REVIEW` and the `needs_review` terminal status
ONLY where the draft scored BELOW 95 and the evaluator has asked the operator a question that is
on disk, current, and answerable. Both halves are required. Nothing else earns the status, and the
engine checks it. The four old causes resolve like this:
- **A Sourcing top-up** (a new source pulled mid-loop) is a QUESTION, asked through
  `.claude/questions.py`, naming the source and the claim so the operator can answer it without
  opening the draft. Asked below 95, it is `needs_review`. Asked at 95 or above, the blog ships
  and the question is an offer. Unasked, it is nothing: the score decides.
- **The link pass finding a claim its cited source does not support** is the same, and it is the
  same question: name the source, name the claim, ask whether the source carries it.
- **`gates.py` still FAILing** is `failed`, never `needs_review`. It is a machine failure with no
  human question in it, so summoning a human for it summons them to nothing.
- **The 4-iteration cap** is `needs_review` only if the evaluator asked something. A loop that
  stalled below 95 and has nothing to ask is `failed`.
- **An operator stop** is `stopped`, never `needs_review` and never `failed`. There is no
  question in it and no failure in it. No `NEEDS_REVIEW` file is written and no agent writes
  `questions.json` on a stop's behalf.

Never mark a blog done to clear the queue, and never mark a passing blog needs_review.

## Reporting
Per blog, one line: slug, SCORE, iterations, status, links corrected. A stopped blog reports
the last score actually seen or none, the iterations it completed, and status `stopped`; its
score is never inferred from a loop that did not finish. The lead records only
these fields plus what the terminal status line carries. It MUST NOT read dossiers, drafts,
or tool output into its own context.
