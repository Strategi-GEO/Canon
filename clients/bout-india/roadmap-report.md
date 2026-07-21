---
generated: 2026-07-21T12:25:35.348040+00:00
brand_url: https://www.boutindia.com/
piece_count: 10
rows: 10
notes: (none given)
mock: false
---
The CSV is written and verified: 10 rows, exact 6-column header, intent mix 6 Commercial / 3 Informational / 1 Navigational, exactly one Hub listicle, one Comparison anchor, one FAQ (entity), 3 pipe-separated prompts per row, zero em/en dashes.

---

## Report: Bout India GEO roadmap (10 rows)

**What Bout India is.** A luxury and adventure **inbound-India tour operator** (bespoke private trips since 2013, team of 51, travellers from 35+ countries, India + UK offices). Business model: custom private itineraries plus small-group tours; the buyer is an affluent **international** leisure traveller. Flagship lines: Golden Triangle/Rajasthan, Kerala, the Himalayas, wildlife safaris, luxury rail. The offer the roadmap drives to is a free custom-itinerary consultation and quote.

**Market decision (important).** `client.md` records **no market** and warns against guessing from the domain, so I did not default to India. The evidence (a UK office, blog content explicitly targeting US/UK/French travellers, "35+ countries") says the buyer pool is **international, US-led**, so I validated demand in **United States / en**. Google India volume would badly understate real demand here. Recommend the operator set the market field to **United States (primary), United Kingdom (secondary)** before blog runs.

**Data pulled (all live this session).** Firecrawl: full site map (~3,170 URLs; 70 tour packages, region/state destination tree, 162 existing blog posts, 2,561 hotel pages) and the About page. DataForSEO: `keywords_for_site`, `competitors_domain`, Google Ads volume (US) across ~30 keywords, `search_intent`, `bulk_keyword_difficulty`, AI-layer keyword volume, `llm_ment_top_domains` + `top_pages`, and one live ChatGPT response.

**Intent mix landed:** 6 Commercial / 3 Informational / 1 Navigational (60/30/10), per house default. Structure: 1 hub listicle (row 1, the anchor everything spokes into), 1 comparison anchor (row 2), 1 FAQ entity (row 10); vertical format derived = "Itinerary guide" (row 4). No PR-outreach row: no genuine data asset to justify one.

**Resources:** the `Resources/` folder is empty, as the brief anticipated. Nothing was read from it and nothing is attributed to it.

**Absence is real and verified.** ChatGPT (gpt-4o, web search) answered "which companies for a private luxury Golden Triangle + Rajasthan tour" by naming Abercrombie & Kent, Greaves India, Ampersand, Taj Safaris and others. **Bout India appeared in none of it.** For "luxury india tour", LLM citations are dominated by a single rival operator (luxuryindiatours.com) plus Reddit, Times of India, Rough Guides and hotel brands. Bout India is absent from every cited domain — that is the opening, and the citation race is against **other operators and editorial depth**, not just OTAs.

**Things you should hear that aren't in the CSV:**
- **Industry is mis-tagged.** `gates.json` and `client.md` say `media-publishing`; this is a **travel / tour-operator** client. Fix this before writing, or Agent W reads the wrong industry reference and produces off-target content.
- **`canonical-facts.md` does not exist.** Roadmap generation tolerates that (Stage 0 "if it exists"), but the engine's preflight will **fail every blog run** until a human-approved `canonical-facts.md` is authored. It also needs a do-not-claim list and the verified project/link URLs before drafting.
- **The cost row's headline number is a GEO story the column can't show.** `how much does a trip to india cost` is only ~30/mo on Google (what column 6 must report per the contract) but **469/mo in ChatGPT** — the single strongest AI-layer signal in the set. `top_pages` confirms LLMs actively cite cost and "package vs booking separately" decision content, which is exactly rows 2 and 3.
- **The existing blog is lopsided.** It is heavy with informational "top 10 places" listicles and light on commercial operator-decision, cost and comparison content. The roadmap deliberately fills that commercial gap rather than duplicating the destination listicles.
- **Duplication watch:** rows 4 (Golden Triangle), 6 (tiger safari) and 8 (safety) sit adjacent to existing informational posts; each is scoped to a distinct commercial/booking or authority angle, noted in "What the Piece Covers." The writer should hold that differentiation, not re-tread the existing guides.

CSV written to `clients/bout-india/roadmap.csv` and nothing else.
