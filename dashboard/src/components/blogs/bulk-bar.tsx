"use client";

import * as React from "react";
import { Loader2, X, type LucideIcon } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiError } from "@/lib/api";
import { formatCount } from "@/lib/format";

/**
 * WHAT ONE BULK ACTION IS. The caller describes its buttons; this file owns pressing them.
 *
 * `eligible` is the SUBSET of the selection this action will actually touch, and computing it is
 * the caller's job because only the caller knows the rule: a send reads the gate contract, a
 * download reads whether a draft exists, a delete touches everything. What this file guarantees is
 * what happens NEXT, which is the same everywhere: run on the eligible ones, never on the rest,
 * and say afterwards how many of each.
 */
export type BulkAction = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Selected rows this will act on. Empty disables the button. */
  eligible: readonly string[];
  /** One clause naming why the others are skipped: "already with the client". */
  skipped?: string;
  destructive?: boolean;
  /** Present for anything irreversible or outward-facing; absent fires on the first click. */
  confirm?: { title: string; body: string; action: string };
  /**
   * ONE CALL OVER THE WHOLE SET, for an action the engine already bulk-handles: the .docx bundles
   * are one request producing one file, and fanning them out would download eight documents.
   */
  runAll?: (slugs: readonly string[]) => Promise<unknown>;
  /**
   * PER ROW, for everything else. This file fans them out and counts, so no caller writes its own
   * allSettled and no caller invents its own words for a partial failure.
   */
  runOne?: (slug: string) => Promise<unknown>;
  /** Past tense for the toast: "Sent", "Posted to the CMS", "Deleted". */
  done: string;
};

/**
 * The toolbar that REPLACES a tab's controls while rows are ticked.
 *
 * REPLACES, and that is the design rather than an accident of layout. A selection is a mode: the
 * operator has stopped filtering and started acting on a set, and leaving Search, Month, Status and
 * Refresh on screen beside four bulk acts asks them to re-read the whole row to find the two
 * controls that now matter. Clearing the selection puts the original row back, so nothing is lost
 * and nothing has to be found twice.
 *
 * MIXED SELECTIONS RUN ON THE ELIGIBLE ONES rather than disabling until the selection is perfect.
 * An operator who ticks a month of blogs and presses Send means "send the ones that can go", and
 * making them hunt for the three already with the client is work the page can do itself. The
 * tooltip says how many it will touch BEFORE the press and the toast says what happened after, so
 * the count is never a surprise in either direction. A button whose eligible set is empty does
 * disable: there is a difference between acting on a subset and acting on nothing.
 */
