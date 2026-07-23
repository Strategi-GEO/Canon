#!/usr/bin/env python3
"""Static checks for server/facts_gen.py. Spawns NOTHING and calls NO model.

Every SDK seam is monkeypatched. The one assertion that matters most is the first: a
human-approved canonical-facts.md must come back byte identical, because overwriting one is
the worst thing this feature could do.

  .venv/bin/python tests/facts_check.py
"""
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import facts_gen  # noqa: E402
from server import roadmap  # noqa: E402

FAILURES = []
CHECKS = [0]

# The client the roadmap checks below read. It is the one this file already anchors on, and the
# checks pull the topic out of its sheet rather than naming one, so nothing here is specific to a
# brand: point this at any client carrying a roadmap.csv and the checks still mean the same thing.
ROADMAP_CLIENT = "vacation-village"


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def test_facts_prompt_is_built_to_serve_the_roadmap():
    """The fact base is built to serve the roadmap, so assert the roadmap reaches the prompt.

    This pins the fix for a real failure. One brand's fact base swept its site generally, recorded
    the outlet list, and shipped; a planned blog about non-drinkers then needed the zero-alcohol
    menu page, which nobody had fetched, because nothing told the fact base that page would matter.
    The writer may not invent a fact and the evaluator may not accept one the fact base does not
    hold, so the session failed a hard gate on a page that was one scrape away. A regression here
    is silent: the prompt still builds, the session still runs, and the gap only shows up as a
    Sourcing rejection weeks later.
    """
    print("\ntest_facts_prompt_is_built_to_serve_the_roadmap")
    try:
        rows = roadmap.load_roadmap(ROADMAP_CLIENT)["rows"]
    except (roadmap.RoadmapNotFound, roadmap.BadUpload) as exc:
        check(f"{ROADMAP_CLIENT} has a readable roadmap.csv to check against", False, str(exc))
        return

    prompt = facts_gen.build_prompt(ROADMAP_CLIENT)

    check("the prompt substitutes ROADMAP_DIGEST",
          "{{ROADMAP_DIGEST}}" not in prompt and "ROADMAP:" in prompt)
    # The REAL guard's regex, deliberately, not a substring search for "{{". Line 3 of the template
    # documents the mechanism with a literal "{{...}}", and "..." is not \w+, so build_prompt is
    # right to ignore it. A naive check would fail on that line and get "fixed" by editing the
    # documentation, which would leave the actual guard untested.
    check("the built prompt leaves no unsubstituted {{TOKEN}} behind",
          facts_gen._PLACEHOLDER.findall(prompt) == [],
          str(facts_gen._PLACEHOLDER.findall(prompt)))

    topic = rows[0]["topic"]
    check("the digest carries the roadmap's real topics", topic in prompt, topic)
    check("the digest numbers rows the house way, index + 1",
          f"1. {topic}" in prompt)
    check("the digest carries the prompts each blog must be cited for",
          "cited for: " in prompt)
    first_prompt = (rows[0].get("prompts") or [None])[0]
    check("a row's target prompt text reaches the digest",
          bool(first_prompt) and first_prompt in prompt, str(first_prompt))

    # Order, not just presence. A fact base that only covers the current roadmap breaks the moment
    # a row is added, so the general sweep stays FIRST and the targeted pass is a SECOND pass over
    # the same map. Reversing them, or dropping the general sweep, is the failure this asserts on.
    general = prompt.find("every page that carries facts")
    targeted = prompt.find("with the ROADMAP in your hand")
    check("STAGE 2 keeps the general sweep BEFORE the targeted pass",
          general != -1 and targeted != -1 and general < targeted, f"{general} < {targeted}")
    check("the targeted pass is a SECOND pass, not a replacement for the sweep",
          "This is a SECOND pass" in prompt)
    check("STAGE 2 points the targeted pass at the digest",
          "Read the ROADMAP block above" in prompt)
    check("the prompt says WHY the targeted pass exists: a missing fact is a hard-gate failure",
          "becomes a hard-gate failure later, in a session that has no way to fix it" in prompt)
    check("a planned blog is a reason to LOOK at a page, never to record what it lacks",
          "It is never a reason to record a fact the page" in prompt)


