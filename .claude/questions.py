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
- `score` is the score this eval gave, and it is a RECORD of this moment, not a switch. The app
  works out whether answering is blocking from the blog's CURRENT score, because the blog moves
  after the asking: one live blog was asked at 85 and scored 96 by the time the operator opened
  it, and reading the 85 demanded they answer for a blog that had already shipped. At 95 or above
  the blog ships and the questions are an offer the operator may decline forever, because the
  first score at or above 95 is final and terminal and a passing draft is never held. Below 95
  nothing ships until they answer, and the answers become binding context for the revise.
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


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Write the evaluator's questions for the operator to <out>/questions.json"
    )
    parser.add_argument("--out", required=True, help="output directory for this topic")
    parser.add_argument("--slug", required=True, help="topic slug")
    parser.add_argument("--iter", required=True, type=int, help="current iteration number")
    parser.add_argument("--score", type=int, default=None, help="the score this eval gave")
    parser.add_argument("--ask", action="append", default=[], help="one question, repeatable")
    parser.add_argument("--why", action="append", default=[], help="what answering it unblocks")
    parser.add_argument("--area", action="append", default=[], help="|".join(AREAS))
    args = parser.parse_args(argv)

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
