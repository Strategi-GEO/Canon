# Bluesky Mechanics

Detailed rules for Bluesky posts. Read this before drafting any Bluesky piece.

## What Bluesky rewards

Bluesky reads like early Twitter. It is conversational, low-polish, and fast. The people there came from a platform they left, and the thing most of them left was marketing voice, so a post that sounds like a brand announcement is not ignored, it is actively disliked. Lowercase openings are normal. Contractions are normal. A post that is one sentence long is normal.

Distribution runs on custom feeds, reposts, and follows, not on an engagement-maximising ranker. There is no reach to be farmed by asking for replies, and asking reads as the tell of someone who does not use the platform. The post that travels is the one somebody wanted to repost, which means the post has to be worth repeating on its own.

For a client, this cuts one way: say the sharp thing the blog says, in the fewest words it survives in, and put the link where a curious reader can take it.

## The 300-grapheme limit

Three hundred graphemes per post. This is the platform limit, enforced at the API, not a style preference. A post at 301 does not get truncated, it gets refused, so an over-limit draft is not a long draft, it is an unpostable one.

Graphemes, not bytes and not code points. An emoji, an accented character, and a devanagari cluster each count as one grapheme even though each is several bytes. There is a second cap of 3,000 bytes that plain Latin text never reaches; it can bind for scripts where every character is three or four bytes, so on a non-Latin draft check the byte length too.

Aim to land between 200 and 280. The last twenty graphemes are the ones you want spare when the operator's link turns out longer than you assumed.

## Links and link cards

This is the rule that differs most from LinkedIn, and it differs in both directions.

Bluesky does NOT suppress posts that carry an external link. There is no reach penalty to route around, so **the canonical blog link goes in the post itself, never in a reply**. Parking it in a reply is a LinkedIn habit that costs a Bluesky post its click for nothing.

The first URL in the post renders a rich link card underneath, pulling the title, description, and image from the page's own open-graph tags. The card is why the post does not need to describe the article: the card already says what the piece is called. Do not spend graphemes restating the headline the card will display.

The URL text is not shortened and not hidden. Every character of it counts against the 300. A canonical blog URL of 70 characters leaves 230 for the actual writing, so measure the link first and draft against what is left. Use the canonical URL from `canonical-facts.md` exactly as recorded. Never guess a slug, and never hand the operator a shortened link the client did not create.

## One post or a thread

Default to one post. Threads are native and cheap here, which is precisely why an unearned thread is conspicuous: it says the writer had a word count to hit rather than an argument to make.

Write a thread of 3 to 5 posts only when the argument has a step a single post cannot carry:
- A number that is misleading without its condition.
- A claim that needs its concession attached, which the client's honest-negatives rule may require.
- A comparison that needs both options present to mean anything.

Five posts is the ceiling for a repurpose. Past that, the piece is the blog, and the blog already exists at the other end of the link.

In a thread, each post stands alone. Reposts detach a post from its chain, so a post that reads as a fragment gets seen as a fragment. Every post carries its own complete claim, and the client's entity name appears in any post that could be read on its own.

## Hook patterns that work

Pick one pattern per post. Do not stack them.

**The flat claim.** State the argument with no runway at all.
- "Farmland outside Bangalore is priced on yield. Most of the people buying it are not farming."

**The specific number.** One hard figure, with the thing that makes it surprising.
- "140 NICU parents asked our team the same question last month. None of the hospital sites answered it."

**The correction.** Name the common belief in one clause, then flip it.
- "Heritage hotels sell charm. The guests who actually book them are buying quiet."

**The overheard question.** Open with the question the reader is already asking, in the words they would use.
- "is it still worth building a content team if AI search answers the question directly"

**The admission.** Something the brand got wrong, or turned down, or changed its mind about.
- "We priced our first three plots on yield. It was the wrong number to lead with and buyers told us so."

## Hook anti-patterns

Do not open with:
- "Excited to share..." or any announcement voice.
- "New blog post:" or "Just published:".
- "A thread:" or "🧵" or "1/". The reply chain is visible; announcing it wastes graphemes and reads as imported from elsewhere.
- "Let's talk about..." or "Some thoughts on...".
- "Hot take:" or "Unpopular opinion:".
- A rocket, fire, or lightbulb emoji as the first character.
- Anything that would be at home in a LinkedIn feed.

## No hashtags

Bluesky renders hashtags as working links, and that is the whole of what they do. Discovery here runs on custom feeds, reposts, follows, and starter packs, none of which read tags the way a hashtag-driven platform does. Culturally, tags on a brand post read as spam, and a stack of them reads as a bot.

Use zero. This is deliberately the opposite of the LinkedIn rule of three to five, and it is not a difference to split: two tags are not a compromise, they are a smaller version of the wrong move.

## Alt text

If the post carries an image, it carries alt text. This is a strong community norm on Bluesky, close to obligatory, and posting an image without it draws public correction, which is a worse outcome for a client than posting no image.

Write the alt text as one or two plain sentences describing what is in the image, for someone who cannot see it. Describe the content, not the vibe. A chart's alt text names what it plots and what it shows. Alt text is not a caption and not a second hook, so do not put the sales line in it.

## Formatting rules

- **No markdown renders.** Asterisks show up as asterisks. No bold, no italic, no headers, no markdown links.
- **Facets are automatic.** A bare URL is detected and linked. A mention written as a full handle, `@name.example.com`, resolves. Write both plainly and do not decorate them.
- Line breaks work and are worth using. A two-line post with a break before the turn reads faster than one block.
- No ALL CAPS for emphasis.
- Emojis: zero or one, and only if the client's voice genuinely uses them. Never as the first character.
- No "link in bio". The link goes in the post.
- No em dashes and no en dashes. Use a period, a comma, or a new line.

## Counting characters

Count. Do not estimate. The cheapest way, given the draft is on disk:

```
python3 -c "import sys; [print(len(p.strip()), repr(p[:40])) for p in open(sys.argv[1]).read().split('\n---\n')]" post.md
```

Python's `len` counts code points, which for ordinary Latin text equals the grapheme count and for emoji with skin-tone or joiner sequences overcounts. Overcounting is the safe direction: a draft that passes a code point count passes the platform's grapheme count too.

State the counted number in the file, in the header line of every post. The operator uses it to sanity check before pasting, and a number that is present and wrong is worse than absent, so count the final text and not an earlier draft of it.

## Worked example structure

Single post:

```
Post 1 (268 chars)
The claim, stated flat, in one or two lines.

The condition or the number that makes it true.

https://client.example.com/the-post
```

Thread:

```
Post 1 (231 chars)
The claim, stated flat. Complete on its own.

---

Post 2 (207 chars)
The number, with the condition that makes it mean something. Names the entity.

---

Post 3 (184 chars)
The concession, made against the option and never a company. Then the link.

https://client.example.com/the-post
```
