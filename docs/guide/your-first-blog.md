# Your first blog, start to finish

This page walks you through writing one blog, from signing in to reading the finished article. Follow it in order. Nothing here assumes you have used Canon before.

!!! warning "This spends real money"
    Pressing **Generate** starts a real run. Every blog researches live sources, so it spends API credits and Claude subscription quota. The card above the button says so too: "Real run. Each blog researches live sources and costs API credits." There is no practice mode.

## 1. Pick an organisation, then a brand

The left sidebar is the whole navigation. When you are not inside a brand yet, it lists your **Organisations**. Click one, and it lists that organisation's **Brands**. Click a brand, and the sidebar becomes that brand's own menu:

**Overview**, **Content Roadmap**, **Blogs**, **LinkedIn**, **Medium**, **Bluesky**, **X**, **Repurpose**, **Reports**, **Analysis**, **Resources**, **Settings**.

If the organisation holds more than one brand, a brand switcher appears above that menu. With only one brand there is no switcher, because it would have nothing to switch to.

!!! info "Everything is scoped to a brand"
    There is no global Blogs page and no global Create page. A blog needs a brand to mean anything: it needs that brand's facts and that brand's roadmap. So you always pick the brand first.

## 2. Check the brand has a content roadmap

Open **Content Roadmap** in the sidebar.

The roadmap is the brief. Every blog starts as a row in it, and the row carries the topic, what the piece covers, and the target prompts the article has to answer. Uploading a sheet, generating one, and deleting one all happen on this tab and nowhere else.

If the brand has no roadmap, the **New** tab on the Blogs page shows a card reading "*brand* has no content roadmap yet" with two buttons, **Go to Content Roadmap** and **New blog**. There is nothing to pick until a sheet exists.

## 3. Check the brand has resources

Open **Overview**. The **Resources** card tells you how many files this brand has, with the sentence "the researcher reads these before searching anything external". The button under it reads **Add resources** when there are none and **View resources** when there are some.

Resources are the brochures, spec sheets and price lists that say what the brand says about itself. The engine builds the brand's fact base mostly from them, and every blog for that brand inherits that one fact base.

!!! tip "Upload resources before the first run, not after"
    A thin fact base is not one thin blog, it is every blog this brand ever gets. Uploading files now is free. Fixing twenty blogs later is not.

## 4. Open Blogs and go to the New tab

Click **Blogs** in the sidebar. The page opens with four sub-tabs across the top:

**New**, **Internal review**, **Client review**, **Published**.

Click **New**. It lists the roadmap rows this brand has, one per row, with a checkbox and the columns **#**, **Title**, **What it covers** and **Status**, plus an upload icon at the end of each row.

A row's **Status** tells you where that topic already stands. A topic nothing has written reads **Not generated**.

## 5. Tick the rows you want written

Each row has a checkbox on the left. The checkbox in the header ticks or clears every row currently on screen.

To tick a run of rows, click one checkbox, then hold Shift and click a second one. Everything between the two is ticked. The note under the table says the same thing: "Shift-click a second checkbox to tick everything between the two."

Some checkboxes cannot be ticked, and they are shown greyed rather than hidden:

| The row reads | Why the checkbox is locked |
| --- | --- |
| **Generating** | A run already owns this topic. Asking for it again is refused. |
| A row missing its topic, scope or prompts | The engine cannot write it, so it is refused at the API boundary. |

A row that already shipped is not on the **New** tab at all, and neither is a blog held for an answer. Rows that ended **Failed** or **Below bar** stay here on purpose, because rerunning them is the obvious next thing to do.

On the right of the button row, a summary reads "*N* of *M* selectable" and, once you have ticked something, "Writes *N* blogs for *brand*, 5 at a time".

## 6. Press Generate

The button at the bottom right reads **Generate**. If a blog run is already live anywhere in the engine, it reads **Add to queue** instead, because that is what the press actually does: your work waits behind whatever is already running.

The keyboard shortcut is Command or Control plus Enter. Hover the button to see which one your machine uses.

The button is disabled when nothing you have ticked can actually run.

## 7. Answer the "Instructions for this run" dialog

Every press of **Generate** opens a dialog titled **Instructions for this run**.

This is the last free moment to shape what gets written. Anything you type here binds only the blogs in this run, ranked as a major priority, never above the brand's canonical facts. The placeholder shows the kind of thing it is for: "Lead every blog with a statistic. Keep them under 900 words for this batch."

**View instructions** opens a read-only markdown view with two tabs, **Brand instructions** and **This run**, so you can write against what is already in force instead of repeating it. The button is absent when the brand has no standing instructions and you have typed nothing, because there would be nothing to show.

Leaving the box blank is a normal answer. Press **Generate** in the dialog to go ahead, or **Cancel** to back out with nothing submitted.

## 8. If the brand has no fact base, answer one more question

If this brand has neither a fact base nor any uploaded resources, one more dialog appears: "*brand* has no fact base yet".

It explains that the engine builds the fact base before it writes a single blog in this run, that the build itself spends quota, and that with no resources it has only the live site to go on.

