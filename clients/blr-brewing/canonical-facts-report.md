---
generated: 2026-07-17T07:37:23.243343+00:00
client: blr-brewing
run_id: c932a236f2384044b7f7491bddd5c2ef
state: done
mock: false
---
Clean: zero em/en dashes, one file written, scratch left only in `/tmp`.

## Report

**Read.** `Blr Brewing Knowledge Base.docx.pdf` (29pp) extracted cleanly via `pdftotext`: 7,717 words, read in full. **No resource was unreadable.** Fetched live: homepage, `/whitefield`, all five other outlet pages, `/group-packages`, plus the Brewer World trade article. DataForSEO returned seven Google profiles and a ChatGPT mentions sweep.

**The finding that shapes everything (§7 #1).** The site's outlet pages repeat the knowledge base's figures and phrasing closely enough to be written *from* it, and the site also hosts this factory's own `/articles/` output. So the engine's precedence rule breaks here: **site agreement with the KB is one self-asserted source wearing two hats, not corroboration.** I therefore refused to promote those numbers to §1/§2 on that basis. Please check this first; everything downstream depends on the answer.

**Conflicts (§7), 12 recorded.**
- **Phones, resolved:** the homepage FIND US block reverses Electronic City and Kanakapura Road. The location cards and Google agree, so the cards win. This is sending callers to the wrong outlet **today**.
- **Primary name, resolved against the KB:** the KB builds its canonical sentence, schema and knowledge-graph plan on "Bangalore Brewing Co." **No public source uses it** — site, footer, both trade articles and all seven Google listings say BLR Brewing Co. The KB's canonical sentence must not ship as written.
- **Waterfall, unresolved:** site says 50-foot, the client's own PR says 45-foot in-body while its headline calls it India's largest. Publishing no height.
- **Hours, unresolved:** site and KB both claim one schedule across all six; Google shows they differ per outlet.
- Also: Yelahanka's map link points at Electronic City; outlet count reads six/seven/eight across pages; Kanakapura has two pincodes.

**§9, the big one.** Nearly every headline number is self-asserted from one founder interview: the 50-50 food-to-alcohol split (the brand's core story), 3,200 daily guests, 850 staff, 30-35k litres/month, 35-40% repeat, 15,000 plants, the koi valuation. **All awards went to §9** — the KB says the Times wins are "publicly listed online and verifiable"; two searches surfaced only Instagram and Facebook. So §6.1 forbids "award-winning" even though the homepage says it. That costs the brand a real asset and is the highest-value thing a human can unblock.

**Please check, in order:** (1) the circularity above; (2) the awards; (3) **a seventh Google listing, "BLR Brewing Co - JP Nagar", 750 reviews, on no page and in no document** — either a closed outlet with a live profile, or the footprint isn't six; (4) the wrong phone numbers; (5) `/group-packages`, the corporate-enquiry page and stated top inbound priority, is `noindex` and serving Kriya's metadata plus a stray "60% OFF" banner; (6) Umang Nair's Siebel training, the brand's strongest credential, unverified.

**Two blockers before the first run:** `gates.json` `entity_names` holds only "BLR Brewing", so no writer can legally name BLR Restaurants Private Limited, Hamilton, Beanlore or the founder without tripping the entity gate. And `client.md` records no market, which DataForSEO requires — the evidence says Bengaluru/India/English, but an operator should write it in rather than let an agent infer it.

I added industry rules the KB never contemplated: **no dietary or allergen claims** (the KB describes vegan/Jain/allergen tagging; a dietary claim is a safety claim), no ABV/IBU/health claims, no excise or FSSAI assertions, and no capacity or booking guarantees.
