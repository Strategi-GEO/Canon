"use client";

import * as React from "react";
import { ChevronRight, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { formatCount, formatElapsed, formatRelative } from "@/lib/format";
import { useOrgs } from "@/lib/orgs-context";
import { useRuns } from "@/lib/runs-context";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/shell/status-badge";
import { ScoreTrail, StageMarks } from "@/components/create/topic-progress";
import { useNow } from "@/components/create/use-now";
import { topicKey, useQueueStreams, type TopicRun } from "@/components/create/use-run-stream";
import { isLive } from "@/lib/sessions";
import { titleFromSlug } from "@/lib/blog-label";

/** Where a topic sits. Derived from ITS OWN frames, never from the run that carries it. */
type Phase = "running" | "queued" | "finished";

/**
 * THE ENGINE'S OWN SLOT TABLE, POLLED, BECAUSE SSE CANNOT ANSWER "WHO IS RUNNING".
 *
 * useQueueStreams caps sockets at MAX_QUEUE_STREAMS (4, because browsers allow ~6 per origin over
 * HTTP/1.1 and the /api/runs poll must not be starved). GEO_CONCURRENCY is 5 here and may be set
 * higher, so the cap sits UNDER the number of blogs the engine will run at once, and a topic in an
 * unstreamed run has no frames for a reason that has nothing to do with the semaphore. Reading
 * that absence as "queued" is what made the header say "3 running" over an engine holding five
 * slots.
 *
 * GET /api/queue is the cure and needs no socket: it reports runner._SLOTS directly, so it knows
 * every holder whether or not this browser is listening to it. It is used ONLY to fill the gap.
 * Where frames exist they still win, because they carry the stage and the score this table renders
 * and the slot table carries neither.
 *
 * Same 4s cadence and the same hidden-tab rule as the runs poll, for the same reasons; the
 * endpoint reads process memory and touches no database. A failed read leaves the last answer
 * standing rather than blanking it: one dropped request is not the engine going idle.
 */
function useSlotKeys(): Set<string> {
  const [keys, setKeys] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    let inFlight = false;
    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      timer = window.setTimeout(poll, 4000);
    }
    function poll() {
      if (inFlight) return;
      inFlight = true;
      api.queue(controller.signal).then(
        (state) => {
          inFlight = false;
          if (controller.signal.aborted) return;
          setKeys(new Set(state.slots.map((slot) => topicKey(slot.client, slot.topic_slug))));
          schedule();
        },
        () => {
          inFlight = false;
          if (controller.signal.aborted) return;
          schedule();
        },
      );
    }
    function onVisible() {
      if (document.visibilityState === "visible") poll();
    }
    poll();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return keys;
}

/** One topic the engine is working on or owes work to. */
type QueueRow = {
  key: string;
  brandSlug: string;
  topicSlug: string;
  /**
   * Its row on the sheet the RUN WAS ACCEPTED AGAINST, one-based, which is the same number the
   * blogs table prints in its own "#". Null on a topic the run carries no index for.
   *
   * The run's own index is the right source HERE and is the wrong one elsewhere. seedsFor refuses
   * it and says why: an index means something only inside the sheet it came from, and the sheet on
   * screen is often not the sheet a run started from, so a number read across the two can point at
   * an unrelated topic. This table shows LIVE runs only, and a live run's sheet is the one it was
   * dispatched from moments ago. What it must never do is match a topic BY that index, which is
   * how seedsFor's defect worked; this only prints it beside a row already identified by slug.
   */
  label: number | null;
  phase: Phase;
  /** Its own stage feed, or null while it is still behind the semaphore. */
  run: TopicRun | null;
  /** When the operator submitted, for the waiting clock. */
  submitted: string;
  /** This brand's, so the operator can tell their own rows from the ones ahead of them. */
  mine: boolean;
};

/**
 * WHAT THE ENGINE IS ACTUALLY DOING, under the New tab's own table.
 *
 * EVERY BRAND, NOT JUST THIS ONE, and that is the point of the brand column. TOPIC_SEMAPHORE
 * admits GEO_CONCURRENCY blogs REPO-WIDE, so the reason a topic here is waiting is very often a
 * blog belonging to somebody else. A queue scoped to the brand whose page you happen to be on
 * would show two rows waiting and nothing to wait for, which is the exact question an operator
 * opens this table to answer.
 *
 * A ROW EXPANDS to the per-stage progress the watch view already draws. It is collapsed by
 * default because the useful glance is "what is in flight and how long has it been", and eight
 * expanded stage trails is a page of them.
 *
 * ONE CONTROL PER ROW, and it means two different things by design: a queued topic is WITHDRAWN,
 * which costs nothing and asks nothing, and a running one is CANCELLED, which throws away real
 * work and warns first. The engine decides which at the moment of the press (see api.stopTopic),
 * so this component never has to guess from a poll that may be a second stale; what it uses
 * `running` for is only whether to warn BEFORE asking.
 */
