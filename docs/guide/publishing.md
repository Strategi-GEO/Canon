# Publishing a blog

Publishing is the last press. Up to that point an article lives inside Canon, where only your team and the client can see it. Publishing sends it out of Canon, and where it lands depends on one setting on the brand.

Read the next section before you press anything. The two destinations share one button and they are not the same act.

## The two destinations

Every brand publishes to one of two places: the **Strategi CMS**, or the client's own website. Posting to the CMS files a draft that one of our editors reviews, so nothing goes public. Posting to the client's own website puts the article live on their domain, so it is the final release and it waits for the client's approval.

| | Strategi CMS | The client's own website |
|---|---|---|
| What the press does | Files the article as a draft in our CMS | Publishes the article live on the client's domain |
| Who can read it afterwards | A Strategi editor, and the client, because the push also marks the article as sent and their portal then shows it | Anyone on the internet |
| Is it public? | No. An editor reviews the draft in the CMS and decides | Yes. There is no later step |
| When the control appears | From internal review onwards, while the client is reviewing, after changes are requested, once approved, and on a below bar blog you take responsibility for | Only once the client has approved the article |
| Setup per brand | None. Canon already holds one shared key | Their blog address, a WordPress username, and an application password |
| SEO title, description, category, tags | Written from the draft and sent with it | Not sent. A reviewer fills those in on their side |
| Link recorded | None. The CMS answers with a preview token | The article's real URL, offered as a **View on** button |
| Byline | Strategi's own | The WordPress user whose application password you connected |
| Taking it back down | Not from Canon. An editor unpublishes it in the CMS | **Unpublish from** their domain, on the article page |

!!! warning "Posting to a client's own website is live and public the moment you press it"
    There is no draft step and no second confirmation on their side. The article goes out with `status: publish`, it appears on their blog index, their feed and their sitemap, and anyone with the URL can read it. This is why the control does not appear until the client has approved the article: their approval is what authorises the release. You can take it back down (see below), and taking it down does not undo the fact that it was public.

!!! note "A CMS post also delivers the article to the client's portal"
    Posting is treated as a release, so the press stamps the article as sent. If the client had not been sent it yet, it appears in their portal from that moment, tagged **Published**. If they have already approved it, or they have an open change request on it, the stamp is refused and their view does not move. So post to the CMS when you are content for the client to read the article, not as a quiet internal filing step. [Reviewing and editing a blog](reviewing.md) covers the send.

## Setting a brand's destination

Open the brand, go to **Settings**, and find the **Blog destination** card. It says what the brand publishes to today, or offers the form to set one.

A brand with no destination cannot post at all. The **Post** control does not appear on any of its blogs, and the engine refuses the request even if somebody reaches it another way. Every brand that existed before this feature was stamped as **Strategi CMS**, so an empty destination means a brand nobody has set up yet.

=== "Strategi CMS"

    Choose **Strategi CMS** in the **Platform** dropdown and press **Connect**. There is no address and no credential to enter: it is one destination with one key the engine already holds.

=== "The client's own website"

    Paste the client's blog page into **Their blog page**, press **Detect**, fill in the credentials that appear, then press **Connect**. The next section walks through it.

Once a destination is set the card shows a green chip naming it, a line reading "Blogs publish as" and the post type, and the page it was matched against. **Change** starts the form again. **Disconnect** forgets the destination and its credential, which turns the Post control off for that brand immediately. Nothing already published is touched by a disconnect.

## Connecting a WordPress site

WordPress is the one client platform Canon can publish to today.

1. In **Their blog page**, paste the page where their articles are listed, or a link to any one of their articles. A link to a real article is better: it tells the engine which section of their site the blog lives in, so new posts land where the existing ones are.
2. Press **Detect**. Canon fetches the page and reads what platform runs it, purely so you do not have to know. If it cannot tell, that is ordinary: pick the platform from the **Platform** dropdown instead.
3. Fill in **WordPress username**, which is the name they sign in with and not their email address.
4. Fill in **Application password**. The card tells the client's side how to make one: "In WordPress: Users → Profile → Application Passwords → name it Canon → Add New. It is shown once." This is not their login password, and it can be revoked on their side at any time without changing their account.
5. Press **Connect**.

Connecting performs four reads and no writes, so you can press it as many times as you like without leaving anything on the client's site. It proves the credential works, then works out where their blogs actually live: which post type their blog page renders from, and which section new articles should join. Nothing is stored unless all of that succeeded, so a half-working connection leaves the brand exactly as it was.

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

## Posting an article

Open the article from the [Blogs](blogs.md) tab. The **Post** control sits in the row of controls under the title, beside **Send to client** where that one is offered.

The button names where the article is going. On a CMS brand it reads **Post to CMS**. On a WordPress brand it reads **Post to Wordpress**, naming the platform rather than the domain, because the exact address lives on the settings card and on the chip after the push.

Pressing it opens a confirmation. The confirmation is worded for the CMS on both destinations, so read the button label, not the dialog, to know where the article is going. Press **Post as draft** to go ahead or **Cancel** to back out. The dialog stays open until the request settles, so any refusal lands in front of you rather than behind a closed window.

After a successful push:

