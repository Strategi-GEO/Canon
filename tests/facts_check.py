#!/usr/bin/env python3
"""Static checks for server/facts.py and server/facts_gen.py. Spawns NOTHING and calls NO model.

Every SDK seam is monkeypatched. The one assertion that matters most is the first: a
human-approved canonical-facts.md must come back byte identical, because overwriting one is
the worst thing this feature could do.

  .venv/bin/python tests/facts_check.py
"""
import asyncio
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import facts  # noqa: E402
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


def md5(path):
    return hashlib.md5(Path(path).read_bytes()).hexdigest()


def _write_client(root, slug, gates, never_claim="No returns language.", description="A brand."):
    directory = Path(root) / slug
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "gates.json").write_text(json.dumps(gates), encoding="utf-8")
    (directory / "never-claim.md").write_text(never_claim, encoding="utf-8")
    (directory / "description.md").write_text(description, encoding="utf-8")
    return directory


def test_vacation_village_untouched():
    """The real, human-written file: created=False and byte identical afterwards."""
    print("\ntest_vacation_village_untouched")
    path = REPO_ROOT / "clients" / "vacation-village" / "canonical-facts.md"
    if not path.is_file():
        check("vacation-village canonical-facts.md is present", False, str(path))
        return

    before = md5(path)
    before_size = path.stat().st_size

    def explode(*args, **kwargs):
        raise AssertionError("a session must never be attempted for an existing facts file")

    original = facts._run_session
    facts._run_session = explode
    try:
        result = asyncio.run(facts.ensure_canonical_facts("vacation-village"))
    finally:
        facts._run_session = original

    after = md5(path)
    check("vacation-village returns created=False", result["created"] is False, str(result))
    check("vacation-village canonical-facts.md is BYTE-IDENTICAL after the call",
          before == after, f"{before} -> {after}")
    check("vacation-village canonical-facts.md kept its size",
          path.stat().st_size == before_size)
    check("the reason names the file as already present",
          "already exists" in result["reason"], result["reason"])


