# How a blog gets made

When you tick a topic and press **Generate**, Canon opens one working session for that one blog. Inside it, three specialists run in order: a researcher, a writer and an evaluator. Nobody skips a step, and the same steps run for every brand.

This page describes what happens between the press and the article landing on your bench.

!!! danger "A press starts a real run"
    Every stage below fetches live pages and runs real agent sessions against your Claude account. Nothing here is simulated, and there is no dry run. The card above the **Generate** button says the same thing: "Real run. Each blog researches live sources and costs API credits."

## The short version

1. **research**: gather and verify sources, and write them into a dossier.
2. **write**: draft the article from that dossier and nothing else.
3. **gates**: run mechanical checks that a script can decide.
4. **links**: fetch every link in the draft and confirm it says what the article claims.
5. **eval**: a hostile reader scores the article out of 100.

Those words are what you see in the **Stage** column of the **Queue** while a blog is running. If the score is 90 or above, the blog is finished. If it is under 90, the writer gets a fix list and the last four steps run again, up to four rounds in total, and the first of those steps reads **revise** rather than **write**.

## It starts with a roadmap row

Every blog begins as one row on the brand's content roadmap. The row is the brief, and it carries three binding things: the **topic**, **what the piece covers**, and the **target prompts**, which are the exact questions in AI search this article has to be the answer to.

Those target prompts are not decoration. The opening of the article answers the first one directly, the section headings are built from them, and the FAQ at the bottom has to cover every one of them. Anything else the sheet carries, a format or a search intent, is passed to the writer as guidance under its own column heading.

See [The Content Roadmap](../guide/roadmap.md) for how those rows get there.

## 1. Research

The researcher reads the brand's own material first: the canonical facts, the resources your team uploaded, and the brand's live website. Only after that does it search outside, and it uses two tools and no others: Firecrawl for fetching pages and DataForSEO for checking what people actually search for.

Every external source is fetched in full and read whole. A search snippet is a lead, never a source, and a claim nothing supports does not make it into the dossier. The researcher traces a statistic back to whoever produced it rather than to whoever last repeated it, and it rejects a source with a commercial stake in the claim.

What comes out is a **dossier**: the frozen set of verified facts this article may be written from. Frozen matters. Once the dossier exists, nothing re-researches the topic, so every later round works from the same evidence.

!!! note "Research is the slow stage, and that is normal"
    A blog can sit on `research` for several minutes without anything being wrong. It is fetching and reading whole pages. A blog sitting on `gates` for the same length of time is the one worth asking about.

## 2. Write

The writer sees the roadmap row, the frozen dossier, the brand's canonical facts, and the scoring rubric it will be graded against. It does not see the researcher's reasoning or its rejected sources.

It writes to a fixed shape, because that shape is what AI search engines lift from: an answer to the primary prompt in the first 100 to 150 words, a TL;DR under the headline, five to eight headings that each trace to a target prompt, at least one comparison table, three or more statements that make sense quoted on their own, an FAQ of six or more pairs, and a sources section last.

The writer has no authority to invent a citation or a URL. If the dossier does not support a claim, the claim does not get written.

## 3. The mechanical gates

The gates are a script, not a model. They decide the things a machine can decide, so that no evaluation pass is spent on a problem a checker could have caught. The writer runs them and keeps fixing until they pass.

What they check:

| Check | What fails |
| --- | --- |
| Word count | The brand's band. The house default targets 1200 to 2000 words, warns above 2000, and fails above 2500 or below 1200. |
| Dashes | Any em dash or en dash. Commas and colons instead. |
| Banned phrases | The house filler list, plus anything the brand adds. |
| Sentence openings | A sentence starting with "And" or "But". |
| Paragraph shape | Any paragraph or bullet over 4 sentences. The 2 sentence floor is a target rather than a check. |
| Hedging | might, could, possibly, perhaps, typically. |
| Entity clarity | Generic references like "the company" or "the brand" instead of the real name. |
| Competitor silence | Where the brand is set to never name rivals, any rival name or rival framing, quotes included. |
| Voice | The reader addressed as "you", the brand speaking as "we", and every liftable block naming the brand in full. |
| Structure | A missing TL;DR, fewer than 5 or more than 8 headings, no comparison table, fewer than 6 FAQ pairs, or a sources section that is not last. |
| Link log | Any external link in the draft that was not recorded as verified. |

