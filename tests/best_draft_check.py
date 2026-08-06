#!/usr/bin/env python3
"""Best-scoring draft preservation. Spawns NOTHING and calls NO model.

The elective loop revises blog.md IN PLACE, so a later, lower iteration overwrites a higher one.
The contract said "keep the best-scoring draft" but nothing on disk did, and a real run peaked at
92 then shipped 89 ("unrecoverable, in-place edits"). This pins the code that now makes it true:

  1. .claude/status.py snapshots blog.md/eval.md to blog.best.md as each NEW HIGH is scored, and
     never on a tie or a lower score, scoped to the CURRENT run so a re-generation cannot inherit
     a prior peak.
  2. server.runner._install_best_draft restores the highest-scoring draft once the loop ends,
     reports its score, and cleans the snapshots, UNLESS the last draft is already the best or a
     current question holds a specific draft.

  .venv/bin/python tests/best_draft_check.py
"""
import importlib.util
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from server import runner  # noqa: E402

# .claude/status.py is not an importable package path; load it by file, the same file the agents
# invoke on the CLI, so the capture under test is the real one and not a copy.
_spec = importlib.util.spec_from_file_location("status_helper", REPO_ROOT / ".claude" / "status.py")
status_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(status_helper)

FAILURES = []
CHECKS = [0]


def check(name, condition, detail=""):
    CHECKS[0] += 1
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")
        FAILURES.append(name)


def _read(path):
    return path.read_text(encoding="utf-8") if path.is_file() else None


def _new_topic():
    root = Path(tempfile.mkdtemp())
    client, topic = "acme", "widgets"
    out = runner.output_dir(client, topic, root=root)
    out.mkdir(parents=True, exist_ok=True)
    return root, client, topic, out


def _write_draft(out, score):
    """A revise: overwrite blog.md and eval.md IN PLACE, exactly as Agent W's Edit does."""
    (out / "blog.md").write_text(f"draft-{score}", encoding="utf-8")
    (out / "eval.md").write_text(f"eval-{score}\nSCORE: {score}\n", encoding="utf-8")


def _score(out, topic, iteration, score, status="running"):
    """Record an eval end score through the REAL status.py CLI, which also captures the best."""
    status_helper.main([
        "--out", str(out), "--slug", topic, "--stage", "eval", "--event", "end",
        "--iter", str(iteration), "--score", str(score), "--status", status,
    ])


def test_peak_is_snapshotted_and_installed_over_a_lower_last_draft():
    print("\ntest_peak_is_snapshotted_and_installed_over_a_lower_last_draft")
    root, client, topic, out = _new_topic()
    # The screenshot's run: 84 -> 87 -> 92 -> 89, each revise overwriting blog.md in place.
    for iteration, score in enumerate([84, 87, 92, 89], start=1):
        _write_draft(out, score)
        _score(out, topic, iteration, score)
    check("the peak (92) is snapshotted, not the last draft (89)",
          _read(out / "blog.best.md") == "draft-92", _read(out / "blog.best.md"))
    check("the peak's eval is snapshotted too",
          (_read(out / "eval.best.md") or "").startswith("eval-92"))

    # The lead writes its terminal failed line at the last, lower score.
    _score(out, topic, 4, 89, status="failed")

    runner._install_best_draft(client, topic, out, 0, root=root)
    check("blog.md is restored to the 92 draft", _read(out / "blog.md") == "draft-92")
    check("eval.md is restored to the 92 eval", (_read(out / "eval.md") or "").startswith("eval-92"))
    check("the snapshots are cleaned up after install",
          not (out / "blog.best.md").exists() and not (out / "eval.best.md").exists())
    summary = runner._summarize(topic, runner._read_status(out))
    check("the reported score is the 92 peak, not the 89 last", summary["score"] == 92, str(summary))
    # The verdict is RE-RESOLVED from the restored peak, never copied from the lead's terminal
    # line: the lead wrote failed at 89, which is below bar, and the restored 92 clears the 90
    # bar, so the install writes done. A status inherited from the lead would read failed here and
    # fail this check, so what the check discriminates is re-resolution against inheritance. The
    # two seeds sit either side of the one bar the engine has, which is the whole of the split.
    check("the restored 92 peak carries the verdict its own score earns, done over the 90 bar",
          summary["status"] == "done", str(summary))


