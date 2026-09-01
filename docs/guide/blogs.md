# The Blogs tab

**Blogs** is one brand's whole pipeline on one page: "Every blog for *brand*, from the roadmap row to the published article."

If you are writing your first blog, start with [Your first blog, start to finish](your-first-blog.md) and come back here for the details.

## The four sub-tabs

Every topic this brand has sits in exactly one of four tabs. The strip runs across the top of the page.

| Tab | What is in it |
| --- | --- |
| **New** | Roadmap rows nothing has written yet, rows a run is working on right now, rows the sheet left incomplete, and rows whose last run ended **Failed** or **Below bar**, so rerunning is one list and one press. |
| **Internal review** | A draft exists and it is on your team's bench. |
| **Client review** | The client can see it. This includes a blog held for an answer, because the client can answer the evaluator's questions from their portal. It stays here until it is live. |
| **Published** | It is live on the client's own site. |

Each tab has its own empty message rather than a generic one:

- **New**, when the sheet has rows but none of them are still runnable: "Every topic on this month's roadmap has been written. They are on the other tabs." When the sheet parsed with no rows at all it says so instead, and asks for a sheet with topics in it.
- **Internal review**: "Nothing on the bench. A blog lands here the moment the engine scores it. Generate one from New, or look in Client review for the ones already sent."
- **Client review**: "Nothing with the client. Nothing has been sent for this month. Tick a blog in Internal review and press **Send to client**."
- **Published**: "Nothing published yet. A blog lands here once it goes live on the client's site. Approved ones waiting for that press are in Client review."

If the brand has no blogs at all, the three article tabs show one card instead: "No blogs for *brand* yet", with a **Create blogs** button. With a month picker on screen the card names the month too.

!!! note "New is a different kind of list"
    The other three tabs list articles. **New** lists roadmap rows, which are plans rather than articles. That is why a below-bar blog can appear on **New** as a row to run again and on **Internal review** as a draft to read and send. One topic, two acts, in the two places each act belongs.

## The month filter

When the brand's roadmap covers more than one month, a dropdown sits at the right of the tab strip, labelled **Filter by roadmap month**. Months are listed newest first.

With only one month there is no dropdown, because it could not change anything.

The month sits beside the tab strip rather than in the row of controls below it because it applies to all four tabs at once, while the controls below change with the tab you are on.

## Searching and refreshing

Under the tab strip:

- **Search titles**, a box that matches the title and the slug. It is not shown on **New**, which lists roadmap rows and has no titles to search.
- **Refresh**, which re-reads the list and the queue under it.

Searching for a bare number, or a number written `#6`, means the roadmap row and nothing else. Typing `6` finds blog six rather than the nine titles that happen to contain the character 6. Anything that is not purely digits is searched as text.

The filters live in the page URL, so a filtered list is something you can paste to a teammate.

## The table

On **Internal review**, **Client review** and **Published** the columns are:

| Column | What it holds |
| --- | --- |
| Checkbox | Ticks the row for the bulk bar. Absent on **Published**. |
| **#** | The blog's identifier. |
| **Title** | The blog's name: what you renamed it to, otherwise the roadmap topic, falling back to the article's H1. Click it to open the blog. |
| **Created** | Relative time. Hover for the exact stamp. |
| **Score** | The evaluator's number. |
| **Status** | Where the article is. |
| **Iterations** | How many iterations the run took. |

On **New** the columns are the checkbox, **#**, **Title**, **What it covers** and **Status**, plus an upload button at the end of each row. **Created**, **Score** and **Iterations** are dropped, because a topic nothing has written cannot have any of them.

### The # column

This is the name the work actually goes by, as in "we are done with six, send seven".

Blogs the engine wrote get a **number**. Blogs a person uploaded get a **letter**. Each counts separately, so a letter on its own tells you a person wrote that one. Hover it to read which.

### Score

