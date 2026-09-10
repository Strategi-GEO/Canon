#!/usr/bin/env python3
"""Boundary median confirmation: the logic, and whether it is worth running.

Spawns no session and opens no database. Part 1 drives the real function with the audit calls
stubbed, so every branch is exercised for free. Part 2 asks the question the feature has to
answer to justify its cost: does a median of three actually beat one roll, and by how much.
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import random
import shutil
import sys
import tempfile

REPO = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from server import runner  # noqa: E402

FAILED: list[str] = []


def check(name, ok, detail=""):
    print(f"  {'ok  ' if ok else 'FAIL'}  {name}{'' if ok else ': ' + detail}")
    if not ok:
        FAILED.append(name)


def make_topic(score, iters=3):
    """A finished topic on disk: an eval carrying `score`, and a status trail that reached it."""
    d = pathlib.Path(tempfile.mkdtemp(prefix="median-"))
    (d / "blog.md").write_text("# A draft\n\nUnchanged throughout.\n", encoding="utf-8")
    (d / "eval.md").write_text(f"SCORE: {score}\n\nFix list:\n- Sourcing: something\n",
                               encoding="utf-8")
    with (d / "status.jsonl").open("w", encoding="utf-8") as fh:
        for i in range(1, iters + 1):
            fh.write(json.dumps({"ts": "2026-09-05T00:00:00Z", "slug": "t", "stage": "eval",
                                 "event": "end", "iter": i, "score": score,
                                 "status": "running", "note": ""}) + "\n")
    return d


def run(out_dir, audits, held=False):
    """Drive the real _confirm_boundary_score with the audit sessions stubbed."""
    seq = list(audits)
    calls = []

    async def fake_audit(client_slug, topic_slug, od):
        if not seq:
            return None, ""
        s = seq.pop(0)
        calls.append(s)
        if s is None:
            return None, ""
        text = f"SCORE: {s}\n\nAudit number {len(calls)}.\n"
        (pathlib.Path(od) / "eval.md").write_text(text, encoding="utf-8")
        return s, text

    real_audit, real_state = runner._one_confirmation_audit, runner._questions_state
    runner._one_confirmation_audit = fake_audit
    runner._questions_state = lambda *a, **k: "current" if held else "none"
    try:
        got = asyncio.run(runner._confirm_boundary_score("acme", "t", out_dir))
    finally:
        runner._one_confirmation_audit, runner._questions_state = real_audit, real_state
    shipped = runner._eval_md_score(out_dir)
    return got, shipped, calls


print("\n[1] The branches")

# Outside the band nothing runs at all: a 94 or a 71 was never in doubt.
for score in (95, 71, 85, 93):
    d = make_topic(score)
    got, shipped, calls = run(d, [88])
    check(f"a {score} is left alone", got == score and calls == [],
          f"got {got} after {len(calls)} audit(s)")
    shutil.rmtree(d, ignore_errors=True)

# Inside the band, and the second audit agrees about the bar: settled, and the ORIGINAL number
# survives. Moving a blog's score because it was looked at twice would be its own defect.
d = make_topic(88)
got, shipped, calls = run(d, [87])
check("two audits below the bar keep the original score", got == 88 and shipped == 88,
      f"got {got}, eval.md says {shipped}")
check("agreement costs exactly one extra audit", calls == [87], str(calls))
shutil.rmtree(d, ignore_errors=True)

d = make_topic(91)
got, shipped, calls = run(d, [96])
check("two audits above the bar keep the original score", got == 91 and shipped == 91,
      f"got {got}, eval.md says {shipped}")
shutil.rmtree(d, ignore_errors=True)

# A genuine split buys the third audit, and the MEDIAN decides.
d = make_topic(89)
got, shipped, calls = run(d, [93, 92])
check("a split takes a third audit and ships the median", got == 92 and calls == [93, 92],
      f"got {got} after {calls}")
check("the eval.md on disk is the MEDIAN audit's own document", shipped == 92,
      f"eval.md carries {shipped}, verdict was {got}")
shutil.rmtree(d, ignore_errors=True)

d = make_topic(91)
got, shipped, calls = run(d, [84, 87])
check("a split downward also ships the median", got == 87 and shipped == 87, f"got {got}")
shutil.rmtree(d, ignore_errors=True)

# The whole point: an 89 that two other auditors put above the bar now ships.
d = make_topic(89)
got, _, _ = run(d, [92, 91])
check("an 89 that two auditors read as a pass now ships", got == 91 and got >= runner.SHIP_SCORE,
      f"got {got}")
shutil.rmtree(d, ignore_errors=True)

# And the converse holds, which is what stops this being a way to launder a fail into a ship.
d = make_topic(91)
got, _, _ = run(d, [86, 88])
check("a 91 that two auditors read as a fail no longer ships",
      got == 88 and got < runner.SHIP_SCORE, f"got {got}")
shutil.rmtree(d, ignore_errors=True)

print("\n[2] The refusals")

# A CURRENT question holds the blog at ANY score, so refining the number buys nothing.
d = make_topic(88)
got, shipped, calls = run(d, [93], held=True)
check("a held blog is never re-audited", got == 88 and calls == [], str(calls))
shutil.rmtree(d, ignore_errors=True)

# A dead session must cost the topic nothing. It already has a verdict; this only refines one.
d = make_topic(88)
got, shipped, calls = run(d, [None])
check("a failed audit keeps the original score", got == 88 and shipped == 88, f"got {got}")
shutil.rmtree(d, ignore_errors=True)

d = make_topic(89)
got, shipped, calls = run(d, [93, None])
check("a failed THIRD audit keeps the original score and its eval",
      got == 89 and shipped == 89, f"got {got}, eval.md {shipped}")
shutil.rmtree(d, ignore_errors=True)

# The trail records what happened, because a score that moved with no explanation is worse than
# one that did not move.
d = make_topic(89)
run(d, [93, 92])
trail = (d / "status.jsonl").read_text(encoding="utf-8")
check("the confirmation is written into the status trail", "boundary median" in trail)
last = json.loads([l for l in trail.splitlines() if l.strip()][-1])
check("the recorded line carries the median score", last.get("score") == 92, str(last.get("score")))
check("the confirmation joins the loop's last iteration, inventing none",
      last.get("iter") == 3, str(last.get("iter")))
shutil.rmtree(d, ignore_errors=True)

print("\n[3] The bar's arithmetic, which the band is defined against")
# THIS DRIFTED ONCE AND NOTHING CAUGHT IT. rubric.md's own summary read "8 hard gates and 12
# graded dimensions" while the file listed 9 and 14, and the EVALUATOR reads that file on every
# run. The counts are not decoration: CLAUDE.md derives the entire ship band from the weights
# totalling 30, so a rubric that miscounts itself makes the contract's arithmetic unverifiable.
import re as _re  # noqa: E402

RUBRIC = (REPO / ".claude" / "skills" / "geo-content-eval" / "references" / "rubric.md").read_text()

gates = _re.findall(r"^\| (G\d+) \|", RUBRIC, _re.M)
dims = _re.findall(r"^\*\*([ABCD]\d+)\.\s*[^*]+?\*\*\s*\(weight (\d+)\)", RUBRIC, _re.M)
weights = sum(int(w) for _, w in dims)

check("rubric.md's stated gate count matches the gates it lists",
      f"{len(gates)} hard gates" in RUBRIC, f"lists {len(gates)}")
check("rubric.md's stated dimension count matches the dimensions it lists",
      f"{len(dims)} graded dimensions" in RUBRIC, f"lists {len(dims)}")
check("the weights still total 30, which is what makes the maximum 90",
      weights == 30, f"total is {weights}")
check("the bar is reachable: 90 normalised is a whole number of weighted points",
      round(weights * 3 * 0.9) == 81, f"needs {round(weights*3*0.9)} of {weights*3}")
check("SHIP_SCORE is the 90 every other rule names", runner.SHIP_SCORE == 90,
      str(runner.SHIP_SCORE))

# The band is only meaningful relative to the bar. If someone moves SHIP_SCORE and leaves the band
# where it is, the confirmation would fire on scores nowhere near the decision it exists to protect.
lo, hi = runner.MEDIAN_BAND
check("the band brackets the bar rather than sitting beside it",
      lo < runner.SHIP_SCORE < hi, f"band {runner.MEDIAN_BAND} vs bar {runner.SHIP_SCORE}")
check("the band is narrow enough to be about the boundary and not the whole range",
      (hi - lo) <= 10, f"width {hi - lo}")

print("\n[4] Is it worth running? A simulation, not a measurement")
# THE ASSUMPTION IS STATED AND IT IS THE WHOLE RESULT. CLAUDE.md says the evaluator's score
# "varies by several points on an identical draft" and never publishes a distribution, so this
# models the noise as gaussian and reports across a range of spreads rather than asserting one.
# Ground truth is the draft's own quality; a verdict is right when it lands on the correct side
# of the bar. Only drafts inside the band are re-audited, exactly as the code does it.
random.seed(7)
TRIALS = 40000
print(f"  {'noise sd':>8} | {'1 roll':>9} | {'median':>9} | {'errors fixed':>13} | {'extra audits':>12}")
print("  " + "-" * 62)
for sd in (2.0, 3.0, 4.0, 5.0):
    wrong_single = wrong_median = extra = 0
    for _ in range(TRIALS):
        truth = random.uniform(78, 100)          # the draft's real quality
        s1 = truth + random.gauss(0, sd)
        actually_ships = truth >= runner.SHIP_SCORE
        if (s1 >= runner.SHIP_SCORE) != actually_ships:
            wrong_single += 1
        lo, hi = runner.MEDIAN_BAND
        if lo <= s1 <= hi:
            s2 = truth + random.gauss(0, sd); extra += 1
            if (s2 >= runner.SHIP_SCORE) == (s1 >= runner.SHIP_SCORE):
                verdict = s1
            else:
                s3 = truth + random.gauss(0, sd); extra += 1
                verdict = sorted((s1, s2, s3))[1]
        else:
            verdict = s1
        if (verdict >= runner.SHIP_SCORE) != actually_ships:
            wrong_median += 1
    a, b = wrong_single / TRIALS * 100, wrong_median / TRIALS * 100
    print(f"  {sd:>8.1f} | {a:>8.2f}% | {b:>8.2f}% | {(a-b)/a*100:>12.1f}% | "
          f"{extra/TRIALS:>11.2f}/blog")

print("\n  Read it as: at every plausible noise level the median makes fewer wrong ship/no-ship")
print("  calls, and it costs well under one extra audit per blog because only the band pays.")

print()
if FAILED:
    print(f"FAILED: {', '.join(FAILED)}")
    sys.exit(1)
print("all median checks passed")
