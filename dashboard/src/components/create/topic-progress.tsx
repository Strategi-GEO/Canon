"use client";

/**
 * NO PROGRESS BAR AND NO PERCENTAGE LIVES HERE, OR ANYWHERE IN THIS PRODUCT.
 *
 * The revise loop runs 0 to 4 iterations, so there is no denominator: a blog that ships on
 * the first eval and one that grinds through four revises are both "one topic". Any bar or
 * percentage would have to invent the total, and it would read as a promise about time that
 * the engine never made. What is honest is what the engine actually reports: which of the
 * five stages is running, how long it has been running, the score trail so far, and the note.
 * That is what this renders.
 *
 * The five segment marks below are NOT a progress bar. They are the five named stages, each
 * pending, active or done, and the revise loop resets them: a topic on iteration 3 genuinely
 * shows write, gates, links and eval pending again, because they are about to run again. A
 * bar would have to pretend that going backwards was progress forwards.
 */

import Link from "next/link";
import { ArrowRight, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shell/status-badge";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format";
import { SEGMENTS, type TopicRun } from "@/components/create/use-run-stream";
import type { RunStatus } from "@/types";

export function TopicProgress({
  topic,
  now,
  blogsHref,
  onRetry,
  runStopped = false,
}: {
  topic: TopicRun;
  /** The shared clock. Null until mounted, so elapsed never renders during SSR. */
  now: Date | null;
  /** This brand's blog library, for the obvious next step once a topic lands. */
  blogsHref: string;
  /** Puts a failed or stopped topic back on the roadmap, ticked and ready to resubmit. */
  onRetry: (topicSlug: string) => void;
  /**
   * True once the operator has stopped this run, and it exists for the topics that never got a
   * frame. The engine writes a terminal stopped line for every topic that was actually in
   * flight, and it writes NOTHING for one still behind the slots: there was no session to
   * interrupt, so there is no line to append. Those topics would otherwise sit here forever
   * wearing the "running" badge this row falls back to before a first frame, over a brand the
   * engine let go of minutes ago. The run's own state is the only thing that knows, and it lives
   * a level up, so it arrives as a prop.
   */
  runStopped?: boolean;
}) {
  const settled = topic.status !== "running";
  // A topic with no frames has no status of its own, so the run's state is the only honest
  // answer available for it.
  const neverStarted = runStopped && !topic.started;

  return (
    <li className="px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <p className="text-sm leading-snug font-medium text-foreground">
            {/* Leads the title on a live run for the same reason it leads it in the library: a
                queue of five is watched by someone who says "six is still going". A topic on no
                row of the sheet on screen simply has no number to lead with. */}
            {topic.roadmapIndex !== null ? (
              <span className="machine mr-1.5 font-normal text-muted-foreground">
                {topic.roadmapIndex + 1}.
              </span>
            ) : null}
            {topic.label}
          </p>
          <p className="machine mt-0.5 text-xs text-muted-foreground">{topic.topicSlug}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {topic.iter > 1 ? (
            <span
              className="machine rounded border border-border bg-muted px-1.5 py-0.5 text-[0.6875rem] leading-none text-muted-foreground"
              // iter 3 means two evals came back under 95. Spelling that out beats a number
              // the operator has to decode.
              title={`Revise iteration ${topic.iter} of a maximum 4`}
            >
              iter {topic.iter}
            </span>
          ) : null}
          <StatusBadge
            status={topic.started ? topic.status : neverStarted ? "stopped" : "running"}
          />
        </div>
      </div>

      <TopicClock topic={topic} now={now} />

      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {SEGMENTS.map((segment) => {
          const state = topic.segments[segment];
          return (
            <div key={segment}>
              <div
                className={cn(
                  "h-1.5 rounded-full",
                  state === "done" && "bg-primary",
                  // The active stage breathes rather than crawls: it says "working", not
                  // "this far along". Reduced motion drops it to a flat tint.
                  state === "active" && "animate-pulse bg-primary/45 motion-reduce:animate-none",
                  state === "pending" && "bg-border",
                )}
              />
              <p
                className={cn(
                  "machine mt-1 text-[0.625rem] leading-none",
                  state === "pending" ? "text-muted-foreground/60" : "text-muted-foreground",
                )}
              >
                {segment}
              </p>
            </div>
          );
        })}
      </div>

      <ScoreTrail topic={topic} />

      {topic.note ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{topic.note}</p>
      ) : neverStarted ? (
        // Never "queued": there is nothing left to wait for. Naming the spend is the point,
        // because it is the reassuring half of a stop and the operator cannot see it anywhere
        // else: a topic that never reached a slot cost nothing at all.
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Never started. You stopped this brand before this topic reached a slot, so nothing was
          researched, written or spent on it.
        </p>
      ) : !topic.started ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Queued. This topic starts the moment a slot frees.
        </p>
      ) : null}

      {/* A topic that never started has nothing to read and nothing to retry: retry means
          resubmitting one row, and the way to restart a brand that was stopped whole is Generate,
          which is where the roadmap already sends them. */}
      {settled && topic.started ? (
        <TerminalActions topic={topic} blogsHref={blogsHref} onRetry={onRetry} />
      ) : null}
    </li>
  );
}