- A number, coloured by band: green at 90 and above, amber from 80 to 89, red below 80.
- `uploaded` where a person handed the article over, so no evaluator ever scored it.
- `no score` where the run never reached an evaluation.

### Status

One tag per row. Hover it and the tooltip names who owes the next act.

| Tag | What it means |
| --- | --- |
| **Not generated** | On the roadmap, nothing written yet. |
| **Generating** | A run is live. Nothing to do until it finishes. |
| **Has questions** | Held until someone answers the evaluator, at any score. |
| **Answers submitted** | The client answered. Rerun to apply their answers, then send. |
| **Internal review** | Passed and on your bench. |
| **With client** | Sent. They owe an approval or a change request. A row also reads this way once every comment in a round is addressed and the client is reading the updated article. |
| **Changes requested** | The client asked for something. Resolve or dismiss each note. |
| **Approved** | The client accepted these exact bytes. The article is locked and nobody edits it. |
| **Published** | Live on the client's site. |
| **Below bar** | Scored 80 to 89. Under the bar and close enough that a rerun is worth it. Or send it if you have read it and are happy. |
| **Failed** | The run finished without a shippable draft and had nothing to ask. |
| **Did not finish** | The run reached no verdict at all. Nothing judged this article. Generate the topic again. |
| **Stopped** | Someone ended the run before it reached a verdict. |
| **Unknown** | No readable status line for this article. |

### The waiting chip

A row whose evaluator asked something carries an amber chip under the title reading "*N* questions to answer". A row whose client has already answered carries a green chip reading "*N* answered by client, rerun", which means the answers are in and nobody has applied them yet.

Above all four tabs, a banner counts them: "*N* blogs are held until you answer the evaluator".

!!! warning "A held blog waits whatever it scored"
    A 96 with an open question waits exactly as an 88 does. There is no dismiss and no proceed. A high score says the draft reads well, not that the claim the evaluator asked about is true. Open the blog to read the questions.

## Sorting

Click a column header to sort by it. **#**, **Title**, **Created**, **Score** and **Status** are sortable. **Iterations** is not.

The default is sheet order, ascending, so the **#** column reads 1, 2, 3 down the page. A new column starts descending. Clicking the column that is already active flips the direction.

**Status** sorts by how much a row wants a human: held blogs and change requests first, then the ones that cannot explain themselves, then your bench, then everything waiting on somebody else.

The **New** tab has no sorting at all. Its rows are the sheet, and the **#** column is the sheet's own order.

## Keyboard

The line under the table names these: `j` and `k` to move, `enter` to open, `/` to search.

Once you are moving through the list, the arrow keys work too. Before that they scroll the page, which is what an arrow key means everywhere else.

## What makes a row selectable

Checkboxes appear on **New**, **Internal review** and **Client review**.

They do not appear on **Published**. The article is live, so **Send to client** and **Publish** are spent, and a bulk delete over something a reader can currently open is not an act to put one click away. Taking one down is still reachable from its own page: **Unpublish from** *host* is the only control the action row carries there. Editing is not, because the bytes are live and the client approved them.

On **New**, rows are shown but locked where the engine would refuse them: a topic a run already owns, and a row missing its topic, scope or prompts. A locked checkbox is better than one that ticks and then quietly does nothing. A blog held for an answer is not listed on **New** at all; it sits in **Client review** until someone answers it.

Selecting rows and then filtering does not lose them. The bulk bar counts only the rows you can currently see, and the rest come back when the filter does.

## The bulk bar

Tick anything and the row of controls is replaced by the bulk bar. Ticking is a mode switch: you have stopped narrowing the list and started acting on a set. **Clear** puts the controls back.

The bar reads "*N* blogs selected", then **Clear**, then four actions.

Every button carries a tooltip saying what it will touch before you press it: "Runs on all 5.", or "Runs on 2 of 5. The rest are skipped: already with the client, or holding an open question." A button whose eligible set is empty is disabled and says why.

