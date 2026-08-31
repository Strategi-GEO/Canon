# LinkedIn, Medium, Bluesky and X

Every finished blog can go out again as a piece written for one social platform. Canon has four channel tabs in the left nav of a brand: **LinkedIn**, **Medium**, **Bluesky** and **X**. All four work the same way, so learning one teaches you all of them.

## A channel post is a fresh cut, never a repost

Canon does not paste your blog into LinkedIn. It reads the whole blog, picks one angle out of it, and writes a new piece in that brand's voice, shaped for that one platform. A LinkedIn post and a Medium article made from the same blog are two different pieces of writing.

The facts come from the blog itself and from the brand's canonical facts. Nothing new is researched, so a channel post can only say what the blog already said. If a claim is not in the blog, it does not reach the post.

## Where the posts come from

There are two doors, and they are not the same for every channel.

!!! info "LinkedIn and Medium arrive on their own. Bluesky and X never do."
    When you publish a blog with **Post to CMS** (or **Post to WordPress**, depending on where the brand publishes), Canon starts a LinkedIn post and a Medium article for that blog automatically. **Bluesky** and **X** are manual only. Nothing appears on those two tabs until you tick blogs and press **Generate**.

The automatic run skips any channel that already has a post for that blog, so it never writes over a piece you made by hand, and it skips a blog that is already generating for that channel.

Apart from that one difference, all four channels are the same everywhere else: the same tabs, the same review page, the same client portal view, the same delete.

## The two sub-tabs

Every channel tab opens on two sub-tabs.

=== "New"

    Every blog for the brand that does not have a post on this channel yet, in roadmap order. The columns are **#**, **Blog**, **Created** and **Status**, and the status is the blog's own status, not the post's.

    A blog leaves this list the moment it has a post. Nothing is lost: it moved to **Created**.

=== "Created"

    The posts themselves, one row each. The columns are **#**, **Post**, **Status** and **Updated**, and every one of them sorts when you click its heading. Click any row to open that post for review.

    The number on the **Created** tab counts the posts in the month you are looking at, which is the same set of rows the tab renders.

The **#** column is the source blog's number, the same number the Blogs tab gives it. A letter instead of a number means the blog was uploaded by hand rather than written by the engine. So "post 6" and "blog 6" are the same article seen twice.

## Generating posts

On the **New** tab, tick the blogs you want and press **Generate**. The line above the table reads how many are ready to generate, and switches to how many you have selected once you start ticking. The checkbox in the header row ticks and unticks everything selectable at once.

Not every blog can be ticked. A blog is selectable when it carries a finished draft an evaluator scored, which means these statuses:

- **Internal review**
- **With client**
- **Changes requested**
- **Approved**
- **Published**
- **Failed**, including the **Below bar** face of it

A blog sitting on **Not generated**, **Generating**, **Has questions**, **Answers submitted**, **Stopped**, **Did not finish** or **Unknown** stays in the list with its checkbox disabled. There is nothing settled in it to cut a post from. Every one of those words is defined in [What each status means](../concepts/blog-states.md).

Each blog you tick becomes its own run on the engine, and each run takes a queue slot exactly like a blog run does. While it runs, the row shows a spinner and the words "generating LinkedIn post" (or whichever piece it is). When the post lands, the row leaves **New** and appears under **Created**.

!!! warning "Generating spends real usage"
    One blog ticked on one channel is one session on the engine. Ticking twelve blogs starts twelve of them, and they queue behind whatever else the engine is doing. Tick what you actually want.

Two more controls sit on that row. **Refresh** re-reads the blogs and the posts. The month picker appears only when the brand has work in more than one month, and it narrows both sub-tabs to that month.

## What each platform gets

| Channel | What Canon writes | The shape of it |
|---|---|---|
| **LinkedIn** | One LinkedIn post | The hook lives in the first two lines, because that is all a reader sees before the cutoff. Target 1,200 to 1,700 characters, hard ceiling 2,800. Three to five specific hashtags at the end. The blog link belongs in the first comment, so the file ends with a `Comment (first reply, with the canonical link):` line for you to post separately. |
| **Medium** | One Medium article | 800 to 1,400 words, shorter than the blog and cut differently. The file opens with `Title:`, `Subtitle:` and `Tags:` lines, then three to five H2 sections, one pull quote and an FAQ block near the end. |
| **Bluesky** | One Bluesky post | 300 characters, hard, because a longer post cannot be posted at all. Usually one post. A short thread of three to five appears only where the argument genuinely needs the extra steps. No hashtags, and the blog link sits inside the post so the link card renders. |
| **X** | One X thread | Five to nine posts, 280 characters each, so a free account can post every one of them. The posts are not numbered, because the thread view already shows position. The link goes in the last post, so the first post keeps its reach. |

