# Content Structure: The Mechanics of Citable Content

This reference covers the structural patterns that make content extractable by AI engines. Structure is the highest-weighted dimension in GEO because it directly controls how well AI retrieval systems can extract and attribute content.

## Heading hierarchy

Every page has a single H1. Subtopics use H2 and H3. H4 and H5 only when strictly necessary.

Headings are descriptive and answer-shaped. They should read as standalone statements or questions, not as labels.

Weak headings (do not use):
- "Overview"
- "Introduction"
- "Benefits"
- "Conclusion"
- "Key Points"
- "Things to Consider"

Strong headings (use patterns like these):
- "What Is Generative Engine Optimization?"
- "How GEO Reduces Content Marketing Cost by 40%"
- "Why Legal Firms Trigger AI Overviews 77.67% of the Time"
- "The 5 Steps to Structure a Blog Post for AI Citation"
- "ChatGPT vs Perplexity vs Google AI Overviews: Which to Optimize For"

The rule: if the heading could be a standalone question a user might type into ChatGPT, it is a strong heading. If it is a generic label, rewrite it.

## The answer-first opening

The first paragraph must directly answer the core question. Not set it up. Not introduce it. Answer it.

Structure:

**First sentence:** The direct answer. Include the primary keyword naturally.

**Second sentence:** The single most important supporting fact. Include a source and date where possible.

**Third sentence:** The implication or what the reader should take away.

**Fourth to sixth sentences:** Brief context or framing for the rest of the piece.

Example (weak):
> "In today's rapidly evolving digital landscape, businesses are increasingly turning to new forms of optimization to stay competitive. One such emerging area is Generative Engine Optimization, or GEO."

Example (strong):
> "Generative Engine Optimization (GEO) is the practice of structuring content so AI search engines like ChatGPT and Perplexity cite it when generating answers. Research from Princeton's 2024 GEO paper shows well-structured content increases AI visibility by up to 40%. For brands competing in AI search, GEO has become the new organic channel, and most websites are still not built for it."

## Definition blocks

Key terms must be defined explicitly using standalone sentences. Format: "X is defined as..." or "X refers to..." or "X is the practice of..."

LLMs are trained heavily on Wikipedia-style definitional content and show strong recall for this pattern.

Rules for definitions:
- Define the term the first time it appears in the body (not just in the title)
- Use a complete, standalone sentence that could be extracted alone
- Include the term, a category it belongs to, and what differentiates it
- Follow the definition with 1-2 sentences of elaboration or example

Example:
> "Hub-and-spoke content structure is a publishing model where a single comprehensive pillar page covers a broad topic and multiple cluster pages cover subtopics within it. Each cluster page links back to the pillar, and the pillar links out to all clusters. This creates a topical cluster that AI engines recognize as a single authoritative node on the subject."

## Paragraph construction

One idea per paragraph. Two to four sentences per paragraph. No exceptions for editorial "flow."

Long paragraphs are skipped by AI extraction. They create too much context for the model to confidently extract a single claim. Break them up.

Every paragraph should contain at least one specific claim. A paragraph that says nothing verifiable is padding. Delete it or rewrite it.

## Lists and tables

### When to use lists

Use numbered lists for:
- Sequential processes (how-to steps)
- Ranked items where the ranking matters
- Time-ordered events

Use bulleted lists for:
- Unordered collections (features, benefits, criteria)
- Comparison points where order is not significant
- Criteria the reader should evaluate against

Every list item must be substantial. Each item should be 2-4 sentences minimum, not just a phrase. AI engines extract and cite individual list items as standalone citations. A bullet saying "Good UX" is not citable. A bullet saying "Good UX increases conversion by 12-15% on average, users are more likely to complete purchase flows that reduce friction at checkout" is citable.

### When to use tables

Use tables for:
- Side-by-side comparisons (X vs Y vs Z)
- Structured data with multiple attributes per entity (pricing tiers, feature matrices)
- Statistics with categories and values
- Any comparison where the reader needs to scan rows and columns

AI systems extract tabular data far more accurately than they parse narrative comparisons. "Law firm A vs Law firm B" in prose is significantly harder to cite than the same comparison in a 3-column table.

Always include table headers that clearly label each column. Use semantic HTML table markup, not just visual alignment.

## FAQ sections

Every piece over 1,000 words should include a FAQ section with 5-10 Q&A pairs.

Pages with FAQPage schema are 3.2x more likely to appear in Google AI Overviews. (Source: Frase)

### Writing FAQ questions

Each question must be phrased the way a real user would ask it, not the way a marketer would phrase it.

Weak (marketer-phrased):
- "What are the benefits of our approach?"
- "How is our solution different?"

Strong (user-phrased):
- "What is GEO and how is it different from SEO?"
- "How long does it take to see results from GEO content?"
- "Do I need a developer to implement schema markup?"

