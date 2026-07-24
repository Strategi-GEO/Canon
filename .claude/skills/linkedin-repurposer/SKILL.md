---
name: linkedin-repurposer
description: Repurposes a client's finished long-form GEO blog into ONE LinkedIn text post, ghostwritten in the client's brand voice. Use this skill whenever the user wants a LinkedIn version of an existing blog or article, says "write the LinkedIn post", "turn this blog into a LinkedIn post", "give me the LinkedIn cut", or asks for LinkedIn distribution of a shipped piece. It writes a native LinkedIn post, never a copy-paste of the source. It does NOT write the Medium version (use medium-repurposer) and does NOT write original long-form (use geo-content-writer).
---

# LinkedIn Repurposer

Converts a single finished client blog into one platform-native LinkedIn text post, ghostwritten in the client's established brand voice. The post is a fresh cut of the blog's argument, not a summary of it.

The goal is not volume. The goal is a post that earns attention in a feed and sounds like the client. LinkedIn rewards a strong hook and dwell time; a good repurpose takes ONE sharp cut of the blog's core argument and lands it in the client's voice.

## When this skill applies

Trigger when there is a finished client blog and the user wants the LinkedIn version of it. Do not trigger for original long-form writing (geo-content-writer), for the Medium cut (medium-repurposer), for Twitter or newsletter formats, for carousels or PDFs, or for posts in anyone's own personal voice. This skill is client ghostwriting only.

## Inputs (the engine supplies these; confirm them if a human runs this directly)

1. **The source blog**, in full. When the engine drives this skill it is written to the run directory as `source.md`. Read the whole file, not a summary.
2. **The client slug** and its config under `clients/<slug>/`:
   - `client.md` for the brand, its domain, its market, and its voice.
   - `gates.json` for the `voice` block, `banned_phrases`, `competitor_policy`/`competitor_terms`, and entity names.
   - `canonical-facts.md` for the do-not-claim list and verified facts. **Binding.** Never write a claim that contradicts it.
   - `Resources/` only if you need to confirm a voice tell.
3. **The output path** the post must be written to (the engine passes it; default `post.md` in the run directory).

Model memory is never a source. Every fact, name, price, and URL in the post traces to the source blog or `canonical-facts.md`. If the source blog does not support a claim, it does not go in the post.

## Workflow

Follow in order.

### Step 1: Read the source blog and extract the skeleton

Pull out:
- The **core argument** in one sentence. Not the headline. The actual claim the blog makes.
- The **three strongest standalone moments**: a data point, a definition, a quotable line, a counter-intuitive observation, a named framework. LinkedIn will take exactly one of them.
- The **primary audience** the blog was written for.

### Step 2: Anchor the client voice

Read `clients/<slug>/client.md` and the `voice` block in `gates.json`. Identify:
- **Register**: formal, conversational, authoritative, warm, plainspoken, technical.
- **Sentence rhythm**: long and rolling, short and clipped, or mixed.
- **Vocabulary tells**: words this brand uses and words it would never use. `banned_phrases` in `gates.json` is a hard list; a phrase in the client's own site copy is still banned, paraphrase it.
- **Stance**: what the brand is for, what it pushes back against.
- **Content rules** the client sets (for example lifestyle-first framing before investment framing, a mandatory local context, a required entity name in each liftable block). Honor them exactly.

If `gates.json` sets `competitor_policy: "never_name"`, no rival appears, named or implied. A concession is made against the option (the location, the asset class, the price band, the buyer fit), never against a named company.

### Step 3: Pick ONE angle

Pick a single entry point into the blog's core argument, sharp enough that a stranger stops scrolling. State it in one line before drafting. Common cuts:
- **Tension**: a pointed contradiction the blog resolves.
- **One moment**: a single specific story, number, or example from the blog.
- **The question**: the exact question the blog answers.
- **The surprising conclusion**: the blog's payoff, stated up front.

One angle, not three. A LinkedIn post that tries to carry the whole blog carries nothing.

### Step 4: Draft the post

Load `references/linkedin-mechanics.md` and follow it. The load-bearing rules:

- Hook lives in the first two lines. The reader sees only that before the "see more" cutoff, so it must stand alone.
- Length target 1,200 to 1,700 characters. Hard ceiling 2,800 (LinkedIn's own limit is 3,000).
- Whitespace is structure. Short lines and paragraph breaks carry weight. This is platform mechanics, not a break from a prose-first brand.
- No markdown renders on LinkedIn: no bold stars, no markdown links, no headers, no inline code.
- No em dashes and no en dashes. Use a period, a comma, or a new line.
- Zero banned openers, phrases, or closers. See `references/banned-patterns.md`.
- End on one line that invites a real reply: a genuine question or a provocation, never a begging-for-engagement line.
- Three to five hashtags at the very end, specific to the client's sector, never generic ones like #business or #marketing.
- If the blog has a canonical link, note it belongs in the first comment, not the body. The body may say "full piece linked in the comments" only if it genuinely needs the link.

### Step 5: Voice and banned-patterns check

Before writing the file, read the draft once more against `references/banned-patterns.md` and check:
1. Does it sound like the client, not like a generic LinkedIn guru?
2. Does it keep the client's content rules (lifestyle-first, local context, entity anchoring, whatever `gates.json` and `canonical-facts.md` require)?
3. Any em dashes or en dashes? Remove them.
4. Any banned opener, phrase, or closer? Strip it.
5. Does the hook stand alone in the first ~210 characters?
6. Does any claim lack support in the source blog or `canonical-facts.md`? Cut it.

If any check fails, revise before writing.

### Step 6: Write the file

Write the finished post to the output path the engine gave you (default `post.md`). Structure:

```
[the post body, with its line breaks preserved]

#SectorTag #SpecificTopic #SpecificTopic2

Comment (first reply, with the canonical link): [link line, or omit if the post needs no link]
```

Write only the post. No preamble, no "here is your post", no commentary. The file IS the deliverable.

## What good looks like

- The hook is one a stranger would stop scrolling for.
- Every line sounds like the client, not like AI and not like the last client's post.
- Every standalone line could be lifted and quoted without losing meaning.
- Nothing in it contradicts `canonical-facts.md`, and nothing claims what the source blog did not.

## What bad looks like

- The post is a bulleted summary of the blog.
- The hook says "Excited to share our latest thinking on...".
- Em dashes anywhere, or markdown bold that renders as literal asterisks.
- Generic hashtags like #business #marketing #leadership.
- A CTA that says "What do you think? Let me know in the comments!" with no real question.

## Reference files

- `references/linkedin-mechanics.md`: feed mechanics, hook library, length rules, CTA and hashtag guidance. Read before drafting.
- `references/banned-patterns.md`: the full list of openers, phrases, clichés, AI-voice tells, and formatting moves to strip. Read on every run.