export function BulkBar({
  count,
  noun,
  actions,
  onClear,
  onDone,
}: {
  /** How many rows are ticked, INCLUDING ones no action here can touch. */
  count: number;
  /** What a row is, for the count: "blog", "post". Pluralised with a bare s. */
  noun: string;
  actions: readonly BulkAction[];
  onClear: () => void;
  /**
   * Re-read the list, after EVERY act and whether or not it fully succeeded.
   *
   * Not optional, and not per-action, because every act here moves the record the table is drawing:
   * a delete removes rows, a send and a CMS push both move a state the Status column renders. The
   * list would otherwise sit on what it read before the press until somebody hit Refresh, showing
   * three blogs that no longer exist. It runs on the partial and failing paths too: the whole point
   * of a fan-out is that some of it landed, so "it failed" is never a reason to trust the old read.
   */
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState<BulkAction | null>(null);
  const [running, setRunning] = React.useState<string | null>(null);

  async function fire(action: BulkAction) {
    const slugs = action.eligible;
    if (slugs.length === 0) {
      return;
    }
    setRunning(action.key);
    try {
      const failures = action.runAll
        ? await runWhole(action.runAll, slugs)
        : await fanOut(slugs, action.runOne);
      report(action, slugs.length, failures);
    } finally {
      setRunning(null);
      setPending(null);
      // Unconditional, including after a download, which changed nothing. Deciding per action
      // would need a flag saying "this one is read-only", and a future action that forgot to set
      // it would leave the table stale in a way nobody notices until a deleted row is still there.
      // The cost of getting it wrong the other way is one GET.
      onDone();
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* THE COUNT IS THE MODE INDICATOR and it sits first, because the bar's whole meaning is
            "these buttons act on N rows" and a person reads left to right. */}
        <span className="machine text-xs font-medium text-foreground">
          {formatCount(count)} {noun}
          {count === 1 ? "" : "s"} selected
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          className="text-muted-foreground hover:text-foreground"
        >
          <X data-icon="inline-start" aria-hidden />
          Clear
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {actions.map((action) => (
          <ActionButton
            key={action.key}
            action={action}
            count={count}
            busy={running === action.key}
            disabled={running !== null}
            onPress={() => (action.confirm ? setPending(action) : void fire(action))}
          />
        ))}
      </div>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && running === null) {
            setPending(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{pending?.confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" disabled={running !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant={pending?.destructive ? "destructive" : "default"}
              disabled={running !== null}
              onClick={(event) => {
                // preventDefault holds the dialog open until the fan-out settles, so a
                // half-finished batch never closes over the operator's head.
                event.preventDefault();
                if (pending) {
                  void fire(pending);
                }
              }}
            >
              {running !== null ? (
                <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
              ) : null}
              {pending?.confirm?.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * One button, plus the sentence that says what it will touch.
 *
 * THE TOOLTIP IS ALWAYS THERE, not only on a partial selection, because "Sends all 5" is worth as
 * much as "Sends 2 of 5" to someone about to press it. A tooltip that appears only when something
 * is wrong teaches an operator that its absence means nothing to read.
 */
function ActionButton({
  action,
  count,
  busy,
  disabled,
  onPress,
}: {
  action: BulkAction;
  count: number;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const Icon = action.icon;
  const n = action.eligible.length;
  const detail =
    n === 0
      ? `No selected row can take this${action.skipped ? `: ${action.skipped}` : ""}.`
      : n === count
        ? `Runs on all ${formatCount(count)}.`
        : `Runs on ${formatCount(n)} of ${formatCount(count)}. The rest are skipped${
            action.skipped ? `: ${action.skipped}` : ""
          }.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The span is load-bearing: a disabled button fires no pointer events, so Radix would
            never see the hover that opens the tooltip explaining WHY it is disabled. */}
        <span>
          <Button
            size="sm"
            variant="outline"
            onClick={onPress}
            disabled={disabled || n === 0}
            // Outlined like its neighbours, with the fail token for the word alone. A solid
            // destructive button in a row of four would be the loudest thing on the page, and the
            // one act nobody should reach for by weight is the one that cannot be undone. The red
            // confirm in the dialog is where the emphasis belongs.
            className={action.destructive ? "text-fail hover:text-fail" : undefined}
          >
            {busy ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" data-icon="inline-start" aria-hidden />
            ) : (
              <Icon data-icon="inline-start" aria-hidden />
            )}
            {action.label}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

/** What went wrong, per row. Empty means everything landed. */
type Failure = { slug: string; message: string };

/**
 * Every row, concurrently, collecting refusals instead of stopping at the first.
 *
 * NO EARLY EXIT, deliberately. Half these actions are already partly done by the time one of them
 * refuses, and unwinding is not available: a send that reached the engine cannot be taken back. So
 * the honest shape is to attempt all of them and report the split, which is also what makes the
 * "run on the eligible ones" promise above true when the engine disagrees with the page about who
 * is eligible.
 */
async function fanOut(
  slugs: readonly string[],
  runOne: BulkAction["runOne"],
): Promise<Failure[]> {
  if (!runOne) {
    return [];
  }
  const results = await Promise.allSettled(slugs.map((slug) => runOne(slug)));
  const failures: Failure[] = [];
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push({ slug: slugs[index], message: reasonOf(result.reason) });
    }
  });
  return failures;
}

/** One request over the whole set: it either produced the file or it did not. */
async function runWhole(
  runAll: NonNullable<BulkAction["runAll"]>,
  slugs: readonly string[],
): Promise<Failure[]> {
  try {
    await runAll(slugs);
    return [];
  } catch (cause) {
    return slugs.map((slug) => ({ slug, message: reasonOf(cause) }));
  }
}

function reasonOf(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.isOffline ? "Cannot reach the engine." : cause.message;
  }
  return String(cause);
}

/**
 * One toast per press, naming what ran and what did not.
 *
 * THE ENGINE'S OWN WORDS on a failure, never a generic sentence: the refusals these routes give
 * are the useful part ("a run for this brand is live", "the client's suggestions are still open"),
 * and replacing them with "could not delete" throws away the only thing that tells an operator
 * what to do next. Only the FIRST is shown, because eight rows refusing a bulk act refuse it for
 * one reason, and eight copies of that reason is a wall.
 */
function report(action: BulkAction, attempted: number, failures: Failure[]) {
  const ok = attempted - failures.length;
  if (failures.length === 0) {
    toast.success(`${action.done} ${formatCount(ok)}`);
    return;
  }
  if (ok === 0) {
    toast.error(`Could not ${action.label.toLowerCase()} ${formatCount(attempted)}`, {
      description: failures[0].message,
    });
    return;
  }
  toast.warning(`${action.done} ${formatCount(ok)}, ${formatCount(failures.length)} refused`, {
    description: failures[0].message,
  });
}