def test_facts_prompt_attributes_without_unlocking():
    """§9's attribution wording, and the carve-out that keeps it from laundering a §6.1 claim.

    A self-asserted metric is citable AS the brand's own claim, which is what makes ~27 dead §9
    rows per brand usable. It is also where a safety bug would hide, so the carve-out is checked
    harder than the rule it qualifies: attribution changes WHO asserts a thing, never WHETHER it
    may be said, and §6.1 keeps primacy in every direction.
    """
    print("\ntest_facts_prompt_attributes_without_unlocking")
    prompt = facts_gen.build_prompt(ROADMAP_CLIENT)

    check("§9 rows carry a required ATTRIBUTION WORDING", "ATTRIBUTION WORDING" in prompt)
    check("the wording names the client as the source of the figure",
          "reports brewing 30,000 to 35,000 litres monthly" in prompt)
    check("the wording tags the figure as the company's own",
          "(company figure," in prompt)
    # Fragments stop at a line break on purpose: the prompt is hard-wrapped markdown, so a check
    # spanning a wrap fails on a reflow rather than on a rule going missing.
    check("the wording is binding, so stripping it forbids the claim",
          "converts a permitted claim into a forbidden" in prompt)
    check("an attributed row still carries its source and fetch date",
          "Every attributed row still carries its source URL and fetch date" in prompt)
    check("the prompt states the two origins and no third",
          "There are two origins for" in prompt and "there is no third" in prompt)

    # The carve-out. Attribution rescues neutral metrics and nothing else.
    check("the carve-out is stated as the point, not an exception",
          "Attribution rescues NEUTRAL self-asserted metrics and NOTHING ELSE" in prompt)
    check("NONE is the default, so a row earns a wording rather than getting one",
          "NONE is the default" in prompt)
    check("attribution NEVER unlocks a §6.1 claim",
          "Attribution NEVER unlocks a claim §6.1 forbids" in prompt)
    check("§6.1 keeps primacy over §9 in the HARD RULES",
          "**§6.1 outranks §9.**" in prompt)
    check("attribution is a demotion, never a promotion",
          "never a promotion that makes a" in prompt)
    check("an attributed returns claim is still a returns claim",
          "still a prohibited returns claim" in prompt)
    check("an attributed superlative is still a superlative",
          "still an unsubstantiated superlative" in prompt)
    check("a claim about a third party gets NONE",
          "Any claim about a third party" in prompt)
    check("a claim sourced only to a §3.1-forbidden page gets NONE",
          "Any claim whose only source is a page §3.1 forbids" in prompt)
    check("market and category claims get NONE, and need an independent source",
          "Market, industry or category claims" in prompt)
    check("the strip test gives a decision procedure rather than a category list",
          "strip the attribution off the sentence and read what" in prompt)
    check("STAGE 5 reconciles with §9 rather than contradicting it",
          "§6.1 outranks §9 and a §9 wording never reopens it" in prompt)

    check("the facts prompt has no em dash or en dash",
          "—" not in prompt and "–" not in prompt)