A mixed selection runs on the rows that can take the action rather than refusing the whole press. Afterwards one toast says what happened, and a partial failure carries the engine's own words for the refusal.

### Download

Bundles the selected blogs into **one** Word document, `<brand>-blogs.docx`. Each article gets a cover page reading "Blog 1", "Blog 2" and so on with its title beneath, ordered by roadmap position.

A blog still being written is skipped, because there is no committed draft to put in the document.

### Send to client

Confirms first: "Send *N* to *brand*?", explaining that "Each one becomes visible in the client portal for review, exactly as it reads now. Blogs the client already has, and blogs holding an open question, are not included." The confirm button reads **Send them**.

!!! danger "A send is outward facing"
    The client sees the article as it reads at the moment you press. Read it before you send it.

This is the only release door, at every score. A blog that missed the 90 bar goes out through this same button, and the engine records that a person sent it at that score. The trail reads "failed at 87, then a person sent it", never a silent pass.

### Publish

Confirms first: "Publish *N* on *brand*'s site?", explaining that "Each one goes live on the client's own website, with its own excerpt and, where their SEO plugin accepts them, its SEO title and description. A blog already published is updated in place." The confirm button reads **Publish them**.

!!! danger "Where this posts depends on the brand"
    The press publishes the article live on the client's own domain, and that door only opens once the client has approved it. On a blog's own page the button names the platform, for example **Post to Wordpress**.

### Delete

!!! danger "Delete cannot be undone"
    The confirm says it plainly: "The draft, its evaluation, its comments and its scratch files all go, and the roadmap row frees up so the topic can be written again. This cannot be undone." The confirm button reads **Delete them**.

The engine refuses a delete while a run for this brand is live, and says so.

## Uploading a blog you wrote by hand

**Against a roadmap row.** Each row on **New** ends with an upload icon. It opens a page that already knows that topic's title, slug and prompts, so it asks for none of them: you paste the article on the left and see it rendered on the right. Hover the icon and the tooltip reads "Upload a finished article for *topic* instead of generating it."

The icon is disabled with a reason on a topic generating right now: "Upload once the run finishes, so the engine's own writes are not raced."

**Off the roadmap entirely.** A **New blog** button writes an article that is on no roadmap row. It sits on the card the **New** tab shows when the brand has no content roadmap yet, beside **Go to Content Roadmap**.

An uploaded blog behaves like any other from then on. It edits, comments and sends the same way. What it does not have is a score, a dossier or an evaluation, because nothing generated it. Its **Eval** tab says "This blog was not scored" and its **Dossier** tab says "This blog has no dossier". Its identifier is a letter rather than a number, so you can tell at a glance.

## Opening one blog

Click anywhere on a row, or click the title. The title is a real link, so Command-click or middle-click opens it in a new tab.

Every blog has its own address, so you can send a teammate a link to one article rather than to the library.

## The stage view

This is one blog's own page. A **Blogs** button at the top left goes back to the library.

### The header

The identifier, then the title. A pencil beside the title renames the blog. Under it:

- The **Status** tag, the same one the table shows.
- The score, with its trail if the run took more than one iteration, for example `72 → 89 → 91 /100`. An uploaded blog shows an **Uploaded** chip here instead.
- The word count, counted the way the engine's own word-count gate counts it, and the number of distinct sources cited.
- When it was created.

### The action row

Which of these appear depends on where the article is. A control the state refuses is absent rather than greyed, and the tag beside the title explains why in words.

