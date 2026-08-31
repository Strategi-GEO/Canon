# The client portal

Canon is one app with two faces. You use `/admin`. Your client uses the same site without `/admin`, and what they see there is the client portal.

It is not a copy of your dashboard with buttons removed. It is a separate set of pages built from the same records, showing a client only their own brands, only the articles you have released to them, and only the words a client is meant to read. There is no score, no evaluator, no dossier and no iteration count anywhere on it.

This page is for you. There is a companion page written for the client themselves, which you can send as a link: [A guide you can send to your client](for-clients.md).

## One login per organisation

When you create an organisation, Canon mints its portal login at the same moment and shows it to you once, in a dialog headed **Client login for {brand}**.

The email is the organisation slug at `portal.strategi.is`, so an org slugged `acme` gets `acme@portal.strategi.is`. The password is generated and shown in that dialog with a copy button beside it. The only way out of the dialog is **I have saved it**, and it cannot be clicked away by accident, because the password is genuinely not retrievable afterwards.

!!! warning "The password is shown exactly once"
    Nothing can read it back. The engine keeps a copy in `.env.portal-credentials` on the machine that minted it, and that file is the only durable record. If it is lost, the login has to be reset from the engine rather than looked up.

**Adding a second brand to an organisation does not mint a second login.** The one login covers every brand in that org, because access is granted at the org and fans out to each brand under it. So a client with four brands signs in once and switches between them inside the portal.

## Signing in and where a client lands

Your client goes to the same address you do and signs in at the same **Sign in** page with the email and password you sent them. There is no sign-up link on purpose: accounts are provisioned by you.

Where they land depends on how many brands their organisation has.

| Their organisation has | The URL they land on | What they see first |
|---|---|---|
| One brand | `/{brand}` | That brand's **Overview** |
| More than one brand | `/{org}` | A chooser listing their brands, with anything waiting on them at the top |

They never type either URL. Signing in routes them, and every link inside the portal is built for their own account.

!!! note "You cannot preview the portal with your own login"
    An operator account that opens a client URL is bounced straight back to `/admin`. To see what a client sees, sign in with that organisation's portal login in a private window.

## The tabs a client has

Down the left, a brand in the portal has eight rows:

**Overview**, **Content Roadmap**, **Blogs**, **LinkedIn**, **Medium**, **Bluesky**, **X**, **Reports**.

That is your own brand nav with every operator row taken out. There is no Create, no Repurpose, no Settings, and no Resources. A client never uploads, downloads or deletes a file, and the brand's fact base is yours alone.

When an organisation has several brands, a **Brand** picker sits above the nav and an **All brands** row sits under it. Switching brands keeps the client on the same section, so someone comparing two brands' articles stays on **Blogs**.

=== "Overview"

    A masthead with the brand name, its domain and industry, a **Description** card showing how the brand is described to the writers, a **Blogs** card previewing recent articles newest first, and a **Where this brand stands** card with three numbers: **Blogs delivered**, **Waiting on you** and **Roadmap topics**.

=== "Content Roadmap"

    Read-only. Three tiles: **Topics on the roadmap**, **Shipped** and **Waiting on you**, plus a theme card. **Preview roadmap** opens the full sheet, month by month, exactly as your own preview dialog draws it.

    The client sees every column, target prompts included. There is no upload, no download and no delete.

=== "Blogs"

    Three tabs: **Needs answers**, **Ready to post** and **Approved**, with a month picker at the right end when the brand has more than one month of roadmap.

    The table has four columns: **#**, **Title**, **Created** and **Status**. The **#** is the roadmap number, the same number your table shows, so "blog 6" means the same article on both sides.

=== "LinkedIn, Medium, Bluesky, X"

    One tab each, with two sub-tabs: **Ready to post** and **Approved**. Same table, same **#** as the source blog. Opening a post shows the post, a **Post to LinkedIn** button (or Medium, Bluesky, X) that copies the text and opens that platform's composer, and **Approve**.

=== "Reports"

    Only the months you have shared. A picker lists every shared month plus the current one; picking a month you have not shared reads "Report not available yet".

    A shared month renders the same dashboard you see: AI mentions per engine, backlinks, referring domains, Google Lighthouse scores and the plan of action. There is no download button on the client's side.

## What a client can see, and what they never see

An article reaches the portal in exactly six states. Everything else is either absent or folded to one calm word.

| The client's tag | What it means | Where it appears |
|---|---|---|
| **Waiting on you** | The run asked a question only a person can answer | **Needs answers** |
| **Answered** | They answered, and it is back with you | **Needs answers** |
| **Ready to review** | You pressed **Send to client** | **Ready to post** |
| **Pending comments** | They left notes and some are still open | **Ready to post** |
| **Comments resolved** | Every note in the round is addressed | **Ready to post** |
| **Approved** | They approved it, and it is locked | **Approved** |
| **Published** | It is live on their site | **Approved** |

Anything else the record can say is shown as **In progress** with the sentence "Our team is working on this article", and no article body at all. A blog sitting in internal review does not appear in their portal in any form. A failed, died or stopped blog never appears either.

