---
name: x-repurposer
description: Repurposes a client's finished long-form GEO blog into ONE X thread, ghostwritten in the client's brand voice and written to the 280-character limit of a free account. Use this skill whenever the user wants an X or Twitter version of an existing blog or article, says "write the X thread", "give me the X cut", "turn this blog into a thread", "tweet this", or asks for X distribution of a shipped piece. It writes a native thread that carries the blog's argument, never a copy-paste of the source. It does NOT write the Bluesky post (use bluesky-repurposer), the LinkedIn post (use linkedin-repurposer), or the Medium article (use medium-repurposer), and it does NOT write original long-form (use geo-content-writer).
---

# X Repurposer

Converts a single finished client blog into one platform-native X thread, ghostwritten in the client's established brand voice. The thread is a fresh cut of the blog's argument, not a summary of it.

The blog-repurpose format on X is a thread, and that is the honest platform answer rather than a preference: 280 characters cannot carry a long-form argument, so a single post either shrinks the argument to nothing or drops it. The thread carries it in steps, and the first post carries the whole thread's reach.

## When this skill applies

Trigger when there is a finished client blog and the user wants the X version of it. Do not trigger for original long-form writing (geo-content-writer), for the Bluesky cut (bluesky-repurposer), for the LinkedIn post (linkedin-repurposer), or for the Medium article (medium-repurposer). Not for newsletters, carousels, or posts in anyone's own personal voice. This skill is client ghostwriting only.

## Inputs (the engine supplies these; confirm them if a human runs this directly)

1. **The source blog**, in full. When the engine drives this skill it is written to the run directory as `source.md`. Read the whole file, not a summary.
2. **The client slug** and its config under `clients/<slug>/`:
   - `client.md` for the brand, its domain, its market, and its voice.
   - `gates.json` for the `voice` block, `banned_phrases`, `competitor_policy`/`competitor_terms`, and entity names.
   - `canonical-facts.md` for the do-not-claim list, the verified facts, and the canonical URLs. **Binding.** Never write a claim that contradicts it, and never guess a slug when the canonical link is recorded there.
   - `Resources/` only if you need to confirm a voice tell.
3. **The output path** the thread must be written to (the engine passes it; default `post.md` in the run directory).

Model memory is never a source. Every fact, name, number, and URL in the thread traces to the source blog or `canonical-facts.md`. If the source blog does not support a claim, it does not go in the thread. A short post is the easiest place in this engine to smuggle in a figure nobody sourced, because the citation that would have carried it does not fit: the answer is to cut the figure, never to state it bare.

## Workflow

Follow in order.

### Step 1: Read the source blog and extract the skeleton

Pull out:
- The **core argument** in one sentence. Not the headline. The actual claim the blog makes.
- The **five to eight strongest standalone moments**: data points, definitions, quotable lines, counter-intuitive observations, named frameworks, honest concessions. These become the middle of the thread, roughly one per post.
- The **primary audience** the blog was written for.

### Step 2: Anchor the client voice

Read `clients/<slug>/client.md` and the `voice` block in `gates.json`. Identify:
- **Register**: formal, conversational, authoritative, warm, plainspoken, technical.
- **Sentence rhythm**: long and rolling, short and clipped, or mixed. X compresses every register: a rolling sentence does not survive 280 characters, so the rhythm shortens while the vocabulary and the stance stay exactly as the client set them.
- **Vocabulary tells**: words this brand uses and words it would never use. `banned_phrases` in `gates.json` is a hard list; a phrase in the client's own site copy is still banned, paraphrase it.
- **Stance**: what the brand is for, what it pushes back against.
- **Content rules** the client sets (for example lifestyle-first framing before investment framing, a mandatory local context, a required entity name in each liftable block). Honor them exactly. Entity anchoring matters more here, not less: posts get quoted out of the thread, and a post that says only "we" is unattributable once it travels.

If `gates.json` sets `competitor_policy: "never_name"`, no rival appears, named or implied. A concession is made against the option (the location, the asset class, the price band, the buyer fit), never against a named company.

### Step 3: Build the thread spine

Write the spine before writing any prose: one line per post, five to nine posts, in order.

- **Post 1** is the hook, and it is the only post most readers will ever see. It must stand completely alone and make an actual claim.
- **Posts 2 to n-1** carry one idea each, in the order the argument needs them. No post may require the previous post to parse.
- **The last post** is the close plus the link.