- A chip appears reading **Posted to CMS**, **Live in the CMS**, or **Published on** their domain, with the time.
- On a website push, a **View on** button opens the real article. That link is the one their site reported, never one Canon built from the slug, because permalink structure differs per site.
- The **Post** control goes away. A published article's only remaining control is **Unpublish**, and only where that article actually went to a website.
- The client's portal shows the article as **Published**, with the sentence "This article is live on your site" and a **View live article** button when a URL was recorded.
- A LinkedIn post and a Medium article are generated from the blog in the background, unless that channel already holds a post or is generating one. Bluesky and X are not fired by a push. See [LinkedIn, Medium, Bluesky and X](channels.md).

!!! warning "The automatic LinkedIn and Medium cuts cost model time"
    Each one opens its own run, so a press on a brand with neither channel written yet buys two generations on top of the push. If you do not want them, generate or delete that channel's post before you post the blog: a channel that already holds a post is left alone.

!!! note "Posting again updates, it does not duplicate"
    Canon remembers which post an article became on the destination. A second press edits that same post rather than creating a second one, at the same address. If somebody has edited the article on the client's site since Canon last pushed it, the push leaves their version alone and tells you so rather than overwriting their work.

### Posting several at once

In the [Blogs](blogs.md) tab, tick the rows you want and use **Post to CMS** in the selection bar. It runs the same door one row at a time, and any blog the door will not accept is left out of the batch rather than failing it. The bulk label reads "Post to CMS" whatever the brand's destination is, so check the destination on the settings card before using it on a website brand.

### When the Post control is not there

The control is removed rather than greyed wherever the state refuses it, because a dead button next to an explained state is a puzzle. The tag beside the article title tells you which state it is in.

| What you see | Why | What to do |
|---|---|---|
| No Post control on any blog for this brand | No destination is set | Set one in **Settings**, under **Blog destination** |
| No Post control on a WordPress brand | The client has not approved this article yet | Send it, and wait for their approval in the portal |
| No Post control, article tagged **Has questions** | The evaluator asked something a person has to answer, and that holds the article at any score | Answer the questions, then let the rerun finish |
| No Post control, article tagged **Stopped** or **Did not finish** | No verdict exists to take responsibility for | Generate the topic again |
| No Post control, article tagged **Failed** with no score beside it | The run never produced a draft an evaluator scored, so there is nothing to ship | Generate the topic again |
| No Post control, article tagged **Published** | It has already gone out | Nothing. A published article is administered where it lives |
| You press, and it is refused because the approval and the article have come apart | A new version was written after the client approved a different one | A person decides which is the real article. Send it again and have the client approve it again |

A below bar blog, one the engine scored under 90 and marked failed, can still be posted. Doing so records you and the score on the article's trail, so the record reads "failed at 87, then a person published it". The bar is the only thing being waived: the draft still passed every mechanical gate and every link check before it was scored.

## Taking an article back down

**Unpublish from** their domain appears beside the published chip, and only where the article is genuinely on a website. An article filed in the Strategi CMS went as a draft and was never public, so there is nothing to take off a website. If an editor has since taken it live in the CMS, the CMS is where it comes back down.

Press it, read the dialog, then press **Take it down**. **Leave it up** backs out.

What happens: the article goes back to a draft on their site. Anyone opening its URL gets a 404. Nothing is deleted. The article, its body, its slug and its full revision history stay exactly where they were, so pressing **Post** again puts this same article back at the same address rather than creating a second one.

!!! warning "Unpublishing costs you the ranking, and the link"
    Search drops the page over the following days, and it does not come back at the same rank when you publish again. AI engines keep citing the URL for weeks after the page stops answering. Any link anyone already has to it breaks. The client's approval, the score and the ledger entry all survive: taking an article off a site does not undo the send or the approval.

If somebody has edited the article on the client's site since Canon published it, the first press is refused with the date, and the dialog stays open. The button then reads **Take it down anyway**. Pressing again goes through. That second press exists because hiding somebody's edit without telling you first is the thing worth preventing, not the hiding itself. Nothing they wrote is deleted either way.

Two outcomes are reported as successes rather than failures: the article was already down, or somebody had already deleted it on their side. Both mean what you asked for is true, and the record now agrees with their site.

## One article, one home

An article should exist at one address. Two copies of the same piece compete with each other in search, and split the citations the whole engine exists to earn.

Three things in Canon keep that true, and none of them need you to do anything:

- **A second Post press updates the existing post.** Canon stores the post it created and edits that one, so pressing again after a fix does not leave two articles behind.
- **Unpublishing keeps the address.** The recorded post and its URL are kept, so publishing again restores the article where it was instead of landing at a second address with a number on the end.
- **Channel posts never go to a site.** A LinkedIn, X, Bluesky or Medium cut of an article is repurposed for that channel and posted there. The bulk bar in the channel library deliberately offers no Post to CMS, because pushing the same article to the site twice is duplicate content.

!!! tip "Where each article actually went is recorded per article, not per brand"
    If a brand moves from the CMS to its own website, articles published before the move still read as having gone to the CMS, and their **Unpublish** control still points at the site they are actually on. The destination on the settings card is where the next press would send an article. The chip on each article is where that one really went.