- A chip once the article has been published, reading **Published on** *host*. **View on** *host* sits beside it where the record holds a link.
- **Unpublish from** *host*, on an article live on a client's own site. Its dialog asks "Take this article off *host*?" and lists what stays and what you lose, including "Any link anyone already has to it breaks."
- **Post to** *platform*, naming the platform the brand's site runs on. It reads **Post to their site** on a brand with no website connected, and **Posted to** *platform* once the press has landed.
- The send stamp: "Sent for client review *N* days ago", or "Approved *N* days ago". Hover for the exact time and the person.
- **Send to client**, on an article that has not been handed over yet. Once it is with the client there is no second send: they read your latest saved version continuously.
- **Retry this topic**, on a blog that failed or did not finish. It takes you to the **New** tab with that row already ticked.

### The answer strip

Where the evaluator asked something, a strip above the article carries an **Answer** button. It opens **Answer to release this blog**, which lists each question with the reason it is being asked and what answering it unblocks.

Every question needs an answer before **Send answers and rerun** enables. If you cannot answer one, say so in the box: that an answer is unavailable is itself an answer the writer can act on.

What the press does is spelled out above the button. The engine applies your answers and the outstanding fix list to the draft that already exists. The research is frozen, so nothing is looked up again, and the article is not rewritten from scratch.

!!! note "The clarified draft ships even if it scores lower"
    A negative answer makes the writer cut a claim, and a draft can lose points for losing it. That is the truth costing points, not the draft getting worse. Keeping the higher score would restore the original with the wrong claim still in it.

### The three tabs

**Blog**, **Eval** and **Dossier**.

**Blog** is the article. It is the only one you can edit. **Eval** is the evaluator's verdict, with the score lifted to the top of the page and a sentence saying what that band means. **Dossier** is the research the article was written from. Both of those are read-only on purpose: they are the record of how the article earned its score.

The real path on disk is printed under each tab, for example `outputs/acme/why-x-matters/blog.md`, so you can open the file yourself.

### Editing

On the **Blog** tab:

- **Edit** opens the raw markdown to type in.
- Select any passage in the article and describe a change for Claude to apply.
- **Undo** and **Redo** step through the committed states this visit has walked through. Each press writes a new version through the same route an edit uses, so the record always holds what is on screen.
- **Copy markdown** puts the raw text on the clipboard. The download icon beside it saves the file.

All of this disappears once the client approves the article. The approval records that they accepted those exact words, so nobody edits it after that, your team included. Posting it is the one act left.

### Comments

The client's change requests sit in a rail beside the passage each one is about. You resolve one with Claude, or dismiss it, from that card. Comments are not threads: a client files a note, your team resolves or dismisses it, and that is the conversation.

The rail is shown even where you cannot act on it, on an article the client is currently reading, so you can see what has been asked.

## The Queue

On the **New** tab, under the row picker, a **Queue** table shows what the engine is doing right now. It renders nothing when the engine is idle.

It spans every brand, because the engine works on a fixed number of blogs at once across the whole system. Rows belonging to another brand are labelled **other brand**, which is often the answer to why yours is waiting.

Columns: **#**, **Topic**, **Brand**, **Stage**, **Since**, and a stop control. The header line counts running, queued and finished, and gives the elapsed time of the oldest running blog.

Rows never move. They are ordered by the sheet's own number, so a topic keeps its place for the life of the run and only the **Stage** cell changes.

Click a row, or the arrow at its left, to expand it: the five stage marks, the score at each iteration, and the engine's own note.

The stop control means two different things and the engine decides which at the moment you press. A row that has already finished carries no control at all.

- On a queued row it removes the topic. Nothing has been spent on it, so it does not ask.
- On a running row it asks first, then ends that session.

!!! note "Nothing is deleted by a stop"
    Whatever the run wrote stays on disk. If an evaluator scored a draft, the blog moves to **Internal review**. If not, the topic goes back to **New**.

## If controls are missing

On the hosted view of the record, the page reads and never writes. A note on the blog's own page says so: answering the evaluator, editing, asking Claude for a change, sending to the client and publishing all run in the Canon app on your own machine.

If a control you expected is absent, check the **Status** tag first. Its tooltip names who owes the next act, and that is usually the whole explanation.
