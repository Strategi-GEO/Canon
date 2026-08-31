# Runs, the queue, and stopping work

This page is about the machinery underneath the writing: what happens after you press **Generate**, why your blog is sometimes waiting, how to read the queue, and what a stop does and does not throw away.

If you have not written a blog yet, read [Your first blog, start to finish](../guide/your-first-blog.md) first. This page assumes you have pressed **Generate** at least once.

## What a run is

When you tick rows and press **Generate**, Canon accepts one **run** for that brand. The run is the whole submit: every row you ticked, in one go.

Inside the run, each topic is separate work. Each blog gets its own session on the engine, writes its own files, and reaches its own verdict. A blog that dies does not touch the blog beside it, and a blog that finishes early does not wait for the slowest one in your batch.

If the brand has no fact base yet, the run builds one before it writes anything. The card on **Overview** says which half it is on: the heading reads **Generating canonical facts** first, then **Generating blogs**. A fact base build can run for minutes with every blog row sitting still, and that is normal.

!!! warning "Every run spends real money"
    There is no practice mode. Each blog researches live sources through Firecrawl and DataForSEO, and the writing runs on the Claude account this machine is logged in to. Ticking twelve rows starts twelve blogs. Tick what you actually want written.

## A session and a blog are different things

Two counts are on screen at the same time and they use the same word, so it is worth thirty seconds.

| | A **session** | A **blog** |
| --- | --- | --- |
| What it is | One press of **Generate** for one brand | One topic inside that press |
| Where you see it counted | The topbar, as "2 sessions running, 1 queued" | The **Queue** table, as "3 running, 2 queued" |
| What "queued" means for it | Nothing in it has started yet | This one topic is waiting for a slot, while its siblings may be running |

So the topbar can say one session is running while the queue table below says two blogs are running and three are waiting. Both are true and they are counting different things.

## How many blogs run at once

Canon works on a fixed number of **blogs** at a time, across every brand in the system. That number is a setting called `GEO_CONCURRENCY`. Canon's built-in default is two. This deployment is set to five, which is the number the dashboard prints in "Writes *N* blogs for *brand*, 5 at a time".

Every door into the engine takes one slot out of that same number:

- a batch of blogs you ticked and generated
- a retry of a single failed topic
- the rerun that applies answers to the evaluator's questions
- a channel post (LinkedIn, Medium, Bluesky or X)

!!! info "Busy never means refused"
    Nothing is ever turned away because the engine is working. A blog over the limit waits, and starts the moment a slot frees, in the order it arrived. The button on the **New** tab tells you this by changing its own word: it reads **Generate** when the engine is idle and **Add to queue** when something is already running. The act is identical either way.

Because the queue spans every brand, the reason your blog is waiting is very often somebody else's blog. That is why the queue table has a **Brand** column and tags rows that are not yours as **other brand**.

## Reading the Queue table

The **Queue** table sits on the **New** tab of the **Blogs** page, under the roadmap rows you pick from. It renders nothing when nothing is in flight, so an empty page means an idle engine rather than a broken one. See [The Blogs tab](../guide/blogs.md) for the rest of that page.

The line above it reads something like:

> 3 running, 2 queued, 1 finished of 6, across every brand · 14m elapsed

The counts leave out anything that is zero, and the elapsed on the end measures the **oldest blog still running**, not your batch. There is no single run to time here, because the table spans several.

| Column | What it holds |
| --- | --- |
| **#** | The blog's number on the roadmap sheet the run started from. The same number the Blogs table prints, so "blog 6" and "queue row 6" are one topic. A dash means the run carries no number for it. |
| **Topic** | The title, read back out of the file name. Hover it for the exact slug. |
| **Brand** | Which brand this blog belongs to, tagged **other brand** when it is not the one you are looking at. |
| **Stage** | What the blog is doing right now, or `Queued` when it has not started. |
| **Since** | `waiting 4m` while queued, a plain clock while running, and `took 22m` once it lands. |

Rows never move. The table sorts by **#** and stays there, so a blog taking a slot or finishing changes its own cells and nothing jumps.

Click anywhere on a row to expand it. You get the five stage marks, the score at each iteration, the stage clock beside the total, and the engine's own note.

!!! note "Channel posts take a slot but have no row here"
    A LinkedIn post or an X thread being written is holding one of the same slots your blogs are waiting for. They are not listed in this table, because they are not blogs and the row's stop control cannot reach them. If the queue looks emptier than the wait suggests, that is usually why. See [Social channels](../guide/channels.md).

## The stages a blog goes through

**Stage** shows the engine's own word for what is happening, and these are all of them.

| Stage | What is happening |
| --- | --- |
| `research` | Sources are being found, fetched in full, and vetted. This is the long stage. A blog sitting here for minutes with nothing to say is the normal case. |
| `write` | The draft is being written from the frozen research. |
| `gates` | The mechanical checks: word count, banned phrases, paragraph shape, voice, entity names. |
| `links` | Every link in the draft is fetched and confirmed to resolve and to carry the claim it is cited for. |
| `eval` | The draft is being scored against the rubric. |
| `revise` | The score missed the bar, so the listed fixes are being applied to the existing draft. |