/**
 * The elapsed line: the one honest number on a screen that must never show a percentage.
 *
 * Two clocks, because they answer two different questions. Total elapsed answers "how long
 * has this blog taken". The stage clock answers "is it stuck?", which total elapsed cannot:
 * research legitimately runs for minutes, so ten minutes total says nothing on its own, while
 * ten minutes on `gates` says something is wrong.
 */
function TopicClock({ topic, now }: { topic: TopicRun; now: Date | null }) {
  if (!topic.started || topic.startedAt === null) {
    return null;
  }

  const settled = topic.status !== "running";
  // A finished topic measures to its terminal frame, so its elapsed freezes at the real
  // duration instead of ticking upward forever after the work stopped.
  const end = settled && topic.endedAt !== null ? new Date(topic.endedAt) : now;
  if (end === null) {
    // Pre-mount only. A fixed height holds the space so the clock's arrival does not shove
    // the segments and the score trail down the page.
    return <div className="mt-1.5 h-4" aria-hidden />;
  }

  const total = formatElapsed(topic.startedAt, end);

  return (
    <p className="machine mt-1.5 flex h-4 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      {settled ? (
        // "stopped after" used to be this row's word for a FAILURE, back when nothing else could
        // stop a topic. A real stopped status makes that word a collision and the collision is
        // the worse of the two readings: it would tell an operator the engine halted a blog they
        // halted themselves, and it would say the same thing about one that genuinely broke.
        // Three states, three verbs, and none of them borrowed.
        <span>
          {topic.status === "failed"
            ? "failed after"
            : topic.status === "stopped"
              ? "stopped after"
              : "took"}{" "}
          {total}
        </span>
      ) : (
        <>
          {topic.stage !== null && topic.stageSince !== null ? (
            <>
              <span className="text-foreground">{topic.stage}</span>
              <span>for {formatElapsed(topic.stageSince, end)}</span>
              <span aria-hidden>&middot;</span>
            </>
          ) : null}
          <span>{total} total</span>
        </>
      )}
    </p>
  );
}

/**
 * What to do about a topic that has landed.
 *
 * A finished blog with no next step is a dead end: the operator has to remember where blogs
 * live and go find it. A failed one with no retry is worse, because retrying is the entire
 * reason a failure is worth showing at all.
 */
