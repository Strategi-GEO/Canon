---
generated: 2026-07-17T05:18:26.282908+00:00
brand_url: https://www.blrbrewing.com/
piece_count: 10
rows: 10
notes: (none given)
mock: false
---
Verified against the checklist by reading the file: 5 columns in order, header present, 10 rows, exactly 3 pipe-separated prompts each, zero em/en dashes, one hub listicle, one comparison anchor, one FAQ (entity), intent mix 6/3/1, brand names confined to the navigational row. `roadmap.csv` is the only file I created in the project. (A throwaway validator I put in `/tmp` couldn't be deleted — sandbox restricts `rm` to the working dir. It's outside the project and inert.)

---

## Report

**Data pulled.** Firecrawl `map` + `scrape` on the homepage, the group-packages page and the published hub article. DataForSEO: `ranked_keywords`, `competitors_domain`, `search_intent`, `kw_data_google_ads_search_volume`, `ai_optimization_keyword_data_search_volume`, `ai_opt_llm_ment_top_domains`, and one `ai_optimization_llm_response` on the category's peak-intent prompt.

**Resources.** `Resources/` and `uploads/` are both empty. Nothing read, nothing attributed. `client.md`, `gates.json` and `description.md` read as context only.

**The biggest finding: this client already has ~10 published articles that look exactly like the roadmap you asked me to build.** `/articles/` carries locality guides for all six outlets, a six-outlet hub listicle with a comparison table, a Sunday brunch piece, and two live-sport pieces. The obvious brief — "six locality guides plus a hub" — is done. Every one of those rows died on the "already covers this well" gate. **This roadmap is deliberately the second lap, not a repeat of the first.** If you expected locality guides, that is why there are none.

**The gap that is real.** I asked ChatGPT which Bangalore brewpubs suit a 50-person corporate dinner. It named Toit, Windmills Craftworks, Arbor, Byg Brewski and The Bier Library. BLR Brewing is absent — while plausibly operating the highest-capacity brewpub in the city. Meanwhile `ranked_keywords` shows the brand owns its own name (`blr brewing co` #1, `bangalore brewing company` #1) but not its category (`best brewery in bangalore` #21, `microbreweries in bangalore` unranked at 3,600/mo). The published articles chased locality discovery; nothing yet contests the group-and-event ground where the money is. The site's only conversion surface is the group-packages form, so all six commercial rows route there.

**Things I would argue about:**

1. **The AI layer is nearly empty, and I built here anyway.** `best brewery in bangalore` is the only term with meaningful AI volume: 42/mo. Everything else returned null or 1–2. That single term went 8 → 16 → 31 → 42 over four months, which is why I think the bet is right, but you are buying a position in a category whose AI demand is currently tiny and growing fast, not one with demand today. Google volume is real (3,600–6,600 on the head terms); AI volume is not yet. Say this to the client plainly rather than let the CSV imply otherwise.

2. **Their real SERP competitors are not brewpubs.** `competitors_domain` returned Zomato, JustDial, TripAdvisor, EazyDiner, Swiggy, magicpin, district.in. Aggregators own the Google ground and BLR will not displace them. But `ai_opt_llm_ment_top_domains` returned a *completely different* set feeding ChatGPT: architectureartdesigns.com, gallivant.co.in, surfacesreporter.com, restaurantindia.in, kitchenherald.com — design and hospitality trade press. Two channels, two competitor sets. That divergence is the single most actionable thing I found, and it is what justifies the PR outreach row (row 9) — the one row I would normally cut. It rests on evidence, but it is the weakest row commercially and the first I would drop if you want nine.

3. **Intent labels: I overrode the endpoint once, openly.** `search_intent` called "why bangalore has so many microbreweries" *commercial* at 0.811. I judged that a model artifact and labelled row 7 Informational. Nearly every term in this category reads commercial/transactional, so following the endpoint literally would have produced a 9/1/0 sheet and broken the 6/3/1 architecture. Flagging rather than hiding it.

4. **`keywords_for_site` returned garbage** — "ind vs sa", "india post", "times of india" — noise with no relation to the domain. I discarded it and used `ranked_keywords` instead. No row rests on that call.

**Two governance problems you should fix before any blog runs:**

- **There is no `canonical-facts.md` for this client, and `never-claim.md` is empty (0 bytes).** Roadmap generation tolerates this ("if it exists"), so I proceeded — but the engine's own Preflight refuses to run a blog without it. More importantly, the *already published* hub article asserts hard numbers with nothing binding them: ~1,200 seats, 15,000+ plants, a 50-ft waterfall, koi "worth several lakh", ~3,200 guests/day, founding year 2019. My rows 1, 4, 9 and 10 lean on facts of exactly that kind. **I could not verify any of them** and no writer should assert them until they are in `canonical-facts.md`. There was no do-not-claim list to filter against, so unlike a normal run, **I cut zero rows on forbidden-claim grounds — because no such list exists.** That is a gap, not a clean bill.

- **The brand presents under three names on its own properties**: "BLR Brewing Co." (homepage), "Bangalore Brewing Co." (article `og:site_name`), "BLR Brewing" (`gates.json` `entity_names`, which is the only permitted name the gates will accept). `BLR Restaurants Private Limited` is the legal entity, and **Beanlore** (HSR/Indiranagar/Jayanagar) and **Hamilton Cocktail Bar** are adjacent brands absent from `gates.json` entirely. Entity ambiguity is precisely what engines resolve badly — it is why row 10 exists, but the config should be fixed regardless.

**Two smaller bugs:** `client.md`'s Market section is unfilled and says an operator must complete it before the first real run; I used India/en on the strength of `description.md` naming Bengaluru, not the domain suffix, but someone should fill it in. And the `group-packages` page — the only conversion surface — is `robots: noindex, nofollow`, with its `og:title` and `og:description` overwritten by the form vendor Kriya ("AI SOP, Checklist & Attendance Software for Retail"). Every commercial row on this roadmap points at that page. **Fix it before publishing, or the roadmap converts into a wall.**
