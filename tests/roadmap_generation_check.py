#!/usr/bin/env python3
"""What a Canon-GENERATED roadmap is guaranteed to be. Spawns NOTHING, calls NO model.

Two guarantees, and they are separate promises to two different readers:

1. EVERY generated sheet is the house column contract EXACTLY. The upload parser is deliberately
   looser (it checks the width and the three binding headers and lets an operator label their own
   guidance columns), which is right for a file a person uploaded and wrong for one this engine
   wrote. _validate_written is where the strict half lives, so a hand-written sheet that skipped
   build_roadmap.py is deleted rather than landed.

2. The session is handed EVERY research MCP this machine holds a key for, and is TOLD which ones,
   so it neither hunts for a tool it does not have nor ignores one it does.

  .venv/bin/python tests/roadmap_generation_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import roadmap, roadmap_gen  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def test_a_generated_sheet_is_the_contract_exactly():
    print("\ntest_a_generated_sheet_is_the_contract_exactly")
    house = list(roadmap.COLUMNS)
    check("the house ten pass", roadmap_gen._exact_contract_error(house) is None)
    # Case is the one thing a spreadsheet round trip changes on its own.
    check("case alone is not a mismatch",
          roadmap_gen._exact_contract_error([c.upper() for c in house]) is None)
    check("surrounding whitespace is not a mismatch",
          roadmap_gen._exact_contract_error([f"  {c} " for c in house]) is None)

    # An eleventh column would ride into every writer's brief as guidance nobody planned.
    err = roadmap_gen._exact_contract_error(house + ["Owner"])
    check("an eleventh column is refused", err is not None)
    check("and the refusal names both counts",
          err and "11 column(s)" in err and f"exactly {len(house)}" in err, str(err))

    # The right WIDTH with the old labels: the case the upload parser cannot catch, because it
    # only checks the three binding headers and these are all guidance columns.
    renamed = list(house)
    renamed[2], renamed[3] = "Format", "MSV"
    check("right width, wrong guidance labels, refused",
          roadmap_gen._exact_contract_error(renamed) is not None)
    check("the upload parser ACCEPTS that same sheet, which is why this check is separate",
          roadmap.parse_csv(",".join(renamed) + "\n" + ",".join(["v"] * len(renamed)) + "\n"))

    # Order is what the positional mapping rests on, so a permutation is not a relabelling.
    swapped = list(house)
    swapped[7], swapped[9] = swapped[9], swapped[7]
    check("a permutation is refused", roadmap_gen._exact_contract_error(swapped) is not None)


def test_the_session_gets_every_research_tool_this_machine_has():
    print("\ntest_the_session_gets_every_research_tool_this_machine_has")
    original = roadmap_gen.db.config_value
    try:
        roadmap_gen.db.config_value = lambda key: "sg_mcp_test" if key == "SEOGETS_API_KEY" else None
        servers = roadmap_gen._optional_mcp_servers()
        check("a configured SEO Gets key attaches the server", "seogets" in servers, str(list(servers)))
        check("as the official remote HTTP MCP",
              servers.get("seogets", {}).get("type") == "http"
              and servers["seogets"]["url"] == "https://app.seogets.com/mcp",
              str(servers.get("seogets")))
        check("with the key as the bearer token",
              servers["seogets"]["headers"]["Authorization"] == "Bearer sg_mcp_test")
        note = roadmap_gen.optional_tools_note(servers)
        check("and the prompt is TOLD it is connected", "mcp__seogets" in note, note[:120])
        check("naming what it is for", "STRIKING DISTANCE" in note, note[:120])

        roadmap_gen.db.config_value = lambda key: None
        empty = roadmap_gen._optional_mcp_servers()
        check("no key means no server", empty == {}, str(empty))
        # The resource_note reason: an agent told to use a tool that is not there burns turns
        # hunting for it, or reports a finding it never measured.
        off = roadmap_gen.optional_tools_note(empty)
        check("and the prompt is told so plainly", "No optional research tools are connected" in off)
        check("and told not to hunt for it", "Do not look for" in off, off[:120])
    finally:
        roadmap_gen.db.config_value = original


def test_the_floor_is_named_and_the_prompt_still_builds():
    print("\ntest_the_floor_is_named_and_the_prompt_still_builds")
    tools = roadmap_gen.__dict__  # the options are built inside a coroutine, so read the source
    source = Path(REPO_ROOT / "server" / "roadmap_gen.py").read_text(encoding="utf-8")
    for tool in ("mcp__firecrawl", "mcp__dataforseo", "mcp__seogets", "Skill"):
        check(f"{tool} is on allowed_tools", f'"{tool}"' in source)
    check("the optional servers are merged into mcp_servers, not replacing the floor",
          "mcp_servers={**servers, **_optional_mcp_servers()}" in source, "")
    prompt = Path(REPO_ROOT / "server" / "prompts" / "roadmap-generation.md").read_text(encoding="utf-8")
    check("the prompt carries the tools block", "{{OPTIONAL_TOOLS}}" in prompt)
    check("build_prompt substitutes it", "OPTIONAL_TOOLS" in source)
    assert tools is not None


def main():
    print("roadmap_generation_check: static checks only. No CLI spawned, no model called.")
    for test in (test_a_generated_sheet_is_the_contract_exactly,
                 test_the_session_gets_every_research_tool_this_machine_has,
                 test_the_floor_is_named_and_the_prompt_still_builds):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
