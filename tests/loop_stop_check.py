#!/usr/bin/env python3
"""What ends the revise loop, and why stop-on-a-dip is not one of them. Calls NO model.

An above-85 monotonic rule shipped for a few hours: "once any iteration scores above 85, an
iteration that does not STRICTLY beat the best so far ends the loop". It was argued from the idea
that a draft above 85 is close, so another revise is as likely to break it as to lift it. THE
ENGINE HAD ALREADY MADE THAT IMPOSSIBLE: _install_best_draft restores the highest-scoring draft
when the loop ends, so a later iteration cannot cost the peak. It can only cost tokens.

Replayed against the real trajectories recorded under outputs/, the rule ended the loop on four
blogs whose LATER iterations reached 90. This pins both halves so it cannot come back on an
argument nobody re-measured: the trajectories are inline FIXTURES rather than reads of outputs/,
which is gitignored, so this check means the same thing on a fresh clone as it does here.

  .venv/bin/python tests/loop_stop_check.py
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import runner  # noqa: E402

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    print(f"  {'PASS' if condition else 'FAIL'}  {name}" + ("" if condition or not detail else f" ({detail})"))
    if not condition:
        FAILURES.append(name)


# Real per-iteration scores, taken from eval end lines in outputs/*/*/status.jsonl on 2026-08-06.
# These four are the whole case: every one of them reached the ship bar on an iteration that came
# AFTER a score fell, so any rule that stops on a dip throws all four away.
RECOVERED_AFTER_A_DIP = [
    [89, 78, 93],
    [76, 88, 88, 94],
    [86, 83, 88, 92],
    [80, 89, 81, 93],
]


def simulate(scores, cap=4, stop_on_dip_above=None):
    """Where the loop ends and what it keeps. The engine restores the PEAK, never the last score.

    Models the three surviving conditions (ship bar, two consecutive no-gain iterations, the
    iteration cap) plus the optional deleted one, so the two can be priced against each other.
    """
    best = prev = None
    nogain = 0
    for i, score in enumerate(scores[:cap], start=1):
        prior_best = best
        best = score if best is None else max(best, score)
        if score >= runner.SHIP_SCORE:
            return i, best
        if stop_on_dip_above is not None and prior_best is not None \
                and prior_best > stop_on_dip_above and score <= prior_best:
            return i, best
        nogain = nogain + 1 if prev is not None and score <= prev else 0
        if nogain >= 2:
            return i, best
        prev = score
    return min(len(scores), cap), best


def test_stopping_on_a_dip_throws_away_shipped_blogs():
    for scores in RECOVERED_AFTER_A_DIP:
        _, kept_running_on = simulate(scores)
        _, kept_stopping = simulate(scores, stop_on_dip_above=85)
        check(f"{scores} ships when the loop runs on", kept_running_on >= runner.SHIP_SCORE,
              f"kept {kept_running_on}")
        check(f"{scores} is LOST to a stop-on-dip rule", kept_stopping < runner.SHIP_SCORE,
              f"kept {kept_stopping}")


def test_the_peak_is_kept_not_the_last_score():
    """The reason a dip is safe. A later iteration can lose points and cost the blog nothing."""
    _, kept = simulate([83, 86, 87, 73])
    check("a run ending 87 then 73 keeps the 87", kept == 87, f"kept {kept}")
    _, kept = simulate([70, 83, 83, 92])
    check("one flat iteration does not end the loop before a 92", kept == 92, f"kept {kept}")


def test_the_cap_and_the_no_gain_rule_still_stop_it():
    end, kept = simulate([74, 74, 74, 74])
    check("two consecutive no-gain iterations end the loop early", end == 3, f"ended at {end}")
    end, _ = simulate([70, 75, 80, 84, 88])
    check("the 4-iteration cap holds", end == 4, f"ended at {end}")
    end, kept = simulate([91, 80, 80])
    check("the ship bar ends the loop at once", (end, kept) == (1, 91), f"{end}, {kept}")


def test_the_lead_is_not_told_to_stop_on_a_dip():
    row = {"topic": "A Topic", "covers": "scope", "prompts": ["p1"], "extras": []}
    prompt = runner._lead_prompt("acme", row, "a-topic", "/tmp/out")
    banned = ["ONLY CLIMBS", "STRICTLY HIGHER than the best", "monotonic"]
    for phrase in banned:
        check(f"the lead prompt does not reinstate {phrase!r}", phrase not in prompt)
    check("the lead is told a dip is not a reason to stop", "A DIP IS NOT A REASON TO STOP" in prompt)
    # Matched on a single line: the prompt is hard-wrapped, so a phrase spanning a break never
    # appears as a substring however faithfully it is quoted.
    check("90 is still the only score that ends the loop early",
          "A score of 90 or higher still ends the loop at once" in prompt)


def main():
    print(__doc__.splitlines()[0])
    for test in (test_stopping_on_a_dip_throws_away_shipped_blogs,
                 test_the_peak_is_kept_not_the_last_score,
                 test_the_cap_and_the_no_gain_rule_still_stop_it,
                 test_the_lead_is_not_told_to_stop_on_a_dip):
        print(f"\n{test.__name__}")
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