Once a blog lands, the **Stage** cell stops naming a stage and shows the verdict instead. On a blog this browser was not streaming it reads **Finished**, which says the topic settled without guessing which way, and the blog's own page carries the verdict.

A blog past its first attempt carries a chip reading `iter 2`, `iter 3` or `iter 4`. Four is the cap.

There is no progress bar and no percentage anywhere in Canon, deliberately. A blog can pass on its first evaluation or be revised up to four times, so there is no total to measure against. The **Since** column and the stage name beside it are the honest numbers.

## Where else the engine's work shows up

=== "The topbar"

    A small status control on the right of the topbar reads "**1 session running, 2 queued**". It appears only when something is live, so an idle Canon has nothing there.

    Click it and a panel titled **Sessions** opens, listing every session in the engine, in the order they will be worked. Each row carries the brand name, its slug, **Queued** or **Running**, how many blogs it holds, and a clock reading `waiting 6m` or `running 12m`. Clicking a row takes you to that brand's **New** tab.

=== "The notifications bell"

    A bell sits beside it, appearing once anything has finished while this tab was open: a blog run landing, a description drafting, or the client acting in their portal. It is empty until then, and opening it marks everything read.

    It only reports what happened **while this tab was open**. Anything from before you got here lives on the brand it belongs to.

=== "The brand Overview"

    A brand with a live session gets a card on its **Overview**. The heading names the phase, and the counts beside it sum to the whole batch: running, queued, shipped, in review, failed, stopped.

    **Open the run view** takes you to the brand's **New** tab, where the queue table is. Once the session ends the card keeps its closing summary and offers **Read the blogs** instead, plus an X to dismiss it.

## Stopping one topic

Every row in the **Queue** table that has not landed carries a stop control on the right. It means two different things and the engine decides which at the moment you press it.

=== "A queued row"

    Nothing has been spent on it, so there is no confirmation. It leaves the queue at once and the toast reads "Removed from the queue", with "It never started, so nothing was spent. The topic is back on the New tab."

    Hovering the control says the same thing: "Remove from the queue. It has not started, so nothing is lost."

=== "A running row"

    A dialog asks first, titled **Stop this blog while it is being written?**, with **Keep writing** and **Stop it**.

    The dialog tells you what survives: whatever the session already wrote stays on disk. If an evaluator has scored a draft, even on the first iteration, the blog moves to **Internal review**. If it has not, the topic goes back to **New**.

A row that has already landed carries no stop control at all, because there is nothing left to stop.

## Stopping every run for a brand

The session card on a brand's **Overview** carries a **Stop** button. This is the one to press when a whole batch is wrong.

It opens a confirmation titled **Stop generating blogs for *brand*?**, and the dialog names the real numbers: how many blogs in this session have finished and stay, how many are in flight and stop here, and how many have not begun. The buttons are **Keep it running** and **Stop the session**.

It stops everything for that brand at once: the session running now and anything queued behind it. **Other brands keep running.** Pressing it twice is not an error and does nothing the second time.

## What a stop keeps and what it discards

This is the part people are afraid of, so here it is plainly. A stop deletes nothing.

| Group | What happens to it |
| --- | --- |
| Blogs that already finished | Kept exactly as they are, with their score, their status and their place in the ledger. |
| Blogs in flight | Discarded. They stop where they are and they never ship. Their files stay on disk. |
| Topics that had not started | They never start. Nothing was spent on them. |

Because the files stay, a stopped topic is cheap to pick back up: the research is the expensive half of a blog and it is still sitting there. Press **Generate** on the brand again to resume.

A stopped blog is never added to the brand's ledger of shipped work, and it never reaches a client on its own.

!!! note "A finished blog is never un-shipped by a stop"
    A blog that reached its verdict microseconds before you pressed **Stop** keeps that verdict. The engine only writes a stop line where no verdict exists yet, so there is no window in which stopping a brand takes a shipped article back.

There is one exception to the word **Stopped**. If the evaluator had already written its questions when the stop landed, the blog is recorded as held for your answer rather than as stopped, because a question that was asked is not un-asked by somebody pressing stop. You answer it exactly as you would any other held blog, on the blog's own page. See [Reviewing and editing a blog](../guide/reviewing.md).

## When the engine stops on its own

Two safety mechanisms can end work you did not end. Both exist because of real failures, and both are described in [Troubleshooting](../reference/troubleshooting.md) with what to do about them.

**A blog that goes silent loses its slot.** Canon treats a blog as healthy for as long as it keeps writing progress lines, however long that takes. If a blog writes nothing at all for two hours, the engine cancels it, and if the cancel is ignored for another two minutes it takes the slot back and marks the topic finished with the note "the session stopped responding and did not answer a cancel, so the engine reclaimed its queue slot". The blog reads **Did not finish**, and the fix is to generate it again.

**Two dead sessions in a row halt everything.** If two blog sessions in a row die inside a minute having written nothing, the engine stops opening new sessions for every brand for fifteen minutes. The usual cause is the Claude account's usage window being exhausted. Any session that writes a single line clears it at once, and after the cooldown one topic is allowed through to test the water.

Nothing on screen names that second one. What you see is blogs not starting. If the queue is full of waiting rows and nothing has moved for a while, that is the case to check for.
