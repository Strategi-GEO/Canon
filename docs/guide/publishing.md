# Publishing a blog

Publishing is the last press. Up to that point an article lives inside Canon, where only your team and the client can see it. Publishing puts it live on the client's own website, where anyone can read it.

Read the next section before you press anything.

## What publishing does

Every brand publishes to **its own website**. There is no internal destination and no draft step: the press puts the article on their domain with `status: publish`, and it is public from that moment.

!!! warning "Publishing is live and public the moment you press it"
    There is no second confirmation on their side. The article appears on their blog index, their feed and their sitemap, and anyone with the URL can read it. This is why the control does not appear until the client has approved the article: their approval is what authorises the release. You can take it back down (see below), and taking it down does not undo the fact that it was public.

Publishing moves the client's view too. Their portal tag flips to **Published**, with a **View live article** button. They had already been sent the article and approved it, because that approval is what opened this door.

??? info "The Strategi CMS was removed"
    Canon used to offer a second destination: a draft filed at `client.strategi.is` for one of our editors to review. That destination is gone. Every brand that was on it has had its destination cleared, so those brands show **no website connected** until somebody connects one. Articles that were published to the CMS keep saying so on their own chip, because that is where they really went.

## Connecting the client's website

Open the brand, go to **Settings**, and find the **Blog destination** card.

**A brand with no website connected cannot publish at all.** The **Publish** control does not appear on any of its blogs, and the engine refuses the request even if somebody reaches it another way. That is the state every brand starts in.

WordPress is the one client platform Canon can publish to today.

1. In **Their blog page**, paste the page where their articles are listed, or a link to any one of their articles. A link to a real article is better: it tells the engine which section of their site the blog lives in, so new posts land where the existing ones are.
2. Press **Detect**. Canon fetches the page and reads what platform runs it, purely so you do not have to know. If it cannot tell, that is ordinary: pick the platform from the **Platform** dropdown instead.
3. Fill in **WordPress username**, which is the name they sign in with and not their email address.
4. Fill in **Application password**. The card tells the client's side how to make one: "In WordPress: Users → Profile → Application Passwords → name it Canon → Add New. It is shown once." This is not their login password, and it can be revoked on their side at any time without changing their account.
5. Press **Connect**.

Never ask a client for their WordPress password, their hosting or cPanel login, or FTP details. None of them is needed.

Connecting performs five reads and no writes, so you can press it as many times as you like without leaving anything on the client's site. It proves the credential works, then works out where their blogs actually live: which post type their blog page renders from, which section new articles should join, and whether their SEO plugin will accept a title and description from Canon. Nothing is stored unless all of that succeeded, so a half-working connection leaves the brand exactly as it was.

Once connected the card shows a green chip naming the site, the post type blogs publish as, the section they join, and the SEO plugin if there is one. **Change** starts the form again. **Disconnect** forgets the destination and its credential, which turns the Publish control off for that brand immediately. Nothing already published is touched by a disconnect.

!!! info "Why the site address matters more than it looks"
    Plenty of themes render the blog from a custom post type such as `insights` or `news`. Posting to the standard Posts section on such a site does not fail: WordPress accepts it, Canon records it, and the article sits in a section their theme never shows. Pointing Canon at a real article is what makes that impossible.

If the site had nothing published when you connected it, the card says so and blogs will go to the site's standard Posts. Point it somewhere else once the client has an article live.

### What Connect refuses, and what to do

| The message says | What it means | What to do |
|---|---|---|
| The site must be on https | WordPress does not offer application passwords on a site without SSL, so the credential cannot exist | Their site needs SSL before Canon can publish to it |
| WordPress rejected the login, and mentions the Authorization header | Their server strips the login header before WordPress sees it. This looks identical to a wrong password | Send whoever manages the site the .htaccess line in the message |
| The WordPress REST API is not reachable | A security plugin such as Wordfence, or the host, is blocking it | Ask whoever manages the site to allow requests to /wp-json/ |
| That is a page type, not a blog type | The address points at their pages rather than their blog | Point it at the page where their articles are listed |
| It is not shown on the front end | An article published there would be invisible to readers | Point it at the section their blog index actually renders |

Shopify, Squarespace, Wix and Webflow are detected and named, and Canon refuses them with a sentence explaining why. Squarespace has no public API for creating posts at all. Shopify and Wix need an app registered with the vendor before any credential exists, which is not something you can complete from this screen. Those clients get their articles pasted in by hand.

## The SEO title and description

A client's site sets its page title and meta description from whichever SEO plugin it runs. An article published without them takes the theme's fallback, which is usually the headline verbatim and no description at all. Canon fills them in where the site lets it.

**Whether it can is decided when you connect, not guessed.** WordPress only accepts these fields over its API where the site has been set up to expose them, and having the plugin installed is not the same thing. So Canon reads one of their existing articles back and takes the fields the site itself hands over. The card then names the plugin it found, or says nothing, and a site with nothing writable simply publishes without them.

Four plugins are recognised: **Yoast SEO**, **Rank Math**, **SEOPress** and **The SEO Framework**. AIOSEO is not, because it keeps these fields somewhere Canon cannot reach.

!!! note "A field somebody already filled in is never overwritten"
    On a first publish the article is new, so both fields are written. On a second press Canon reads what the article holds and fills only what is still empty. If somebody on the client's side has typed their own SEO title, it stays. This is the same rule Canon keeps for the article body.

## Publishing an article

Open the article from the [Blogs](blogs.md) tab. The **Publish** control sits in the row of controls under the title, beside **Send to client** where that one is offered. The button names the platform, because the exact address lives on the settings card and on the chip after the push.