export function QueueTable({
  brandSlug,
  onChanged,
}: {
  /** The brand whose page this is, for the "yours" column and nothing else. */
  brandSlug: string;
  /** A topic left the queue: the caller re-reads its blogs and its roadmap. */
  onChanged: () => void;
}) {
  const { runs } = useRuns();
  const { orgs } = useOrgs();
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = React.useState<QueueRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  /** Brand slug to display name, so the column reads as a brand rather than as a key. */
  const brandNames = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const org of orgs ?? []) {
      for (const brand of org.brands ?? []) {
        map.set(brand.slug, brand.name);
      }
    }
    return map;
  }, [orgs]);

  /**
   * The live blog runs this table streams. Repurpose runs are excluded here for the same reason
   * their rows are: their topic slugs are synthetic and the per-topic stop route cannot reach
   * them, so a socket for one would buy frames nothing renders.
   */
  const liveRunIds = React.useMemo(
    () =>
      runs
        .filter((run) => run.kind !== "repurpose" && isLive(run))
        // This brand's first, so the cap inside useQueueStreams drops somebody else's run before
        // it drops the one the operator is standing in front of.
        .sort(
          (a, b) =>
            Number(b.client === brandSlug) - Number(a.client === brandSlug) ||
            a.started.localeCompare(b.started),
        )
        .map((run) => run.run_id),
    [runs, brandSlug],
  );
  const streamed = useQueueStreams(liveRunIds);
  const slotKeys = useSlotKeys();

  const rows = React.useMemo<QueueRow[]>(() => {
    const out: QueueRow[] = [];
    for (const run of runs) {
      // Repurpose runs take the same slot, so they genuinely are why a blog waits, and they are
      // still excluded: their topic_slug is synthetic ("<blog>/repurpose/<channel>"), they are
      // not blogs, and the per-topic stop route does not reach them. Showing a row whose only
      // control would 404 is worse than not showing it.
      if (run.kind === "repurpose" || !run.live) {
        continue;
      }
      for (const topic of run.topics) {
        const key = topicKey(run.client, topic.topic_slug);
        /**
         * THE PHASE COMES FROM THE TOPIC'S OWN FRAMES, and this is the fix.
         *
         * It used to read `runStateIsRunning(run)`, a RUN-level flag fanned onto every topic the
         * run carried, so ten topics under one running batch all read "Running" while five of
         * them were parked on the semaphore: the header said "10 running, 0 waiting" over an
         * engine holding exactly five slots. mark_running flips once, on the run's FIRST slot,
         * and runner.py says so itself.
         *
         * No entry means no status line, and a topic writes none until its session opens, which
         * happens only after `await TOPIC_SEMAPHORE.acquire()`. So absence IS queued.
         *
         * EXCEPT THAT ABSENCE HAS A SECOND CAUSE, AND `terminal` IS WHY IT MUST BE READ FIRST.
         * The rule above holds only while every live run owns a socket, and useQueueStreams caps
         * them at MAX_QUEUE_STREAMS. A topic in an unstreamed run therefore has no frames for a
         * reason that has nothing to do with the semaphore, and reading that as "queued" printed
         * `Queued, waiting 24m` over a topic that had FAILED twenty minutes earlier, counting up
         * forever. The same gap ran the other way on a stopped topic: its last delivered frame
         * said `revise/start`, the `stopped` frame never arrived, and the row advertised a live
         * write on a session the operator had already killed, under a stop button that then
         * reported "it never started" because the engine no longer held it.
         *
         * `terminal` is the cure because it is not inferred. runner.mark_topic_terminal sets it
         * the instant a topic's session settles, it rides the same /api/runs poll these rows are
         * already built from, and server/app.py's 409 guard and create-for-brand's own lock set
         * read it exactly this way. Deriving the phase from anything weaker is what let one topic
         * read Queued here and Not generated on the New tab at the same moment.
         */
        const streamedRun = streamed.get(key) ?? null;
        // Frames first where they exist, then the slot table, then absence. The order is the
        // whole of the fix: a stream carries the terminal line and the stage, so it outranks a
        // slot that has not been released yet; the slot table speaks only for the topics no
        // socket reached, which is exactly the set that used to read "Queued" while running.
        const phase: Phase =
          topic.terminal === true
            ? "finished"
            : streamedRun !== null
              ? streamedRun.status === "running"
                ? "running"
                : "finished"
              : slotKeys.has(key)
                ? "running"
                : "queued";
        out.push({
          key,
          brandSlug: run.client,
          topicSlug: topic.topic_slug,
          label: typeof topic.index === "number" ? topic.index + 1 : null,
          phase,
          run: streamedRun,
          submitted: run.started,
          mine: run.client === brandSlug,
        });
      }
    }
    /**
     * BY "#", ALWAYS, AND THE POINT IS THAT A ROW NEVER MOVES.
     *
     * This used to sort by phase, running first, then queued, then landed. Every topic therefore
     * JUMPED THE LENGTH OF THE TABLE the moment it took a slot, and again when it finished, so the
     * one list an operator watches rearranged itself under them precisely when something happened.
     * Sorting by the sheet's own number gives each topic a fixed home for the life of the run: the
     * stage cell changes in place, and nothing else moves.
     *
     * A topic with no number sorts last rather than as zero, which would put an unnumbered row
     * ahead of row one. Brand breaks ties, because two brands both have a "#1" and the numbers
     * would otherwise shuffle between polls; the slug settles it after that, so the order is total
     * and stable rather than left to the sort's own tie behaviour.
     */
    return out.sort(
      (a, b) =>
        (a.label ?? Number.MAX_SAFE_INTEGER) - (b.label ?? Number.MAX_SAFE_INTEGER) ||
        a.brandSlug.localeCompare(b.brandSlug) ||
        a.topicSlug.localeCompare(b.topicSlug),
    );
  }, [runs, brandSlug, streamed, slotKeys]);

  const running = rows.filter((row) => row.phase === "running").length;
  const queued = rows.filter((row) => row.phase === "queued").length;
  const finished = rows.filter((row) => row.phase === "finished").length;

  /**
   * ONE CLOCK, AND IT MEASURES THE OLDEST BLOG STILL RUNNING.
   *
   * There is no single run here to time. The queue is repo-wide and spans several runs whose
   * topics start at different moments, so a run-level elapsed would be a number about one of
   * them printed over all of them. The oldest running topic is the honest summary of "how long
   * has the engine been on this", it is the row an operator scans for anyway, and every row
   * carries its own clock beside it.
   */
  const oldestStart = rows.reduce<string | null>((acc, row) => {
    const at = row.phase === "running" ? row.run?.startedAt ?? null : null;
    return at !== null && (acc === null || at < acc) ? at : acc;
  }, null);
  // Ticks only while something is running: a settled queue's clock is a duration, not a timer.
  const now = useNow(running > 0);

  if (rows.length === 0) {
    return null;
  }

  async function stop(row: QueueRow) {
    setBusy(row.key);
    try {
      const result = await api.stopTopic(row.brandSlug, row.topicSlug);
      toast.success(
        result.stopped === "running" ? "Stopped the session" : "Removed from the queue",
        {
          description:
            result.stopped === "running"
              ? "Whatever it had written is on disk. It moves to Internal review if an evaluator scored a draft, and back to New if not."
              : "It never started, so nothing was spent. The topic is back on the New tab.",
        },
      );
      onChanged();
    } catch (cause) {
      // The engine's own words: "no live or queued run for this topic" is the useful sentence
      // when a row finished between the poll and the press, and a generic message would send the
      // operator looking for a fault that is really just a race they cannot lose.
      toast.error("Could not stop it", {
        description:
          cause instanceof ApiError
            ? cause.isOffline
              ? "Cannot reach the engine."
              : cause.message
            : String(cause),
      });
    } finally {
      setBusy(null);
      setPending(null);
    }
  }

  return (
    <div className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium text-foreground">Queue</h3>
        {/* THE LINE THE WATCH PANEL USED TO CARRY, now over the one queue that remains. Same
            three clauses and the same rule for them: a clause whose count is zero is omitted
            rather than printed as a zero, because "0 finished" is noise on a run that has only
            just started. The repo-wide qualifier stays, because it is the answer to the question
            this table exists for: the blog ahead of yours often belongs to another brand. */}
        <p className="machine text-xs text-muted-foreground">
          <span className="text-foreground">{formatCount(running)}</span> running
          {queued > 0 ? (
            <>
              , <span className="text-foreground">{formatCount(queued)}</span> queued
            </>
          ) : null}
          {finished > 0 ? (
            <>
              , <span className="text-foreground">{formatCount(finished)}</span> finished
            </>
          ) : null}{" "}
          of <span className="text-foreground">{formatCount(rows.length)}</span>, across every
          brand
          {oldestStart !== null && now !== null ? (
            <>
              {" "}
              <span aria-hidden>&middot;</span> {formatElapsed(oldestStart, now)} elapsed
            </>
          ) : null}
        </p>
      </div>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8" />
              {/* No sort control on it, because the table has exactly one order and this column
                  IS that order. An arrow here would offer to change something that cannot change. */}
              <TableHead className="machine w-12 text-xs font-medium text-muted-foreground">
                #
              </TableHead>
              <TableHead className="machine text-xs font-medium text-muted-foreground">
                Topic
              </TableHead>
              <TableHead className="machine w-44 text-xs font-medium text-muted-foreground">
                Brand
              </TableHead>
              {/* STAGE, NOT STATE. "Running" was the same word on every moving row and told an
                  operator nothing they could not already see from the spinner; which of the five
                  stages a blog is on is the fact they are actually watching for, and research
                  sitting still for minutes is the normal case they need to be able to read. */}
              <TableHead className="machine w-48 text-xs font-medium text-muted-foreground">
                Stage
              </TableHead>
              <TableHead className="machine w-32 text-xs font-medium text-muted-foreground">
                Since
              </TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Stop</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const expanded = open.has(row.key);
              return (
                <React.Fragment key={row.key}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() =>
                      setOpen((prev) => {
                        const next = new Set(prev);
                        if (!next.delete(row.key)) next.add(row.key);
                        return next;
                      })
                    }
                  >
                    <TableCell className="py-2.5">
                      <ChevronRight
                        className={cn(
                          "size-4 text-muted-foreground transition-transform",
                          expanded && "rotate-90",
                        )}
                        aria-hidden
                      />
                    </TableCell>
                    <TableCell className="machine py-2.5 text-xs text-muted-foreground">
                      {/* The same number the blogs table prints, so "blog 6" and "queue row 6"
                          are one topic. A dash where the run carries no index for the row. */}
                      {row.label ?? "-"}
                    </TableCell>
                    <TableCell className="max-w-0 py-2.5">
                      {/* THE TITLE, READ BACK OUT OF THE SLUG, because the run wire carries no
                          other. RunTopic is index, slug and offset; StatusEvent adds stage and
                          score and no title either; and this table spans BRANDS, so the one
                          listing that does know a title is the wrong brand's for most rows. A
                          de-hyphenated slug is the same fallback the channel review page uses and
                          it reads as the sentence the title was made from. Word case past the
                          first letter is deliberately left alone: the slug threw away which words
                          were capitalised, and title-casing them all asserts a title nobody
                          wrote. The slug itself is one hover away. */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="block cursor-default truncate text-sm text-foreground">
                            {titleFromSlug(row.topicSlug)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="machine">{row.topicSlug}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                    <TableCell className="py-2.5 text-xs text-muted-foreground">
                      {brandNames.get(row.brandSlug) ?? row.brandSlug}
                      {/* Named rather than merely ordered: a row from another brand is why yours
                          is waiting, and that is worth being able to see at a glance. */}
                      {row.mine ? null : (
                        <span className="ml-1.5 text-[0.6875rem] text-muted-foreground/70">
                          other brand
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <StageCell row={row} />
                    </TableCell>
                    <TableCell className="machine py-2.5 text-xs text-muted-foreground">
                      <RowClock row={row} now={now} />
                    </TableCell>
                    <TableCell
                      className="py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
                      {/* NOTHING TO STOP ON A TOPIC THAT HAS LANDED. The engine holds no slot and
                          no queue entry for it, so stop_topic answers 404, and a control whose
                          only outcome is an error is worse than no control. It could not be
                          hidden before this change, because every row claimed to be running. */}
                      {row.phase === "finished" ? null : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-8 text-muted-foreground hover:text-fail"
                                disabled={busy !== null}
                                onClick={() =>
                                  // A QUEUED TOPIC NEEDS NO CONFIRM. Nothing has been spent on it
                                  // and putting it back is one press, so a dialog would be a
                                  // question with only one sensible answer. A running one is the
                                  // opposite and always asks. This warning is only now correct:
                                  // it used to fire on genuinely queued rows, telling an operator
                                  // a costless withdrawal would throw away real work.
                                  row.phase === "running" ? setPending(row) : void stop(row)
                                }
                              >
                                {busy === row.key ? (
                                  <Loader2 className="animate-spin" aria-hidden />
                                ) : (
                                  <X aria-hidden />
                                )}
                                <span className="sr-only">
                                  {row.phase === "running" ? "Stop" : "Remove from the queue"}{" "}
                                  {row.topicSlug}
                                </span>
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {row.phase === "running"
                              ? "Stop this session"
                              : "Remove from the queue. It has not started, so nothing is lost."}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={7} className="bg-muted/30 py-3 whitespace-normal">
                        <QueueRowDetail row={row} now={now} />
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next && busy === null) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop this blog while it is being written?</AlertDialogTitle>
            {/* THE WARNING SAYS WHAT IS LOST AND WHAT IS NOT, because both halves change the
                decision. A session mid-research has produced nothing an operator can use; one
                that has finished an iteration has a scored draft that survives the stop. */}
            <AlertDialogDescription>
              A session is running on {pending?.topicSlug}. Stopping it now ends that session and
              spends nothing further. Whatever it already wrote stays on disk: if an evaluator has
              scored a draft, even the first iteration, the blog moves to Internal review, and if
              it has not, the topic goes back to New to be run again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={busy !== null}>
              Keep writing
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={(event) => {
                event.preventDefault();
                if (pending) void stop(pending);
              }}
            >
              {busy !== null ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : null}
              Stop it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/**
 * The stage the blog is actually on, in the column that used to say "Running" on every row.
 *
 * A queued topic has no stage, and saying "research" over one that has not started would be the
 * same class of lie the old State column told. It says what is true instead: it is waiting.
 */
function StageCell({ row }: { row: QueueRow }) {
  if (row.phase === "queued") {
    return <span className="text-xs text-muted-foreground">Queued</span>;
  }
  if (row.phase === "finished") {
    /**
     * NEVER GUESS WHICH TERMINAL. This defaulted to "done", which renders as "shipped", and the
     * default is reached exactly when the row has NO frames: a topic in a run past
     * MAX_QUEUE_STREAMS, or one whose terminal frame never arrived. So the rows least known to
     * this table were the ones it congratulated. A blog that failed at research with no score,
     * and one that ended failed at 87, both read "shipped" beside a queue that offered no way to
     * remove them, while the sheet above called the same blogs "Failed".
     *
     * `terminal` says THAT a topic settled and never WHICH way, so with no frames the honest word
     * is neither "shipped" nor "failed": it is finished, and the row's own page has the verdict.
     */
    if (row.run === null) {
      return <span className="text-xs text-muted-foreground">Finished</span>;
    }
    return <StatusBadge status={row.run.status} />;
  }
  const stage = row.run?.stage ?? null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
        <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        {/* Between a stage's end frame and the next stage's start frame nothing is open, which is
            why TopicRun holds `stage` separately from `segments`.

            NULL HAS TWO CAUSES AND THEY DESERVE DIFFERENT WORDS. With a stream attached, null
            means the session has opened and its first agent has not announced itself yet, which
            is genuinely "starting" and now lasts seconds rather than minutes: every agent writes
            its --event start line as its first action (see _agent_definitions). With NO stream,
            the row is here because /api/queue reports the engine holding a slot for it, and the
            slot table carries no stage, so "starting" would be a guess about a blog that may be
            an hour into its work. "running" is what is actually known. */}
        <span className="machine">{stage ?? (row.run === null ? "running" : "starting")}</span>
        {row.run !== null && row.run.iter > 1 ? (
          <span
            className="machine rounded border border-border bg-muted px-1 py-0.5 text-[0.625rem] leading-none text-muted-foreground"
            title={`Revise iteration ${row.run.iter} of a maximum 4`}
          >
            iter {row.run.iter}
          </span>
        ) : null}
      </span>
      {/* THE PROGRESS BAR THE OVERVIEW CARD USED TO CARRY, ON THE ROW ITSELF. It used to require
          expanding the row, so the one thing an operator opens this table to see was the one
          thing behind a click. Drawn only where frames exist: an unstreamed row knows the topic
          holds a slot and nothing about which of the five stages it is on, and five unlit
          segments over a working blog reads as a stall rather than as missing information. */}
      {row.run !== null ? <StageMarks topic={row.run} compact /> : null}
    </div>
  );
}

/**
 * THIS TOPIC'S OWN CLOCK, which is what the column always claimed to be showing.
 *
 * It used to render the RUN's `started_running`, the instant its FIRST topic took a slot, so a
 * topic still parked on the semaphore displayed a clock a sibling had started, and every row of
 * a ten-topic run read the same age. Three phases, three measurements, none of them borrowed.
 */
function RowClock({ row, now }: { row: QueueRow; now: Date | null }) {
  if (now === null) {
    // Pre-mount: elapsed must not render during SSR, and a fixed cell keeps the row from
    // resizing when it arrives.
    return <span className="inline-block h-4" aria-hidden />;
  }
  if (row.phase === "queued") {
    return <span>waiting {formatElapsed(row.submitted, now)}</span>;
  }
  const startedAt = row.run?.startedAt ?? null;
  if (startedAt === null) {
    return <span>{formatRelative(row.submitted)}</span>;
  }
  if (row.phase === "finished") {
    const endedAt = row.run?.endedAt ?? null;
    // Frozen at the terminal frame, so a landed blog reports the duration it actually took
    // rather than ticking upward forever after the work stopped.
    return <span>took {formatElapsed(startedAt, endedAt !== null ? new Date(endedAt) : now)}</span>;
  }
  return <span>{formatElapsed(startedAt, now)}</span>;
}

/**
 * What one expanded row shows: the progress the watch panel used to draw, per blog, here.
 *
 * THE OLD OBJECTION IS GONE AND THAT IS WHY THIS CAN EXIST. This used to be two sentences of
 * prose, refusing to draw the stage trail because "the watch view owns that stream, and opening
 * two subscriptions to the same run from two components is how a page ends up with two
 * disagreeing clocks". There is no watch view now: this table is the only subscriber, so there
 * is one stream, one clock, and one place a blog's progress is reported.
 *
 * A QUEUED TOPIC STILL HAS NO PROGRESS TO DRAW, and an empty five-stage trail over one would
 * read as a session that has stalled rather than one that has not begun.
 */
function QueueRowDetail({ row, now }: { row: QueueRow; now: Date | null }) {
  if (row.run === null) {
    // A running row with no frames is a slot the engine reported through /api/queue while this
    // browser had no socket left for its run. It IS spending quota, so it must not be offered the
    // queued row's "nothing has been spent on it" copy.
    if (row.phase === "running") {
      return (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Running. This browser is not streaming this run, so the stage trail is not available
          here; the engine reports the slot it holds. Open the blog to read its progress.
        </p>
      );
    }
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Waiting for a slot. The engine runs a fixed number of blogs at once across every brand, so
        this starts as soon as one ahead of it finishes. Nothing has been spent on it yet, and
        removing it from the queue costs nothing.
      </p>
    );
  }

  const topic = row.run;
  const settled = row.phase === "finished";
  const end = settled && topic.endedAt !== null ? new Date(topic.endedAt) : now;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="machine flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {/* The two clocks TopicProgress carries, for the reason it gives: total elapsed answers
              "how long has this blog taken", and the stage clock answers "is it stuck?", which
              total elapsed cannot, because research legitimately runs for minutes. */}
          {end !== null && topic.startedAt !== null ? (
            <>
              {!settled && topic.stage !== null && topic.stageSince !== null ? (
                <>
                  <span className="text-foreground">{topic.stage}</span>
                  <span>for {formatElapsed(topic.stageSince, end)}</span>
                  <span aria-hidden>&middot;</span>
                </>
              ) : null}
              <span>{formatElapsed(topic.startedAt, end)} total</span>
            </>
          ) : null}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {topic.iter > 1 ? (
            <span
              className="machine rounded border border-border bg-muted px-1.5 py-0.5 text-[0.6875rem] leading-none text-muted-foreground"
              title={`Revise iteration ${topic.iter} of a maximum 4`}
            >
              iter {topic.iter}
            </span>
          ) : null}
          <StatusBadge status={topic.status} />
        </div>
      </div>

      <div className="mt-3">
        <StageMarks topic={topic} />
      </div>

      <ScoreTrail topic={topic} />

      {topic.note ? (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{topic.note}</p>
      ) : null}
    </div>
  );
}
