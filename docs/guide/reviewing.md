# Reviewing and editing a blog

When a run finishes, the article is not out the door yet. It sits on your bench: you read it, change what you want changed, answer anything the evaluator could not settle by itself, and then send it to the client. This page covers everything that happens on a single blog's page.

Open a blog from the [Blogs tab](blogs.md) by clicking its row. That takes you to the blog's own page, which is where every act on this page lives.

## The two things people mix up

There are two kinds of note attached to a blog, and they run in opposite directions. New users read one as the other and get stuck, so this is worth thirty seconds.

| | A **comment** | A **question** |
|---|---|---|
| Who wrote it | You, or the client from their portal | The evaluator, during the run |
| What it says | "Change this passage like so" | "I cannot tell whether this is true. You tell me." |
| Where it appears | In the rail beside the article | In a strip above the tabs |
| Does it block anything | No. The blog can be sent with comments open, unless the client filed them | Yes. The blog is held at any score until you answer |
| What clears it | **Resolve with Claude**, or dismissing it | Answering it, which starts one revise |
| Can you ignore it | Yes | No. There is no dismiss and no proceed |

!!! tip "The one-line version"
    A comment is **you asking for a change**. A question is **the evaluator asking you to confirm a fact**. A comment is optional. A question is not.

## Reading the article

The blog page has three tabs across the top of the card.

=== "Blog"

    The finished article, rendered. This is the tab you spend your time on, and the only one where you can comment or edit.

=== "Eval"

    The evaluator's verdict: the score on its own line near the top, then the fix list with an Area against each item. This is what the run scored the draft you are reading.

=== "Dossier"

    The frozen research the writer worked from: the sources, the figures, and where each one came from. Read this when you want to know whether a claim has anything behind it.

Under each tab, at the bottom, is the real path to the file on disk, like `outputs/acme/best-cafes-in-delhi/blog.md`. You can open that in Finder if you want the raw file.

**Copy markdown** puts the raw markdown on your clipboard, ready to paste anywhere. The download button beside it saves the same text as a `.md` file.

## Asking Claude for a change

This is the fastest way to change something. You point at a passage, say what should be different about it, and the engine rewrites that passage and nothing else.

### Filing one

1. On the **Blog** tab, select the text you want changed. Drag with the mouse, or long press and drag the handles on a tablet.
2. A card opens in the rail beside your passage, quoting what you selected.
3. Type what should change in the box: *What should change in this selection?*
4. Press **Resolve with Claude**, or hit Cmd+Enter (Ctrl+Enter on Windows).

Write the instruction the way you would say it to a person. "Cut this sentence, we cannot support it" and "say this in one sentence instead of three" both work. You are describing the change, not writing the replacement text.

!!! note "Your typing is safe from a stray click"
    Once you have started typing, the card stays on its passage. Clicking elsewhere in the article does not move it or wipe what you wrote. **Cancel**, the Escape key, or a successful send is what clears it.

### What actually happens

The engine runs one short Claude session with no tools at all. The article and your instruction are both in the prompt, and the session returns exact old-text and new-text pairs for your passage.

The engine then applies those replacements itself, and it requires each quoted old text to appear in the article exactly once. Zero matches means the session paraphrased instead of copying. More than one match means the change could land somewhere you never selected. Both are refused rather than guessed at, and the comment fails with that reason on its card.

**This edits the draft in place.** When it succeeds, `blog.md` is rewritten and a new version is committed to the record. There is no preview and no accept step. The article you are looking at is the article that changed.

!!! warning "Every resolve spends real money"
    **Resolve with Claude** starts an engine session against your Claude account. Filing five comments runs five sessions. Type the instruction you mean the first time rather than iterating on a passage.

### The three-in-flight cap

At most three changes can be applying at once on one blog. File a fourth and the engine refuses it, and the composer says so before you press: *Three changes are already in flight. Wait for one to land before filing another.*

The cap is counted on the shared record, not on your machine, so it holds even when a teammate is resolving comments on the same article from theirs.

### Reading the cards

Each card carries a small icon and a chip saying who filed it, **you** or **client**.

| Icon | State | What it means |
|---|---|---|
| Spinner | applying | A session is running on it right now |
| Green tick | resolved | The change landed and the article has it |
| Hollow circle | open | Nothing has run yet. It waits for **Resolve with Claude** |
| Amber triangle | failed | The session could not comply. The reason is printed on the card |

A comment you file goes straight to applying, because filing it is the act of running it. A comment the **client** files from their portal arrives **open** and sits there until you press **Resolve with Claude** on its card. That button is also the retry on a failed one.

If a later edit rewrites or removes the passage a comment names, the card says so: *This passage is not in the article any more, so this comment has no highlight.* The card stays, because a request nobody has answered should not vanish.

### Dismissing a comment

The small **X** at the top right of a card dismisses it. Use it when the change is not one you want made, or when the client's note has been handled another way.