def test_placeholder_is_treated_as_absent():
    """A PLACEHOLDER file is a stub preflight refuses on, so it is drafted over."""
    print("\ntest_placeholder_is_treated_as_absent")
    root = Path(tempfile.mkdtemp())
    try:
        directory = _write_client(root, "stub", {"client": "stub", "name": "Stub",
                                                 "domain": "https://stub.example"})
        path = directory / "canonical-facts.md"
        path.write_text("# canonical-facts.md: Stub\n\nPLACEHOLDER: fill this in.\n",
                        encoding="utf-8")

        check("a PLACEHOLDER file is not usable", facts.is_usable(path) is False)

        drafted = []

        async def fake_draft(inputs, target):
            drafted.append(inputs["slug"])
            target.write_text(f"# x\n\n{facts.AGENT_DRAFTED_MARKER}\n", encoding="utf-8")

        original = facts._draft_facts
        facts._draft_facts = fake_draft
        try:
            result = asyncio.run(facts.ensure_canonical_facts("stub", clients_root=root))
        finally:
            facts._draft_facts = original

        check("a PLACEHOLDER client would be drafted", drafted == ["stub"], str(drafted))
        check("a PLACEHOLDER client returns created=True", result["created"] is True)
        check("the drafted file carries no PLACEHOLDER token",
              facts.PLACEHOLDER_TOKEN not in path.read_text(encoding="utf-8"))
        check("an empty file is not usable either",
              facts.is_usable(directory / "missing.md") is False)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_demo_client_spends_nothing():
    """A demo client must never attempt an SDK session, in any environment."""
    print("\ntest_demo_client_spends_nothing")
    root = Path(tempfile.mkdtemp())
    try:
        directory = _write_client(root, "demo-tmp", {"client": "demo-tmp", "name": "Demo Tmp",
                                                     "domain": "https://demo.example",
                                                     "demo_mode": True})
        calls = []

        def spy(prompt, options):
            calls.append(prompt)
            raise AssertionError("the demo client attempted an SDK session")

        original = facts._run_session
        facts._run_session = spy
        try:
            result = asyncio.run(facts.ensure_canonical_facts("demo-tmp", clients_root=root))
        finally:
            facts._run_session = original

        path = directory / "canonical-facts.md"
        check("the demo client attempted NO SDK session", calls == [], str(calls))
        check("the demo client got a facts file", path.is_file())
        check("the demo client returns created=True", result["created"] is True)
        check("the demo facts file names itself demo content",
              "Demo content" in path.read_text(encoding="utf-8"))
        check("the demo facts file carries no PLACEHOLDER token",
              facts.PLACEHOLDER_TOKEN not in path.read_text(encoding="utf-8"))
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_lock_drafts_once():
    """Five topics starting at once draft the file ONCE, not five times."""
    print("\ntest_lock_drafts_once")
    root = Path(tempfile.mkdtemp())
    try:
        directory = _write_client(root, "racer", {"client": "racer", "name": "Racer",
                                                  "domain": "https://racer.example"})
        counter = [0]

        async def fake_draft(inputs, target):
            counter[0] += 1
            # Yield inside the critical section: without the lock the other four callers
            # would run here and each bump the counter.
            await asyncio.sleep(0.05)
            target.write_text(f"# facts\n\n{facts.AGENT_DRAFTED_MARKER}\n", encoding="utf-8")

        async def five():
            return await asyncio.gather(*(
                facts.ensure_canonical_facts("racer", clients_root=root) for _ in range(5)
            ))

        original = facts._draft_facts
        facts._draft_facts = fake_draft
        try:
            results = asyncio.run(five())
        finally:
            facts._draft_facts = original

        check("five concurrent callers drafted exactly once", counter[0] == 1, str(counter[0]))
        check("exactly one caller reports created=True",
              sum(1 for r in results if r["created"]) == 1, str(results))
        check("the file exists after the race", (directory / "canonical-facts.md").is_file())
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_prompt_carries_the_guardrails():
    """Assert on the built prompt, so an edit that drops a guard fails here."""
    print("\ntest_prompt_carries_the_guardrails")
    inputs = {
        "slug": "acme", "name": "Acme", "domain": "https://acme.example",
        "industry": "real-estate", "description": "Acme builds things.",
        "never_claim": "Never say assured returns.", "resources": ["brochure.pdf"],
    }
    prompt = facts.build_prompt(inputs, Path("/tmp/acme/canonical-facts.md"))

    check("the prompt seeds do-not-claim VERBATIM from never-claim.md",
          "Seed it VERBATIM with the operator's never-claim rules" in prompt)
    check("the prompt carries the operator's never-claim text itself",
          "Never say assured returns." in prompt)
    check("the prompt forbids removing or softening an operator line",
          "never remove, reword, soften" in prompt)
    check("the prompt states the site is MARKETING COPY",
          "The client's own website is MARKETING COPY" in prompt)
    check("the prompt forbids copying marketing into the facts as verified",
          "NEVER copy a claim from the client's own marketing INTO the facts" in prompt)
    check("the prompt records site claims as the client's own claim",
          "the client's own claim" in prompt)
    check("the prompt requires every URL to have been fetched",
          "must have been FETCHED and returned 200" in prompt)
    check("the prompt forbids guessing a slug", "Never guess a slug" in prompt)
    check("the prompt requires unknowns written as unknown",
          "An unknown is written as unknown" in prompt)
    check("the prompt requires the agent-drafted header",
          facts.AGENT_DRAFTED_MARKER in prompt)
    check("the prompt forbids the PLACEHOLDER token",
          f"Never write the token {facts.PLACEHOLDER_TOKEN}" in prompt)
    check("the prompt names the client's resource files", "brochure.pdf" in prompt)
    check("the prompt adds the house no-returns rule",
          "No returns, yield, ROI, appreciation" in prompt)
    check("the prompt has no em dash or en dash",
          "—" not in prompt and "–" not in prompt)


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


def main():
    print("facts_check: static checks only. No CLI spawned, no query() called, "
          "no blog generated.")
    for test in (test_vacation_village_untouched, test_placeholder_is_treated_as_absent,
                 test_demo_client_spends_nothing, test_lock_drafts_once,
                 test_prompt_carries_the_guardrails,
                 test_facts_prompt_is_built_to_serve_the_roadmap,
                 test_facts_prompt_attributes_without_unlocking,
                 test_facts_prompt_survives_a_client_with_no_roadmap):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("facts_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
