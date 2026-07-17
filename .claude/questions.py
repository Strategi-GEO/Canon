#!/usr/bin/env python3
"""Write <out>/questions.json: the evaluator's questions for the human operator.

This is the ONLY way any agent asks the operator anything. It exists for the case the fix list
cannot cover: a gap that no amount of rewriting closes, because the missing thing is a fact only
a person can supply. "Confirm a dated source for Kodagu's district area" and "is The Manor counted
among the 24+ amenities" are questions; "rephrase this H2" is not, that is the writer's job.

Shape, one object per file, rewritten whole by each eval:

  {"slug":str, "asked":iso8601, "iter":int, "score":int|null,
   "questions":[{"id":"q1","area":"Sourcing|Structure|Draft|Mechanics",
                 "question":str, "why":str}]}

Rules the shape encodes:
- Questions belong to ONE eval of ONE topic, so the file is REWRITTEN, never appended to. A stale
  question from iteration 2 answered at iteration 4 would be answering a draft that no longer
  exists.
- `score` is the score this eval gave, and it is a RECORD of this moment, not a switch. NOTHING
  reads it to decide anything. OPEN QUESTIONS HOLD THE BLOG AT ANY SCORE and answering is a
  DEMAND, never an offer, so there is no score at which the form stops mattering. The old
  score-gated rule shipped exactly what it licensed: two blogs went out at 96 over their own open
  questions, one publishing a claim its canonical-facts file lists as not citable. The record is
  still worth keeping, because the moment is half of the act: one live blog was asked at 85 and
  stood at 96 by the time the operator opened it, and "answered while it stood at 85" and
  "answered while it stood at 96" are two different decisions.
- An `area` of Sourcing is the heaviest thing this file writes, because A SOURCING QUESTION ENDS
  THE REVISE LOOP at the iteration it is filed, before the revise is dispatched. No rewrite closes
  a Sourcing gap: the writer has no authority to invent a citation or URL. So such a question
  surrenders every iteration the blog had left, and there is no in-loop revise for its answer to
  become context for. Ask it only where a person genuinely holds the missing fact, and file a
  fix-list item instead wherever a bounded researcher top-up can find the source. See
  check_area_cli.
- `why` is not decoration. The operator is deciding whether to spend their own time, and a
  question that cannot say what it unblocks should not have been asked.
- Every question carries the same four Areas the fix list uses, because an answer routes exactly
  like a fix does: Sourcing goes back to the researcher, the rest to the writer.

CLI, three repeatable flags that zip together in order:

  python3 .claude/questions.py --out <output_dir> --slug <slug> --iter 2 --score 93 \
      --ask "Can you confirm a dated source for Kodagu's 4,106 sq km area?" \
      --why "B1 cites it undated, which caps Sourcing at 2. A dated source lifts it to 3." \
      --area Sourcing \
      --ask "..." --why "..." --area Draft

Exits 2 on a bad area, on mismatched flag counts, or on an empty question or why.

The READ side of the same CLI, which the session lead runs and which writes nothing:

  python3 .claude/questions.py --out <output_dir> --slug <slug> --check-area Sourcing [--iter 3]

It exits 0 when a live question of that area is on disk, printing what it found, and 1 when
there is none. See check_area_cli for what the lead does with the answer and why.
"""
import argparse
import datetime
import json
import os
import sys

AREAS = ("Sourcing", "Structure", "Draft", "Mechanics")

# Five is a limit on the operator's attention, not on the evaluator's curiosity. A form of
# fifteen questions does not get answered, it gets closed, and then the blog sits in review
# forever. Ask for what actually changes the outcome and let the fix list carry the rest.
MAX_QUESTIONS = 5


def write_questions(out_dir, slug, iter, questions, score=None):
    """Validate every question, stamp asked, and write the file whole.

    `iter` shadows the builtin on purpose: it matches the field name in the shape, exactly as
    status.py does it.
    """
    if not questions:
        raise ValueError("no questions given: write no file rather than an empty one")
    if len(questions) > MAX_QUESTIONS:
        raise ValueError(
            f"{len(questions)} questions: at most {MAX_QUESTIONS}. Ask only what changes the "
            f"outcome and leave the rest to the fix list"
        )

    built = []
    for position, question in enumerate(questions, 1):
        area = question.get("area")
        if area not in AREAS:
            raise ValueError(f"bad area {area!r}: must be one of {'|'.join(AREAS)}")
        text = str(question.get("question") or "").strip()
        why = str(question.get("why") or "").strip()
        if not text:
            raise ValueError(f"question {position} is empty")
        if not why:
            raise ValueError(
                f"question {position} has no --why: say what answering it unblocks, or do not ask"
            )
        built.append({"id": f"q{position}", "area": area, "question": text, "why": why})

    payload = {
        "slug": str(slug),
        "asked": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "iter": int(iter),
        "score": None if score is None else int(score),
        "questions": built,
    }
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "questions.json")
    # Written whole through a temp file and renamed: the app reads this file to build the
    # operator's form, and a half written one would render a truncated question as if it were
    # the whole of it.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)
    return payload


