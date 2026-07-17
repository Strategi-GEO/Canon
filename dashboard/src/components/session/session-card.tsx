"use client";

/**
 * NO PROGRESS BAR AND NO PERCENTAGE, here or anywhere in this product. The revise loop runs
 * 0 to 4 iterations, so there is no denominator and any bar would have to invent one. The
 * full argument sits at the top of create/topic-progress.tsx, which this card RENDERS rather
 * than restates: the Create tab and the Overview tab therefore describe one run in one
 * vocabulary, and a stage name means the same thing on both.
 *
 * What this adds over that view is compression. The Overview is not a run page: it carries a
 * description, a roadmap and stats, so a session cannot take the whole
 * screen. Collapsed, the card answers "is my batch OK?" in one line, which is the only
 * question the Overview owes an answer to. Everything else is one click away.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, Clock, Loader2, RotateCw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { errorLines } from "@/components/clients/engine-error";
import { TopicProgress } from "@/components/create/topic-progress";
import { useNow } from "@/components/create/use-now";
import { summarize } from "@/components/create/use-run-stream";
import { useLiveRun, type LiveRun } from "@/components/session/use-live-run";
import { StopSessionDialog } from "@/components/session/stop-session-dialog";
import { ApiError } from "@/lib/api";
import { formatElapsed } from "@/lib/format";
import { brandHref, useOrgs } from "@/lib/orgs-context";
import { clockOf, hasEnded, type Session } from "@/lib/sessions";
import { cn } from "@/lib/utils";
import type { RoadmapState } from "@/lib/use-roadmap";

/**
 * The live session for ONE brand, for that brand's Overview.
 *
 * The org and brand arrive as props and are never read from a context or the URL: the route
 * owns that, and a card that guesses its own brand is how an operator ends up watching the
 * wrong brand's run under this brand's name.
 */