Tip: use "people also ask" data from Google, Answer The Public, or AlsoAsked to find real user questions.

### Writing FAQ answers

Each answer is 75-300 words. Opens with a direct answer in the first sentence. Follows with supporting context, specifics, and a source where relevant.

Each answer should be self-contained. A user who sees only that Q&A extracted by an AI engine should get a complete, useful response.

## TL;DR / summary blocks

Long-form pages (1,500+ words) should include a 3-5 sentence summary at the top, immediately below the H1 or the answer-first opening.

AI engines frequently pull from summary sections for snippet generation. A well-written TL;DR is often the exact block that gets cited.

Format:

```
**TL;DR:** [Three to five sentences covering the core argument, the key data point, and the practical takeaway. Each sentence should be quotable on its own.]
```

## Hub-and-spoke topical structure

A single page does not build authority. A cluster of interconnected pages on the same topic does.

### The hub

The hub (also called a pillar page) is a comprehensive guide covering a topic at the broadest level. Typical length: 2,500-4,000 words. Covers every major subtopic at a high level. Links out to every cluster page.

Example hub: "The Complete Guide to GEO for Finance Firms in 2026"

### The spokes

Each spoke is a focused cluster page answering one specific question within the hub's topic. Typical length: 800-1,500 words. Goes deep on one narrow angle. Links back to the hub.

Example spokes for the finance hub:
- "How finance firms should structure thought leadership for AI citation"
- "LinkedIn vs website: which drives more AI citations for wealth managers"
- "FAQ schema for financial advisory sites: a technical walkthrough"
- "What AI engines cite when users ask about retirement planning"

### Why this matters for AI

86% of AI citations come from sites with five or more interconnected pages on a topic. (Source: Digital Applied) A single standalone blog post rarely gets cited. A well-interconnected cluster becomes the "authoritative node" AI engines treat as the go-to source.

## Schema markup essentials

Schema tells AI search engines what a page is about at a glance. The essential schema types by content type:

**All editorial content:** `Article` or `BlogPosting` schema with `headline`, `author` (as `Person`), `datePublished`, `dateModified`. AI engines use `dateModified` aggressively. Stale values cause deprioritization.

**How-to content:** `HowTo` schema with numbered `step` items. This is what AI engines extract for "how to X" queries.

**FAQ sections:** `FAQPage` schema with `Question` and `Answer` pairs. Pages with this markup are 3.2x more likely in Google AI Overviews.

**Author pages:** `Person` schema on every author bio page. Include credentials, expertise areas, social profiles, and organizational affiliation.

**About / organization pages:** `Organization` schema (or specific subtypes like `RealEstateAgency`, `MedicalClinic`, `LegalService`) with verifiable details.

**Product pages:** `Product` schema with `offers`, `review`, `aggregateRating`.

**Local businesses:** `LocalBusiness` subtypes with NAP (name, address, phone), hours, service area.

Schema is not optional for GEO. Claude should flag in the delivered piece where schema should be applied, the writer is not responsible for implementing schema, but the brief should make the schema requirements explicit for the development team.

## Entity consistency

Name every entity explicitly and consistently across the piece. An entity is any: company, product, person, place, technology, framework, or concept that matters to the topic.

Rules:
- Pick one canonical name for each entity and use it every time. If a product is called "Acme Analytics Platform" on the homepage, do not call it "our platform" or "the Acme tool" later. Always "Acme Analytics Platform."
- Define every proprietary framework or methodology with a named page. AI engines cite named entities, not generic descriptions.
- Do not substitute pronouns or vague references. "The company" or "this approach" kills the entity mention that AI engines use to build knowledge graphs.

## Source attribution

When referencing data, studies, or expert opinions, attribute them clearly within the text.

Format: "According to [specific source name + year], [specific claim]."

Examples:
- "According to the Conductor 2025 AI Referral Traffic Report, legal queries trigger AI Overviews 77.67% of the time."
- "Princeton's 2024 GEO research found that well-structured content increases AI visibility by up to 40%."
- "Frase's analysis of 17 million AI responses showed that pages with FAQPage schema appear in Google AI Overviews 3.2x more often than pages without it."

Never attribute to unnamed "studies," "experts," or "research." If the source cannot be named, the claim cannot be included.

## Author credentialing

Every piece should have a named author. Where the topic is YMYL (Your Money, Your Life), legal, medical, financial, the author's credentials matter enormously.

Minimum author information to surface:
- Full name
- Job title and organization
- Relevant credential (degree, certification, license, Bar number, years of experience)
- Link to a `/team/[name]` bio page with `Person` schema

AI engines check author credentials when deciding whether to cite content in YMYL categories. Unnamed or uncredentialed authors on legal, medical, or financial pages are treated as untrusted.