A dismissed comment is hidden from the rail but kept on the record, so the review trail is intact and the client can still see that their suggestion was reviewed rather than lost. You cannot dismiss a comment while it is applying: wait for it to land first.

### Add to brand instructions

Beside **Resolve with Claude** is **Add to brand instructions**. This does nothing to the article. It rewrites the comment as a standing instruction for every future blog for that brand and appends it to the brand record.

Use it when the note is not really about this article. "Never call our customers users" is a standing instruction. "Cut the second paragraph" is not. The button flips to **Added to instructions** and stays that way, so everyone on the team sees it has been done.

### When commenting is not offered

The composer and the resolve buttons disappear once the article has moved on, and the tag beside its title says where it has moved to.

- The article is **With client**. They are reading the exact version you sent, and moving the bytes underneath them is how someone ends up approving a version that no longer exists.
- The article is **Approved**. It is locked for good, for you and for the client both.
- The article is **Published**. It has been posted, so the conversation about changing it is over.

A live run is a different case, and the controls stay where they are. While a run is live on this blog itself the tag reads **Generating** and the whole bench is away. While a run is live on some *other* topic for the same brand, the composer is still there and the engine refuses the change when you press: *a run for 'acme' is live; edit once it finishes so the engine's own writes are not raced.* Wait for the run to finish and press again.

## Editing the markdown by hand

Sometimes you want to fix a typo yourself. On the **Blog** tab, press **Edit**.

The article opens in a split editor: raw **Markdown** on the left, live **Preview** on the right. Type in the left pane and watch the right. Press **Save** to commit or **Cancel** to throw the change away. **Save** stays greyed until you have actually changed something.

A successful save tells you the word count it committed, and writes a new version to the record, so the change is the same kind of thing a Claude resolve produces.

**Undo** and **Redo** sit beside **Edit** and step back and forward through the states this visit has walked through. Each press writes a version of its own, so nothing is destroyed by using them. A refresh forgets the trail: the record keeps the current article, your browser keeps the path it took.

!!! note "Edit waits for Claude"
    While a Claude change is applying, **Edit** is greyed with the reason: *A Claude change is being applied. Edit once it lands, so the two writes cannot race.* It comes back on its own. There is nothing to fix.

## The evaluator's questions

Some gaps no rewrite can close, because the missing fact is one only a person holds. No amount of research settles whether valet parking is real at an address, or whether a particular source really carries a particular claim. When the evaluator hits one of those, it asks you.

A blog with live questions shows an amber strip above the tabs: **This blog is held until you answer 2 questions**, with each question and its Area listed underneath.

### Why a good score does not release it

This is the part people push back on. A blog scoring 96 with open questions is held exactly as a blog scoring 92 is. There is no dismiss, no proceed, and no score high enough to skip past it.

The reason is what the old rule actually shipped. When a passing score could wave a question away, two blogs went out at 96 over their own open questions: one published a claim the brand's fact base records as not citable, the other cited a publication date from a source nobody had read in full. A high score says the draft reads well, not that the claim is true.

### Answering them

Press **Answer**. A dialog opens, titled *Answer to release this blog*, with one box per question.

Each question carries three things: its **Area** (Sourcing, Structure, Draft or Mechanics), the question itself, and a line reading *Why it is being asked*. That last line is usually the most useful thing on the screen. It says what the evaluator suspects and what your answer unblocks, which is how you tell whether you are even the person who can answer.

There are never more than five questions, and each is meant to be answerable in about ten seconds without opening the draft.

Every box needs something in it. The engine refuses a blank one and names it. If you genuinely cannot answer one, say that in the box and say why: that an answer is unavailable is itself an answer the writer can act on.

Then press **Send answers and rerun**.

!!! warning "This starts a full engine session"
    Answering dispatches one surgical revise, on your machine and your quota. It is not free and it is not instant. Fill in every box before you press.

### What answering does

The engine applies your answers and the outstanding fix list to the draft that already exists. The research dossier is frozen, so nothing is researched again and the article is not rewritten from scratch. Then the mechanical gates run, the link pass re-checks any links that changed, and a fresh evaluator scores the result reading your answers alongside the brand's canonical facts.

You get exactly one of these per set of answers. It is the only re-score the engine permits after the first one.

!!! info "The clarified draft ships even if it scores lower"
    A negative answer forces the writer to cut a claim, and a draft can lose points for losing it. That is the truth costing points, not the draft getting worse. Keeping the higher-scoring version here would put the original back with the wrong claim still in it.

An answer is guidance, ranking with the brand's canonical facts and above any internal document. It is never a citation. A claim that needs a source still needs a fetched one.

!!! tip "Durable facts belong in canonical facts"
    If your answer establishes something permanent about the brand, put it in that brand's `canonical-facts.md` as well. Otherwise the next blog asks you the same question.

### Questions about a draft that no longer exists