function TerminalActions({
  topic,
  blogsHref,
  onRetry,
}: {
  topic: TopicRun;
  blogsHref: string;
  onRetry: (topicSlug: string) => void;
}) {
  if (topic.status === "failed") {
    return (
      <div className="mt-2.5">
        <Button variant="outline" size="sm" onClick={() => onRetry(topic.topicSlug)}>
          <RotateCw aria-hidden data-icon="inline-start" />
          Retry this topic
        </Button>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Retry returns to the roadmap with this row ticked. The note above is the engine&apos;s
          own reason it stopped.
        </p>
      </div>
    );
  }

  /**
   * A stopped topic takes the same door as a failed one and NOT the same words.
   *
   * Without an arm of its own it fell through to "Review it", which links to a library where
   * this blog is not: the evaluator never scored it, so there is nothing to review and the
   * button would be a dead end. The action is right and the framing is not. Nothing went wrong
   * here, and the sentence that matters is the one about the work still being on disk, because
   * an operator who believes a stop threw away twenty minutes of research will not press Stop
   * again, and will sit and watch a batch they have already decided against.
   */
  if (topic.status === "stopped") {
    return (
      <div className="mt-2.5">
        <Button variant="outline" size="sm" onClick={() => onRetry(topic.topicSlug)}>
          <RotateCw aria-hidden data-icon="inline-start" />
          Pick this topic back up
        </Button>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          You stopped this brand while this blog was in flight, so it never shipped. Nothing was
          deleted: whatever it had researched or drafted is still on disk, and this returns to the
          roadmap with the row ticked.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2.5">
      <Button variant="outline" size="sm" asChild>
        {/* The library, not a deep link: there is no per-blog route to point at, and a link
            that resolved to nothing would be worse than one that lands the operator where the
            blog demonstrably is. */}
        <Link href={blogsHref}>
          {topic.status === "done" ? "Read it" : "Review it"}
          <ArrowRight aria-hidden data-icon="inline-end" />
        </Link>
      </Button>
    </div>
  );
}

/**
 * The final chip is coloured by the SCORE BAND, not by the status word: 95+ passes (accent),
 * 90-94 is close (amber), below 90 is a miss (red). Keying on the number is what makes a failed
 * 92 read amber instead of red, matching the house score bands everywhere else a score is shown.
 *
 * The stopped arm is explicit and comes FIRST, and it is the one arm no compiler would have
 * caught: a stopped topic scored what it scored and then a person stopped the run, which is not
 * a verdict, so its number wears no verdict colour whatever the band would say.
 */
function settledChipClass(status: RunStatus, score: number): string {
  if (status === "stopped") {
    return "border-muted-foreground/40 bg-muted text-muted-foreground";
  }
  if (score >= 95) {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  if (score >= 90) {
    return "border-review/25 bg-review-bg text-review";
  }
  return "border-fail/25 bg-fail-bg text-fail";
}

/**
 * The score trail is the signature of this product: 88 -> 92 -> 96 is a blog earning its way
 * past the bar, and 88 -> 89 is a different problem entirely from a blog that never started.
 *
 * Rendered with the arrow glyph, never a dash of any kind, per house style.
 */
function ScoreTrail({ topic }: { topic: TopicRun }) {
  const entries = [...topic.scores.entries()].sort((a, b) => a[0] - b[0]);

  if (entries.length === 0) {
    return null;
  }

  const settled = topic.status !== "running";

  return (
    <ol
      className="mt-3 flex flex-wrap items-center gap-1"
      // Read out as one value, because the trail only means anything as a sequence: a screen
      // reader hearing three separate list items loses the fact that the score climbed.
      aria-label={`Score trail: ${entries.map(([, score]) => score).join(" then ")}`}
    >
      {entries.map(([iter, score], i) => {
        const last = i === entries.length - 1;
        return (
          <li key={iter} className="flex items-center gap-1">
            {i > 0 ? (
              <span className="machine text-xs text-muted-foreground" aria-hidden>
                →
              </span>
            ) : null}
            <span
              className={cn(
                "machine rounded border px-1.5 py-0.5 text-xs leading-none font-medium",
                last && settled
                  ? settledChipClass(topic.status, score)
                  : "border-border bg-muted text-muted-foreground",
              )}
              title={`Iteration ${iter} scored ${score}`}
            >
              {score}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
