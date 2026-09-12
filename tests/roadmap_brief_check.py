#!/usr/bin/env python3
"""The roadmap row reaches the AGENTS, not just the lead. Spawns NOTHING, calls NO model.

Every column the sheet carries used to reach the agents by relay alone: the lead had it in its
prompt and had to retype it into each dispatch. The extras are the half a lead drops first,
because it has no use for them itself, and a writer that never hears "Content Type: Comparison
anchor" writes a different piece. roadmap-row.md is the backstop, so this pins that the file is
written, that it carries the extras under the SHEET's own headers, and that both lead prompts
still carry the same text.

  .venv/bin/python tests/roadmap_brief_check.py
"""
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import runner  # noqa: E402

FAILURES = []
CHECKS = [0]

ROW = {
    "topic": "Weekend homes near Bengaluru",
    "covers": "What a buyer compares, and on what evidence.",
    "prompts": ["which weekend homes near bengaluru are worth it",
                "how much does a plot near bengaluru cost"],
    "topic_slug": "weekend-homes-near-bengaluru",
    # Position 3 is "Content Type" on a generated sheet and "Approx. Volume (IN/mo)" on an
    # operator's, which is why extras carry their own label instead of a position. Cost Per Click
    # is one of the six data points that ARE the row's justification, the ten-column contract
    # carrying no prose column arguing about them: it reaches the writer under its own header like
    # every other extra, and it is guidance, never a citable figure.
    "extras": [{"label": "Content Type", "value": "Comparison anchor"},
               {"label": "Query Intent", "value": "Commercial"},
               {"label": "Keyword Volume", "value": "1,000 to 2,000"},
               {"label": "Cost Per Click", "value": "1.20"}],
}


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def test_the_brief_carries_every_column():
    print("\ntest_the_brief_carries_every_column")
    brief = runner._roadmap_brief(ROW)
    check("the topic is in it", ROW["topic"] in brief)
    check("the scope is in it", ROW["covers"] in brief)
    for prompt in ROW["prompts"]:
        check(f"prompt {prompt[:28]!r} is in it", prompt in brief)
    for extra in ROW["extras"]:
        check(f"extra {extra['label']!r} is labelled by its own header",
              f"{extra['label']}: {extra['value']}" in brief, brief)
    check("it says the extras are never citable", "can NEVER be cited" in brief)


def test_a_sheet_with_no_extras_says_nothing_about_them():
    print("\ntest_a_sheet_with_no_extras_says_nothing_about_them")
    # A blank Content Type is a sheet that did not plan one, not a row to annotate with an empty
    # label. Same for a blank Cost Per Click: DataForSEO had no figure, and an empty label reads
    # as one.
    brief = runner._roadmap_brief({**ROW, "extras": []})
    check("no guidance block appears", "under the sheet's own headers" not in brief, brief)
    check("the binding three still do", ROW["covers"] in brief)


def test_the_file_is_written_and_both_leads_carry_the_same_text():
    print("\ntest_the_file_is_written_and_both_leads_carry_the_same_text")
    with tempfile.TemporaryDirectory() as tmp:
        out_dir = Path(tmp)
        runner._write_roadmap_brief(out_dir, ROW)
        path = out_dir / "roadmap-row.md"
        check("roadmap-row.md exists", path.is_file())
        text = path.read_text(encoding="utf-8")
        check("the file carries the Content Type extra",
              "Content Type: Comparison anchor" in text, text)
        check("and a justification figure reaches it under its own header",
              "Cost Per Click: 1.20" in text, text)

        lead = runner._lead_prompt("blr-brewing", ROW, ROW["topic_slug"], str(out_dir))
        revise = runner._revise_lead_prompt("blr-brewing", ROW, ROW["topic_slug"], str(out_dir), 2)
        for name, prompt in (("first draft", lead), ("revise", revise)):
            check(f"the {name} lead still carries the extras itself",
                  "Content Type: Comparison anchor" in prompt, prompt[:400])
            check(f"the {name} lead names the file as the backstop",
                  "roadmap-row.md" in prompt, prompt[:400])

        # A revise whose roadmap row has gone keeps the brief the run that wrote the draft used,
        # rather than clearing it: the file describes the topic, and the topic has not changed.
        runner._write_roadmap_brief(out_dir, None)
        check("an absent row leaves the earlier file alone", path.is_file())
        gone = runner._revise_lead_prompt("blr-brewing", None, ROW["topic_slug"], str(out_dir), 2)
        check("a revise with no row still runs", ROW["topic_slug"] in gone)


def main():
    print("roadmap_brief_check: static checks only. No CLI spawned, no model called.")
    for test in (test_the_brief_carries_every_column,
                 test_a_sheet_with_no_extras_says_nothing_about_them,
                 test_the_file_is_written_and_both_leads_carry_the_same_text):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
