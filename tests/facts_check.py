#!/usr/bin/env python3
"""Static checks for server/facts.py. Spawns NOTHING and calls NO model.

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

FAILURES = []
CHECKS = [0]


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


def main():
    print("facts_check: static checks only. No CLI spawned, no query() called, "
          "no blog generated.")
    for test in (test_vacation_village_untouched, test_placeholder_is_treated_as_absent,
                 test_demo_client_spends_nothing, test_lock_drafts_once,
                 test_prompt_carries_the_guardrails):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + ", ".join(FAILURES))
        return 1
    print("facts_check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
