"use client";

/**
 * Still no progress bar and no percentage. See the note at the top of topic-progress.tsx:
 * the revise loop has no denominator, so a bar could only lie about how far along a run is.
 * This view answers "is it moving?" with counts and clocks instead, every one of which is a
 * fact the engine actually reported.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Clock, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TopicProgress } from "@/components/create/topic-progress";
import { useNow } from "@/components/create/use-now";
import { formatElapsed } from "@/lib/format";
import { ENGINE_SLOTS, clockOf, hasEnded } from "@/lib/sessions";
import { summarize, type StreamState } from "@/components/create/use-run-stream";
import type { FactsGenJob, RunState } from "@/types";

/**
 * The one clock this view shows, and the word for what it measures.
 *
 * "running" and "waiting" are the session clocks sessions.ts hands out. "building" is added
 * here and stays here: it measures the fact base job, which is not a session state, and pushing
 * it into sessions.ts would put a clock the run list knows nothing about into the file that
 * decides what the run list means.
 */
type Clock = { since: string; measures: "running" | "waiting" | "building" };

export function WatchState({
  runId,
  state,
  factsBuild,
  submittedAt,
  runningSince,
  stream,
  blogsHref,
  onBack,
  onRetry,
}: {
  runId: string;
  /**
   * Where the ENGINE says this run sits against CLIENT_LOCK. A run is queued from the instant
   * of POST until it takes that lock, and this view used to have no idea: it read `live` and
   * announced a run in progress over a session on which nothing had run.
   */
  state: RunState;
  /**
   * The canonical-facts.md build THIS run is waiting on, or null once its blogs are dispatched.
   * Resolved by factsBuildOf from the engine's own job record, so a settled build, or one
   * belonging to some other run, arrives here as null and this view says nothing about it.
   */
  factsBuild: FactsGenJob | null;
  /**
   * SUBMIT time, from the engine's own run record so elapsed survives a refresh intact. It
   * feeds the WAITING clock and nothing else: a queued run's `started` can be ten minutes old
   * with no work done, so measuring work from it is the lie this split exists to prevent.
   */
  submittedAt: string;
  /** When the engine took the lock and began. Null while queued. Feeds the RUNNING clock. */
  runningSince: string | null;
  /** Held by the parent, because the roadmap table reads the same frames to paint its rows. */
  stream: StreamState;
  /** This brand's blog library. The route owns every URL in this tree. */
  blogsHref: string;
  onBack: () => void;
  /** Sends a failed topic back to the roadmap, ticked, so retrying is one click. */
  onRetry: (topicSlug: string) => void;
}) {
  const { topics, reconnecting } = stream;

  const queued = state === "queued";
  // Either authority may say so first. The stream's closing frame usually wins, and the run
  // list is the backstop: a missed frame would otherwise leave this spinning a live clock over
  // a run the engine has already finished.
  //
  // On a STOPPED run the backstop is the only authority there is. A topic still behind the slots
  // when the stop landed had no session to interrupt, so the engine writes no terminal line for
  // it and this stream never closes: `state` is the one thing that knows the brand halted.
  const finished = stream.finished || hasEnded(state);
  // Ended and stopped are one fact to the clock and two different sentences. This view is the
  // one an operator opens to find out what happened, so it must never call a stop a finish.
  const stopped = state === "stopped";

  /**
   * The run's PHASE, and a run has exactly two. It is in "facts" while the engine writes this
   * brand's canonical-facts.md, and in "topics" from the moment blogs are dispatched. Nothing
   * here invents it: it is the engine's own job record, resolved against this run's id.
   *
   * It outranks `queued` deliberately. A build that is running is quota being spent on this run
   * right now, whatever the run's lock state says, and the queued copy below promises the exact
   * opposite: nothing started, nothing spent. Between two engine facts that disagree, the one
   * that never under reports a spend is the one an operator can act on.
   *
   * It carries the build's own `started` rather than a bare flag, because the phase and the
   * instant its clock measures from are one fact: split into two, they are two things that can
   * disagree, and the disagreement would be a clock running over a phase that ended.
   */
  const buildingSince = !finished && factsBuild !== null ? factsBuild.started : null;
  const building = buildingSince !== null;

  // The clock stops when the run does: a finished run's elapsed is a duration, not a timer.
  const now = useNow(!finished);

  /*
    The "Run finished" toast used to fire here and now fires from the notification log instead.

    It had to move because it could only ever speak from this component: the ref that armed it
    lives on a view that unmounts the moment the operator leaves the Create tab, so the one
    person it never reached was the one who walked away, which is the only person a toast about
    finishing is for. RunNotifier watches the run list above every route and cannot miss it.

    What that costs, stated plainly: this toast read its counts off the SSE stream and could say
    "3 shipped, 1 in review, 0 failed", and the run list carries topic slugs with no score and no
    status, so the notification says how many blogs the run held and links to the Blogs tab for
    what came of them. Keeping both would double-toast this exact screen. The clean way to have
    the counts back is server side: ledger.py already records run_id and score together, so
    list_runs could decorate each topic with them and the notification would carry the same
    sentence without a single new fetch in the browser.
  */

  // `queued` means two different things on this screen and they must never be confused: the
  // RUN is queued behind another brand's session, while a TOPIC is queued behind the engine's
  // five slots inside a running session. Renamed at the boundary so the distinction survives.
  const {
    shipped,
    review,
    failed,
    stopped: stoppedTopics,
    running,
    queued: queuedTopics,
  } = summarize(topics);
  /**
   * The one clock this view is entitled to, and the word that says what it measures.
   *
   * In the facts phase it measures the BUILD, because the build is the thing actually running:
   * the run's own clock would be counting a session whose blogs have not begun. Everywhere else
   * clockOf decides, from `started_running` while running and from `started` while queued, and
   * never the other way round. Every instant here is the engine's own, so a refresh twenty
   * minutes in still reads twenty minutes.
   */
  const clock: Clock | null =
    buildingSince !== null
      ? { since: buildingSince, measures: "building" }
      : clockOf({ state, submittedAt, runningSince });
  const elapsed = now === null || clock === null ? null : formatElapsed(clock.since, now);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {/* The facts phase gets its own heading rather than hiding under "Run in progress".
                An operator looking at a list of blogs where nothing is moving asks one question,
                and the heading is where they read the answer. */}
            {building
              ? "Building the fact base"
              : stopped
                ? "Run stopped"
                : queued
                  ? "Run queued"
                  : finished
                    ? "Run finished"
                    : "Run in progress"}
          </h2>
          <p className="machine mt-1 text-xs wrap-break-word text-muted-foreground">{runId}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Available while the run is live too. The run is in the engine, so leaving this
              view cannot touch it, and an operator who wants to queue more topics has to be
              able to get back to the roadmap without waiting for the slowest blog. */}
          <Button variant="outline" size="sm" onClick={onBack}>
            Back to the roadmap
          </Button>
          {finished ? (
            <Button size="sm" asChild>
              <Link href={blogsHref}>
                Read the blogs
                <ArrowRight aria-hidden data-icon="inline-end" />
              </Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link href={blogsHref}>Blogs</Link>
            </Button>
          )}
        </div>
      </div>

      <Card className="mb-4">
        <CardContent className="text-xs leading-relaxed text-muted-foreground">
          {building ? (
            <>
              <p>
                This brand had no <span className="machine">canonical-facts.md</span>, so the
                engine is writing one before it writes a blog. No topic in this run has started:
                no research, no draft, no eval. The list below is what the run holds, waiting.
              </p>
              <p className="mt-2">
                Every blog in this run is written and audited against that file, which is why it
                comes first rather than alongside. It is one agent session reading this brand&apos;s
                resources and its live site, so there is no way to say how far along it is: the
                clock is the only honest number here.
              </p>
              <p className="mt-2">
                The build lives in the engine, not in this tab. Leaving the page or closing the
                browser does not stop it, and coming back re-attaches to it. The topics start on
                their own the moment the file lands.
              </p>
            </>
          ) : stopped ? (
            // Ahead of `queued` and ahead of `finished`, because a run can be stopped from
            // either state and the stop is the newer fact both times. It is the last thing that
            // happened to this run, so it is the first thing this card says about it.
            <>
              <p>
                You stopped this brand, so the engine let this run go. Every blog that had already
                finished is kept exactly as it was, on disk and in the ledger. Blogs that were in
                flight are marked stopped and never shipped.
              </p>
              <p className="mt-2">
                Nothing was deleted. Whatever each stopped topic had researched or drafted is
                still on disk, so generating it again picks that work up rather than starting from
                nothing. Topics that had not begun never began, and they cost nothing.
              </p>
              <p className="mt-2">
                The brand is halted rather than paused: there is no resume. Back to the roadmap,
                tick what you want, and Generate starts a fresh run for those topics.
              </p>
            </>
          ) : queued ? (
            <>
              <p>
                The engine runs one session at a time across every brand, so this run waits on
                whichever session holds the engine now. Nothing in it has started: no research,
                no draft, no eval, and no credits spent.
              </p>
              <p className="mt-2">
                It starts on its own the moment the session ahead of it finishes, and this page
                picks it up from there. The sessions control in the header lists every session
                the engine is holding, in the order it will work them.
              </p>
            </>
          ) : finished ? (
            <p>
              Every topic in this run has reached a terminal state. A blog in review left a
              question only you can answer, and it waits for that answer at any score: the question
              is about something the evaluator could not see, so a passing number does not settle
              it. A blog that shipped scored <span className="machine">95</span> or above on its
              first eval with nothing left to ask. A blog that failed scored below{" "}
              <span className="machine">95</span> with nothing to ask, so there is no task here for
              a person.
            </p>
          ) : (
            <>
              <p>
                Research is the long stage. A topic can sit on{" "}
                <span className="machine">research</span> for minutes with nothing to say, and
                that silence is normal, not a stall. Each topic carries how long its current
                stage has been running, which is the number that tells you otherwise.
              </p>
              <p className="mt-2">
                The engine runs <span className="machine">{ENGINE_SLOTS}</span>{" "}
                topics at a time across every brand, so a queued topic here can also be waiting
                on another brand&apos;s run. Each one starts the instant a slot frees rather
                than waiting for the rest of this run.
              </p>
              <p className="mt-2">
                This run lives in the engine, not in this tab. Leaving the page or closing the
                browser does not stop it, and coming back re-attaches to it.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {/* One live region for the whole run, so a screen reader hears the state change rather
            than each of twelve topics announcing itself over the top of the others.

            The elapsed timer sits OUTSIDE the region on purpose. A value that ticks every
            second inside aria-live re-announces the entire region every second, so the reader
            turns into a metronome and the change that actually mattered, a topic reaching
            eval or failing, is buried under a recital of the clock. Sighted operators lose
            nothing: the timer is still right next to the sentence. */}
        <span aria-live="polite" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {building ? (
            // Not a count of running blogs, because none is running. What is true is that the
            // fact base is being written and how many blogs are behind it.
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              <span>
                Writing the fact base. No blog has started, and{" "}
                <span className="machine text-foreground">{topics.length}</span>{" "}
                {topics.length === 1 ? "blog is" : "blogs are"} waiting on it.
              </span>
            </span>
          ) : stopped ? (
            // The kept count leads. "N stopped" alone is the half of a stop that alarms, and the
            // half that answers it is the one number this line can state as fact.
            <span className="text-muted-foreground">
              <span className="machine text-foreground">{shipped}</span> shipped and kept,{" "}
              <span className="machine text-foreground">{stoppedTopics}</span> stopped,{" "}
              <span className="machine text-foreground">{review}</span> in review. Nothing was
              deleted.
            </span>
          ) : queued ? (
            // Not a spinner and not a count of running blogs. Nothing is running, so the only
            // honest statement here is that the run is waiting and how many blogs are in it.
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Clock className="size-3 shrink-0" aria-hidden />
              <span>
                Waiting on the engine. Nothing in this run has started, and it holds{" "}
                <span className="machine text-foreground">{topics.length}</span>{" "}
                {topics.length === 1 ? "blog" : "blogs"}.
              </span>
            </span>
          ) : reconnecting ? (
            // A silently dead stream that still looks alive is the worst failure this view has,
            // so the drop is stated plainly, along with the fact that it costs the run nothing.
            <span className="flex items-center gap-1.5 text-review">
              <RotateCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              Reconnecting to the run feed. The run itself keeps going, and no history is lost.
            </span>
          ) : !finished ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden />
              <span>
                <span className="machine text-foreground">{running}</span> running
                {queuedTopics > 0 ? (
                  <>
                    , <span className="machine text-foreground">{queuedTopics}</span> queued
                  </>
                ) : null}
                {shipped + review + failed > 0 ? (
                  <>
                    , <span className="machine text-foreground">{shipped + review + failed}</span>{" "}
                    finished
                  </>
                ) : null}{" "}
                of <span className="machine text-foreground">{topics.length}</span>
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              <span className="machine text-foreground">{shipped}</span> shipped,{" "}
              <span className="machine text-foreground">{review}</span> in review,{" "}
              <span className="machine text-foreground">{failed}</span> failed
            </span>
          )}
        </span>
        {/* Three different questions, so three different words. A queued run has run for
            nothing and waited for however long, and it must never carry an "elapsed" that an
            operator reads as work done; a run building its fact base has done neither. */}
        {elapsed !== null && clock !== null ? (
          <span className="machine text-muted-foreground">{clockLine(clock.measures, elapsed)}</span>
        ) : null}
      </div>

      {finished && failed > 0 ? (
        <Card className="mb-4 border-fail/25 bg-fail-bg">
          <CardContent className="flex items-start gap-1.5 py-3">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-fail" aria-hidden />
            <p className="text-xs leading-relaxed text-fail">
              <span className="machine">{failed}</span>{" "}
              {failed === 1 ? "topic" : "topics"} failed. Each one carries the engine&apos;s own
              reason below and a retry that puts it back on the roadmap ready to resubmit.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-border">
          {topics.map((topic) =>
            // A queued run, and a run still building its fact base, get NAMES ONLY.
            // TopicProgress renders five stage marks, a status badge and a stage clock, and
            // every one of them would be describing work that has not begun: its badge falls
            // back to "running" for a topic with no frames, and its queued line promises the
            // topic starts as a slot frees, which in the facts phase is the wrong reason for
            // the wait. What is true is which blogs the run holds, so that is what this lists.
            queued || building ? (
              <li key={topic.topicSlug} className="px-4 py-3">
                <p className="text-sm leading-snug font-medium text-foreground">{topic.label}</p>
                <p className="machine mt-0.5 text-xs text-muted-foreground">{topic.topicSlug}</p>
              </li>
            ) : (
              <TopicProgress
                key={topic.topicSlug}
                topic={topic}
                now={now}
                blogsHref={blogsHref}
                onRetry={onRetry}
                // The engine writes no terminal line for a topic that never reached a slot, so
                // the run's own state is all this row has to go on.
                runStopped={stopped}
              />
            ),
          )}
        </ul>
      </Card>
    </div>
  );
}

/**
 * The clock, said in the words of whatever it is measuring.
 *
 * One elapsed value means three different things on this screen, and the number alone cannot
 * tell them apart: eight minutes of work, eight minutes waiting on another brand's session, and
 * eight minutes building a fact base are three different answers to "how is my run going". The
 * word carries the difference, so it is never optional.
 */
function clockLine(measures: Clock["measures"], elapsed: string): string {
  if (measures === "waiting") {
    return `waiting ${elapsed}`;
  }
  if (measures === "building") {
    return `building for ${elapsed}`;
  }
  return `${elapsed} elapsed`;
}
