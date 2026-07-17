"use client";

import * as React from "react";
import { Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { EngineDown } from "@/components/clients/engine-error";
import { formatAbsolute, formatCount } from "@/lib/format";
import type { RoadmapSheet } from "@/types";

/**
 * What each column DOES, by position. Nothing here is decoration: this is the engine's actual
 * contract and it is invisible in any header text.
 *
 * There is no "ignored" case any more and there must never be one again. The factory used to
 * read three columns and drop the rest, so this map marked the other columns Ignored and greyed
 * them out. It now registers EVERY column: 1, 2 and 5 are the binding brief, found by position,
 * and every other column is handed to the writer under its own header as guidance, which is how
 * a Format of "Comparison anchor" reaches the agent that acts on it. A column labelled Ignored
 * in this preview while its value was steering the draft would be the worst kind of wrong: a
 * confident, specific lie about the operator's own file.
 */
function roleOf(index: number): string {
  if (index === 0) return "Topic";
  if (index === 1) return "Scope";
  if (index === 4) return "Target prompts";
  return "Guidance";
}

/**
 * The whole roadmap CSV, on demand.
 *
 * It fetches when it OPENS rather than on page mount, because this is the entire file and the
 * tab around it answers its questions from the parsed roadmap instead. Most visits to the tab
 * never open this, and paying for the sheet on every one of them would buy nothing.
 *
 * The grid labels what each column DOES, and marks none of them dead. It once greyed out
 * every column but 1, 2 and 5 and badged them Ignored, which was true then and is a lie now:
 * the engine registers all of them, and a Format sitting greyed out here while it steers the
 * draft would be a confident, specific lie about the operator's own sheet.
 */
export function RoadmapPreviewDialog({ brandSlug, brandName }: { brandSlug: string; brandName: string }) {
  const [open, setOpen] = React.useState(false);
  // Which open this is. Bumped in the event handler that opens the dialog, so a fetch can be
  // matched to the open that asked for it.
  const [attempt, setAttempt] = React.useState(0);
  const [result, setResult] = React.useState<{
    attempt: number;
    sheet: RoadmapSheet | null;
    error: ApiError | null;
  }>({ attempt: -1, sheet: null, error: null });

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const controller = new AbortController();
    api.roadmapSheet(brandSlug, controller.signal).then(
      (sheet) => setResult({ attempt, sheet, error: null }),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setResult({
          attempt,
          sheet: null,
          error: cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
        });
      },
    );

    return () => controller.abort();
  }, [open, brandSlug, attempt]);

  // Derived rather than cleared from the effect. Clearing on open means writing state during
  // render's own effect pass, which cascades a second render; stamping each result with the
  // open it belongs to answers the same question, "is what I am holding about THIS open", by
  // comparison instead. It also settles the race for free: a slow first fetch landing after a
  // reopen carries the old attempt and is ignored rather than flashing a stale sheet.
  const settled = result.attempt === attempt;
  const sheet = settled ? result.sheet : null;
  const error = settled ? result.error : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setAttempt((count) => count + 1);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Table2 data-icon="inline-start" aria-hidden />
          Preview roadmap
        </Button>
      </DialogTrigger>

      {/* Wider than the default dialog and capped in height, because the thing inside is a
          spreadsheet and a spreadsheet squeezed into a small dialog is unreadable.

          The rows are declared rather than left implicit, and that is what makes the cap
          mean anything. DialogContent is a grid, its implicit rows are auto, and an auto row
          cannot be compressed below its content: the sheet kept its full height and painted
          outside the card instead, so on a 1366x768 laptop the last rows of the operator's
          own file rendered on the backdrop and the filename footer left the viewport
          entirely. Naming the middle row minmax(0,1fr) lets it shrink under the cap and hands
          the leftover height to the grid, which is the only child that should absorb it.
          overflow-hidden then keeps the rounded card clipping its own corners. */}
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>The content roadmap for {brandName}</DialogTitle>
          <DialogDescription>
            The sheet as it sits on disk, every column of it. Columns 1, 2 and 5 are the brief
            the factory reads by position. Every other column reaches the writer as guidance,
            under the header you gave it.
          </DialogDescription>
        </DialogHeader>

        {error ? <EngineDown error={error} /> : null}
        {!error && !sheet ? <Skeleton className="h-64 w-full" /> : null}
        {sheet ? <SheetGrid sheet={sheet} /> : null}

        {sheet ? (
          <p className="machine text-xs wrap-break-word text-muted-foreground">
            {sheet.filename}, {formatCount(sheet.bytes)} bytes, uploaded{" "}
            {formatAbsolute(sheet.modified)}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sticky header, sticky row numbers, and the scroll living HERE rather than on the page. The
 * page must never scroll sideways to accommodate a wide CSV: the sheet is arbitrary width, so
 * letting it size the document would let one operator's spreadsheet break the whole layout.
 *
 * min-w-0 and min-h-0 are what make that work at all. This is a grid child, grid children
 * default to min-width:auto and min-height:auto, and an auto-sized child sizes to its content
 * instead of scrolling it. Both axes need saying: with only min-w-0 the sheet scrolled
 * sideways and grew downwards past the dialog, and the sticky header had no scroll of its own
 * to hold against, so the column role labels scrolled away with the page and left six
 * anonymous columns behind, which is the exact misreading this dialog exists to prevent.
 */
function SheetGrid({ sheet }: { sheet: RoadmapSheet }) {
  if (sheet.rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        This sheet has a header row and no data rows under it.
      </p>
    );
  }

  return (
    <div className="min-h-0 min-w-0 overflow-auto rounded-lg ring-1 ring-foreground/10">
      <table className="w-max border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            {/* Sticky in both axes, so it outranks both the header row and the number column
                it sits at the corner of. */}
            <th className="sticky top-0 left-0 z-30 border-b border-border bg-muted px-3 py-2.5 text-xs font-medium text-muted-foreground">
              #
            </th>
            {/* Every column is rendered at full weight. Nothing here is greyed out, because
                nothing in the sheet is dead weight any more: what is not the brief is guidance,
                and guidance reaches the writer. */}
            {sheet.columns.map((column, index) => (
              <th
                key={index}
                className="sticky top-0 z-20 min-w-44 max-w-80 border-b border-l border-border bg-muted px-3 py-2.5 align-bottom"
              >
                <span className="machine block text-xs font-medium wrap-break-word text-foreground">
                  {column.trim() === "" ? "(no header)" : column}
                </span>
                <span className="mt-1 block text-[10px] tracking-wide text-primary uppercase">
                  {roleOf(index)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="machine sticky left-0 z-10 border-b border-border bg-card px-3 py-2 align-top text-xs text-muted-foreground">
                {rowIndex + 1}
              </td>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  // Target prompts arrive newline separated inside one quoted cell, so the
                  // newlines are content and collapsing them would misrepresent the file.
                  // Every cell reads at full contrast: half of them used to be dimmed to say
                  // the engine threw them away, and the engine no longer does.
                  className="machine max-w-80 border-b border-l border-border px-3 py-2 align-top text-xs whitespace-pre-line wrap-break-word text-foreground"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