Pressing it opens a confirmation naming the site and saying what goes across. Press **Publish** to go ahead or **Cancel** to back out. The dialog stays open until the request settles, so any refusal lands in front of you rather than behind a closed window.

After a successful push:

- A chip appears reading **Published on** their domain, with the time.
- A **View on** button opens the real article. That link is the one their site reported, never one Canon built from the slug, because permalink structure differs per site.
- The **Publish** control goes away. A published article's only remaining control is **Unpublish**.
- The client's portal shows the article as **Published**, with the sentence "This article is live on your site" and a **View live article** button.
- A LinkedIn post and a Medium article are generated from the blog in the background, unless that channel already holds a post or is generating one. Bluesky and X are not fired by a push. See [LinkedIn, Medium, Bluesky and X](channels.md).

!!! warning "The automatic LinkedIn and Medium cuts cost model time"
    Each one opens its own run, so a press on a brand with neither channel written yet buys two generations on top of the push. If you do not want them, generate or delete that channel's post before you publish the blog: a channel that already holds a post is left alone.

!!! note "Publishing again updates, it does not duplicate"
    Canon remembers which post an article became on their site. A second press edits that same post rather than creating a second one, at the same address. If somebody has edited the article on the client's site since Canon last pushed it, the push leaves their version alone and tells you so rather than overwriting their work.

### What goes across

The draft exactly as the evaluator scored it, converted to HTML. Nothing is rewritten on the way, so the article a reader opens is the one in the blog.md tab.

- **The byline is theirs.** The article posts as the WordPress user whose application password connected the site.
- **It joins the section you pointed Canon at**, so it sits with their existing articles rather than under the site default.
- **Tags and categories are not created.** Canon does not add terms to a client's taxonomy.
- **The SEO title and description** go where their plugin accepts them, as above.

### Publishing several at once

In the [Blogs](blogs.md) tab, tick the rows you want and use **Publish** in the selection bar. It runs the same per-blog door for every ticked row at once, and any blog the door will not accept is left out of the batch rather than failing it.

### When the Publish control is not there

The control is removed rather than greyed wherever the state refuses it, because a dead button next to an explained state is a puzzle. The tag beside the article title tells you which state it is in.

| What you see | Why | What to do |
|---|---|---|
| No Publish control on any blog for this brand | No website is connected | Connect one in **Settings**, under **Blog destination** |
| No Publish control on one article | The client has not approved this article yet | Send it, and wait for their approval in the portal |
| No Publish control, article tagged **Has questions** | The evaluator asked something a person has to answer, and that holds the article at any score | Answer the questions, then let the rerun finish |
| No Publish control, article tagged **Stopped** or **Did not finish** | No verdict exists to take responsibility for | Generate the topic again |
| No Publish control, article tagged **Failed** with no score beside it | The run never produced a draft an evaluator scored, so there is nothing to ship | Generate the topic again |
| No Publish control, article tagged **Published** | It has already gone out | Nothing. A published article is administered where it lives |
| You press, and it is refused because the approval and the article have come apart | A new version was written after the client approved a different one | A person decides which is the real article. Send it again and have the client approve it again |

A below bar blog, one the engine scored under 90 and marked failed, can still be published. Doing so records you and the score on the article's trail, so the record reads "failed at 87, then a person published it". The bar is the only thing being waived: the draft still passed every mechanical gate and every link check before it was scored.

## Taking an article back down

**Unpublish from** their domain appears beside the published chip.

Press it, read the dialog, then press **Take it down**. **Leave it up** backs out.

What happens: the article goes back to a draft on their site. Anyone opening its URL gets a 404. Nothing is deleted. The article, its body, its slug and its full revision history stay exactly where they were, so pressing **Publish** again puts this same article back at the same address rather than creating a second one.

!!! warning "Unpublishing costs you the ranking, and the link"
    Search drops the page over the following days, and it does not come back at the same rank when you publish again. AI engines keep citing the URL for weeks after the page stops answering. Any link anyone already has to it breaks. The client's approval, the score and the ledger entry all survive: taking an article off a site does not undo the send or the approval.

If somebody has edited the article on the client's site since Canon published it, the first press is refused, and the dialog stays open. The button then reads **Take it down anyway**. Pressing again goes through. That second press exists because hiding somebody's edit without telling you first is the thing worth preventing, not the hiding itself. Nothing they wrote is deleted either way.

Two outcomes are reported as successes rather than failures: the article was already down, or somebody had already deleted it on their side. Both mean what you asked for is true, and the record now agrees with their site.

## One article, one home

An article should exist at one address. Two copies of the same piece compete with each other in search, and split the citations the whole engine exists to earn.

Three things in Canon keep that true, and none of them need you to do anything:

- **A second Publish press updates the existing post.** Canon stores the post it created and edits that one, so pressing again after a fix does not leave two articles behind.
- **Unpublishing keeps the address.** The recorded post and its URL are kept, so publishing again restores the article where it was instead of landing at a second address with a number on the end.
- **Channel posts never go to a site.** A LinkedIn, X, Bluesky or Medium cut of an article is repurposed for that channel and posted there. The bulk bar in the channel library deliberately offers no Publish, because pushing the same article to the site twice is duplicate content.

!!! tip "Where each article actually went is recorded per article, not per brand"
    If a brand moves from one website to another, articles published before the move still read as having gone to the first, and their **Unpublish** control still points at the site they are actually on. What is on the settings card is where the *next* press would send an article. The chip on each article is where *that one* really went. Canon will not replay one site's article id at another site, so a brand that changes destination publishes a fresh article rather than editing a stranger's post.
