"use client";

import * as React from "react";
import { Check, Info, Loader2, MessageCircleQuestion, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { FieldError } from "@/components/clients/engine-error";
import { modeOf, type QuestionsMode } from "@/components/blogs/questions-state";
import { useNow } from "@/components/create/use-now";
import { ApiError, api } from "@/lib/api";
import { formatAbsolute, formatElapsed } from "@/lib/format";
import { useRuns } from "@/lib/runs-context";
import { clockOf, isLive, runStateOf } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import type { TopicQuestions } from "@/lib/use-blog-questions";
import type { BlogQuestion, BlogQuestions, RunSummary } from "@/types";

/**
 * A blog whose terminal status is needs_review, as the drawer reads it off the disk: the
 * engine's own reason from the terminal status.jsonl line, and whether that file is still being
 * read. Null for every blog that is not held, which is every done and every failed one.
 *
 * needs_review MEANS the run has something to ask the operator, so this arrives as context for
 * the questions rather than as a demand of its own. What it may never do again is render alone:
 * the reason is the explanation of an obligation, and an explanation shown apart from the way to
 * discharge it is how a status ends up ordering a human to act and offering them no door.
 */
export type ReviewHold = {
  /** The engine's words, verbatim. Null when the terminal line carried no note. */
  note: string | null;
  /** True while status.jsonl is still being read, so the note is not yet knowable. */
  pending: boolean;
};

/**
 * The evaluator's questions for one blog, and the operator's way to answer them.
 *
 * WHY THIS EXISTS: some gaps no rewrite closes, because the missing thing is a fact only a
 * person has. No amount of further research settles whether valet parking is real at an address,
 * and the fix list cannot carry it either: a fix list routes to an agent. So the evaluator asks,
 * and this is where a human answers. Every token the engine would spend hunting for something
 * the operator already knows is a token spent to arrive at a worse answer more slowly.
 *
 * IT LIVES ON THE BLOG VIEW because the questions are about one blog, and the operator cannot
 * decide whether they can answer without the draft in front of them.
 *
 * THE THREE STATES IT RENDERS, and there is no fourth, because the engine settles the terminal
 * status on exactly this rule and corrects anything else:
 *
 *   >= 95, no questions     Nothing here. The shipped badge is the whole story, so this renders
 *                           null rather than a box confirming that all is well.
 *   >= 95, with questions   `Open` in the ship tone with an amber tag. It shipped, it says so, and
 *                           the questions are an offer.
 *   <  95, with questions   `Open` in the review tone. Blocked, no dismiss, the form is the way
 *                           out.
 *
 * Below 95 with NOTHING to ask never reaches this component at all: that is `failed`, and a failed
 * blog has no human task in it to render.
 *
 * The strip is what the drawer shows; the form is a dialog behind it, following the same pattern
 * as the roadmap generation dialog. The drawer's tabs own a fixed height calculated from the
 * header, so a form unfolding inline above them would push the article out from under its own
 * scroll area, and the operator is reading the article to decide what to type.
 *
 * IT ALSO OWNS THE REVIEW REASON, which used to be a strip of its own below this one reading "a
 * human has to confirm something before this ships". That box demanded an act and named none: on
 * a blog whose questions were stale it sat above a panel saying the operator may not answer, and
 * on a blog with no questions at all it sat above nothing. A status that demands a human act
 * while naming no act is a dead end, so the reason now renders inside whichever strip is already
 * on screen, next to the thing that discharges it or next to the sentence explaining that
 * nothing does.
 */
export function AnswerQuestions({
  brandSlug,
  topicSlug,
  blogScore,
  entry,
  review,
  onSettled,
}: {
  brandSlug: string;
  topicSlug: string;
  /**
   * What the library reports for this blog NOW, straight off the disk scan. It is the score of
   * whatever draft is shipped, so after a revise it is the outcome, and the score the questions
   * carry is what the draft scored when they were asked. The pair is the whole answer to "what
   * did answering get me".
   */
  blogScore: number | null;
  /** This topic's entry from the library's one read. Undefined while that read is in flight. */
  entry: TopicQuestions | undefined;
  /** The engine's hold on this blog, or null when it is not held. See ReviewHold. */
  review: ReviewHold | null;
  /** Re-reads the blogs and the questions: called on a submit, and when the revise lands. */
  onSettled: () => void;
}) {
  const { runs, queue } = useRuns();

  /**
   * The run record the 202 handed back, held ONLY until the engine's own list carries it.
   *
   * The list is polled every four seconds. Without this, those four seconds report no run for a
   * blog whose revise has demonstrably started, and the panel would spend them showing the
   * outcome of a revise that has not happened: the pre-revise score, labelled as the result.
   * Nothing durable rests on it. A refresh drops it and the list below re-attaches on its own.
   */
  const [accepted, setAccepted] = React.useState<RunSummary | null>(null);

  /**
   * The run working this blog, in preference order: our own accepted run as the ENGINE now
   * reports it, then any live run holding this topic, then the 202 for the seconds before the
   * poll lands.
   *
   * The middle one is what makes this durable. A revise started before a refresh, in another
   * tab, or by another operator is picked up here from the engine's list, with its elapsed
   * measured from the ENGINE's own timestamp, so a refresh ten minutes in still reads ten
   * minutes. Nothing about a live run is remembered in this browser.
   */
  const record =
    runs.find((run) => run.run_id === accepted?.run_id) ??
    runs.find(
      (run) =>
        run.client === brandSlug &&
        isLive(run) &&
        run.topics.some((topic) => topic.topic_slug === topicSlug),
    ) ??
    accepted;

  const revising = record !== undefined && record !== null && isLive(record);

  /**
   * The engine admits ONE session at a time across every brand, so it 409s a submit while this
   * brand is live. Saying so up front beats discovering it: the operator has typed paragraphs by
   * the time they press, and a refusal then reads as their answers being rejected.
   */
  const session = queue.find((item) => item.clientSlug === brandSlug) ?? null;

  // Re-read the moment the engine stops reporting a run for this topic. The library's score was
  // read BEFORE the revise, so without this the outcome below would present the pre-revise
  // number as the thing the revise produced.
  const settled = React.useRef(revising);
  React.useEffect(() => {
    if (settled.current && !revising) {
      onSettled();
    }
    settled.current = revising;
  }, [revising, onSettled]);

  if (entry === undefined) {
    // The read is in flight. Nothing is claimed either way for the frame it takes: an operator
    // is not told a blog has no questions by a panel that has not asked yet. The review reason
    // waits with it, because what this strip should say about a hold depends entirely on whether
    // the hold turns out to have a question behind it.
    return null;
  }

  if (entry.error !== null) {
    return (
      <Strip tone="fail">
        <p className="flex items-center gap-2 text-xs font-medium text-fail">
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          Cannot tell whether this blog is waiting on you
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-fail/90">
          The engine did not answer for this topic&apos;s questions, so this view will not claim
          it has none. Its own words:
        </p>
        <FieldError error={entry.error} className="mt-1" />
        <ReviewNote review={review} tone="fail" />
      </Strip>
    );
  }

  const questions = entry.payload;
  if (questions === null || questions.questions.length === 0) {
    if (review === null) {
      // The ordinary case: the evaluator settled everything by itself and asked nobody anything.
      return null;
    }
    return <Held review={review} blogScore={blogScore} />;
  }

  const mode = modeOf(questions);

  if (mode === "answered") {
    // No review reason here, deliberately. The operator has already acted, and the terminal note
    // belongs to the run that asked rather than to the revise their answers started: repeating
    // "held for a human" at the one moment the human is done would describe the wrong run.
    return (
      <Answered
        questions={questions}
        blogScore={blogScore}
        record={revising ? record : null}
      />
    );
  }

  if (mode === "stale") {
    return <Stale questions={questions} blogScore={blogScore} review={review} />;
  }

  return (
    <Open
      brandSlug={brandSlug}
      topicSlug={topicSlug}
      questions={questions}
      blogScore={blogScore}
      mode={mode}
      review={review}
      lockedReason={
        session === null
          ? null
          : session.state === "running"
            ? "A session is running for this brand right now. The engine works one at a time, so it refuses a second: answer once it lands."
            : "A session for this brand is queued at the engine. The engine works one at a time, so it refuses a second: answer once the queue clears."
      }
      onStarted={(run) => {
        setAccepted(run);
        onSettled();
      }}
    />
  );
}

/**
 * The strip in the drawer, in the tone the situation has earned.
 *
 * `ship` and `review` are what separate the two states an operator can act on, and the separation
 * is the point: a shipped blog carrying questions is green with an amber tag on it, and a blog
 * held below 95 is amber throughout. One reads as finished with a caveat, the other as stopped.
 * Both are the app's existing status tokens, so a strip never introduces a colour the status
 * badges do not already use for the same meaning.
 */
function Strip({
  tone,
  children,
}: {
  tone: "ship" | "review" | "fail" | "muted";
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-b px-4 py-3",
        tone === "ship" && "border-ship/25 bg-ship-bg",
        tone === "review" && "border-review/25 bg-review-bg",
        tone === "fail" && "border-fail/25 bg-fail-bg",
        tone === "muted" && "border-border bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

/**
 * Why the engine held this blog, in its own words from the terminal status.jsonl line.
 *
 * It renders INSIDE whichever strip is already on screen and never gets one of its own. The note
 * is the reason for an obligation, so it belongs beside either the button that discharges that
 * obligation or the sentence explaining that nothing does. Rendered on its own it became a box
 * that told a human to confirm something and named neither what nor how, which is the defect
 * this component exists to end.
 */
function ReviewNote({
  review,
  tone,
}: {
  review: ReviewHold | null;
  tone: "ship" | "review" | "fail" | "muted";
}) {
  if (review === null) {
    return null;
  }
  if (review.pending) {
    return <Skeleton className="mt-2 h-3 w-4/5" />;
  }
  const className = cn(
    "mt-1.5 text-xs leading-relaxed",
    tone === "ship" && "text-muted-foreground",
    tone === "review" && "text-review/90",
    tone === "fail" && "text-fail/90",
    tone === "muted" && "text-muted-foreground",
  );
  if (review.note === null) {
    // Honest about the gap rather than inventing a plausible reason for the hold.
    return <p className={className}>The run left no reason on its terminal status.jsonl line.</p>;
  }
  return (
    <p className={className}>
      <span className="font-medium">
        {tone === "ship"
          ? // A SHIPPED blog whose status still reads needs review is a real row on disk right
            // now: ramen scored 96 and was held anyway, under the old rule, for a Sourcing top-up
            // that had already resolved itself. The engine settles this on the next run and the
            // status is being corrected by hand, but until then the badge above says one thing and
            // this block says another, and an operator deserves to be told which is right rather
            // than left to guess. The score is right. The status is the artifact.
            "Its status on disk still reads needs review, which is the old rule and not this one. The run's own words for it: "
          : "The run's own reason for holding it: "}
      </span>
      {review.note}
    </p>
  );
}

/**
 * What the blog's score says about it, which is the whole of what is left once it is settled that
 * nothing is being asked of the operator.
 *
 * The house bar is 95, and the engine settles a run with nothing to ask on that number alone:
 * at or above it the blog is done, below it the loop exhausted itself and the run failed. So the
 * score is the fact to report here, and the status is not.
 */
function standingLine(blogScore: number | null): string {
  if (blogScore === null) {
    return "No eval recorded a score for it either, so status.jsonl and eval.md are all there is to read.";
  }
  if (blogScore >= 95) {
    return `It scored ${blogScore}, at or above the 95 bar, so the draft you are reading is one the evaluator passed.`;
  }
  return `It scored ${blogScore}, below the 95 bar, so the loop stopped without a draft the evaluator would pass.`;
}

/**
 * Held for review with nothing on disk to answer: the dead end this panel exists to end.
 *
 * needs_review means the run has a question for the operator and it means nothing else. A blog
 * holding none is summoning a person to an act it cannot name, and the honest response is to say
 * exactly that rather than to repeat the summons in a louder box. There is no form here because
 * there is nothing to put in one, and a button whose only outcome is a refusal would be theatre.
 *
 * The engine now corrects this state itself: runner.py settles a question-free needs_review to
 * done or failed on its score, so no new run can land here. Blogs written before that rule still
 * carry the old status, and the operator has several of them on disk right now, so this is a real
 * state to render rather than a defensive branch.
 */
function Held({ review, blogScore }: { review: ReviewHold; blogScore: number | null }) {
  return (
    <Strip tone="muted">
      <p className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Info className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        This blog is marked needs review and left no question for you
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Needs review means a run wanted something only a person can give, and a run asks by writing
        the question down. This one wrote none, so nothing here is waiting on you and there is
        nothing to send back. {standingLine(blogScore)}
      </p>
      <ReviewNote review={review} tone="muted" />
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        The draft is in the blog.md tab and the evaluator&apos;s verdict is in eval.md, and Copy
        markdown takes the draft as it stands. Posting to the CMS stays refused while the status
        reads needs review, because the engine posts only what it shipped.
      </p>
    </Strip>
  );
}

/**
 * The two states an operator can act on, as ONE block each, read top to bottom.
 *
 * THE ORDER IS THE FEATURE: reason, then the engine's evidence, then the questions themselves,
 * then the action. This drawer used to stack two amber boxes, one saying "this blog cannot ship
 * until you answer 2 questions" with the button, and under it one saying "a human has to confirm
 * something before this ships" with the engine's actual reason. They said the same thing in
 * different words, so an operator read both looking for the difference and found none, and the
 * genuinely useful sentence, the engine's note about how the loop exhausted itself, sat in the box
 * WITHOUT the button where it got skimmed past. One block, one read, nothing to compare.
 *
 * THE TWO STATES ARE THE SAME SHAPE AND OPPOSITE OBLIGATIONS, which is why they are one component
 * with the difference stated rather than two components free to drift:
 *
 *   below 95, with questions  BLOCKED. Amber throughout. The form is the only way out, and there
 *                             is no dismiss, because the evaluator is saying no rewrite closes
 *                             this.
 *   95 or above, questions    SHIPPED, and it says so, in the ship tone with an amber tag naming
 *                             the open questions. This blog is finished and its score is final.
 *                             The offer is an offer.
 *
 * Exactly 95 ships. That is the house rule the rest of the app already runs on, and an earlier
 * draft of this feature broke it by blocking there.
 */
function Open({
  brandSlug,
  topicSlug,
  questions,
  blogScore,
  mode,
  review,
  lockedReason,
  onStarted,
}: {
  brandSlug: string;
  topicSlug: string;
  questions: BlogQuestions;
  /** What the blog scores NOW. The score the questions carry is what it scored when asked. */
  blogScore: number | null;
  mode: Extract<QuestionsMode, "blocking" | "offer">;
  /** The engine's hold, rendered in this block because this block is where it gets discharged. */
  review: ReviewHold | null;
  /** Why the engine would refuse this submit right now, or null when it would take it. */
  lockedReason: string | null;
  onStarted: (run: RunSummary) => void;
}) {
  const blocking = mode === "blocking";
  const count = questions.questions.length;
  const noun = count === 1 ? "question" : "questions";
  // The disk's number first: a blog whose revise carried it from 92 to 96 is a shipped blog, and
  // the 92 the questions remember is not what it scores now.
  const score = blogScore ?? questions.score;
  const tone = blocking ? "review" : "ship";

  return (
    <Strip tone={tone}>
      {/* 1. THE REASON. The headline states the state, and the tag beside it is the caveat rather
             than a second headline: a shipped blog reads as shipped first. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <p
          className={cn(
            "flex items-center gap-2 text-xs font-medium",
            blocking ? "text-review" : "text-ship",
          )}
        >
          {blocking ? (
            <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <Check className="size-3.5 shrink-0" aria-hidden />
          )}
          {blocking
            ? `This blog cannot ship until you answer ${count === 1 ? "a question" : `${count} questions`}`
            : score === null
              ? "This blog has shipped and stays shipped"
              : `This blog shipped at ${score} and stays shipped`}
        </p>
        {blocking ? null : <OpenQuestionsTag count={count} />}
      </div>

      <p
        className={cn(
          "mt-1.5 text-xs leading-relaxed",
          blocking ? "text-review/90" : "text-muted-foreground",
        )}
      >
        {blocking ? (
          <>
            {/* No score is a state the engine holds on, not one it ships: an evaluator that asked
                and died before writing its scored line leaves the questions and no number, and
                the blog stays held. Naming a score that was never recorded would put an empty gap
                where the operator looks for the reason. */}
            {questions.score === null ? (
              <>
                No eval recorded a score for it, so it never reached the{" "}
                <span className="machine">95</span> bar,
              </>
            ) : (
              <>
                It scored <span className="machine">{questions.score}</span>, below the{" "}
                <span className="machine">95</span> bar,
              </>
            )}{" "}
            and the evaluator found something no amount of research settles: the answer is a fact
            only you hold. Answering starts a surgical revise of this draft. There is nothing to
            dismiss here and no proceed.
          </>
        ) : (
          <>
            <span className="machine">95</span> and above ships, questions or not, so this score is
            final and the {noun} below {count === 1 ? "is" : "are"} an offer you can decline
            forever. Answering lets the engine try to improve the draft, and the rerun keeps
            whichever draft scores higher, so it cannot cost you the score you already have.
          </>
        )}
      </p>

      {/* 2. THE EVIDENCE, above the questions and never below the button. It is the engine saying
             how the loop exhausted itself, which is what tells an operator their answer really is
             the only way forward rather than one option among several. */}
      <ReviewNote review={review} tone={tone} />

      {/* 3. THE QUESTIONS. What is actually being asked, before the button that answers it: an
             operator decides whether they are the person who can answer by reading the questions,
             not by reading a count of them. */}
      <QuestionList questions={questions.questions} tone={tone} />

      {/* 4. THE ACTION, last, because everything above it is what the press is based on. */}
      <div className="mt-3">
        <AnswerDialog
          brandSlug={brandSlug}
          topicSlug={topicSlug}
          questions={questions}
          blocking={blocking}
          lockedReason={lockedReason}
          onStarted={onStarted}
        />
      </div>
    </Strip>
  );
}

/**
 * The amber tag on a shipped blog: how many questions are open on something already finished.
 *
 * The operator asked for exactly this and named the colour: the blog "still ships with the Amber
 * tag". The tag is amber because a question is a question in either state, and it sits on a green
 * headline in a green block because this blog is done. That pairing is the whole message, and it
 * is the difference a blocked blog, amber throughout, reads as at a glance.
 */
function OpenQuestionsTag({ count }: { count: number }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded border border-review/25 bg-review-bg px-1.5 text-[0.6875rem] leading-none font-medium text-review">
      <MessageCircleQuestion className="size-3 shrink-0" aria-hidden />
      <span className="machine">{count}</span> open {count === 1 ? "question" : "questions"}
    </span>
  );
}