Sometimes you open a blog and find questions that were asked at an earlier iteration, about a draft a later revise has since replaced. The strip says so and offers no form, because the engine refuses answers about a superseded draft. There is nothing for you to do with them: the blog's state comes from its score.

### When the client answered instead

Your client can answer the evaluator's questions from their own portal. Their portal has no engine behind it, so nothing runs when they submit.

The strip on your side then reads *The client answered all 3 questions from their portal*, with each question and their answer printed in full. Read what they wrote, then press **Rerun with their answers**. That is the revise their answers are owed, and it spends this machine's quota, which is why it is a button rather than something that happens by itself.

## Sending it to the client

When you are happy with the article, press **Send to client**. Confirm in the dialog with **Send it**.

!!! danger "There is no unsend"
    Sending makes the article visible in the client's portal immediately, exactly as it reads at that moment. Finish your edits first. This is the door out of internal review and it does not swing back.

Once sent, the article is theirs to read and the editing controls go away on your side. The page shows **Sent for client review** with the date, and its tooltip names the exact time and the person who sent it.

### Sending a blog that missed the bar

A run ships on its own only at 90 or above, which is the one number the whole engine compares against. See [How a blog gets made](../concepts/how-it-works.md) for where that number comes from. Below it the run ends **failed**, which covers both a near miss at 87 and an outright failure, and the dashboard labels the near-miss band "Below bar" so you can tell them apart.

There is still one send button and it has the same label. Press **Send to client** on a below-bar blog and the dialog says plainly what you are doing: the evaluator scored the draft under the house bar, and sending it records it as shipped on your authority with the score kept on the record. The trail reads "failed at 87, then a person sent it". The evaluator's number is never rewritten.

!!! warning "A below-bar send locks the roadmap row"
    It enters the ledger exactly as a 90-plus blog does, so that topic will not come back around. If you want another attempt at the bar instead, use **Retry this topic** beside the send button.

The one thing the engine will not send is a failed blog with no evaluator-scored draft at all, because there is nothing there for you to have read and taken responsibility for. Generate that topic again instead.

### What the client sees

In their portal, the article appears under their brand with a banner: *This article is ready for you. Approve it and our team takes it live. To ask for a change, select any text in the article and leave a note beside it.*

They get exactly two acts. **Approve**, or select a passage and leave a note on it. They cannot edit the text and they cannot see anything that has not been sent to them.

## When the client requests changes

A note the client leaves arrives in the same rail you use, on the same passage, with a **client** chip and a line reading *waiting on you since*. The tag beside the title reads **Changes requested**.

Work through them one at a time. On each card you have the same two doors: **Resolve with Claude** to make the change, or the **X** to dismiss it. Your own **Edit** button is available here too if you would rather fix something by hand.

!!! note "Resolving is the delivery"
    While an article is in a change round, the client's portal shows the newest committed version continuously. They see each fix as you make it. There is no second send to press and no separate act that hands the article back.

As you clear the round, their portal banner follows along: *Our team is working through your notes* while any are pending, then *All your notes are addressed* once none are. On your side the tag flips from **Changes requested** to **With client**, which means the ball is back with them.

!!! tip "Refresh to see new client notes"
    The blog page does not poll for the client's side. A client's note is minutes or days of human work away, so nothing sits there checking. Refresh the page, or watch the notification in the Blogs library, which picks up new client comments at its own next read.

## Approving

Approval is the client's act, not yours. They press **Approve** in their portal and confirm.

Their dialog is blunt about what it costs them: approving locks the article permanently, those become the exact words that go out, and nobody can change them afterwards, them or your team. They cannot add comments or ask for fixes once it is approved.

!!! danger "An approval is final and it is enforced in the database"
    After approval, editing, commenting and resolving are all refused, on your side as much as theirs. This is not a permission you can be granted: the article is in a state that forbids it. The refusal names the approval and its date.

On your side the tag turns to **Approved**, the chip beside it reads **Approved** with the date and names the client in its tooltip, and one act remains: posting it. See [Publishing](publishing.md) for that half.

An approved article cannot be sent again. The engine refuses it and names the approval and its date, because an approval belongs to one exact article and there is no way to put different text under it.

## Quick reference

| You want to | Do this |
|---|---|
| Change a passage | Select it, write the instruction, **Resolve with Claude** |
| Fix a typo yourself | **Edit**, type in the left pane, **Save** |
| Undo a change | **Undo** beside the **Edit** button |
| Decline a client's note | The **X** on its card |
| Make a note a standing rule | **Add to brand instructions** on its card |
| Release a held blog | **Answer**, fill every box, **Send answers and rerun** |
| Apply answers the client filed | **Rerun with their answers** |
| Give it to the client | **Send to client**, then **Send it** |
| Try a failed topic again | **Retry this topic** |

For what each tag beside the title means and who owes the next act, see [What each status means](../concepts/blog-states.md). For what your client sees at every step, see [A guide for your client](../client-portal/for-clients.md).
