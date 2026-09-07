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
import { formatAbsolute, formatCount, formatRelative } from "@/lib/format";
import { HOSTED_READONLY } from "@/lib/hosted";
import { cn } from "@/lib/utils";
import { DeleteRoadmapDialog } from "@/components/roadmap/delete-roadmap-dialog";
import { RoadmapDownloadButton } from "@/components/roadmap/roadmap-download-button";
import { RewriteControls, lockedReasonFor } from "@/components/roadmap/rewrite-controls";
import { SheetGrid, type SheetReview } from "@/components/roadmap/shared";
import { useRowSelection } from "@/components/create/use-row-selection";
import type {
  BlogSummary,
  RewriteJob,
  RoadmapMonth,
  RoadmapRow,
  RoadmapSheet,
} from "@/types";

/**
 * Everything the rewrite flow needs, handed down from the roadmap tab that owns the state:
 * the parsed rows and blogs it already fetched, and the batch list its poll already watches.
 * The dialog derives per-row facts from these and owns only the tick set and the feedback
 * box. Absent on the hosted build, where the preview stays read-only.
 */
export type PreviewReview = {
  /** The LATEST month's parsed rows; rewrites only ever target the latest sheet. */
  rows: RoadmapRow[];
  /** Every blog on disk, at any status: each one locks its row against rewriting. */
  blogs: BlogSummary[];
  jobs: RewriteJob[];
  rowsInFlight: ReadonlySet<number>;
  adopt: (job: RewriteJob) => void;
  clear: (jobId: string) => void;
  /** True while a run is live or a generation is running: the engine would 409 the POST. */
  locked: boolean;
  lockedReason?: string;
};

/**
 * Every one of the brand's monthly roadmaps, on demand, one per sidebar entry.
 *
 * A brand used to hold one roadmap and this dialog showed that one sheet. It now holds many, one
 * per month, so the sidebar lists them newest-first and the main pane shows the selected month's
 * sheet. The newest month is selected on open, because the preview must always land on the
 * latest roadmap. It fetches when it OPENS rather than on page mount: most visits to the tab
 * never open this, and paying for the list plus a sheet on every one of them would buy nothing.
 *
 * THE PREVIEW IS ALSO WHERE TOPICS ARE REVIEWED AND REWRITTEN, on the latest month only. The
 * roadmap tab once carried its own second table for this, which was the same roadmap displayed
 * twice; the raw sheet here shows every column the operator wrote, which is what judging a row
 * actually needs, so the tick column and the feedback bar live here and nowhere else.
 */
