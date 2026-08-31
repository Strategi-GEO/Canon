# Frequently asked questions

Short answers to the things people ask in their first week. Each one links to the page that covers it properly.

## Money and quota

### What does one blog cost?

Canon cannot tell you a number, and it does not pretend to. There is no meter in the app.

What it can tell you is what a blog buys. One blog is one session on the engine, running the `claude` CLI against the Claude account **this machine** is logged in to. Inside that session a researcher fetches and vets sources, a writer drafts and checks the draft, and an evaluator scores it.

If the score misses the bar, a writer and an evaluator run again, up to four rounds in total. Research is the expensive half.

So a blog that passes first time is much cheaper than one that goes four rounds, and both are real spend. There is no practice mode and no demo mode.

### Does anything charge me by accident?

No. Nothing generates on its own except one case: publishing a blog automatically starts a LinkedIn post and a Medium article for it. Everything else waits for you to press something.

### Why did everything stop with nothing on screen to explain it?

Most likely the Claude account's usage window is exhausted. Sessions then die inside a minute having written nothing, and after two of those in a row Canon halts dispatch for every brand for fifteen minutes rather than burning the rest of your batch proving the same point.

Nothing was spent on the topics that did not start, and they retry clean. See [Troubleshooting](troubleshooting.md).

## Scores and shipping

### My blog scored 82. What do I do?

The bar is 90, and there is nothing between. A blog at 82 is tagged **Below bar** in amber rather than red, because it is a near miss you decide about rather than a failure.

You have two doors and they are both legitimate:

- **Retry this topic** takes you to the **New** tab with that row already ticked, so the run starts when you press **Generate**. A rerun can never make the blog worse: if it ends lower, the engine restores the earlier verdict exactly as it was.
- **Send to client** releases the draft you have read, on your authority. Canon records this honestly: the trail reads failed at 82, then sent by a person, with your name and the score on it.

Read the draft before you choose. The whole reason a sub-90 blog waits for a person is so a person reads it.

### Why does the same blog score differently when I run it again?

The evaluator is a fresh reader every time, with no memory of the previous run, so its number moves by a few points on an identical draft. That is also why Canon never re-scores a blog to double-check: a confirmatory re-run adds no rigour and can strand a blog under a bar it had already cleared.

The first score at or above 90 ends the loop and stands.

### What is the difference between Failed, Below bar, Stopped and Did not finish?

| Tag | What happened | What it wants |
| --- | --- | --- |
| **Below bar** | It was scored and landed between 80 and 89 | You read it, then retry or send |
| **Failed** | It was scored, landed under the bar, and had nothing to ask | Same as above, with less to like |
| **Stopped** | Someone ended the run before it reached a verdict | Its research is still on disk. The run view offers **Pick this topic back up**, which returns to the roadmap with the row ticked |
| **Did not finish** | The run reached no verdict at all: the session died, stopped responding, or was refused before it opened | Generate the topic again. Nothing judged this article, so any score on the row belongs to an earlier attempt |

**Did not finish** has no send button, and that absence is deliberate. Sending a below-bar blog means overruling the bar on a draft an evaluator judged. Here nothing judged anything, so there is nothing to overrule.

### The evaluator asked a question. Can I skip it?

No. A blog with a live question is held at any score, including 96, and there is no dismiss and no proceed anyway.

The reason is what the old rule shipped: two blogs went out at 96 carrying claims the brand's own facts contradicted. A question is the evaluator saying it cannot tell whether the draft is true, and a draft that might be false does not ship because it scored well.

Answering it starts one rerun that applies your answers. The clarified draft always ships, even if it scores lower, because a lower score on a truthful draft is truth costing points. See [Reviewing and editing a blog](../guide/reviewing.md).

## Sending, editing and publishing

### Can I edit a blog after I send it to the client?

Not while they are reading it. Once you press **Send to client**, the client is reading exact pinned bytes, so editing would change the article underneath someone mid-review. The only act left on that bench is posting to the CMS, which changes nothing they are reading.

Editing comes back the moment the client asks for changes, which is what that state is for. After the client **approves**, nobody edits it again, you included: the approval stamp records that the client accepted those exact words, so an edit after it would make the record assert something they never agreed to.

### Why can I not publish to the client's own website yet?

Because they have not approved it.

Canon has two publishing destinations and they are not the same act. Posting to the **Strategi CMS** files a draft that one of our own editors reviews, so it releases nothing and the door is open from internal review onwards. Posting to the **client's own website** publishes the article live on their domain, which is the final release, so it waits for their sign-off.

