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
import { deriveTheme } from "@/components/roadmap/roadmap-theme";
import { SheetGrid, StatTile, ThemeCard } from "@/components/roadmap/shared";
import { ApiError, api, detailText } from "@/portal/api";
import { formatDate, formatRelative } from "@/portal/format";
import { usePortal } from "@/portal/portal-context";
import type { PortalRoadmap } from "@/portal/types";
import type { RoadmapMonth } from "@/types";
import { cn } from "@/lib/utils";

/**
 * The content roadmap tab, the SAME page the admin roadmap tab renders, minus what a client
 * must not see and what a client cannot do. The tiles, the theme card and the preview's sheet
 * grid are the admin's own components imported from components/roadmap/shared.tsx, not
 * lookalikes, so the two surfaces cannot drift.
 *
 * What is deliberately absent, by the operator's instruction: the "Blogs written", "Failed"
 * and "Remaining to write" tiles, which describe engine outcomes the portal never carries.
 * What is structurally absent: every write (upload, generate, download, delete), because this
 * surface is read-only by construction, and the raw CSV itself is admin-gated, so the preview
 * grid is rebuilt from the client wire: topic, covers and prompts by position, extras by
 * header, which is exactly how the engine reads the sheet.
 */
export function RoadmapView({ org, brand }: { org: string; brand: string }) {
  const { blogs, brands, loading, error, refresh } = usePortal();
  const [attempt, setAttempt] = React.useState(0);
  const [loaded, setLoaded] = React.useState<{ brand: string; roadmap: PortalRoadmap } | null>(null);
  const [roadmapError, setRoadmapError] = React.useState<{ brand: string; error: ApiError } | null>(null);

  // The latest month's rows, for the tiles and the theme. Stamped with the brand so switching
  // brands shows the loader rather than the previous brand's counts.
  React.useEffect(() => {
    const controller = new AbortController();
    api.roadmap(brand, controller.signal).then(
      (roadmap) => setLoaded({ brand, roadmap }),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setRoadmapError({
          brand,
          error: cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
        });
      },
    );
    return () => controller.abort();
  }, [brand, attempt]);

  const roadmap = loaded?.brand === brand ? loaded.roadmap : null;
  const loadError = roadmapError?.brand === brand ? roadmapError.error : null;
  const firstError = error ?? loadError;

  if (firstError !== null) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">Could not load this brand</p>
        <p className="mt-1 text-xs text-muted-foreground">{detailText(firstError)}</p>
        <Button
          className="mt-4"
          variant="outline"
          size="sm"
          onClick={() => {
            setRoadmapError(null);
            setLoaded(null);
            setAttempt((n) => n + 1);
            refresh();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (loading || roadmap === null) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  const mine = blogs.filter((b) => b.brand === brand && b.org === org);
  const brandName =
    brands.find((entry) => entry.slug === brand && entry.org === org)?.name ?? roadmap.brand_name;
  const shipped = roadmap.rows.filter((row) => row.delivered).length;
  const waiting = mine.filter((b) => b.state === "has_questions").length;
  const theme = deriveTheme(roadmap.rows);

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            Content roadmap
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            The topic list {brandName}&apos;s blogs are written from, and where it stands.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RoadmapPreviewDialog brand={brand} brandName={brandName} />
        </div>
      </div>

      {roadmap.rows.length === 0 ? (
        <p className="mt-10 py-10 text-center text-sm text-muted-foreground">
          No roadmap is in place for this brand yet.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatTile
              label="Topics on the roadmap"
              value={roadmap.rows.length}
              note={`Everything ${brandName} has planned to write.`}
            />
            <StatTile
              label="Shipped"
              value={shipped}
              tone="ship"
              note="Written, finished, and delivered to your library on the Blogs tab."
            />
            <StatTile
              label="Waiting on you"
              value={waiting}
              tone="review"
              note="Held on a question only you can answer. Each one is on the Blogs tab under Needs answers."
            />
          </div>

          <ThemeCard theme={theme} />
        </>
      )}
    </div>
  );
}

/**
 * The admin preview dialog's exact shape: months newest-first in a sidebar, the selected
 * month's sheet as a column grid beside it, the filename footer under the grid. The grid is
 * the shared SheetGrid; only the cells are rebuilt here, because the raw CSV never crosses
 * the client wire. No download and no delete in the sidebar: both are engine writes.
 */