def read_form(out_dir):
    """The form at <out_dir>/questions.json parsed, or None when there is none worth reading.

    A corrupt file reads as ABSENT here, and the tolerance is scoped to what this reader is FOR:
    the check below, which asks whether a live question is holding the loop. A form no parser can
    read is one the app refuses to render, so it summons nobody and it holds nothing.
    server.questions._read_json RAISES on that same file, because it reads it for the OPERATOR'S
    form, where swallowing a corrupt file would render an empty form and tell them nobody asked.
    Two jobs, two right answers, and neither is the other's bug.
    """
    path = os.path.join(out_dir, "questions.json")
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return None


def questions_in_area(form, area):
    """The questions in a parsed form carrying `area`, in the order they were asked.

    THE ONE COMPUTATION of "does this form carry a question of this area", and it stays one.
    server.questions.has_area_question imports this exact function by file path, the way
    server.runner loads .claude/status.py, so the CLI the lead runs and the predicate the engine
    and the tests read cannot drift into two answers about one file.

    It says NOTHING about whether the form is LIVE. Staleness, answeredness and readability belong
    to the caller, and both callers apply them: check_area_cli refuses a form for another slug or
    another iteration, and has_area_question goes through runner._questions_state first. A form the
    app refuses carries no live question of any area, because it summons nobody.
    """
    if not isinstance(form, dict):
        return []
    return [
        question
        for question in (form.get("questions") or [])
        if isinstance(question, dict) and question.get("area") == area
    ]