def test_no_swap_when_the_last_draft_is_already_the_best():
    print("\ntest_no_swap_when_the_last_draft_is_already_the_best")
    root, client, topic, out = _new_topic()
    for iteration, score in enumerate([84, 92], start=1):  # monotonic: last IS the best
        _write_draft(out, score)
        _score(out, topic, iteration, score)
    _score(out, topic, 2, 92, status="failed")
    runner._install_best_draft(client, topic, out, 0, root=root)
    check("blog.md is left untouched when the last draft is the best", _read(out / "blog.md") == "draft-92")
    check("snapshots are cleaned even when nothing is installed", not (out / "blog.best.md").exists())


def test_a_current_question_vetoes_the_swap():
    print("\ntest_a_current_question_vetoes_the_swap")
    root, client, topic, out = _new_topic()
    for iteration, score in enumerate([84, 92, 89], start=1):
        _write_draft(out, score)
        _score(out, topic, iteration, score)
    _score(out, topic, 3, 89, status="needs_review")
    original = runner._questions_state
    runner._questions_state = lambda c, t, root=None: "current"  # a live form holds the 89 draft
    try:
        runner._install_best_draft(client, topic, out, 0, root=root)
    finally:
        runner._questions_state = original
    check("the held draft (89) stays on disk; the higher 92 is NOT swapped in",
          _read(out / "blog.md") == "draft-89")
    check("snapshots are still cleaned under a current question", not (out / "blog.best.md").exists())


def test_capture_is_scoped_to_the_current_run():
    print("\ntest_capture_is_scoped_to_the_current_run")
    root, client, topic, out = _new_topic()
    # A prior run peaked at 95 and ended terminal.
    _write_draft(out, 95)
    _score(out, topic, 3, 95)
    _score(out, topic, 3, 95, status="done")  # prior run's terminal line
    check("the prior run's peak is snapshotted", _read(out / "blog.best.md") == "draft-95")
    # A fresh run begins and its first draft scores only 80. The stale 95 snapshot must be dropped,
    # or the next install would ship a prior run's draft.
    (out / "blog.md").write_text("draft-80-new", encoding="utf-8")
    (out / "eval.md").write_text("eval-80\nSCORE: 80\n", encoding="utf-8")
    _score(out, topic, 1, 80)
    check("the new run's first eval overwrites the stale prior-run snapshot",
          _read(out / "blog.best.md") == "draft-80-new", _read(out / "blog.best.md"))


def test_hard_killed_prior_run_snapshot_is_not_installed():
    """The one real bug the review found: a prior run HARD-KILLED (SIGKILL/OOM) mid-loop leaves a
    stale blog.best.md and trailing scored eval lines with NO terminal line, so status.py's scope
    still sees the killed peak and a later, lower run never overwrites it. run_topic now clears the
    snapshot at run start, so _install_best_draft can never ship the foreign draft."""
    print("\ntest_hard_killed_prior_run_snapshot_is_not_installed")
    root, client, topic, out = _new_topic()
    # Prior run scored 95, snapshot taken, then the process died with no terminal line.
    (out / "blog.md").write_text("draft-95-killed", encoding="utf-8")
    (out / "eval.md").write_text("eval-95\nSCORE: 95\n", encoding="utf-8")
    _score(out, topic, 1, 95)
    check("the hard-killed run left a stale snapshot", _read(out / "blog.best.md") == "draft-95-killed")

    # A new run begins. run_topic clears snapshots right after taking the baseline (the fix).
    baseline = len(runner._read_status(out))
    runner._clear_best_snapshots(out)
    # Both sit below the killed run's 95, which carries no terminal line under it and so is still
    # inside status.py's scope: neither scores a new high, so no snapshot replaces the cleared one.
    # This is about the SNAPSHOT scope and not about the bar: the 88 the loop ends on is below bar
    # and the lead's line says so, which is why nothing here reads a verdict.
    for iteration, score in [(1, 90), (2, 88)]:
        _write_draft(out, score)
        _score(out, topic, iteration, score)
    _score(out, topic, 2, 88, status="failed")

    runner._install_best_draft(client, topic, out, baseline, root=root)
    check("the foreign killed-run 95 draft is NOT installed", _read(out / "blog.md") == "draft-88")
    check("nothing is installed once the stale snapshot is cleared at run start",
          not (out / "blog.best.md").exists())