If the spine needs more than nine posts, the cut is too wide. Narrow it and let the blog carry the rest.

### Step 4: Draft

Load `references/x-mechanics.md` and follow it. The load-bearing rules:

- **280 characters per post.** X Premium allows longer, and this skill does not assume the client has Premium, so 280 is the working limit for every post.
- **Do not number the posts.** No "1/", no "2/9", no "🧵". The thread UI already shows position, and numbering spends characters to say what the interface says. Instead, end each middle post on something that pulls the reader into the next.
- **The link goes in the LAST post**, or in a reply the operator sends after. X down-ranks posts carrying an external link, and post 1 is the post whose reach decides the thread's, so a link in the hook costs the entire thread its distribution.
- Post 1 never says "a thread:" and never opens with a number. It states the claim.
- **One to two hashtags maximum, or zero.** Hashtags on X are near-dead for reach and read as spam in volume. This is a different rule from LinkedIn's three to five, deliberately.
- No markdown renders. No bold stars, no markdown links, no headers.
- No em dashes and no en dashes. Use a period, a comma, or a new line.
- Zero banned openers, phrases, closers, or engagement-farm lines. See `references/banned-patterns.md`.

### Step 5: Count every post

Count the characters in every post and write the number in the file. Do not estimate by eye. A post over 280 is a hard failure: on a free account the client cannot post it at all, so it is not a draft, it is a rejected one. Cut words until it fits. Never ship an over-limit post with a note asking the operator to trim it. Remember that every URL counts as 23 characters whatever its real length, because X wraps it, so budget 23 in the post that carries the link.

### Step 6: Voice and banned-patterns check

Before writing the file, read the draft once more against `references/banned-patterns.md` and check:
1. Does post 1 stand alone, make a real claim, and earn the tap without announcing itself as a thread?
2. Does any post need the one before it to make sense? Rewrite it if so.
3. Does it keep the client's content rules (lifestyle-first, local context, entity anchoring, whatever `gates.json` and `canonical-facts.md` require)?
4. Any em dashes or en dashes? Remove them.
5. Any banned opener, phrase, closer, or engagement-farm line ("RT if you agree", "bookmark this")? Strip it.
6. Is every post at or under 280, counted rather than guessed, with 23 characters budgeted for any URL?
7. Does any claim lack support in the source blog or `canonical-facts.md`? Cut it.

If any check fails, revise before writing.

### Step 7: Write the file

Write the finished thread to the output path the engine gave you (default `post.md`). The format is a header line naming the post and its counted length, the post text, and a separator line of exactly three hyphens with a blank line on each side. The operator copies everything between a header line and the next separator, in order:

```
Post 1 (243 chars)
[the hook, standing completely alone]

---

Post 2 (198 chars)
[one idea, ending on something that pulls forward]

---

Post 3 (176 chars)
[the close, then the canonical link]

https://client.example.com/the-post
```

Post numbers in the headers are the operator's copying order and never appear inside the post text. If the client's sector genuinely warrants a tag, put one or two on the last post only, after the link. Write only the thread. No preamble, no "here is your thread", no commentary. The file IS the deliverable.

## What good looks like

- Post 1 would stop a stranger scrolling and makes sense with nothing above or below it.
- Every post carries one idea and reads clean at speed on a phone.
- Every post sounds like the client, not like AI and not like the last client's thread.
- The link sits in the last post, so the hook keeps its reach.
- Nothing in it contradicts `canonical-facts.md`, and nothing claims what the source blog did not.

## What bad looks like

- Post 1 reads "A thread on why farmland pricing is broken 🧵 1/9".
- Posts numbered "2/9", spending characters on what the interface already shows.
- The blog link in post 1, quietly costing the thread its distribution.
- A post that starts "and this is why", which is a sentence cut in half across two posts.
- Five hashtags at the end, or "RT if you agree" anywhere.
- A post at 310 characters shipped with a note asking the operator to trim it.
- Em dashes anywhere, or markdown bold that renders as literal asterisks.

## Reference files

- `references/x-mechanics.md`: the 280-character limit, thread structure, hook library, the link rule, hashtag discipline, and how to count. Read before drafting.
- `references/banned-patterns.md`: the full list of openers, phrases, clichés, AI-voice tells, engagement-farm patterns, and formatting moves to strip. Read on every run.