The Bluesky and X files carry a header line above each post with its counted length, like `Post 1 (243 chars)`, and a line of three hyphens between posts:

```text
Post 1 (243 chars)
The hook, standing completely alone.

---

Post 2 (198 chars)
One idea, ending on something that pulls forward.
```

Copy everything between a header line and the next separator. The header itself is your copying order and never goes into the post.

## Reviewing one post

Click a row on the **Created** tab. The review page opens with the source blog's number and title at the top, then the kind of piece, its status, its word count and when it last changed.

To change something, select the passage you want fixed. A box opens asking "What should change in this selection?". Write the instruction and press **Resolve with Claude**. Claude edits only that passage and the new text appears on the page. The X on a comment card dismisses it instead, which closes the request without touching the text. This is the same flow the blog stage uses, described in [Reviewing and editing](reviewing.md).

Three changes can be in flight at once. File a fourth and Canon asks you to wait for one to land.

A channel post has no versions, so an applied change is written straight into the post. The piece you are reading is always the current one.

The rest of the bench on that page:

- **Regenerate** throws the current text away and writes the piece again from the same blog. It appears only while the post is in **Created**, before you have sent it anywhere.
- **Copy markdown** puts the whole piece on your clipboard, and the button beside it downloads it as a `.md` file.
- **Post to LinkedIn**, **Post to Medium**, **Post to Bluesky** or **Post to X**, described below.

If you open a review page for a blog that has no post yet, you get a card with a **Generate LinkedIn post** button (or whichever piece it is) so you can start one from there.

## Sending it to the client

Press **Send to client** on the review page, or tick rows on the **Created** tab and use **Send to client** in the bar that replaces the controls. The bulk version runs only on rows that are in **Created** or **Changes requested**, and its tooltip says how many of your ticked rows it will act on and why the rest are skipped.

The client then sees the piece in their portal tagged **Ready to post**. They can press **Approve**, or select a passage and ask for a change, exactly as they do with a blog. See [the client portal](../client-portal/index.md).

When a client asks for a change, the post moves to **Changes requested** and your button becomes **Send again**. Resolve or dismiss each of their comments first: while one is still open, Canon refuses the send and says so.

!!! warning "An approved post is locked"
    Once the client approves, there is no way to send it again, edit it, comment on it or regenerate it. The only act left on the page is **Mark as posted**. To change an approved post you delete it and generate a fresh one.

## Actually posting it

Canon does not post to any platform for you. The **Post to X** button, and its equivalents on the other three tabs, copies the whole piece to your clipboard and opens that platform's composer in a new tab. You paste it there and press their post button.

For a thread, paste it post by post. Copy the text under `Post 1`, post it, then copy the text under `Post 2` and post that as a reply, and so on to the end. Canon does not prefill the composer even where the platform allows it, because a prefill link can carry only the first post and would silently drop the other eight.

When the piece is live, come back and press **Mark as posted**. That records it and turns the status green. Nothing checks the platform for you, so this is the step that keeps your records honest.

## Downloading a bundle

**Download all** on the **Created** tab builds one Word file holding every post the tab is currently showing, with a cover page before each one reading "LinkedIn post 1", "X thread 2" and so on, with the article's title beneath. The tooltip states the count before you press it.

"All" means the month you are looking at, not the whole brand. Where a brand has one month, those are the same set.

To bundle a specific handful instead, tick those rows and press **Download** in the selection bar. Both produce a file named after the brand and the channel, like `acme-linkedin.docx`.

## Deleting a post

Tick rows on the **Created** tab and press **Delete**.

!!! danger "Delete removes the post, never the blog"
    The post and every comment on it go, and this cannot be undone.

    The source blog is untouched. It keeps its draft, its score, its ledger entry and its own status, and it reappears in the **New** tab with its checkbox live again, ready to generate a fresh post whenever you want one.

Deleting is the way to start over on a post you have already sent, since **Regenerate** disappears once a post leaves **Created**. A post the client has approved or that is marked posted cannot be regenerated at all.

## Where this sits

These four tabs are downstream of everything else. A blog has to be written and finished before it can be cut for a channel, so start at [the Blogs tab](blogs.md), and read [Publishing](publishing.md) for the press that also fires the automatic LinkedIn and Medium posts.