def test_lead_terminal_line_at_the_best_score_does_not_veto_the_install():
    """The supreme-steel live bug: the lead wrote its terminal line SHAPED AS an eval end
    carrying the best score (92) without moving any bytes, so best == last over the whole
    trail and the install concluded nothing needed restoring while the 87 draft sat on disk.
    Best and last are now computed from the agents' running-status lines alone."""
    print("\ntest_lead_terminal_line_at_the_best_score_does_not_veto_the_install")
    root, client, topic, out = _new_topic()
    for iteration, score in enumerate([92, 87], start=1):
        _write_draft(out, score)
        _score(out, topic, iteration, score)
    # The lead's terminal line, narrating the best score it never restored.
    _score(out, topic, 2, 92, status="failed")
    runner._install_best_draft(client, topic, out, 0, root=root)
    check("the 92 draft is restored despite the lead's 92-scored terminal line",
          _read(out / "blog.md") == "draft-92", _read(out / "blog.md"))
    check("eval.md is the 92 eval", (_read(out / "eval.md") or "").startswith("eval-92"))
    summary = runner._summarize(topic, runner._read_status(out))
    check("the reported score is 92", summary["score"] == 92, str(summary))


def test_a_retry_never_replaces_a_higher_scoring_blog():
    """The cross-run half of the same rule, and it compares two numbers rather than reading a
    band: a topic whose first run ended at 92, retried, and landed 87 keeps the 92 verdict set.
    A retry that strictly beats the prior keeps its own result."""
    print("\ntest_a_retry_never_replaces_a_higher_scoring_blog")
    root, client, topic, out = _new_topic()
    # Run 1: failed at 92, terminal line written, artifacts on disk.
    _write_draft(out, 92)
    _score(out, topic, 1, 92)
    _score(out, topic, 1, 92, status="failed")
    baseline = len(runner._read_status(out))

    # Run 2 starts: the runner snapshots the prior verdict, then the retry lands lower.
    prior = runner._snapshot_prior_verdict(out)
    check("the prior score is read off eval.md", prior == 92, str(prior))
    runner._clear_best_snapshots(out)
    _write_draft(out, 87)
    _score(out, topic, 1, 87)
    _score(out, topic, 1, 87, status="failed")
    runner._install_best_draft(client, topic, out, baseline, root=root)
    runner._keep_prior_run_if_higher(client, topic, out, baseline, prior, root=root)
    check("the retry's 87 did not replace the prior 92 draft",
          _read(out / "blog.md") == "draft-92", _read(out / "blog.md"))
    check("eval.md is the prior 92 eval", (_read(out / "eval.md") or "").startswith("eval-92"))
    summary = runner._summarize(topic, runner._read_status(out))
    check("the reported score is the prior 92", summary["score"] == 92, str(summary))
    check("prior snapshots are cleaned up",
          not (out / runner.PRIOR_BLOG_NAME).exists() and not (out / runner.PRIOR_EVAL_NAME).exists())

    # Run 3: a retry that strictly beats the kept 92 replaces it.
    baseline = len(runner._read_status(out))
    prior = runner._snapshot_prior_verdict(out)
    check("the kept 92 is now the prior", prior == 92, str(prior))
    runner._clear_best_snapshots(out)
    _write_draft(out, 96)
    _score(out, topic, 1, 96)
    _score(out, topic, 1, 96, status="done")
    runner._install_best_draft(client, topic, out, baseline, root=root)
    runner._keep_prior_run_if_higher(client, topic, out, baseline, prior, root=root)
    check("a strictly better retry keeps its own draft",
          _read(out / "blog.md") == "draft-96", _read(out / "blog.md"))


def test_a_retry_is_told_its_iteration_budget_is_fresh():
    """THE OTHER HALF OF THE RETRY CONTRACT, and the half that was missing.

    _keep_prior_run_if_higher defends a retry's downside and is worthless if the retry never
    runs. status.jsonl is append only ACROSS runs, so a retried topic hands its lead the prior
    session's whole trail: four iterations, a terminal line, and the engine's restore line under
    it. cafes-in-connaught-place was retried twice at 09:45 and 09:52 UTC on 2026-08-05; both
    leads read that spent loop, concluded the 4-iteration cap was reached, wrote the same failed
    82 back, and returned in about ninety seconds having dispatched no agent and scored nothing.
    The operator pressed a button that could not do anything.

    The engine cannot enforce this one: the loop runs inside the session. So the prompt names
    the rule, and it names the prior score rather than leaving the lead to infer it from the
    trail, because inferring from the trail is the whole of what went wrong.
    """
    print("\ntest_a_retry_is_told_its_iteration_budget_is_fresh")
    row = {"topic": "T", "covers": "C", "prompts": ["p"], "topic_slug": "t", "extras": []}
    fresh = runner._lead_prompt("c", row, "t", "/tmp/out")
    retry = runner._lead_prompt("c", row, "t", "/tmp/out", prior_score=82)

    for name, prompt in (("first run", fresh), ("retry", retry)):
        check(f"the {name} lead is told the four iterations start at one",
              "THE FOUR ITERATIONS ARE YOURS AND THEY START AT ONE" in prompt)
        check(f"the {name} lead is told the output dir is a resume point",
              "RESUME POINT, never a spent one" in prompt)
    check("a first run is told nothing about a prior draft",
          "previous run left a draft" not in fresh)
    check("a retry is told the prior score", "scoring 82" in retry, retry[-600:])
    check("a retry is told the engine defends that score", "defends that 82" in retry)
    check("a retry is told to draft from the frozen dossier",
          "the dossier is frozen" in retry)


