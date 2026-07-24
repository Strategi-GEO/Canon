# Banned Patterns

Strip these on every run. Read this file every time before writing the file.

## Punctuation

- **No em dashes.** Not one. Replace with a period, a comma, or a new line. Absolute rule, every client.
- **No en dashes used as em dashes.** Same rule.
- **No double spaces after periods.**
- **No Oxford-comma switching mid-piece.** Pick one and hold it.

## Banned openers

Out on LinkedIn and on Medium, regardless of client voice:

- "Excited to share..."
- "Thrilled to announce..."
- "I'm humbled to..."
- "Here's the thing:"
- "Let me tell you a story."
- "Picture this:"
- "Imagine if..."
- "Quick question for my network:"
- "Hot take:"
- "Unpopular opinion:"
- "In today's fast-paced world..."
- "In an era of..."
- "Ever wonder why..."
- "Let's be honest..."
- "Buckle up."
- "Grab a coffee."
- "I've been thinking about [X] a lot lately."
- "Hear me out."
- "Controversial take, but..."

## Banned phrases and clichés

Strip these wherever they appear:

- "Game-changer" / "game-changing"
- "Deep dive" / "let's dive in"
- "Unpack" (as in "let's unpack this")
- "Unlock" (as in "unlock potential", "unlock value")
- "At the end of the day"
- "Move the needle"
- "Low-hanging fruit"
- "Circle back"
- "Touch base"
- "Take it to the next level"
- "In this day and age"
- "The reality is..."
- "The truth is..."
- "It's important to note that..."
- "Needless to say"
- "That being said"
- "Having said that"
- "At scale" (only if used vaguely; fine if genuinely describing scale)
- "Best-in-class"
- "World-class"
- "Cutting-edge"
- "Next-generation"
- "Revolutionary"
- "Innovative solutions"
- "Tailored solutions"
- "Bespoke solutions"
- "Holistic approach"
- "Synergies"
- "Leverage" (as a verb, except in narrow technical contexts)
- "Stakeholders" (except when literally referring to shareholders or named parties)
- "Paradigm shift"
- "Thought leader" / "thought leadership" (when self-applied)

## Banned closers

- "What do you think? Let me know in the comments!"
- "Agree or disagree? Drop your thoughts below."
- "Thoughts? 👇"
- "Follow for more."
- "If you found this helpful, hit the like button and share."
- "PS. If you enjoyed this, please consider sharing."
- "Let that sink in."
- "Read that again."
- "The choice is yours."
- "The rest is up to you."

## Banned formatting moves

- **All caps for emphasis.** Use a line break or rewrite for rhythm.
- **Markdown bold on LinkedIn.** It does not render. It shows up as literal asterisks.
- **Markdown links on LinkedIn.** They do not render.
- **Inline hashtags in the body.** Looks thirsty. Hashtags go at the end.
- **"1/" or thread-numbering convention.** LinkedIn is not Twitter.
- **Emoji at the start of a line as decoration.** Emojis only if the client's voice uses them, and never as the first character.
- **Headers in LinkedIn text posts.** LinkedIn does not render markdown headers. If a section needs to stand out, use a line break and a short leading label.
- **Dashes or asterisks as list bullets** unless the client's voice genuinely uses lists. Prose tends to hit harder for most ghostwritten brand work.

## AI-voice tells

These are the phrases AI writing falls into. Strip them even when they are not on the lists above. The clue is that they sound vaguely motivational and carry no specific information:

- "It's a journey, not a destination."
- "Success isn't about [X], it's about [Y]."
- "Remember, [generic uplifting statement]."
- "The truth is, we all..."
- "We've all been there."
- "In essence..."
- "Ultimately..."
- "When it comes down to it..."
- "At its core..." (overused; fine sparingly)
- "The bottom line is..."

## Tone tells to watch for

Beyond specific phrases, watch for patterns that read as AI-written or generic marketing:

- Every paragraph ends with a pithy one-liner that summarises the paragraph.
- The piece keeps "landing" on points that sound like they should be tweets.
- Lots of rhetorical questions in a row.
- Sentences starting with "And" or "But" as a stylistic tic rather than for genuine emphasis.
- The conclusion restates the three points the piece already made.
- Every argument is a three-part list (first X, then Y, finally Z).
- The writing is smooth but you cannot remember anything specific thirty seconds after reading it.

If a draft has any of these, rewrite. Specificity is the cure: name a real person, a real number, a real place, a real moment.

## Client-specific rules live in the client's config, not here

This engine is brand-agnostic. Every client-specific content rule, banned term, competitor policy, and retired statistic lives under `clients/<slug>/`, never in this file. Before writing, carry these in:

- **`clients/<slug>/gates.json`**: `banned_phrases` (a hard list, additive to the ones above), `competitor_policy` and `competitor_terms` (when `never_name`, no rival appears anywhere, named or implied; comparisons are between options, never companies), the `voice` block, and the entity names to anchor liftable blocks with.
- **`clients/<slug>/canonical-facts.md`**: the do-not-claim list and the resolved facts. Binding. No unsubstantiated superlatives (best, first, only, number one, leading). Frame every client projection as the client's own guidance, never independent fact.
- **`clients/<slug>/client.md`**: the brand voice in prose, the market, and any framing rule the client insists on (for example lifestyle-first before investment framing, a mandatory local context, a required entity mention per block).

A rule in the client's config always wins over a general instinct here. Where this file and a client's `canonical-facts.md` genuinely conflict, follow `canonical-facts.md`.