You get two ways out:

- **Upload resources** closes the dialog and takes you to the brand's **Resources** tab. Nothing is submitted.
- **Proceed anyway** submits the run exactly as pressing **Generate** would have.

This dialog does not appear for a brand that already has a fact base or any resources.

## 9. Watch the Queue

Under the row picker, a **Queue** table appears once anything is running. It renders nothing when the engine is idle.

The line above it reads something like "3 running, 2 queued, 1 finished of 6, across every brand", followed by how long the oldest running blog has been going.

!!! info "The queue spans every brand"
    The engine works on a fixed number of blogs at once across the whole system, not per brand. So the reason your blog is waiting is often somebody else's blog. Rows that belong to another brand are labelled **other brand**.

The columns are **#**, **Topic**, **Brand**, **Stage** and **Since**. **Stage** reads `Queued` for a topic that has not started, or the stage it is on now: `research`, `write`, `gates`, `links`, `eval`, and `revise` once a blog is being revised. A blog past its first attempt also shows an `iter 2` style chip.

Click a row, or the arrow at its left, to expand it. You get the five stage marks, the score at each iteration, and the engine's own note.

### How long it takes

This table carries no progress bar and no percentage, and that is deliberate. A blog can pass on its first evaluation or be revised up to four times, so there is no total to measure against. What is honest is the **Since** column and the stage name beside it.

Research legitimately sits still for minutes. That is normal, not a stall.

### Stopping something

Each queue row that has not finished has a stop control on the right. A row that already landed has none, because the engine holds nothing to stop.

- On a **Queued** row it removes the topic from the queue with no confirmation, because nothing has been spent on it. The toast reads "Removed from the queue".
- On a running row it asks first: "Stop this blog while it is being written?" with **Keep writing** and **Stop it**.

!!! note "Stopping never deletes anything"
    Whatever the run had written stays on disk. If an evaluator scored a draft, even on the first iteration, the blog moves to **Internal review**. If it did not, the topic goes back to **New**.

## 10. When a blog lands

Refresh the page, or press **Refresh** above the table.

A finished blog leaves **New** and appears on another tab:

| Where it goes | What happened |
| --- | --- |
| **Internal review** | It was scored and it is on your team's bench. |
| **Client review** | The evaluator asked a question, so the blog is held until someone answers. Held blogs sit here because the client can answer them too. |

A banner appears above the tabs whenever anything is held: "*N* blogs are held until you answer the evaluator". It appears whichever tab you are standing on.

On the row itself, the **Score** column shows the evaluator's number, coloured by band:

- 90 and above is green. The draft cleared the bar.
- 80 to 89 is amber. A near miss you decide about.
- Under 80 is red.
- `uploaded` where a person handed the article over, so no evaluator scored it.
- `no score` where the run never reached an evaluation.

The **Status** column beside it names where the article is. A run that ended short of the bar reads **Below bar** between 80 and 89 and **Failed** under that. **Did not finish** means the run never reached a verdict at all: nothing judged this blog, so the only sensible next step is generating it again.

## 11. Answer any questions

Click the row to open the blog's own page.

If the evaluator asked something, a strip at the top of the article card carries an **Answer** button. It opens a dialog titled **Answer to release this blog**, listing each question with the reason it is being asked.

Every question needs an answer. If you cannot answer one, say so in the box and say why: that is itself an answer the writer can act on.

Press **Send answers and rerun**. The engine applies your answers to the draft that already exists, with the research frozen, then scores the result again.

!!! warning "A high score does not release a held blog"
    A blog with an open question waits at any score, including 96. There is no dismiss and no proceed. A high score says the draft reads well, not that the claim the evaluator asked about is true.

## 12. Read it, then send it

On the blog's page you get three tabs: **Blog**, **Eval** and **Dossier**.

- **Blog** is the article. Select any passage to ask Claude for a change, or press **Edit** to type in the raw markdown. **Undo** and **Redo** step back through changes you have made in this visit.
- **Eval** is the evaluator's verdict, with the score lifted to the top and a sentence saying what that band means.
- **Dossier** is the research the article was written from.

**Copy markdown** puts the raw text on your clipboard. The download icon beside it saves the file.

When you are happy with it, press **Send to client**. That makes the article visible in the client portal exactly as it reads now, so read it first.

!!! danger "Send and Post are outward facing"
    **Send to client** shows the article to the client. **Post to CMS** files it in the Strategi CMS as a draft that one of our editors reviews. On a brand that publishes to its own website the button reads **Post to WordPress** instead, that press publishes the article live on the client's site, and it only opens once the client has approved it.

If the blog missed the bar and you still want it to go out, **Send to client** is the same button and the same press. The engine records that a person sent it at that score rather than pretending it passed.

If you would rather run it again, a failed blog's page carries **Retry this topic**, which takes you back to the **New** tab with that row already ticked.

## Where to go next

[The Blogs tab](blogs.md) is the full reference for the page you have just used: every column, every filter, and every action on the bulk bar.