function RoadmapPreviewDialog({ brand, brandName }: { brand: string; brandName: string }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Table2 data-icon="inline-start" aria-hidden />
          Preview roadmap
        </Button>
      </DialogTrigger>

      {/* Wide and height-capped like the admin preview: the body row is minmax(0,1fr) so the
          month list and the sheet each scroll inside themselves. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] max-h-[85vh] overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>The content roadmaps for {brandName}</DialogTitle>
          <DialogDescription>
            Every month {brandName} has planned, newest first. Pick a month to see its sheet.
            Columns 1, 2 and 5 are the brief the factory reads by position; every other column
            reaches the writer as guidance, under its own header.
          </DialogDescription>
        </DialogHeader>

        {/* Mounted only while open: mounting starts the fetches, unmounting aborts them. */}
        {open ? <PreviewBody brand={brand} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The grid's cells, from the client wire instead of the raw CSV: positions 0, 1 and 4 are the
 * brief (topic, covers, prompts), every other column is that row's extra under its own header.
 * Prompts re-join on newlines because that is how the sheet itself carries several in one cell.
 */
function toGrid(roadmap: PortalRoadmap): string[][] {
  return roadmap.rows.map((row) =>
    roadmap.columns.map((column, index) => {
      if (index === 0) return row.topic;
      if (index === 1) return row.covers;
      if (index === 4) return row.prompts.join("\n");
      return row.extras[column] ?? "";
    }),
  );
}

function PreviewBody({ brand }: { brand: string }) {
  const [attempt, setAttempt] = React.useState(0);
  const [months, setMonths] = React.useState<RoadmapMonth[] | null>(null);
  const [monthsError, setMonthsError] = React.useState<ApiError | null>(null);
  const [selected, setSelected] = React.useState<number | null>(null);

  // The month list. The API orders ascending, so the newest is the last and is the one
  // selected by default. No reset here: the body mounts fresh on every open, and a retry
  // resets state itself before bumping `attempt`.
  React.useEffect(() => {
    const controller = new AbortController();
    api.roadmapMonths(brand, controller.signal).then(
      (res) => {
        setMonths(res.months);
        setSelected((cur) => cur ?? res.months.at(-1)?.month ?? null);
      },
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setMonthsError(cause instanceof ApiError ? cause : new ApiError(0, String(cause)));
      },
    );
    return () => controller.abort();
  }, [brand, attempt]);

  // The selected month's rows, stamped with the month they belong to: a slow fetch landing
  // after the reader clicked another month carries the old month and is ignored by the
  // `settled` check rather than flashing the wrong plan.
  const [result, setResult] = React.useState<{
    month: number;
    roadmap: PortalRoadmap | null;
    error: ApiError | null;
  }>({ month: -1, roadmap: null, error: null });

  React.useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    api.roadmap(brand, controller.signal, selected).then(
      (roadmap) => setResult({ month: selected, roadmap, error: null }),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setResult({
          month: selected,
          roadmap: null,
          error: cause instanceof ApiError ? cause : new ApiError(0, String(cause)),
        });
      },
    );
    return () => controller.abort();
  }, [brand, selected, attempt]);

  const settled = result.month === selected;
  const roadmap = settled ? result.roadmap : null;
  const rowsError = settled ? result.error : null;
  const selectedMonth = months?.find((m) => m.month === selected) ?? null;

  const retry = () => {
    setMonths(null);
    setMonthsError(null);
    setResult({ month: -1, roadmap: null, error: null });
    setAttempt((n) => n + 1);
  };

  if (monthsError !== null) {
    return (
      <div className="rounded-lg border bg-card px-4 py-3">
        <p className="text-sm text-muted-foreground">{detailText(monthsError)}</p>
        <Button className="mt-2" variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      </div>
    );
  }
  if (months === null) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted" aria-busy />;
  }
  if (months.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No roadmap is in place for this brand yet.
      </p>
    );
  }

  // Newest at the top: the API orders ascending, and the reader wants the latest month first.
  const ordered = [...months].reverse();

  return (
    <div className="flex min-h-0 flex-col gap-4 sm:flex-row">
      <aside className="flex max-h-40 shrink-0 flex-col gap-1 overflow-y-auto rounded-lg p-1.5 ring-1 ring-foreground/10 sm:max-h-none sm:w-60">
        {ordered.map((m) => (
          <button
            key={m.month}
            type="button"
            onClick={() => setSelected(m.month)}
            aria-current={m.month === selected ? "true" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-left outline-none focus-visible:underline",
              m.month === selected ? "bg-muted" : "hover:bg-muted/50",
            )}
          >
            <span className="block truncate text-sm font-medium text-foreground">{m.label}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {m.row_count} {m.row_count === 1 ? "topic" : "topics"}
              {" · "}
              <span title={formatDate(m.modified)}>{formatRelative(m.modified)}</span>
            </span>
          </button>
        ))}
      </aside>

      {/* The selected month's sheet fills the 1fr row and scrolls; the filename footer sits
          under it. Same grid trick as the dialog shell, one level down. */}
      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-2">
        {rowsError !== null ? (
          <div className="rounded-lg border bg-card px-4 py-3">
            <p className="text-sm text-muted-foreground">{detailText(rowsError)}</p>
            <Button className="mt-2" variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : null}
        {rowsError === null && roadmap === null ? (
          <div className="h-full min-h-40 animate-pulse rounded-lg bg-muted" aria-busy />
        ) : null}
        {roadmap !== null ? (
          <SheetGrid sheet={{ columns: roadmap.columns, rows: toGrid(roadmap) }} />
        ) : null}

        {roadmap !== null && selectedMonth !== null ? (
          <p className="machine text-xs wrap-break-word text-muted-foreground">
            {selectedMonth.filename}, uploaded {formatDate(selectedMonth.modified)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
