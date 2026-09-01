# What each status means

Every blog in Canon is in exactly one state, and one piece of code decides which. The tag you see on a row is that state, and hovering it tells you who owes the next act.

Your team and the client are looking at the same article at the same moment, so they see the same state through two different sets of words. A client is never shown "Internal review", because a client cannot see the article at that point at all.

This page is the glossary. Keep it open the first few weeks.

## The admin table

These are the tags your team sees on the **Blogs** tab and on a blog's own page.

| Tag | What it means | Who owes the next act | What you can do |
| --- | --- | --- | --- |
| **Not generated** | A roadmap row nothing has written yet. | You | Tick it and press **Generate**. |
| **Generating** | A run is live on this article. | The engine | Nothing to the article. You can stop the run. |
| **Has questions** | The evaluator asked something only a person can answer. Held at any score. | You or the client | **Answer**. |
| **Answers submitted** | The client answered, and the rerun those answers are owed has not landed yet. | You | **Rerun with their answers**, then edit, comment and send. |
| **Internal review** | It passed and it is on your team's bench. | You | Edit, comment, **Send to client**. |
| **With client** | Sent for review. | The client | Nothing that changes the bytes. |
| **Changes requested** | The client asked for something since the last send. | You | Edit, comment. The client keeps reading your latest version, so there is no second send. |
| **Approved** | The client accepted these exact bytes. Locked. | Nobody | **Publish** it. |
| **Published** | Live on the client's own site. | Nobody | **Unpublish**. |
| **Below bar** | Scored 80 to 89. Under the bar, close enough that a rerun is worth it. | You | Edit, comment, **Send to client**, **Retry this topic**. |
| **Failed** | The run finished without a shippable draft and had nothing to ask. | You | The same bench as **Below bar**. |
| **Did not finish** | The run reached no verdict at all. | You | Read or annotate what an earlier attempt left. Generate the topic again. |
| **Stopped** | Someone ended the run before it reached a verdict. | You | Generate again to resume. |
| **Unknown** | No readable status line for this article. | You | Generate the topic again. |

The publish button names the platform the brand's site runs on, so it reads **Post to Wordpress**. Canon refuses the press until the client has approved the article, because it puts the article live on their domain. See [Organisations and brands](organisations-and-brands.md#where-a-brands-blogs-publish).

## Each one in full

### Not generated

A topic on the roadmap that nothing has written. It is the only tag that describes a plan rather than an article, which is why it appears on the **New** tab and nowhere else.

Tick the row and press **Generate**. Nothing else moves it.

### Generating

A run owns the article right now. Every door is shut while that is true, including doors a finished blog would offer, because two writers on one draft is how a revise loses work.

This outranks everything else. An article that was sent, came back with change requests, and is being rerun reads **Generating** while that run is live, because the true answer is that the engine is working on it.

Watch it in the **Queue** under the topic list on the **New** tab, where the **Stage** column names which stage a blog is on.

### Has questions

The evaluator could not tell whether something in the draft is true, so it asked. The article is **held**, and answering is the only door.

**This holds at any score.** A 96 with an open question waits exactly as an 84 does. There is no dismiss and no proceed anyway, because the question is the evaluator saying it cannot verify a claim, and a draft that might be false does not go out because it scored well.

There are at most five questions and each is written to be answerable in about ten seconds. Either your team answers from the blog's page, using **Answer**, or the client answers from their portal. Either way one surgical revise follows: the answers are applied to the existing draft, the checks rerun, and a fresh evaluator scores it.

!!! warning "An unanswered question strands the article forever"
    There is no timeout, no expiry and no escalation. A held blog never ships and never enters the ledger for as long as nobody answers. That is a chosen cost: the alternative is publishing "we could not confirm this" on a schedule.

### Answers submitted

The client filed their answers and the article is back with you. This tag covers two moments, and the buttons on the page tell you which one you are in.

If the rerun has not happened yet, the page offers **Rerun with their answers**. The client's portal has no engine behind it, so their submit dispatches nothing: somebody on your side presses that button.

If the rerun has already landed clean, the article is a finished draft nobody has delivered, and the page offers edit, comment and **Send to client** instead.

The client sees **Answered** through all of it, with the note "Thanks, we have your answers. Our team is working them into this article now."

### Internal review

The article scored 90 or above with nothing held against it. It is on your team's bench and the client cannot see it.

This is where you read it properly, edit anything you want changed, and decide when the client sees it. **Send to client** is the press that makes it visible in the portal.

### With client

Sent. The client is reading the exact version that was pinned when you sent it, and they owe you an approval or a change request.

**Your team has no editing controls here on purpose.** An edit at this point changes the article underneath someone mid review. Nothing on this bench changes the bytes.

### Changes requested

The client asked for something since the last send. Resolve or dismiss each comment, and the client keeps reading the latest version as you go, so a resolved comment reaches them without a second delivery.

Once every comment in the round is addressed, the tag changes to **With client** with the note "Every comment in this round is addressed and the client is reading the updated article." The underlying state has not changed, only the label, so the article stays with the client and your editing and comment controls stay available. There is no second send to press: the round ends when they approve.

### Approved

The client accepted these exact bytes. The article is **locked for everyone**, your team included.

The approval stamp records that the client accepted this specific version, so any edit after it would make the record assert something the client never did. Posting is the one act left, because it changes nothing about the article.

!!! danger "There is no un-approve"
    A client who approves by mistake cannot be walked back from inside the app, and neither can your team.

### Published

The article is live on the client's own website, where anyone can read it.