A few checks only warn rather than fail, superlatives among them, and a warning lets the draft carry on. The last row is what ties the gates to the next stage.

## 4. Link verification

The writer fetches every link in the draft and confirms two separate things: that the URL resolves to the page it is supposed to, and that the page actually contains the claim the article attaches to it. A link that 404s, redirects to a homepage, or points at a page that does not carry the claim gets fixed or removed.

Each verified URL is written to a log beside the article, and the gates then check the draft against that log. That is the point of the two running in this order: the link pass is checked rather than trusted. On a second or third round, links already in the log are not fetched again.

The link pass may fix or remove a link. It may not add a new claim or a new source, so a claim with nothing behind it becomes a sourcing problem rather than a quiet patch.

## 5. The evaluator, and the score

The evaluator is deliberately hostile and deliberately blind. It sees the finished draft, the scoring rubric, the brand's canonical facts, the brand's standing instructions and anything you typed for this run, and any answers you have already filed. It never sees the dossier, the writer's reasoning, or any earlier evaluation, so it cannot be talked into a score by the same reasoning that produced the draft. It reads your instructions and your answers so it does not mark the article down for obeying them: a claim the writer cut because you said it was wrong would otherwise read as missing detail.

It grades 14 dimensions and normalises them to a number out of 100, then writes that number and a fix list, with each item labelled by area: **Sourcing**, **Structure**, **Draft** or **Mechanics**. Because the gates and the link pass both ran before it, the article it scores is the article you will read.

## The bar is 90

There is one number in Canon and it is 90. At 90 and above the blog is finished and the loop ends at once. Below 90 it does not ship on its own.

There is no middle band and no second threshold. An 89 is not a pass, and a 96 is not more finished than a 91: both are done, and neither is worth rerunning for a better number.

**The first score at or above 90 is final.** Canon never re-scores an article to confirm it, because the evaluator is stateless and its score moves by several points on an identical draft. A confirming rerun would add no rigour and could strand an article below a bar it had already cleared.

!!! info "Why 90 and not 95"
    The bar used to be 95, and the rubric stopped being able to produce it. Two new scoring dimensions changed the arithmetic, and the normalisation skips the value 95 entirely: 85 of 90 points rounds to 94 and 86 of 90 rounds to 96. A real twelve blog run never reached 95 once, so every blog burned all four rounds and failed, which is where the quota went. 90 is exactly reachable, at 81 of the 90 available points.

## The revise loop

When the score is under 90, a fresh writer gets the frozen dossier, the current draft and the fix list, and applies **only the listed fixes**. It does not rewrite the article. Then the gates run again, the link pass runs on changed links only, and a fresh evaluator scores it again.

Four rounds is the maximum. The loop also stops early in two other cases: two rounds in a row with no gain, and a **Sourcing question**, which is the evaluator saying only a person can supply the missing fact. No rewrite closes that, so spending another round on it buys nothing.

Scores go up and down across rounds. A dip is not a reason to stop, because Canon keeps the best-scoring draft: when the loop ends, the highest scoring version and its evaluation are the ones restored. So a later round can cost tokens, and it cannot damage the article.

The score trail on a blog's page shows every round, so `76` then `88` then `88` then `94` reads as a climb rather than one final number with no history.

!!! note "Retrying a topic starts the count again"
    A blog that has run before keeps its whole history on disk, and a retry does not inherit a spent budget. A retried topic gets four fresh rounds. If the retry ends lower than the previous attempt, Canon puts the earlier result back, so a retry cannot make a blog worse.

## When the evaluator asks a question

Some gaps no rewrite can close, because the missing thing is a fact only a person holds. In that case the evaluator files a question, and the article is **held**.

A held article does not ship at any score. A 96 with an open question waits exactly as an 84 does, because a question means the evaluator could not tell whether the article is true, and a piece that might be false does not go out because it scored well. There is no dismiss and no proceed anyway.

