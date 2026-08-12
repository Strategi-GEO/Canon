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
import { formatCount, formatRelative } from "@/lib/format";
import { useOrgs } from "@/lib/orgs-context";
import { useRuns } from "@/lib/runs-context";
import { cn } from "@/lib/utils";
import type { RunSummary } from "@/types";

/** One topic the engine is working on or owes work to. */
type QueueRow = {
  key: string;
  brandSlug: string;
  topicSlug: string;
  /** True once the engine reports the run running rather than queued. */
  running: boolean;
  /** When the operator submitted, for the waiting clock. */
  submitted: string;
  /** When the engine picked the run up, or null while queued. */
  startedRunning: string | null;
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
        out.push({
          key: `${run.client}/${topic.topic_slug}`,
          brandSlug: run.client,
          topicSlug: topic.topic_slug,
          running: runStateIsRunning(run),
          submitted: run.started,
          startedRunning: run.started_running ?? null,
          mine: run.client === brandSlug,
        });
      }
    }
    // Running first, then this brand's, then by submit time: what is moving matters most, and
    // among the rest an operator cares about their own before somebody else's.
    return out.sort(
      (a, b) =>
        Number(b.running) - Number(a.running) ||
        Number(b.mine) - Number(a.mine) ||
        a.submitted.localeCompare(b.submitted),
    );
  }, [runs, brandSlug]);

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

  const runningCount = rows.filter((row) => row.running).length;

  return (
    <div className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-sm font-medium text-foreground">Queue</h3>
        <p className="machine text-xs text-muted-foreground">
          {formatCount(runningCount)} running, {formatCount(rows.length - runningCount)} waiting,
          across every brand
        </p>
      </div>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8" />
              <TableHead className="machine text-xs font-medium text-muted-foreground">
                Topic
              </TableHead>
              <TableHead className="machine w-44 text-xs font-medium text-muted-foreground">
                Brand
              </TableHead>
              <TableHead className="machine w-28 text-xs font-medium text-muted-foreground">
                State
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
                    <TableCell className="max-w-0 py-2.5">
                      <span className="block truncate text-sm text-foreground">
                        {row.topicSlug}
                      </span>
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
                      {row.running ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                          <Loader2
                            className="size-3 animate-spin motion-reduce:animate-none"
                            aria-hidden
                          />
                          Running
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Queued</span>
                      )}
                    </TableCell>
                    <TableCell className="machine py-2.5 text-xs text-muted-foreground">
                      {formatRelative(row.startedRunning ?? row.submitted)}
                    </TableCell>
                    <TableCell
                      className="py-2.5"
                      onClick={(event) => event.stopPropagation()}
                    >
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
                                // opposite and always asks.
                                row.running ? setPending(row) : void stop(row)
                              }
                            >
                              {busy === row.key ? (
                                <Loader2 className="animate-spin" aria-hidden />
                              ) : (
                                <X aria-hidden />
                              )}
                              <span className="sr-only">
                                {row.running ? "Stop" : "Remove from the queue"} {row.topicSlug}
                              </span>
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {row.running
                            ? "Stop this session"
                            : "Remove from the queue. It has not started, so nothing is lost."}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-muted/30 py-3 whitespace-normal">
                        <QueueRowDetail row={row} />
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
 * What one expanded row shows.
 *
 * A QUEUED TOPIC HAS NO PROGRESS TO DRAW and saying so is the honest thing: it has not started,
 * so an empty stage trail would read as a session that has stalled. A running one gets the stage
 * feed, which arrives on the run's own SSE stream rather than from this table, so the detail is
 * deliberately thin here: the watch view owns that stream, and opening two subscriptions to the
 * same run from two components is how a page ends up with two disagreeing clocks.
 */
function QueueRowDetail({ row }: { row: QueueRow }) {
  if (!row.running) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Waiting for a slot. The engine runs a fixed number of blogs at once across every brand, so
        this starts as soon as one ahead of it finishes. Nothing has been spent on it yet, and
        removing it from the queue costs nothing.
      </p>
    );
  }
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      Running since{" "}
      <span className="machine">{formatRelative(row.startedRunning ?? row.submitted)}</span>. The
      engine writes each stage to this topic&apos;s own status feed as it happens, so you can leave
      this page and come back: nothing here is holding the run open.
    </p>
  );
}

/** The engine's own word for whether a run has been picked up, defaulting to queued. */
function runStateIsRunning(run: RunSummary): boolean {
  return run.state === "running";
}