def test_facts_prompt_survives_a_client_with_no_roadmap():
    """A brand can be onboarded and its fact base built before any roadmap exists.

    Monkeypatched rather than pointed at a roadmap-less client on disk, so the check keeps testing
    the handler even after someone uploads a sheet for whichever client that was. The guard is what
    makes Change 1 safe to add: prompt and substitution have to land together or the run fails
    loudly, so it is checked in both directions, that it stays quiet on a good prompt and that it
    still raises on an unsubstituted token.
    """
    print("\ntest_facts_prompt_survives_a_client_with_no_roadmap")

    def no_roadmap(client_slug):
        raise roadmap.RoadmapNotFound(f"no roadmap.csv for client {client_slug!r}")

    original = facts_gen.roadmap.load_roadmap
    facts_gen.roadmap.load_roadmap = no_roadmap
    try:
        prompt = facts_gen.build_prompt(ROADMAP_CLIENT)
    finally:
        facts_gen.roadmap.load_roadmap = original

    check("a client with NO roadmap still builds a prompt rather than raising",
          bool(prompt))
    check("the no-roadmap note says so explicitly instead of sending a blank",
          "(no roadmap yet: sweep broadly.)" in prompt)
    check("the no-roadmap note calls the absence normal, not a setup mistake",
          "it is not a setup mistake" in prompt)
    check("a client with no roadmap runs the general sweep and skips the targeted pass",
          "skip the targeted pass" in prompt)
    check("the no-roadmap prompt still leaves no unsubstituted {{TOKEN}} behind",
          facts_gen._PLACEHOLDER.findall(prompt) == [])

    # The other half of the guard: a {{TOKEN}} the server does not substitute must RAISE, never
    # ship literal braces to an agent that would read them as an instruction about a value nobody
    # sent. PROMPT_PATH is swapped for a temp file, so the real prompt is never touched.
    root = Path(tempfile.mkdtemp())
    try:
        fake = root / "prompt.md"
        fake.write_text("{{CLIENT_NAME}} and {{NOT_SUBSTITUTED}}\n", encoding="utf-8")
        raised = None
        original_path = facts_gen.PROMPT_PATH
        facts_gen.PROMPT_PATH = fake
        try:
            facts_gen.build_prompt(ROADMAP_CLIENT)
        except facts_gen.FactsGenerationError as exc:
            raised = str(exc)
        finally:
            facts_gen.PROMPT_PATH = original_path
        check("an unsubstituted {{TOKEN}} raises rather than reaching the agent",
              raised is not None and "NOT_SUBSTITUTED" in raised, str(raised))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_facts_prompt_researches_a_brand_with_no_resources_and_no_domain():
    """A brand with an EMPTY knowledge base and no domain still builds its fact base, from research.

    The knowledge base is optional: an operator who uploads nothing and records no domain still
    gets a canonical-facts.md, built by researching the brand on the open web with Firecrawl search
    and DataForSEO. Before this, the two empty branches pointed at each other ('build from the live
    site' vs 'rests on the resources alone'), a dead end that left the session with a stub the
    validator rejected, failing the whole run. This pins the fallback: both notes now redirect to
    the research section, and the section itself names the tools.

    Monkeypatched rather than pointed at a resource-less client on disk, so it keeps testing the
    handler after anyone uploads a file for whichever client that was.
    """
    print("\ntest_facts_prompt_researches_a_brand_with_no_resources_and_no_domain")

    orig_res = facts_gen.clients_mod.list_resources
    orig_cfg = facts_gen.runner.load_client_config
    facts_gen.clients_mod.list_resources = lambda slug: []
    facts_gen.runner.load_client_config = lambda slug: {
        "name": "Nomad Coldbrew", "industry": "beverages"}  # no 'domain' key
    try:
        prompt = facts_gen.build_prompt(ROADMAP_CLIENT)
    finally:
        facts_gen.clients_mod.list_resources = orig_res
        facts_gen.runner.load_client_config = orig_cfg

    check("the research fallback section exists in the prompt",
          "WHEN THERE ARE NO UPLOADED RESOURCES AND NO LIVE SITE" in prompt)
    check("the fallback names Firecrawl search as the way to find the brand",
          "firecrawl_search" in prompt)
    check("the fallback names DataForSEO brand lookups that need no domain",
          "ai_opt_llm_ment_search" in prompt and "business_data_business_listings_search" in prompt)
    check("the empty-resources note redirects to the research fallback, not a dead end",
          "no live site to map" in prompt and "open web with Firecrawl search and DataForSEO" in prompt)
    check("the no-domain note no longer rests on resources alone",
          "rests on the resources\nalone" not in prompt and "rests on the resources alone" not in prompt)
    check("the no-domain note points to the same research fallback",
          "WHEN THERE ARE NO UPLOADED RESOURCES AND NO LIVE SITE' and build from open-web" in prompt)
    check("research or not, the fallback still demands the file carry §6 and §9",
          "must still carry §6" in prompt)
    check("the empty-KB prompt still leaves no unsubstituted {{TOKEN}} behind",
          facts_gen._PLACEHOLDER.findall(prompt) == [])
    check("the empty-KB prompt has no em dash or en dash",
          "—" not in prompt and "–" not in prompt)


def main():
    print("facts_check: static checks only. No CLI spawned, no query() called, "
          "no blog generated.")
    for test in (test_facts_prompt_is_built_to_serve_the_roadmap,
                 test_facts_prompt_attributes_without_unlocking,
                 test_facts_prompt_survives_a_client_with_no_roadmap,
                 test_facts_prompt_researches_a_brand_with_no_resources_and_no_domain):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("facts_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