export function SessionCard({
  orgSlug,
  brandSlug,
  roadmap,
}: {
  orgSlug: string;
  brandSlug: string;
  /**
   * The Overview's single roadmap read, passed down rather than fetched again. This page
   * already shipped the defect where two cards each fetched the same CSV and could disagree;
   * this card needs the rows only to put the operator's own topic titles on the run, which is
   * not worth a third GET.
   */
  roadmap: RoadmapState;
}) {
  const router = useRouter();
  const { findBrand } = useOrgs();
  const { run, stream, error, checking } = useLiveRun(brandSlug, roadmap);
  const { topics, reconnecting } = stream;

  // Either authority may say the session ended. The stream's closing frame usually wins, and
  // the run list is the backstop: this card used to believe the stream alone, so a missed frame
  // left it spinning a live clock over a session /api/runs already reported finished.
  //
  // A STOPPED session leans on the backstop entirely, and it is the case that proves the backstop
  // earns its place. The engine writes a terminal line for every topic that was in flight, so the
  // stream closes for those, and it writes nothing for a topic still behind the slots because
  // there was no session to interrupt. The stream therefore may never close at all on a stop, and
  // the run list is the only authority that knows the brand halted.
  const ended = stream.finished || (run !== null && hasEnded(run.state));
  // Ended and stopped are the same fact to a clock and different facts to a sentence. Nothing
  // below may print "finished" over a session a person cut short.
  const stopped = run?.state === "stopped";

  const [expanded, setExpanded] = React.useState(false);
  /**
   * Keyed by run id, not a boolean: dismissing a finished session must not also hide the next
   * one the operator starts, and they start one from the Create tab and come straight back.
   */
  const [dismissed, setDismissed] = React.useState<string | null>(null);
  const panelId = React.useId();

  // The clock stops when the run does: a finished session's elapsed is a duration, not a timer.
  const now = useNow(run !== null && !ended);

  const blogsHref = brandHref(orgSlug, brandSlug, "/blogs");
  const createHref = brandHref(orgSlug, brandSlug, "/create");

  if (checking) {
    // Nothing, not a skeleton. Most Overview loads have no live session, so a placeholder for
    // a card that usually never appears would be a flash of furniture on every page load.
    return null;
  }

  if (error !== null) {
    return <CheckFailed error={error} />;
  }

  // No live session: render nothing at all. The Overview has real content and the header
  // already carries Create blogs as its one accent action, so an idle "no session" card would
  // be a permanent empty box telling the operator a thing they can neither act on nor want.
  // The card's absence is the answer, and it is the same answer the header's button implies.
  if (run === null || dismissed === run.runId) {
    return null;
  }

  // The operator's own label for this brand, resolved from the hierarchy exactly as the queued
  // card resolves the brand ahead of it. The slug is the engine's key and it only reaches a
  // sentence if the hierarchy does not hold this brand at all, where a nicer name would be a
  // guess. It is needed on both cards below, so it is resolved once, above the split.
  const brandName = findBrand(brandSlug)?.brand.name ?? brandSlug;

  /**
   * A QUEUED session is a different fact and gets a different card. Everything below reads the
   * topic stream, and a queued session has no frames: it would render as a run whose every
   * blog is sitting idle, which is indistinguishable from a wedged one. Worse, the counts
   * below say "queued" about TOPICS waiting on a slot inside a running session, and reusing
   * them here would tell an operator whose session has not started that their blogs are
   * underway. The two states share nothing but the word, so they share no markup.
   */
  if (run.state === "queued") {
    return (
      <QueuedSession
        run={run}
        now={now}
        createHref={createHref}
        brandName={brandName}
        brandSlug={brandSlug}
      />
    );
  }

  const { shipped, review, failed, stopped: stoppedTopics, running, queued } = summarize(topics);
  // From `started_running`, NEVER from `started`. A session that waited ten minutes and then
  // ran for one has done one minute of work, and clockOf is the only thing that decides which
  // instant a state is entitled to measure from.
  const clock = clockOf(run);
  const elapsed = now === null || clock === null ? null : formatElapsed(clock.since, now);

  // One sentence, changing only when the run's state actually changes. The visible elapsed is
  // deliberately NOT in here: it ticks every second, and a live region carrying it would talk
  // over the operator forever rather than tell them the one thing that changed.
  const announcement = reconnecting
    ? "Reconnecting to the session feed. The run keeps going and no history is lost."
    : stopped
      ? // The kept count leads, because it is the answer to the question a stop raises. A screen
        // reader hearing "stopped" and nothing else has been told the scary half only.
        `Session stopped. ${shipped} shipped and kept. ${stoppedTopics} discarded. Nothing was deleted.`
      : ended
        ? `Session finished. ${shipped} shipped, ${review} in review, ${failed} failed.`
        : `Session running, ${topics.length} blogs. ${running} running, ${queued} queued, ${shipped} shipped, ${review} in review, ${failed} failed.`;

  return (
    <Card className="mt-4">
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="flex flex-wrap items-center gap-2 px-(--card-spacing)">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((open) => !open)}
          className="-mx-2 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
        >
          <span className="flex min-w-0 items-center gap-2">
            {ended ? null : (
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden
              />
            )}
            <span className="text-sm font-medium text-foreground">
              {stopped ? "Session stopped" : ended ? "Session finished" : "Session running"}
            </span>
            <span className="text-xs text-muted-foreground">
              <span className="machine text-foreground">{topics.length}</span>{" "}
              {topics.length === 1 ? "blog" : "blogs"}
            </span>
          </span>

          {/* Every count an operator needs to answer "is my batch OK?" without expanding, and
              they sum to the total: a topic is running, queued, or in exactly one terminal
              state. Breaking failures out of a single "finished" number is the point, because
              a batch with a dead blog in it is not OK and must not read as one. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {reconnecting ? (
              // A silently dead stream that still looks alive is the worst failure this card
              // has, so the drop is stated where the counts it froze are shown.
              <span className="flex items-center gap-1 text-review">
                <RotateCw
                  className="size-3 shrink-0 animate-spin motion-reduce:animate-none"
                  aria-hidden
                />
                reconnecting
              </span>
            ) : null}
            {ended ? null : (
              <>
                <Count value={running} label="running" />
                {queued > 0 ? <Count value={queued} label="queued" /> : null}
              </>
            )}
            <Count value={shipped} label="shipped" />
            {review > 0 ? <Count value={review} label="in review" tone="review" /> : null}
            {failed > 0 ? <Count value={failed} label="failed" tone="fail" /> : null}
            {/* NO TONE, so it stays neutral next to the two tinted counts. The tinted ones are
                the ones that want a human; a stop wants nobody, because the human already acted.
                It is counted rather than dropped so these still sum to the total, which is the
                promise stated above: a stopped topic counted nowhere would turn a run of five
                into a card reporting four. */}
            {stoppedTopics > 0 ? <Count value={stoppedTopics} label="stopped" /> : null}
          </span>

          <span className="ml-auto flex shrink-0 items-center gap-2">
            {elapsed !== null ? (
              <span className="machine text-xs text-muted-foreground">{elapsed} elapsed</span>
            ) : null}
            <ChevronDown
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden
            />
          </span>
        </button>

        {ended ? (
          <>
            {/* The obvious next step, stated once the work exists to act on. Outline, never
                the accent: the accent on this page is Create blogs and stays there. */}
            <Button variant="outline" size="sm" asChild>
              <Link href={blogsHref}>
                Read the blogs
                <ArrowRight aria-hidden data-icon="inline-end" />
              </Link>
            </Button>
            {/* Dismissable only once it is dead. A finished session is history, and history
                belongs to the Blogs tab; a live one is the whole reason this card exists, so
                hiding that would be hiding the thing the operator asked to watch. */}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss this finished session"
              onClick={() => setDismissed(run.runId)}
            >
              <X aria-hidden />
            </Button>
          </>
        ) : (
          <>
            {/* The full run view, which operators reported being unable to reach: it renders on
                the Create tab whenever a run is live and re-attaches on its own, so this is a
                route to it rather than a second copy of it. Outline, never the accent: the
                accent on this page is Create blogs and stays there. */}
            <Button variant="outline" size="sm" asChild>
              <Link href={createHref}>
                Open the run view
                <ArrowRight aria-hidden data-icon="inline-end" />
              </Link>
            </Button>
            {/* Only on a live session, which is the same rule dismiss follows in the other arm
                and the inverse of it: there is nothing to stop once the work is over, and a stop
                offered on a finished session could only ever be a press that did nothing.

                The counts come off the stream this card is already reading, so the dialog names
                real numbers rather than talking about blogs in the abstract. */}
            <StopSessionDialog
              brandName={brandName}
              brandSlug={brandSlug}
              kept={shipped + review + failed}
              discarded={running}
              neverStart={queued}
            />
          </>
        )}
      </div>

      <AlsoWaiting others={run.others} />

      {/* Hidden rather than unmounted so aria-controls always resolves to a real element.
          `hidden` takes it out of the flex flow too, so a collapsed card carries no ghost gap
          under its one line. */}
      <div id={panelId} hidden={!expanded}>
        {expanded ? (
          <div className="border-t border-border">
            <p className="px-(--card-spacing) pt-(--card-spacing) text-xs leading-relaxed text-muted-foreground">
              {stopped
                ? // The three groups a stop actually produces, in the operator's own order. It
                  // says the files are still there because that is the fact that makes the next
                  // Generate cheap, and nothing else on this card can tell them.
                  "You stopped this brand. Every blog that had already finished is kept, exactly as it was. Blogs that were in flight are marked stopped and never shipped, and nothing was deleted: their research and drafts are still on disk. Topics that had not started never started and cost nothing. Generate picks the brand back up."
                : ended
                  ? "Every topic here reached a terminal state. A blog in review left a question only you can answer, and it is held until you answer it whatever it scored. A blog shipped means its first eval scored 95 or above with nothing left to ask. A blog that failed scored below 95 with nothing to ask."
                  : "Queued topics are waiting on a free engine slot, shared across every brand, and each one starts the moment a slot frees rather than waiting for the rest of this session. Research is the long stage, so a topic sitting there with nothing to say is normal: the stage clock on each row is the number that says otherwise."}
            </p>
            {reconnecting ? (
              <p className="px-(--card-spacing) pt-2 text-xs leading-relaxed text-review">
                Reconnecting to the session feed. The run lives in the engine rather than in
                this tab, so it keeps going, and the engine replays every frame on reconnect.
              </p>
            ) : null}
            <ul className="mt-1 divide-y divide-border">
              {topics.map((topic) => (
                <TopicProgress
                  key={topic.topicSlug}
                  topic={topic}
                  now={now}
                  blogsHref={blogsHref}
                  // A topic the engine never reached wrote no line of its own, so this row is
                  // the only thing that can say what became of it.
                  runStopped={stopped}
                  // The Overview holds no roadmap selection to tick, so this lands the
                  // operator on the Create tab where the row is. See the report: the copy
                  // under that button promises a ticked row, which only the Create tab can
                  // honour today.
                  onRetry={() => router.push(createHref)}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * A session that has been accepted and has NOT started, because another brand's session holds
 * the engine's CLIENT_LOCK.
 *
 * This card exists to answer one question the brand-scoped view otherwise cannot: "why is
 * nothing happening?". The answer is never about this brand, it is about another one, so the
 * card names the brand that is running and how many sessions sit in front of this one. Without
 * that an operator reads an accepted session doing nothing for ten minutes as a broken engine,
 * and the engine is working perfectly.
 *
 * There is NO stage, NO topic row and NO count of running blogs here, because none of those
 * exist yet. The only honest number is how long this session has WAITED, which is measured
 * from submit time and named as waiting, never as elapsed and never as running.
 */
function QueuedSession({
  run,
  now,
  createHref,
  brandName,
  brandSlug,
}: {
  run: LiveRun;
  now: Date | null;
  createHref: string;
  /** Resolved by the card above, so both cards name this brand the same way. */
  brandName: string;
  brandSlug: string;
}) {
  const { findBrand } = useOrgs();

  const clock = clockOf(run);
  const waited = now === null || clock === null ? null : formatElapsed(clock.since, now);

  const runningAhead = run.ahead.find((session) => session.state === "running") ?? null;
  const queuedAhead = run.ahead.filter((session) => session.state === "queued").length;
  // Resolved to the operator's own name for the brand. The slug is the engine's key, and it
  // only appears if this brand is not in the hierarchy at all, where inventing a nicer name
  // would be a guess.
  const runningName =
    runningAhead === null
      ? null
      : (findBrand(runningAhead.clientSlug)?.brand.name ?? runningAhead.clientSlug);

  return (
    <Card className="mt-4">
      {/* The elapsed wait is deliberately outside this: it ticks every second, and a live
          region carrying it would recite the clock forever instead of announcing the one
          change that matters, which is this session starting. */}
      <p className="sr-only" aria-live="polite">
        {`Session queued, ${run.topicCount} ${run.topicCount === 1 ? "blog" : "blogs"}. Nothing in it has started. The engine runs one session at a time across every brand.`}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-(--card-spacing)">
        <span className="flex min-w-0 items-center gap-2">
          {/* Not a spinner. A spinner would say work is happening, and the entire point of
              this card is that none is. */}
          <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-sm font-medium text-foreground">Session queued</span>
          <span className="text-xs text-muted-foreground">
            <span className="machine text-foreground">{run.topicCount}</span>{" "}
            {run.topicCount === 1 ? "blog" : "blogs"}
          </span>
        </span>

        <span className="text-xs text-muted-foreground">Nothing in it has started</span>

        <span className="ml-auto flex shrink-0 items-center gap-2">
          {waited !== null ? (
            <span className="machine text-xs text-muted-foreground">waiting {waited}</span>
          ) : null}
          <Button variant="outline" size="sm" asChild>
            <Link href={createHref}>
              Open the run view
              <ArrowRight aria-hidden data-icon="inline-end" />
            </Link>
          </Button>
          {/* A queued session is the cheapest thing in this app to stop and the likeliest to be
              worth stopping: nothing has run, nothing has been spent, and it is usually here
              because the operator submitted it and then thought better of it. Every count the
              dialog names is known exactly, because a session that has not started has all of
              its topics in front of it and none behind. */}
          <StopSessionDialog
            brandName={brandName}
            brandSlug={brandSlug}
            kept={0}
            discarded={0}
            neverStart={run.topicCount}
          />
        </span>
      </div>

      <div className="border-t border-border">
        <p className="px-(--card-spacing) pt-(--card-spacing) text-xs leading-relaxed text-muted-foreground">
          {/* The mechanism only. WHO is ahead is Ahead's job, because it is often another
              brand, sometimes this same brand's earlier session, and occasionally nobody at
              all: a lead sentence that named any of those would be wrong in the other two
              cases. */}
          The engine runs one session at a time across every brand, so this session waits on
          the engine rather than on anything in this roadmap.{" "}
          <Ahead runningName={runningName} queuedAhead={queuedAhead} />
        </p>
        <AlsoWaiting others={run.others} />
      </div>
    </Card>
  );
}

/**
 * This brand's OTHER live sessions, named rather than silently dropped.
 *
 * The card shows one session. A brand with a second one waiting would otherwise have it appear
 * nowhere on its own Overview, and that second session is usually the one the operator just
 * submitted and came here to look for: its absence reads as a lost submit, so they submit
 * again and collect a 409. One line, because the queue in the header is where the full answer
 * lives and this only has to stop the Overview implying the session does not exist.
 */
function AlsoWaiting({ others }: { others: Session[] }) {
  if (others.length === 0) {
    return null;
  }

  return (
    <p className="mt-3 px-(--card-spacing) text-xs leading-relaxed text-muted-foreground">
      <span className="machine text-foreground">{others.length}</span>{" "}
      {others.length === 1 ? "more session for this brand is" : "more sessions for this brand are"}{" "}
      queued behind this one. The sessions control in the header lists every one of them, in the
      order the engine will work them.
    </p>
  );
}

/** What sits in front of this session, and therefore when it starts. */
function Ahead({
  runningName,
  queuedAhead,
}: {
  runningName: string | null;
  queuedAhead: number;
}) {
  if (runningName !== null && queuedAhead === 0) {
    return (
      <>
        <span className="text-foreground">{runningName}</span> is running now, and this session
        is next.
      </>
    );
  }

  if (runningName !== null) {
    return (
      <>
        <span className="text-foreground">{runningName}</span> is running now, and{" "}
        <span className="machine text-foreground">{queuedAhead}</span>{" "}
        {queuedAhead === 1 ? "other session was" : "other sessions were"} submitted before this
        one. This session starts when they finish.
      </>
    );
  }

  if (queuedAhead > 0) {
    return (
      <>
        <span className="machine text-foreground">{queuedAhead}</span>{" "}
        {queuedAhead === 1 ? "session was" : "sessions were"} submitted before this one. This
        session starts when {queuedAhead === 1 ? "it finishes" : "they finish"}.
      </>
    );
  }

  // Nothing ahead and still queued: the engine is between sessions, so this one is next. That
  // is the whole honest answer. Naming a brand here would mean inventing one, because the run
  // list says there is none.
  return <>Nothing is ahead of it, so the engine picks this session up next.</>;
}

/**
 * One count, and never colour alone: the word carries the same meaning the tint does, because
 * an operator who cannot separate amber from red still has to run a batch.
 *
 * Green is absent on purpose. `shipped` is the good number and it stays neutral, so the only
 * tinted counts are the two that want a human, and the eye goes straight to them.
 */
function Count({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone?: "review" | "fail";
}) {
  return (
    <span
      className={cn(
        "whitespace-nowrap",
        tone === "review" && "text-review",
        tone === "fail" && "text-fail",
      )}
    >
      <span className={cn("machine", tone === undefined && "text-foreground")}>{value}</span>{" "}
      {label}
    </span>
  );
}

/**
 * The engine did not answer, so this brand's session state is unknown.
 *
 * One quiet line, not a card: a failed check is not an emergency and the Overview has other
 * work to show. It must still be said, because rendering nothing here would claim this brand
 * has no session running when the truth is that nobody asked successfully. The engine's own
 * words come through untouched: "cannot reach" and "refused" send an operator to two
 * different places.
 */
function CheckFailed({ error }: { error: ApiError }) {
  return (
    <p className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-fail">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        {error.isOffline
          ? "Cannot reach the engine, so a live session for this brand would not show here."
          : "The engine refused the session check, so a live session for this brand would not show here."}
      </span>
      <span className="machine wrap-break-word">{errorLines(error).join(" ")}</span>
    </p>
  );
}