export function RoadmapPreviewDialog({
  brandSlug,
  brandName,
  /** True while a run is live: the engine 409s a month delete until it finishes. */
  locked,
  /** Called after a month is deleted, so the roadmap tab re-reads its stats and month list. */
  onChanged,
  review,
}: {
  brandSlug: string;
  brandName: string;
  locked: boolean;
  onChanged?: () => void;
  review?: PreviewReview;
}) {
  const [open, setOpen] = React.useState(false);
  const rewriting = review !== undefined && review.rowsInFlight.size > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Table2 data-icon="inline-start" aria-hidden />
          {/* The button is also the tab's one hint that batches are running with the dialog
              closed: the count is where the operator left work in flight. */}
          {rewriting
            ? `Preview roadmap (rewriting ${formatCount(review.rowsInFlight.size)})`
            : "Preview roadmap"}
        </Button>
      </DialogTrigger>

      {/* Wider than the default dialog and capped in height, because the thing inside is a
          spreadsheet with a list beside it, and a spreadsheet squeezed into a small dialog is
          unreadable. The body row is minmax(0,1fr) so it shrinks under the cap and hands the
          leftover height to its two panes; overflow-hidden keeps the rounded card clipping its
          own corners while the sidebar and the sheet each scroll inside themselves. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] max-h-[85vh] overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>The content roadmaps for {brandName}</DialogTitle>
          <DialogDescription>
            Every month {brandName} has planned, newest first. Pick a month to see its sheet as it
            sits on disk. Columns 1, 2 and 8 are the brief the factory reads by position; every
            other column reaches the writer as guidance, under the header you gave it.
            {review !== undefined
              ? " On the latest month, tick the topics that miss, say what is wrong, and a research session replaces exactly those rows; you can start another batch while one runs."
              : ""}
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while open, so the fetches below fire on open and clean up on close
            without any per-open bookkeeping. */}
        {open ? (
          <PreviewBody
            brandSlug={brandSlug}
            brandName={brandName}
            locked={locked}
            onChanged={onChanged}
            onClose={() => setOpen(false)}
            review={review}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The month list and the selected sheet. Split from the dialog shell so it mounts fresh on each
 * open: mounting is what starts the reads and unmounting is what aborts them.
 */
function PreviewBody({
  brandSlug,
  brandName,
  locked,
  onChanged,
  onClose,
  review,
}: {
  brandSlug: string;
  brandName: string;
  locked: boolean;
  onChanged?: () => void;
  onClose: () => void;
  review?: PreviewReview;
}) {
  const [months, setMonths] = React.useState<RoadmapMonth[] | null>(null);
  const [monthsError, setMonthsError] = React.useState<ApiError | null>(null);
  const [selected, setSelected] = React.useState<number | null>(null);

  // The list of months. The API orders them ascending, so the newest is the last, and it is the
  // one selected by default: the preview always opens on the latest roadmap.
  React.useEffect(() => {
    const controller = new AbortController();
    api.roadmapMonths(brandSlug, controller.signal).then(
      (res) => {
        setMonths(res.months);
        setSelected((cur) => cur ?? res.months.at(-1)?.month ?? null);
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setMonthsError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
      },
    );
    return () => controller.abort();
  }, [brandSlug]);

  // The selected month's sheet, stamped with the month it belongs to. A slow fetch that lands
  // after the operator has clicked another month carries the old month and is ignored by the
  // `settled` check rather than flashing the wrong sheet, and a switch shows a skeleton until
  // the new one lands.
  const [result, setResult] = React.useState<{
    month: number;
    sheet: RoadmapSheet | null;
    error: ApiError | null;
  }>({ month: -1, sheet: null, error: null });

  // rowsInFlight.size rides in the deps ON PURPOSE: a batch landing shrinks it, and the rows
  // it replaced are already on disk, so the sheet on screen is stale the moment it does. A
  // batch STARTING grows it and refetches a sheet that has not changed, which costs one cheap
  // read and keeps the trigger simple.
  const inFlightCount = review?.rowsInFlight.size ?? 0;
  React.useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    api.roadmapSheet(brandSlug, controller.signal, selected).then(
      (sheet) => setResult({ month: selected, sheet, error: null }),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setResult({
          month: selected,
          sheet: null,
          error: cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
        });
      },
    );
    return () => controller.abort();
  }, [brandSlug, selected, inFlightCount]);

  const settled = result.month === selected;
  const sheet = settled ? result.sheet : null;
  const sheetError = settled ? result.error : null;

  // ------------------------------------------------------------------
  // The rewrite flow, active on the LATEST month only: older months are history, and the
  // engine splices only the latest sheet. All per-row facts derive from what the tab handed
  // down; the dialog owns nothing but the tick set.
  // ------------------------------------------------------------------
  const rowByIndex = React.useMemo(
    () => new Map((review?.rows ?? []).map((row) => [row.index, row])),
    [review?.rows],
  );
  const blogBySlug = React.useMemo(
    () => new Map((review?.blogs ?? []).map((blog) => [blog.topic_slug, blog.status])),
    [review?.blogs],
  );

  const rowsInFlight = review?.rowsInFlight;
  const blockedFor = React.useCallback(
    (rowIndex: number): string | null => {
      const row = rowByIndex.get(rowIndex);
      if (row === undefined) {
        // The grid renders raw rows, and a blank line in the CSV has no parsed row behind
        // it: there is no topic to replace, so there is nothing to tick.
        return "This row is blank in the sheet, so there is nothing to rewrite.";
      }
      const status = blogBySlug.get(row.topic_slug);
      if (status !== undefined) {
        return lockedReasonFor(status);
      }
      return null;
    },
    [rowByIndex, blogBySlug],
  );

  const eligible = React.useCallback(
    (row: RoadmapRow) =>
      blockedFor(row.index) === null && !(rowsInFlight?.has(row.index) ?? false),
    [blockedFor, rowsInFlight],
  );
  const { selected: ticked, setSelected: setTicked, toggle } = useRowSelection(
    review?.rows ?? [],
    eligible,
  );

  // Ticks are re-filtered through `eligible` every render rather than trusted: a batch
  // started from another tab can take a ticked row mid-compose, and a ghost tick submitted
  // for it would only buy a 409. What the grid and the bar see is always currently-tickable.
  const visibleTicked = React.useMemo(
    () =>
      new Set(
        [...ticked].filter((index) => {
          const row = rowByIndex.get(index);
          return row !== undefined && eligible(row);
        }),
      ),
    [ticked, rowByIndex, eligible],
  );

  const latestMonth = months?.at(-1)?.month ?? null;
  const reviewActive =
    review !== undefined && selected !== null && selected === latestMonth;

  const gridReview: SheetReview | undefined =
    reviewActive && sheet !== null
      ? {
          blocked: blockedFor,
          rewriting: (rowIndex) => rowsInFlight?.has(rowIndex) ?? false,
          selected: visibleTicked,
          onToggle: toggle,
        }
      : undefined;

  // After a delete: notify the tab, re-read the list, and reselect. If the deleted month was the
  // one on screen (or is otherwise gone), fall to the newest that remains; if none remain, close.
  async function afterDelete() {
    onChanged?.();
    try {
      const res = await api.roadmapMonths(brandSlug);
      setMonths(res.months);
      if (res.months.length === 0) {
        onClose();
        return;
      }
      setSelected((cur) =>
        cur !== null && res.months.some((m) => m.month === cur)
          ? cur
          : (res.months.at(-1)?.month ?? null),
      );
    } catch (cause) {
      setMonthsError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    }
  }

  if (monthsError) {
    return <EngineDown error={monthsError} />;
  }
  if (months === null) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (months.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {brandName} has no roadmap yet. Upload or generate one to see it here.
      </p>
    );
  }

  // Newest at the top: the API orders ascending, and the operator reaches for the latest month
  // first.
  const ordered = [...months].reverse();

  return (
    <div className="flex min-h-0 flex-col gap-4 sm:flex-row">
      {/* Stacks above the pane on a narrow screen, capped so it never eats the sheet; a fixed
          column beside it on sm and up. Scrolls inside itself either way. */}
      <aside className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto rounded-lg p-1.5 ring-1 ring-foreground/10 sm:max-h-none sm:w-60">
        {ordered.map((m) => (
          <div
            key={m.month}
            className={cn(
              "flex items-center gap-1 rounded-md py-1 pr-1 pl-2.5",
              m.month === selected ? "bg-muted" : "hover:bg-muted/50",
            )}
          >
            <button
              type="button"
              onClick={() => setSelected(m.month)}
              aria-current={m.month === selected ? "true" : undefined}
              className="min-w-0 flex-1 py-1 text-left outline-none focus-visible:underline"
            >
              <span className="block truncate text-sm font-medium text-foreground">{m.label}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {formatCount(m.row_count)} {m.row_count === 1 ? "topic" : "topics"}
                {" · "}
                <span title={formatAbsolute(m.modified)}>{formatRelative(m.modified)}</span>
              </span>
            </button>
            <RoadmapDownloadButton
              brandSlug={brandSlug}
              brandName={brandName}
              month={m.month}
              label={m.label}
              compact
            />
            {/* Deleting a month is an engine write, so the hosted build previews and downloads
                but offers no way to destroy a sheet. */}
            {HOSTED_READONLY ? null : (
              <DeleteRoadmapDialog
                brandSlug={brandSlug}
                month={m.month}
                label={m.label}
                rowCount={m.row_count}
                locked={locked}
                onDeleted={afterDelete}
              />
            )}
          </div>
        ))}
      </aside>

      {/* The selected month's sheet fills the 1fr row and scrolls; the rewrite bar and the
          filename footer sit under it. Same grid trick as the dialog shell, one level down. */}
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto_auto] gap-2">
        {sheetError ? <EngineDown error={sheetError} /> : null}
        {!sheetError && !sheet ? <Skeleton className="h-full w-full" /> : null}
        {sheet ? <SheetGrid sheet={sheet} review={gridReview} /> : null}

        {/* The batches in flight and the next batch's feedback, on the latest month only.
            Renders nothing until something is ticked or running, so the ordinary preview
            stays exactly the reading surface it always was. */}
        {reviewActive && review !== undefined ? (
          <RewriteControls
            brandSlug={brandSlug}
            jobs={review.jobs}
            selected={visibleTicked}
            onStarted={review.adopt}
            onCleared={review.clear}
            onDeselect={() => setTicked(new Set())}
            locked={review.locked}
            lockedReason={review.lockedReason}
          />
        ) : null}

        {sheet ? (
          <p className="machine text-xs wrap-break-word text-muted-foreground">
            {sheet.filename}, {formatCount(sheet.bytes)} bytes, uploaded{" "}
            {formatAbsolute(sheet.modified)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