The questions are capped at five, and each one has to be answerable in about ten seconds without opening the draft. Either your team or the client can answer. When your team answers from the dashboard, one surgical revise starts straight away: the answers are applied to the existing draft, the checks rerun, and a fresh evaluator scores it. When the client answers from their portal, the answers are recorded and an operator presses the rerun to start that same revise, because the run spends this machine's quota.

**The clarified article ships even if it scores lower.** A truthful answer often forces a claim to be cut, which costs factual density and therefore points. The lower score is the truth costing points, not the article getting worse, so the clarified version is the one that stands.

!!! warning "Nobody answering means the blog never ships"
    There is no timeout on a held article and no escalation. It waits for as long as it takes. That is a deliberate choice: releasing an unverified draft on a timer would publish "we could not confirm this" as though it were confirmed.

## Below the bar

A blog that ends under 90 is recorded as failed, and its draft stays on disk exactly as scored. Canon splits that range in the dashboard so a near miss reads differently from a collapse:

- **80 to 89** wears the amber **Below bar** tag. The draft is one rerun short and worth reading.
- **Under 80** wears the red **Failed** tag.

Both are the same underlying verdict and both get the same controls: read it, edit it, comment on it, **Retry this topic**, **Send to client**, or post it.

**Sending a below bar blog is allowed, and it is a person's call.** There is one release door at every score, and when the article missed the bar the engine promotes it on the way out, recording in the trail that it failed at 87 and then a person sent it. The evaluator's number is never rewritten. What the press waives is the 90 bar and nothing else: the gates and the link pass ran before the score, so the article you send is already mechanically clean and link clean.

## A fixed number at a time, and everything else queues

Canon works a fixed number of blogs at once, across every brand in the deployment. It is one setting: the built-in default is two, and this deployment is set to five. Whatever the number is, it is the same queue for everything: a batch from the **New** tab, a single retry, a rerun with a client's answers, and a social repurpose each take one slot.

The **Generate** card tells you the number before you press. Beside the button it reads "Writes 3 blogs for *brand*, 5 at a time".

A blog over the limit is never refused, it is queued, and it starts the instant a slot frees, in the order it was submitted. When a run is already live anywhere, the button itself reads **Add to queue** rather than **Generate**, because that is what the press does.

The **Queue** sits under the topic list on the **New** tab, and it appears only while something is in flight. Its header reads something like "2 running, 6 queued, 1 finished of 9, across every brand", and its columns are **#**, **Topic**, **Brand**, **Stage** and **Since**. A queued row reads **Queued** in the Stage column, and opening the row says "Waiting for a slot. The engine runs a fixed number of blogs at once across every brand, so this starts as soon as one ahead of it finishes."

!!! tip "Width decides what you own when the quota runs out, not what a blog costs"
    Running more blogs at once does not make any single blog cheaper. It changes what you are holding when a usage limit lands mid batch. A real five wide run produced twelve half finished blogs and zero shipped, and an untouched topic retries cleanly where a half done one does not.

## Stopping a run

Two stops exist and they are different acts.

**One topic**: the stop control at the end of that row in the **Queue**. On a running blog it asks "Stop this blog while it is being written?" On a queued one it removes it from the queue with no confirmation, which costs nothing because no work has started.

**A whole brand**: the **Stop** button on the session card, which asks "Stop generating blogs for *brand*?" It ends the session running now and everything queued behind it. Other brands keep running.

Either way, **nothing is deleted**. Blogs that already finished keep their status, their score and their ledger entry. A blog stopped mid flight keeps whatever it had researched or written, on disk, so resuming it later is cheap. A blog that never reached a slot cost nothing at all.

## What you get at the end

For every topic Canon keeps the article itself, the evaluation with its score and fix list, the research dossier, the verified link log, and the run's own progress trail. The blog's page in the dashboard reads all of them, and shows the first three on its **Blog**, **Eval** and **Dossier** tabs.

Where the article sits after all that, and who owes the next act, is [What each status means](blog-states.md).