def check_area_cli(out_dir, slug, area, iter):
    """Print what is on disk for this area and return the exit code: 0 found, 1 none, 2 unusable.

    `iter` IS REQUIRED AND IS THE WHOLE STALENESS GUARD. It was optional once, and every caller
    omitted it, which silently disabled the only check standing between a dead form and a killed
    loop: a form from iteration 1 read as live while the blog sat on iteration 3, exit 0, loop
    over. The lead knows its own iteration and already passes it to every subagent, so requiring
    it costs nothing and removes a flag whose absence was indistinguishable from a pass. It is
    NOT derived here: reaching runner._summarize from `.claude/` would reimplement the engine's
    iteration logic as a second computation, which is exactly the drift this design avoids.

    THE RULE THIS SERVES: A SOURCING QUESTION ENDS THE REVISE LOOP IMMEDIATELY, at the iteration it
    is filed. At SCORE < 95 the lead runs this BEFORE dispatching a revise, and on exit 0 the loop
    ENDS NOW: it writes the terminal needs_review line and stops, without revising, without
    dispatching another evaluator, and without deleting the form. Questions of area Structure,
    Draft or Mechanics do NOT end the loop: they are superseded by the next iteration's form, and
    the lead deletes questions.json before the next evaluator exactly as before. At SCORE >= 95
    nothing changes, because the loop ends anyway and terminal resolution holds the blog if ANY
    current question exists, of any area.

    THE REASON: Sourcing is the ONE area no rewrite can close, which the contract already says in
    its own words, "the writer has no authority to invent a citation or URL". A Sourcing QUESTION
    names a fact only a person has, so iterating past one spends research and revise budget
    rediscovering something the evaluator already knew was terminal. The live proof: the date-night
    blog filed Sourcing questions at iteration 1, ran a bounded research top-up and two full
    revises, and landed at iteration 3 on FOUR Sourcing questions about claims no rewrite could ever
    have fixed. Three iterations bought nothing.

    THE DISTINCTION, because it is the thing a reader gets wrong: a Sourcing FIX-LIST ITEM still
    routes to a bounded Agent R top-up and still does NOT end the loop. That routing is unchanged
    and it works, date-night's iteration 2 top-up sourced three Sourcing fix-list items. A fix-list
    item says "a machine can find this source"; a question says "only a person holds this fact".
    Same area word, opposite implications for the loop.

    THE ENFORCEMENT LIMIT, stated plainly: this is a LEAD INSTRUCTION and the engine CANNOT enforce
    it, because the loop runs inside the SDK session and the backend cannot reach into it to stop a
    revise. That is a real departure from this project's "the check is in Python where nothing can
    argue with it" principle, so it is named here rather than papered over. IT FAILS IN BOTH
    DIRECTIONS AND THEY ARE NOT SYMMETRIC:
      IGNORING the rule costs money, not correctness. The lead burns iterations, then hits terminal
      resolution, where the final form still holds the blog in Python. It cannot ship a blog it
      should have held.
      OVER-APPLYING it costs a good blog. Ending the loop on a form that is stale or another
      topic's writes needs_review with iterations unspent, and terminal resolution then reads that
      same form as non-holding and corrects the topic to `failed` by its score. A draft that had
      budget left to reach 95 dies instead. The required `iter` above is what closes that
      direction, which is why it is required rather than advisory.

    THIS QUERY NEVER WRITES, and it deliberately does not know about answeredness, unlike the
    engine's four-valued question state. An answered form cannot exist mid-loop: answers arrive
    only after the loop has ended and the blog is already held. So this answers exactly one narrow
    question, "does the form for THIS slug at THIS iteration carry a live question of this area",
    and it is not a second opinion on the engine's liveness rule.
    """
    form = read_form(out_dir)
    if form is None:
        print(f"no readable questions.json in {out_dir}: no live {area} question")
        return 1
    if not isinstance(form, dict):
        # Valid JSON that is not an object parses cleanly and then fails on the first .get(), so
        # read_form's decode guard never sees it. A body this file cannot read summons nobody,
        # which is the same answer an absent form gets.
        print(f"questions.json in {out_dir} is not a JSON object: no live {area} question")
        return 1
    # A form for another topic or another iteration is not this draft's form. The staleness rule is
    # the app's already: questions belong to ONE eval of ONE topic, so one describing a draft the
    # blog has moved past cannot end a loop about the draft that exists.
    if form.get("slug") != slug:
        print(
            f"questions.json in {out_dir} belongs to {form.get('slug')!r}, not {slug!r}: "
            f"no live {area} question"
        )
        return 1
    if form.get("iter") != iter:
        print(
            f"questions.json asks about iteration {form.get('iter')} and the draft is on "
            f"iteration {iter}, so it is stale: no live {area} question"
        )
        return 1

    found = questions_in_area(form, area)
    if not found:
        print(f"{slug}: no {area} question in questions.json (iter {form.get('iter')})")
        return 1

    print(f"{slug}: {len(found)} {area} question(s) at iteration {form.get('iter')}")
    for question in found:
        print(f"  {question.get('id')}: {question.get('question')}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Write the evaluator's questions for the operator to <out>/questions.json"
    )
    parser.add_argument("--out", required=True, help="output directory for this topic")
    parser.add_argument("--slug", required=True, help="topic slug")
    parser.add_argument(
        "--iter",
        type=int,
        help="current iteration number: REQUIRED, to write and to --check-area alike",
    )
    parser.add_argument("--score", type=int, default=None, help="the score this eval gave")
    parser.add_argument("--ask", action="append", default=[], help="one question, repeatable")
    parser.add_argument("--why", action="append", default=[], help="what answering it unblocks")
    parser.add_argument("--area", action="append", default=[], help="|".join(AREAS))
    parser.add_argument(
        "--check-area",
        choices=AREAS,
        default=None,
        help="write nothing: exit 0 if a live question of this area is on disk, 1 if not, 2 if unusable",
    )
    args = parser.parse_args(argv)

    # The read path, and it returns before anything is written. The lead runs it at SCORE < 95 to
    # find out whether a Sourcing question has already ended the loop, and a query that could
    # rewrite the form it is asking about would destroy the very thing it reports on.
    if args.check_area:
        if args.iter is None:
            # A usage error, NOT a "no". Exit 1 is a meaningful answer here ("nothing of that area
            # is live, revise on"), so a caller that forgot the staleness guard must never land on
            # it: that is how an omitted --iter used to read as a pass and end a loop on a dead form.
            print(
                "questions.py: --iter is required with --check-area. It is the staleness guard: "
                "without it a form from an earlier iteration reads as live and ends the loop.",
                file=sys.stderr,
            )
            sys.exit(2)
        try:
            sys.exit(check_area_cli(args.out, args.slug, args.check_area, args.iter))
        except SystemExit:
            raise
        except Exception as exc:
            # Exit 1 means "no live question of that area, carry on revising", so an unhandled
            # crash must never borrow it: a lead reading the code alone would take the failure for
            # an answer and iterate past a question that ends the loop. 2 is unusable, not absent.
            print(f"questions.py: --check-area failed: {exc}", file=sys.stderr)
            sys.exit(2)

    if args.iter is None:
        print("questions.py: --iter is required to write questions", file=sys.stderr)
        sys.exit(2)

    if not (len(args.ask) == len(args.why) == len(args.area)):
        print(
            f"questions.py: got {len(args.ask)} --ask, {len(args.why)} --why and "
            f"{len(args.area)} --area. Each question needs all three, in the same order.",
            file=sys.stderr,
        )
        sys.exit(2)

    questions = [
        {"question": ask, "why": why, "area": area}
        for ask, why, area in zip(args.ask, args.why, args.area)
    ]

    try:
        write_questions(args.out, args.slug, args.iter, questions, score=args.score)
    except ValueError as exc:
        print(f"questions.py: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