!!! danger "A held blog appears without you sending it"
    An article the run held on a question shows up in the client's **Needs answers** tab as soon as the question exists. You do not press anything, and the client sees the current draft alongside the question so they can answer in context. The draft is captioned as not final.

    If that is not what you want a client reading, answer the question yourself from your own bench before they get to it.

Never on the client wire, in any state: the score, the iteration count, the evaluator, the dossier, `eval.md`, any internal error text, and the raw roadmap CSV. Comment failures are hidden too: an apply that failed reads to the client exactly like one still being worked on.

## Roles

Access is stored per organisation with one of three roles: `admin`, `commenter` or `viewer`.

Every login Canon mints is a **commenter**. An `admin` or a `commenter` may answer questions, request changes and approve. A `viewer` may read and nothing else, and the database refuses their writes.

The portal does not know which role the signed-in account holds, so a viewer sees the same buttons and gets a refusal when they press one. In practice this rarely comes up, because the only role the app ever grants is commenter.

## Which of your acts make something appear

| You do this | Your client sees this |
|---|---|
| A run ends held on a question | The article in **Needs answers**, tagged **Waiting on you**, with the draft and the questions |
| **Send to client** on a blog | The article in **Ready to post**, tagged **Ready to review**, with **Approve** live |
| **Send again** on a blog | The updated article, and any approval they had already given is cleared |
| **Resolve with Claude** on their note | The note's line changes to "Resolved by the team", and the article updates in place |
| Dismiss their note | The note's line changes to "Reviewed, no change" |
| Rename a blog | The new title, everywhere |
| **Send to client** on a channel post | The post on that channel's **Ready to post** sub-tab |
| **Send to client** on a report | That month becomes pickable on **Reports** |
| Upload or generate a roadmap | The topics on **Content Roadmap**, at once |
| **Post to CMS** or **Post to WordPress** | The tag flips to **Published**, and where the site returns an address, a **View live article** button |

Two of those are worth reading twice.

**Send again resets their approval.** The dialog says so before you press it. If a client has approved and you send once more, they have to approve the new version.

**They read the newest version continuously.** While an article is out with a client, you do not re-send after every fix. They see each resolved comment land as you make it. The one time **Send again** appears is at the end of a round of comments, once every note is addressed, and pressing it is what closes the round.

## What a client can do back to you

Three acts, and each one lands on your side without an email.

### Answer a question

They open the article in **Needs answers**, read the draft on the left and the questions on the right, and press **Send answers**. Every question has to be filled in; the button stays disabled until they are all non-blank.

Submitting hands the article back to you. Their tag becomes **Answered**, and the article shows up on your bench as **Answers submitted** for you to rerun.

!!! note "Nothing runs on its own when they answer"
    On default configuration, an answer does not start a revise by itself. The pickup sweep ships disabled, so the rerun happens when you press it. That is why the portal tells the client their answers are "with our editorial team" rather than promising work is under way.

### Request a change

They select any passage in the article and a card opens beside it, quoting what they selected. They type what should change and press **Send to the team**.

Each note arrives as an open suggestion on your stage page, in the rail beside the passage it is about, exactly like one you filed yourself. You resolve it with Claude or dismiss it.

A client can hold at most **ten open suggestions on one article** at a time. Past that the record refuses with a line telling them the team will follow up on the ones already filed.

### Approve

**Approve** sits in the banner at the top of a released article, behind a confirm dialog that tells them approval is permanent.

The approval names the version they read. If you send a newer version while their approval is in flight, the record refuses it and the dialog changes to "This article changed", with **Read the new version**. Their approval is not recorded, and they are asked to read the new one first.

!!! danger "An approval locks the article for everyone, you included"
    Once a client approves, the database refuses every new version of that article, from the portal, from your dashboard and from the engine. No edit, no rerun, no upload. Comments are refused from both sides too.

    The only acts left are posting it and, where the destination supports it, taking it back down. If an approved article is wrong, the fix is a new topic, not an edit.

Approval also gates the live publish: posting to a client's own website is refused until they have approved, because that press is the final release. Posting to the Strategi CMS files a draft for our editors and needs no approval. See [Publishing](../guide/publishing.md).

## Things that surprise operators

**A question holds the blog at any score.** A client who never answers strands the article forever. There is no timeout and no dismiss. Keep question forms short: five at most, each answerable in ten seconds.

**A client can approve with their own notes still open.** That is deliberate. Approving over an open suggestion is them saying the remaining notes no longer block it, and you dismiss those with that context.

**An approved article shows no comments at all**, on either side. The conversation is over and the rail disappears, so the article reads clean.

**The Reports tab shows only what you shared.** Generating a report does nothing for the client. Sharing it does.

**Channel posts have no version anchor.** A channel post is edited in place, so approving one carries no version check and there is no stale refusal on that path.

## Related pages

- [The Blogs tab](../guide/blogs.md), the operator side of the same articles
- [Reviewing and editing](../guide/reviewing.md), where client notes and questions land
- [Publishing](../guide/publishing.md), and why approval gates a live push
- [Social channels](../guide/channels.md), the four channel tabs
- [Reports](../guide/reports.md), and how a month gets shared