Which destination a brand uses is set on the brand, in **Settings** under **Blog destination**. A brand with no destination configured cannot post at all. See [Publishing a blog](../guide/publishing.md).

### Do clients see my comments?

No. The client portal shows only the comments the **client** wrote. Your own comments and the passages you sent to Claude stay on your side.

What the client does see is their own suggestions and what became of them, including the ones you dismissed. That is on purpose: a suggestion that vanished with no trace reads as ignored.

### Do clients see the score?

No. The score never crosses to the client's side of the app.

### Why is Bluesky not generating on its own?

Because nobody wants a short-form post fired off for every article without being asked.

Publishing a blog automatically starts a **LinkedIn** post and a **Medium** article for it. **Bluesky** and **X** are manual only: nothing appears on those two tabs until you tick finished blogs and press **Generate**. Apart from that one difference, all four channels behave identically.

Every channel post you tick is its own session on the engine and takes a queue slot exactly like a blog does. See [Social channels](../guide/channels.md).

## Runs and the queue

### What happens if I close my laptop in the middle of a run?

It depends what you close.

| What you do | What happens to the run |
| --- | --- |
| Close the browser tab | Nothing. The run lives in the engine, not in the tab. Reopen the page and it reattaches, replaying everything it missed |
| Put the machine to sleep | The engine sleeps with it and picks up where it left off. Canon tolerates two hours of silence before it treats a blog as wedged, so a short sleep costs nothing |
| Choose **Quit** from the menu | The engine and the dashboard both stop. Blogs in flight are lost, though their files stay on disk and a fresh run picks the research back up |

A long sleep is the risky one. If a blog writes nothing for two hours the engine reclaims its slot and marks the topic **Did not finish**, and you generate it again.

### Why is my blog waiting when nothing of mine is running?

Because the queue is shared across every brand in the system, not per brand. The engine works a fixed number of **blogs** at a time, and the blog ahead of yours very often belongs to somebody else. The **Queue** table tags those rows **other brand** so you can see it.

Nothing is ever refused for being busy. Your blog waits and starts the moment a slot frees, in the order it arrived. See [Runs, the queue, and stopping work](../admin/runs-and-queue.md).

### Can I run more blogs at once?

The number is a setting your admin controls, and raising it is not free in the way it looks.

It saves nothing per blog. What it changes is what you own when the usage limit lands mid-batch. A real run at five wide produced twelve half-finished blogs and zero shipped; the same quota at two wide buys a handful of **finished** blogs and leaves the rest untouched, and an untouched topic retries clean where a half-done one does not.

### Does stopping a run delete anything?

No. Nothing on disk is ever deleted by a stop.

Blogs that finished are kept exactly as they are. Blogs in flight stop where they are and never ship, though their research and drafts stay on disk. Topics that had not started never start and cost nothing.

That is why picking a stopped topic back up is cheap: the expensive half is already paid for.

### A blog finished a second before I pressed Stop. Did I lose it?

No. Canon only records a stop where no verdict exists yet, so a blog that reached its verdict first keeps it, keeps its score, and keeps its place in the ledger.

## Working together

### Six of us use Canon. Do we share a queue?

You share the **work** but not the **engine**. Every blog, comment and approval lives on one shared record, so all six of you see the same articles in the same states. Each of you runs your own copy of Canon on your own machine, and generation runs there, against your own Claude login.

So the queue you are looking at is your machine's queue, and the quota a run spends is yours.

### Can two of us work on the same blog?

Yes, on the shared record. Locks that matter are enforced there rather than in your browser, so a teammate resolving a comment on the same article from their machine is counted against the same limits you are.

While a run owns an article, every door is shut for everyone. Two writers on one draft is how a revision loses text.

## Files

### Where are the actual files?

Every blog gets a folder on the machine that wrote it, under `outputs/<brand>/<topic>/`. The blog page prints the real path under each of its three tabs, **Blog**, **Eval** and **Dossier**, so you can open the file in Finder.

| File | What it is |
| --- | --- |
| `blog.md` | The article |
| `eval.md` | The score and the fix list |
| `dossier.md` | The frozen research the writer worked from |
| `status.jsonl` | The progress feed the queue table reads |
| `links-verified.txt` | Every link that was fetched and confirmed |

You do not need any of these to use Canon. They are there when you want to see the workings.

### Why did my roadmap refuse to change while a run was going?

Because the run is reading it. Canon never edits your roadmap sheet, and it will not let the sheet move underneath a run that was dispatched from it. The lock lifts as soon as the run ends, including when you stop it.
