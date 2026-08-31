---
name: bluesky-repurposer
description: Repurposes a client's finished long-form GEO blog into ONE Bluesky post, or a short thread where the argument genuinely needs one, ghostwritten in the client's brand voice. Use this skill whenever the user wants a Bluesky version of an existing blog or article, says "write the Bluesky post", "give me the Bluesky cut", "post this on Bluesky", "turn this blog into a skeet", or asks for Bluesky distribution of a shipped piece. It writes native Bluesky text inside the 300-grapheme limit, never a copy-paste of the source. It does NOT write the X thread (use x-repurposer), the LinkedIn post (use linkedin-repurposer), or the Medium article (use medium-repurposer), and it does NOT write original long-form (use geo-content-writer).
---

# Bluesky Repurposer

Converts a single finished client blog into one platform-native Bluesky post, or a short thread where the argument genuinely needs one, ghostwritten in the client's established brand voice. The post is a fresh cut of the blog's argument, not a summary of it.

Bluesky reads like early Twitter, not like a professional network. It is conversational, low-polish, and allergic to marketing voice: a post that sounds like a brand announcement dies there, and engagement bait dies faster. A good repurpose takes ONE sharp cut of the blog's argument, lands it inside 300 graphemes, and sounds like a person somebody would follow.

## When this skill applies

Trigger when there is a finished client blog and the user wants the Bluesky version of it. Do not trigger for original long-form writing (geo-content-writer), for the X thread (x-repurposer), for the LinkedIn post (linkedin-repurposer), or for the Medium article (medium-repurposer). Not for newsletters, carousels, or posts in anyone's own personal voice. This skill is client ghostwriting only.

## Inputs (the engine supplies these; confirm them if a human runs this directly)

1. **The source blog**, in full. When the engine drives this skill it is written to the run directory as `source.md`. Read the whole file, not a summary.
2. **The client slug** and its config under `clients/<slug>/`:
   - `client.md` for the brand, its domain, its market, and its voice.
   - `gates.json` for the `voice` block, `banned_phrases`, `competitor_policy`/`competitor_terms`, and entity names.
   - `canonical-facts.md` for the do-not-claim list, the verified facts, and the canonical URLs. **Binding.** Never write a claim that contradicts it, and never guess a slug when the canonical link is recorded there.
   - `Resources/` only if you need to confirm a voice tell.
3. **The output path** the post must be written to (the engine passes it; default `post.md` in the run directory).

Model memory is never a source. Every fact, name, number, and URL in the post traces to the source blog or `canonical-facts.md`. If the source blog does not support a claim, it does not go in the post. Three hundred graphemes is not room to hedge a fact into safety: an unsupported claim gets cut, never softened.

## Workflow

Follow in order.

### Step 1: Read the source blog and extract the skeleton

Pull out:
- The **core argument** in one sentence. Not the headline. The actual claim the blog makes.
- The **three strongest standalone moments**: a data point, a definition, a quotable line, a counter-intuitive observation, a named framework. A single Bluesky post takes exactly ONE of them. A thread takes at most three.
- The **primary audience** the blog was written for.

### Step 2: Anchor the client voice

Read `clients/<slug>/client.md` and the `voice` block in `gates.json`. Identify:
- **Register**: formal, conversational, authoritative, warm, plainspoken, technical.
- **Sentence rhythm**: long and rolling, short and clipped, or mixed. Bluesky compresses every register toward the short end. A formal client still writes shorter sentences here, and that is a platform translation, not a voice change.
- **Vocabulary tells**: words this brand uses and words it would never use. `banned_phrases` in `gates.json` is a hard list; a phrase in the client's own site copy is still banned, paraphrase it.
- **Stance**: what the brand is for, what it pushes back against. Bluesky rewards a stated position and punishes a press release.
- **Content rules** the client sets (for example lifestyle-first framing before investment framing, a mandatory local context, a required entity name in each liftable block). Honor them exactly. Entity anchoring survives the compression: a post that says only "we" is unattributable once it is reposted away from the profile.

If `gates.json` sets `competitor_policy: "never_name"`, no rival appears, named or implied. A concession is made against the option (the location, the asset class, the price band, the buyer fit), never against a named company.

### Step 3: Decide one post or a thread