Pressing **Publish** again updates the same article rather than creating a second one. If somebody edited it on their own site after your last push, Canon declines to overwrite it and tells you, which is a success and not something to retry.

One control is left: **Unpublish from *site***. It acts on our own push rather than on the article, and it is the way out of a mistaken publish that does not need somebody logging in to the client's own site.

### Below bar and Failed

Both are the same verdict: the run finished and the score missed 90. The split is a label, drawn on the score alone, so a near miss reads differently from a collapse.

**Below bar** is 80 to 89, in amber: "Under the ship bar with nothing left to ask, and close enough that a rerun is worth it. Retry it for the bar, or send it to the client if you have read it and are happy with it."

**Failed** is anything under that, in red, or a run that scored nothing at all.

Both get the same bench: edit it, comment on it, **Send to client**. Posting is not a way out of either, because every push waits for the client's approval and an article at this stage has not been sent to them, let alone approved. Retrying is not a button on the bench, because a retry is a run: the row stays selectable on the **New** tab, and a blog's page carries a **Retry this topic** link that takes you there with the row already ticked.

**Sending one is your call and it is recorded as yours.** Canon appends a new done verdict saying a person sent it, so the trail reads "failed at 87" and then that send. The evaluator's number is never rewritten, and who pressed send is recorded on the blog itself.

### Did not finish

The run reached no verdict at all: the session died, stopped responding, or was refused before it opened. This is split out from **Failed** because the two want opposite things from you.

A failed blog has a draft an evaluator read and scored, so the question is whether to send it. This one was never judged, so there is nothing to decide and the answer is to generate the topic again. Anything the row shows came from an earlier attempt, and reading its score as a verdict reads a number that belongs to a different run.

There is **no send and no publish** here, and the absence is the point: releasing a draft on your own authority rests on your having read one an evaluator judged, and here nothing judged anything. Editing and commenting survive, because a died run often leaves a real draft from an earlier attempt.

### Stopped

Somebody ended the run before it reached a verdict. This is not a failure: **Failed** says the engine could not produce the blog, and **Stopped** says a person decided.

No score describes a stopped blog, so nothing is released from here and the bench is empty. Nothing was deleted either: whatever was researched or drafted is still on disk, which is what makes generating the topic again cheap.

### Unknown

Canon could not read a status for this article. It sorts near the top of the list rather than the bottom, alongside **Failed**, because a blog that cannot explain itself wants a human early. It is not finished, it is mute.

## How the list is ordered

The **Status** column sorts by how much a row wants a person, not alphabetically:

**Has questions**, then **Changes requested**, then **Answers submitted**, then **Failed** and **Did not finish**, then **Unknown**, then **Stopped**, then **Internal review**, **Generating**, **With client**, **Approved**, **Published**, and **Not generated** last.

The two states blocking somebody outside your team come first. A stopped blog ranks below the ones that want an explanation, because it is the only state you already know about: you caused it.

## What the client sees

The client's portal uses different words for the same states, and hides the ones that are none of their business. No label on their side mentions a score, an evaluator or an iteration.

| The state | The client's tag | Can they see it | What they can do |
| --- | --- | --- | --- |
| Generating | In progress | No | Nothing |
| Has questions | **Waiting on you** | Yes | Answer |
| Answers submitted | **Answered** | Yes | Nothing. They read the draft and their own answers. |
| Internal review | In progress | No | Nothing |
| With client | **Ready to review** | Yes | Approve, or select a passage and ask for a change |
| Changes requested | **Pending comments** | Yes | Approve, or add another note |
| Changes requested, all addressed | **Comments resolved** | Yes | Approve, or add another note |
| Approved | **Approved** | Yes | Nothing. It is locked. |
| Published | **Published** | Yes | Nothing |
| Below bar, Failed, Did not finish, Stopped, Unknown | In progress | No | Nothing |

!!! note "A client can approve while comments are open"
    Approving mid round is the client saying the remaining notes no longer block them. It is their call to make, and Canon does not refuse it.

## Social post statuses

A LinkedIn post, a Medium article, a Bluesky post or an X thread is not a blog. It has no score, no questions and no failure verdict, so it runs a shorter set of states on the **LinkedIn**, **Medium**, **Bluesky** and **X** tabs.

| Tag | The client's tag | What it means | What you can do |
| --- | --- | --- | --- |
| **Generating** | In progress | A run is producing this post. | Nothing until it finishes. |
| **Created** | In progress | Generated and in internal review. The client cannot see it. | Refine it, then **Send to client**. |
| **With client** | **Ready to post** | Sent. The client owes an approval or a change request. | Wait. |
| **Changes requested** | **Pending comments** | The client asked for changes since the last send. | Resolve or dismiss each one, then **Send again**. |
| **Approved** | **Approved** | The client approved this post. | **Mark as posted**, once it is live on the channel. |
| **Posted** | **Posted** | Live on the channel. | Nothing. |

Canon does not post to the social platforms for you. **Mark as posted** records that you published it, so the dialog says: "Marking it posted records it as live on the channel. Do this once you have published it."

### Which blogs can be repurposed

Any blog carrying a finished, scored draft. That includes **Below bar** and **Failed** blogs, because the draft an evaluator scored is exactly what send and edit already operate on.

Six states are not repurposable and their rows are shown with their own tag rather than hidden: **Generating** (no settled draft), **Answers submitted** (a correction is mid flight), **Has questions** (somebody owes an answer before the draft can be trusted), **Did not finish**, **Stopped**, and **Unknown**.