/**
 * The questions, in the block rather than only behind the button.
 *
 * The question TEXT and its Area, and deliberately not the why or the boxes to type in: the full
 * form is a dialog because the drawer's tabs own a fixed height and a form unfolding here would
 * push the article out from under its own scroll area. What belongs here is enough to decide
 * whether to open that form, which is what is being asked and who could answer it.
 *
 * questions.py caps an ask at five, so this list has a real bound and cannot swallow the drawer.
 */
function QuestionList({
  questions,
  tone,
}: {
  questions: BlogQuestion[];
  tone: "ship" | "review";
}) {
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {questions.map((item) => (
        <li key={item.id} className="flex items-baseline gap-2">
          <span className="machine inline-flex h-5 shrink-0 items-center rounded border border-border bg-background/60 px-1.5 text-[0.6875rem] leading-none text-muted-foreground">
            {item.area}
          </span>
          <span
            className={cn(
              "min-w-0 text-xs leading-relaxed text-pretty",
              tone === "review" ? "text-review/90" : "text-muted-foreground",
            )}
          >
            {item.question}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The form.
 *
 * A dialog, following the roadmap generation dialog: it takes typed input, it starts an engine
 * session, and it gets out of the way the instant the engine accepts, because the run then lives
 * in the engine and the strip behind this watches it.
 */
function AnswerDialog({
  brandSlug,
  topicSlug,
  questions,
  blocking,
  lockedReason,
  onStarted,
}: {
  brandSlug: string;
  topicSlug: string;
  questions: BlogQuestions;
  blocking: boolean;
  lockedReason: string | null;
  onStarted: (run: RunSummary) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  const answerOf = (id: string) => drafts[id] ?? "";
  // The engine 422s a blank answer and names the ids. Mirroring the rule here is what turns a
  // refusal into a disabled button with a sentence next to it, which is the difference between
  // being told before typing and being told after pressing.
  const blank = questions.questions.filter((item) => answerOf(item.id).trim() === "");
  const complete = blank.length === 0;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.answerQuestions(brandSlug, topicSlug, {
        answers: questions.questions.map((item) => ({
          id: item.id,
          answer: answerOf(item.id).trim(),
        })),
      });
      setOpen(false);
      setDrafts({});
      onStarted(run);
      toast.success("Answers filed, revise started", {
        description:
          "The engine is revising the existing draft with them. It keeps whichever draft scores higher.",
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          // The typed answers are KEPT. Closing a dialog is not the same act as discarding
          // paragraphs somebody wrote, and this one is closed by Escape and by a click on the
          // overlay. Only a successful submit clears them.
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant={blocking ? "default" : "outline"} className="shrink-0">
          Answer
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {blocking
              ? "Answer to unblock this blog"
              : "Answer to let the engine try to improve this blog"}
          </DialogTitle>
          <DialogDescription>
            {blocking ? (
              <>
                The evaluator scored this draft {questions.score} at iteration {questions.iter}{" "}
                and stopped on {questions.questions.length === 1 ? "this" : "these"}. There is no
                proceed here and nothing to dismiss: research cannot settle{" "}
                {questions.questions.length === 1 ? "it" : "them"}, so the draft waits on you.
              </>
            ) : (
              <>
                This blog scored {questions.score} and has already shipped. Answering is entirely
                optional, and the rerun keeps whichever draft scores higher, so pressing this
                cannot cost you the {questions.score} you already have.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          {questions.questions.map((item, position) => (
            <Question
              key={item.id}
              item={item}
              position={position + 1}
              value={answerOf(item.id)}
              onChange={(value) =>
                setDrafts((previous) => ({ ...previous, [item.id]: value }))
              }
            />
          ))}

          {/* What the press does, immediately above the button that does it. This is the last
              thing read before the click, which is the only place it can do its job. */}
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <p className="text-xs leading-relaxed text-foreground">
              This starts a surgical revise: the engine applies your answers and the outstanding
              fix list to the draft that already exists. The dossier is frozen, so nothing is
              researched again, and the article is not rewritten from scratch.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Gates and the link pass run, then a fresh evaluator scores the result.{" "}
              <span className="text-foreground">
                The higher scoring draft ships, so a worse revise cannot replace what you have.
              </span>{" "}
              An answer is guidance, ranking with the brand&apos;s canonical facts and above any
              internal doc. It is never a citation: a claim needing a source still needs a fetched
              one.
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              The run lives in the engine, not in this tab. Closing the browser does not stop it,
              and coming back re-attaches to it.
            </p>
          </div>

          {!complete ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Every question needs an answer: the engine refuses a blank one and names it.{" "}
              <span className="machine text-foreground">{blank.length}</span> of{" "}
              <span className="machine text-foreground">{questions.questions.length}</span> still
              empty. If you cannot answer one, say so in the box: that an answer is unavailable is
              itself an answer the writer can act on.
            </p>
          ) : null}

          {lockedReason !== null ? (
            <p className="text-xs leading-relaxed text-review">{lockedReason}</p>
          ) : null}

          {error ? <FieldError error={error} /> : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Close
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || !complete || lockedReason !== null}
            >
              {submitting ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : null}
              Send answers and rerun
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One question, its Area, and its why.
 *
 * The WHY is rendered in full and never behind a toggle. It is frequently the most informative
 * line on the screen: it is where the evaluator says what it suspects and what answering
 * changes, and it is how the operator decides whether they are even the person who can answer.
 * questions.py refuses to write a question without one for exactly this reason.
 */
function Question({
  item,
  position,
  value,
  onChange,
}: {
  item: BlogQuestion;
  position: number;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `answer-${item.id}`;
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-baseline gap-2">
        <span className="machine text-xs text-muted-foreground">{position}</span>
        <span className="machine inline-flex h-5 shrink-0 items-center rounded border border-border bg-muted px-1.5 text-[0.6875rem] leading-none text-muted-foreground">
          {item.area}
        </span>
      </div>
      <Label htmlFor={id} className="mt-2 block text-sm leading-relaxed font-medium text-pretty">
        {item.question}
      </Label>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Why it is being asked: </span>
        {item.why}
      </p>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        required
        placeholder="Answer in your own words. If you cannot answer, say that and say why."
        className="mt-2.5"
      />
    </div>
  );
}

/**
 * The questions were asked about a draft that no longer exists.
 *
 * This is REAL and not a hypothetical: blogs under outputs/ have a questions.json from iteration 1
 * sitting beside a blog that finished at iteration 2. The iteration-1 evaluator asked, the revise
 * fixed what it could, and the iteration-2 evaluator did not need to ask again, so the file on
 * disk describes a draft that has been replaced.
 *
 * There is NO submit here. The engine 409s it, and an answer about a superseded draft fed into a
 * revise of a live one is worse than no answer at all: it is confident, specific and about the
 * wrong text. Offering a button whose only outcome is a refusal would be theatre.
 *
 * WHAT CHANGED IS EVERYTHING AROUND THAT. This used to render under a strip demanding a human
 * confirm something, so the two together said: you must act, and you may not act. That is the
 * worst of both, and it was not even true. Nothing is being asked of the operator here. The
 * questions are historical, the blog's state comes from its score, and this says so instead of
 * presenting a superseded ask as a duty the operator has failed to meet.
 */
function Stale({
  questions,
  blogScore,
  review,
}: {
  questions: BlogQuestions;
  blogScore: number | null;
  review: ReviewHold | null;
}) {
  return (
    <Strip tone="muted">
      <p className="flex items-center gap-2 text-xs font-medium text-foreground">
        <MessageCircleQuestion className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        These questions are about an older draft of this blog
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        They were asked at iteration <span className="machine">{questions.iter}</span>
        {questions.score === null ? null : (
          <>
            , scoring <span className="machine">{questions.score}</span>
          </>
        )}
        , and the draft has been revised since. The text they describe is gone, so nothing here is
        waiting on you: a later evaluator read the draft that exists now and did not need to ask
        again. {standingLine(blogScore)}
      </p>
      {review !== null ? (
        // The legacy pairing, and the one the operator has on disk today. runner.py now settles a
        // needs_review whose only questions are stale, so a new run cannot reach this.
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          The status still reads needs review, and these questions are the only thing on disk that
          could explain it. They cannot: no answer to them applies to the draft you are reading, so
          there is no act being asked for and none to perform. The score is what this blog stands
          on.
        </p>
      ) : null}
      <ReviewNote review={review} tone="muted" />
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:underline">
          Read what it asked
        </summary>
        <ul className="mt-2 flex flex-col gap-2">
          {questions.questions.map((item) => (
            <li key={item.id} className="text-xs leading-relaxed text-muted-foreground">
              <span className="machine text-foreground">{item.area}</span>: {item.question}
            </li>
          ))}
        </ul>
      </details>
    </Strip>
  );
}

/**
 * Answered: the revise is either running or it has landed.
 *
 * NO BAR AND NO PERCENTAGE, as everywhere else in this app. A revise is an agent session running
 * an unknown number of iterations, so nothing on the wire could give a bar a denominator. The
 * elapsed clock is the honest number, and it is measured from the ENGINE's own timestamp.
 */
function Answered({
  questions,
  blogScore,
  record,
}: {
  questions: BlogQuestions;
  blogScore: number | null;
  /** The live run, or null once the engine stopped reporting one for this topic. */
  record: RunSummary | null;
}) {
  const now = useNow(record !== null);
  const clock =
    record === null
      ? null
      : clockOf({
          state: runStateOf(record),
          submittedAt: record.started,
          runningSince: record.started_running,
        });
  const elapsed = now === null || clock === null ? null : formatElapsed(clock.since, now);

  if (record !== null) {
    const queued = runStateOf(record) === "queued";
    return (
      <Strip tone="review">
        <p className="flex items-center gap-2 text-xs font-medium text-review">
          <Loader2
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          {queued
            ? "Your answers are filed and the rerun is queued"
            : "The engine is reworking this draft with your answers"}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-review/90">
          {queued
            ? "The engine works one session at a time across every brand, so this waits its turn. Nothing has run yet."
            : "It applies your answers and the outstanding fix list to the existing draft, then gates, the link pass, and a fresh evaluator. The higher scoring draft is the one that ships."}
          {elapsed !== null ? (
            <>
              {" "}
              <span className="machine">
                {clock?.measures === "waiting" ? `waiting ${elapsed}` : `${elapsed} elapsed`}
              </span>
              .
            </>
          ) : null}
        </p>
      </Strip>
    );
  }

  return (
    <Strip tone="muted">
      <p className="flex items-center gap-2 text-xs font-medium text-foreground">
        <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        You answered {questions.questions.length === 1 ? "this blog's question" : "this blog's questions"}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{outcomeLine(questions, blogScore)}</p>
      <p className="machine mt-1 text-xs text-muted-foreground">
        asked {formatAbsolute(questions.asked)}
      </p>
    </Strip>
  );
}

/**
 * What answering got them, in the engine's own numbers and no others.
 *
 * The comparison is between the score the questions were asked at and the score the disk reports
 * for this blog NOW. Both are the engine's, neither is remembered in this browser, so the
 * sentence reads the same after a refresh as it did the moment the run landed.
 *
 * The equal case is the honest one and it is stated rather than dressed up: the engine keeps
 * whichever draft scores higher, so a rerun that came back worse leaves the original shipping
 * and the number unmoved. That is the outcome an operator has to be able to trust, because it is
 * the entire reason pressing the button at 96 is safe.
 */
function outcomeLine(questions: BlogQuestions, blogScore: number | null): string {
  const asked = questions.score;
  if (blogScore === null || asked === null) {
    // Nothing to compare. Inventing a comparison out of one number is how a view starts lying.
    return "The rerun has finished. The score above is what this blog reports now, read from the disk.";
  }
  if (blogScore > asked) {
    return `The clarified draft scored ${blogScore} and is the one that ships, up from the ${asked} this blog scored when the questions were asked.`;
  }
  if (blogScore === asked) {
    return `The clarified draft did not beat ${asked}, so the original draft still ships and this blog still scores ${asked}. The engine keeps whichever draft scores higher, which is why the rerun could not cost you anything.`;
  }
  return `This blog now reports ${blogScore}, below the ${asked} it scored when the questions were asked. The engine ships whichever draft scored higher, so read eval.md for what the evaluator did with it.`;
}