def test_a_crashed_session_still_installs_the_peak():
    """THE LIVE LOSS THIS TEST EXISTS FOR. sandoz-restaurants scored 93, then 88, then 89, and the
    session died on iteration 4 with the CLI's own "error result" surfacing as an exception.

    _install_best_draft used to be called ONLY after run_topic's try block, on the clean-return
    path. Every except arm re-raises, so a crash skipped it entirely and then committed whatever
    iteration had last edited blog.md. On disk afterwards: blog.best.md holding the 93 and its
    eval, blog.md holding the 89, and the 89 is what shipped, what the record kept and what the
    operator read. The engine had the better draft the whole time.

    A CRASH IS WHEN A PEAK IS MOST LIKELY TO BE UNINSTALLED, not least: every extra iteration is
    another chance both to score lower than the peak and to die before the loop ends cleanly. So
    the guarantee has to hold on the failure path or it is not a guarantee.
    """
    print("\ntest_a_crashed_session_still_installs_the_peak")
    root, client, topic, out = _new_topic()
    # The real trail, in the real order.
    for iteration, score in enumerate([93, 88, 89], start=1):
        _write_draft(out, score)
        _score(out, topic, iteration, score)
    check("the 93 is snapshotted while the loop runs",
          _read(out / "blog.best.md") == "draft-93", _read(out / "blog.best.md"))
    check("blog.md still holds the last draft the loop edited",
          _read(out / "blog.md") == "draft-89")

    # NO TERMINAL LINE. The session died mid-iteration, so the lead never wrote one: this is
    # exactly the state run_topic's `except Exception` arm inherits, and it is what makes this
    # different from every other test here.
    check("the crash leaves no terminal line behind",
          runner._terminal_line(runner._read_status(out)) is None)

    runner._install_best_draft(client, topic, out, 0, root=root)

    check("the crash path still restores the 93 draft", _read(out / "blog.md") == "draft-93",
          _read(out / "blog.md"))
    check("and its matching eval, so the score describes the bytes beside it",
          (_read(out / "eval.md") or "").startswith("eval-93"), _read(out / "eval.md"))
    check("the snapshots are consumed",
          not (out / "blog.best.md").exists() and not (out / "eval.best.md").exists())
    summary = runner._summarize(topic, runner._read_status(out))
    check("the reported score is the 93 peak, never the 89 the crash left",
          summary["score"] == 93, str(summary))


def test_score_helpers():
    print("\ntest_score_helpers")
    lines = [
        {"stage": "eval", "event": "end", "score": 84, "iter": 1},
        {"stage": "eval", "event": "end", "score": 92, "iter": 3},
        {"stage": "eval", "event": "end", "score": 89, "iter": 4},
    ]
    check("_max_eval_score picks the peak", runner._max_eval_score(lines) == 92)
    check("_last_eval_score picks the last", runner._last_eval_score(lines) == 89)
    check("_first_iter_for_score maps a score to the iteration that first reached it",
          runner._first_iter_for_score(lines, 92) == 3)
    check("_max_eval_score is None with no eval scores", runner._max_eval_score([]) is None)


def main():
    print("best_draft_check: static checks only. No CLI spawned, no model called.")
    for test in (test_peak_is_snapshotted_and_installed_over_a_lower_last_draft,
                 test_no_swap_when_the_last_draft_is_already_the_best,
                 test_a_current_question_vetoes_the_swap,
                 test_capture_is_scoped_to_the_current_run,
                 test_hard_killed_prior_run_snapshot_is_not_installed,
                 test_lead_terminal_line_at_the_best_score_does_not_veto_the_install,
                 test_a_retry_never_replaces_a_higher_scoring_blog,
                 test_a_retry_is_told_its_iteration_budget_is_fresh,
        test_a_crashed_session_still_installs_the_peak,
                 test_score_helpers):
        test()
    print(f"\n{CHECKS[0] - len(FAILURES)}/{CHECKS[0]} checks passed")
    if FAILURES:
        print("FAILED: " + "; ".join(FAILURES))
        sys.exit(1)


if __name__ == "__main__":
    main()