Default to ONE standalone post of 300 graphemes or fewer. Threads are native and cheap on Bluesky, which is exactly why an unearned one is obvious. Write a 3 to 5 post thread only when the argument has a step the single post genuinely cannot carry: a number that means nothing without its condition, a claim that needs its concession attached, a comparison that needs both sides. State in one line why the thread is needed before drafting it. If you cannot state it, write one post.

### Step 4: Draft

Load `references/bluesky-mechanics.md` and follow it. The load-bearing rules:

- **300 graphemes per post, hard.** That is the platform limit, not a style target. An over-limit post cannot be posted at all.
- The canonical blog link goes IN the post, not in a reply. Bluesky does not suppress links the way LinkedIn does, and the first URL renders a rich link card. The URL text itself spends graphemes from the 300, so budget it before drafting.
- **No hashtags.** Discovery on Bluesky runs on custom feeds, reposts, and follows. Hashtags render, and they read as spam. This is the opposite of the LinkedIn rule, deliberately.
- No markdown renders. No bold stars, no markdown links, no headers. Paste the plain URL and let facet detection link it.
- No em dashes and no en dashes. Use a period, a comma, or a new line.
- Zero banned openers, phrases, or closers, and zero LinkedIn voice. See `references/banned-patterns.md`.
- Each post in a thread stands alone. A reader who sees post 3 in isolation, because someone reposted it, still gets a complete claim.

### Step 5: Count every post

Count the graphemes in every post and write the number in the file. Do not estimate by eye. A post over 300 is a hard failure: the client cannot post it, so it is not a draft, it is a rejected one. Cut words until it fits. Never ship an over-limit post with a note asking the operator to trim it, and never split a single post into two just to dodge the count.

### Step 6: Voice and banned-patterns check

Before writing the file, read the draft once more against `references/banned-patterns.md` and check:
1. Does it sound like a person on Bluesky, or like a LinkedIn post that wandered in?
2. Does it keep the client's content rules (lifestyle-first, local context, entity anchoring, whatever `gates.json` and `canonical-facts.md` require)?
3. Any em dashes or en dashes? Remove them.
4. Any banned opener, phrase, or closer? Any hashtag? Strip it.
5. Is every post at or under 300, counted rather than guessed?
6. Does any claim lack support in the source blog or `canonical-facts.md`? Cut it.

If any check fails, revise before writing.

### Step 7: Write the file

Write the finished post to the output path the engine gave you (default `post.md`). The format is a header line naming the post and its counted length, the post text, and a separator line of exactly three hyphens with a blank line on each side. The operator copies everything between a header line and the next separator. A single post uses the same format with one post:

```
Post 1 (271 chars)
[the post text, line breaks preserved, canonical link included]
```

A thread uses the same header and separator, in order:

```
Post 1 (243 chars)
[the post text]

---

Post 2 (198 chars)
[the post text, canonical link included]
```

If the cut depends on a visual the operator would attach (a chart, a table, a photograph named in the source blog), add one final block after the last separator, headed `Alt text:`, carrying one or two plain sentences describing the image. Alt text is a near-obligatory community norm on Bluesky, so an image without it costs the post more than it gains. Omit the block entirely when the post is text only.

Write only the post. No preamble, no "here is your post", no commentary. The file IS the deliverable.

## What good looks like

- The post could have been written by a person, and a stranger scrolling would stop for it.
- Every line sounds like the client, not like AI and not like the last client's post.
- The link is in the post, the card will render, and the count fits under 300 with room to breathe.
- Each post in a thread makes complete sense lifted alone.
- Nothing in it contradicts `canonical-facts.md`, and nothing claims what the source blog did not.

## What bad looks like

- The post opens "Excited to share our latest piece on..." and reads like a press release.
- Hashtags at the end, or three of them stuffed inline.
- A five-post thread carrying an argument one post could have made.
- A post at 340 graphemes shipped with a note asking the operator to trim it.
- Em dashes anywhere, or markdown bold that renders as literal asterisks.
- The link parked in a reply because that is what LinkedIn wants.

## Reference files

- `references/bluesky-mechanics.md`: the grapheme limit, link cards, thread discipline, hook library, the no-hashtag rule, alt text, and how to count. Read before drafting.
- `references/banned-patterns.md`: the full list of openers, phrases, clichés, AI-voice tells, and formatting moves to strip. Read on every run.
