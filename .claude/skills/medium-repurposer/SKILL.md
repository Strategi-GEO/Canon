---
name: medium-repurposer
description: Repurposes a client's finished long-form GEO blog into ONE Medium article, ghostwritten in the client's brand voice and kept AI-citable. Use this skill whenever the user wants a Medium version of an existing blog or article, says "write the Medium article", "give me the Medium cut", "turn this blog into a Medium piece", or asks for Medium distribution of a shipped piece. It writes a native Medium article that is a different, shorter cut of the source, not a repost. It does NOT write the LinkedIn post (use linkedin-repurposer) and does NOT write original long-form (use geo-content-writer).
---

# Medium Repurposer

Converts a single finished client blog into one platform-native Medium article, ghostwritten in the client's established brand voice. The Medium piece is a shorter, differently-cut version of the source blog, structured so both a human reader and an AI search crawler can use it.

The goal is authority and long-tail reach. Medium articles with clear structure, named entities, and quotable standalone lines get cited by ChatGPT, Perplexity, and Google AI Overviews. For a client whose positioning depends on authority, the Medium piece is a GEO asset, not just a social post.

## When this skill applies

Trigger when there is a finished client blog and the user wants the Medium version of it. Do not trigger for original long-form writing (geo-content-writer), for the LinkedIn cut (linkedin-repurposer), for newsletters, or for posts in anyone's own personal voice. This skill is client ghostwriting only.

## Inputs (the engine supplies these; confirm them if a human runs this directly)

1. **The source blog**, in full. When the engine drives this skill it is written to the run directory as `source.md`. Read the whole file.
2. **The client slug** and its config under `clients/<slug>/`:
   - `client.md` for the brand, its domain, its market, and its voice.
   - `gates.json` for the `voice` block, `banned_phrases`, `competitor_policy`/`competitor_terms`, and entity names.
   - `canonical-facts.md` for the do-not-claim list and verified facts and URLs. **Binding.** Never write a claim that contradicts it.
   - `Resources/` only if you need to confirm a voice tell or a fact already in the source.
3. **The output path** the article must be written to (the engine passes it; default `post.md` in the run directory).

Model memory is never a source. Every fact, name, statistic, and URL in the article traces to the source blog or `canonical-facts.md`. A statistic without a named source in the blog does not get carried over.

## Workflow

Follow in order.

### Step 1: Read the source blog and extract the skeleton

Pull out:
- The **core argument** in one sentence. The actual claim, not the headline.
- The **three strongest standalone moments** and the **GEO moves already in the piece**: definition blocks, FAQ-style answers, named entities, statistics with named sources, standalone quotables. These carry over into the Medium cut.
- The **primary audience**.

The Medium piece takes a DIFFERENT cut from any LinkedIn version: if a LinkedIn post exists or will exist for this blog, Medium zooms to the full case or the pattern while LinkedIn takes the single sharp moment. State your Medium cut in one line before drafting.

### Step 2: Anchor the client voice

Read `clients/<slug>/client.md` and the `voice` block in `gates.json`. Identify register, sentence rhythm, vocabulary tells (and `banned_phrases`, a hard list), stance, and the client's content rules (lifestyle-first framing, a mandatory local context, a required entity name in each liftable block, whatever the client sets). Honor them exactly.

If `gates.json` sets `competitor_policy: "never_name"`, no rival appears anywhere, named or implied, including in tables, FAQ answers, and any sources list. Comparisons are between options (asset type, location, price band, buyer situation), never between companies.

### Step 3: Draft the article

Load `references/medium-mechanics.md` and follow it. The load-bearing rules:

- Length 800 to 1,400 words. Shorter than the source blog. A different cut, not a re-run.
- Title 50 to 65 characters. Specific and clear, not clever-for-clever's-sake, no listicle unless the piece is genuinely a list.
- Subtitle 140 to 160 characters. It works as the standalone description and the Medium homepage preview.
- Three to five H2 sections. No H3s unless genuinely needed.
- One pull quote: the strongest standalone line, surfaced from the body, never a repeat of the title or subtitle.
- Preserve GEO moves from the source: at least one definition block, at least one FAQ-style Q&A near the end, at least two standalone quotable lines, named entities retained, statistics retained WITH their named source.
- No em dashes and no en dashes. Use a period, a comma, or a new line.
- Five tags: two broad (sector), two specific (topic), one form/angle tag.
- Zero banned openers, phrases, or closers. See `references/banned-patterns.md`.

### Step 4: Voice and banned-patterns check

Before writing the file, read the draft once more against `references/banned-patterns.md` and check:
1. Does it read as a standalone article, not an obvious social cut?
2. Does it keep the client's content rules and never contradict `canonical-facts.md`?
3. Any em dashes or en dashes? Remove them.
4. Any banned opener, phrase, or closer? Strip it.
5. Does the subtitle work as a standalone description?
6. Does an AI crawler have clear definitions, clear entities, and clear citeable statements?
7. Does any statistic lack a named source, or any claim lack support in the source blog or `canonical-facts.md`? Cut it or restore its source.

If any check fails, revise before writing.

### Step 5: Write the file

Write the finished article to the output path the engine gave you (default `post.md`). Structure:

```
Title: [title]
Subtitle: [subtitle]
Tags: tag1, tag2, tag3, tag4, tag5

[the article body, with its H2s, pull quote, FAQ block, and closing]
```

Write only the article. No preamble, no commentary. The file IS the deliverable.

## What good looks like

- The article reads as a standalone piece, not an obvious repost.
- Every line sounds like the client, not like AI and not like the last client's article.
- Every standalone line could be lifted and quoted without losing meaning.
- An AI search engine parsing it has clear definitions, clear entities, and clear citeable statements.
- Nothing contradicts `canonical-facts.md`; every statistic keeps its named source.

## What bad looks like

- The article is the blog with minor edits.
- The title is a listicle when the source blog is not.
- Em dashes anywhere, or a statistic with no source.
- A definition block or FAQ dropped, so the crawler has nothing to lift.
- Generic tags like "Life", "Thoughts", "Writing".

## Reference files

- `references/medium-mechanics.md`: title and subtitle patterns, structure, pull-quote selection, GEO preservation, tag strategy, formatting. Read before drafting.
- `references/banned-patterns.md`: the full list of openers, phrases, clichés, AI-voice tells, and formatting moves to strip. Read on every run.
