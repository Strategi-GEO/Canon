# X Mechanics

Detailed rules for X threads. Read this before drafting any X piece.

## What X rewards

X is read at speed, on a phone, mostly by people who did not go looking for the post. The timeline is ranked, so the first post decides everything: how far the thread travels, how many people open it, and whether the rest of it exists as far as most readers are concerned.

That makes the economics of an X repurpose different from every other channel here. On Medium the whole piece competes. On LinkedIn the first two lines compete. On X the first post competes, and the other eight are the reward for the people who tapped.

Threads are read in one scroll. A reader who has tapped through is moving fast, so a post that needs re-reading loses them mid-thread, and the post after it never gets seen.

## The 280-character limit

280 characters per post on a free account. X Premium raises the cap, and this skill does not assume the client pays for Premium, so **280 is the working limit for every post**. A thread written to a longer limit is unpostable on the account it was written for, which is a hard failure, not a formatting note.

Every URL counts as 23 characters regardless of its real length, because X wraps every link in its own shortener. A 90-character canonical blog URL spends 23. Budget those 23 in the post that carries the link and never in any other.

Aim for 180 to 250 in the middle posts. Posts that hug the limit read as cramped, and the whole point of a thread is that you have another post available.

## Why the repurpose is a thread

Default to 5 to 9 posts. Below five, the argument is thin enough that the blog did not need repurposing. Above nine, the reader is being asked to consume the blog inside the timeline, which is what the link is for.

A single post is the wrong shape for a blog repurpose. Not because a single post cannot perform, but because 280 characters either shrinks the blog's argument into a slogan or carries one detail and abandons the rest. If the piece genuinely reduces to one strong line, say so to the operator and write that line as post 1 with the link in post 2.

## Post 1: the hook

Post 1 is the only post most readers will see. It has three jobs: stand completely alone, make an actual claim, and give a reason to tap.

Patterns that work. Pick one, do not stack them.

**The flat claim.** State the argument with no runway.
- "Farmland outside Bangalore is priced on yield. Almost nobody buying it intends to farm."

**The specific number.** One hard figure and the thing that makes it surprising.
- "140 NICU parents asked our team the same question last month. Not one hospital website answered it."

**The correction.** The common belief in one clause, then the flip.
- "Heritage hotels sell charm. The guests who actually book them are paying for quiet."

**The named pattern.** Name something you keep seeing, then commit to explaining it.
- "Every real estate brochure we read this year made the same mistake: the price arrives before the life does."

**The admission.** Something the brand got wrong, turned down, or changed its mind about.
- "We priced our first three plots on yield. Buyers told us it was the wrong number to lead with."

What post 1 must never be:
- "A thread:" or "🧵" or "1/". Announcing the thread is not a claim, and the interface already shows it.
- "Let's talk about..." or "Some thoughts on...".
- A question with no content behind it ("Ever wondered about farmland?").
- A teaser that withholds the subject ("This changes how we think about land. Here is why.").
- The blog headline pasted in with a link.

## Middle posts

One idea per post. A post that carries two ideas gets skimmed for the first one.

**No post may need the previous post to parse.** Do not run a sentence across a post boundary, and do not open a post with "and", "but", "which is why", or a bare pronoun pointing back. Posts get quote-posted alone, and a fragment quoted alone reads as a fragment. Where a post could travel on its own, the client's entity name goes in it.

**End each middle post on a pull.** Not a cliffhanger and not "keep reading", both of which read as manipulation. A pull is simply an idea that is obviously unfinished: a number whose explanation is owed, a claim with a stated exception coming, a question the next post answers. The last sentence should leave the reader wanting the next post rather than telling them to want it.

Give one post to the honest concession where the source blog makes one. Under `competitor_policy: "never_name"` that concession is made against the option, never against a company. A thread of nine consecutive wins reads as an ad.

Line breaks inside a post work and are worth using. Two short lines with a break read faster than one dense block.

## The last post and the link

The last post is the close plus the link.

**The link goes here, not in post 1**, and the reason is mechanical: X down-ranks posts carrying an external link, and post 1's reach is the thread's reach. A link in the hook throttles everything behind it. The alternative placement is a reply the operator sends once the thread is up, which behaves the same way; the last post is the default because it needs no second action from the operator.

The close states the argument's payoff in the client's voice and then hands over the URL. Use the canonical URL from `canonical-facts.md` exactly as recorded. Never guess a slug. Do not write "link below" or "check the thread": say the thing, then give the link.

## Numbering

Do not number the posts. No "1/", no "2/9", no "🧵", no "(cont.)".

The thread UI shows position already, numbering costs characters that the writing needs, and a numbered thread reads as a format from 2016. The header lines in the output file carry the order for the operator; nothing about the order appears inside the post text.

## Hashtags

One to two maximum, or zero. Zero is the usual right answer.

Hashtags on X are close to dead for reach: discovery runs on the ranker, on quote posts, and on who follows whom. In volume they read as spam, and three or more on a brand post reads as a bot. This is a different rule from LinkedIn's three to five, and the difference is the platform, not a matter of taste.

If a tag genuinely earns its place, put it on the last post, after the link, and make it specific to the client's sector. Never inline in the middle of a sentence, and never on post 1, where every character is doing work.

## Formatting rules

- **No markdown renders.** Asterisks show as asterisks. No bold, no italic, no headers, no markdown links.
- **No ALL CAPS for emphasis.** Use a line break.
- **No bullet symbols** unless the client's voice genuinely uses lists. Inside 280 characters, prose almost always wins.
- Emojis: zero or one across the whole thread, and only if the client's voice uses them. Never as the first character of post 1.
- Mentions are fine when the account is genuinely being referenced. Never to farm reach.
- No em dashes and no en dashes. Use a period, a comma, or a new line.

## Counting characters

Count. Do not estimate. The cheapest way, given the draft is on disk:

```
python3 -c "import sys; [print(len(p.strip()), repr(p[:40])) for p in open(sys.argv[1]).read().split('\n---\n')]" post.md
```

Then adjust the post that carries a URL: subtract the URL's real length and add 23, which is what X counts it as.

State the counted number in the file, in the header line of every post. The operator uses it to sanity check before pasting, and a number that is present and wrong is worse than absent, so count the final text and not an earlier draft of it.

## Worked example structure

```
Post 1 (219 chars)
The claim, flat, standing alone. No thread announcement, no number.

---

Post 2 (204 chars)
The evidence: one number, with the condition that makes it mean something. Names the entity.

---

Post 3 (188 chars)
The second idea, complete on its own, ending on something obviously unfinished.

---

Post 4 (231 chars)
The concession, made against the option and never a company.

---

Post 5 (167 chars)
The close, in the client's voice. Then the link.

https://client.example.com/the-post
```
