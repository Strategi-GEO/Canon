"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, api, detailText } from "@/portal/api";
import { formatDate } from "@/portal/format";
import { blogHref } from "@/portal/nav";
import { usePortal } from "@/portal/portal-context";
import type { PortalRoadmap } from "@/portal/types";
import { cn } from "@/lib/utils";

/**
 * The content roadmap, mirrored from the admin dashboard's roadmap view MINUS every
 * operator affordance: no upload, no generate, no delete, no report, and no scores on the
 * delivered stamps. A client reads the plan; the plan is the team's to change.
 *
 * Each row: number, topic, what the piece covers, the sheet's own extra columns as chips,
 * the target prompts behind a disclosure (they are the piece's search strategy, worth
 * seeing, too long to always show), and a delivered stamp that links into the library.
 */
export function RoadmapView({ org, brand }: { org: string; brand: string }) {
  const { isSingleBrand } = usePortal();
  const single = isSingleBrand(org);
  const [roadmap, setRoadmap] = React.useState<PortalRoadmap | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    setRoadmap(null);
    setError(null);
    api
      .roadmap(brand, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setRoadmap(data);
        }
      })
      .catch((cause) => {
        if (controller.signal.aborted) {
          return;
        }
        if (cause instanceof ApiError) {
          setError(cause);
        } else if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(new ApiError(0, String(cause)));
        }
      });
    return () => controller.abort();
  }, [brand, attempt]);

  if (error !== null) {
    if (error.status === 404) {
      return (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
          No roadmap is in place for this brand yet.
        </p>
      );
    }
    return (
      <div className="rounded-lg border bg-card px-4 py-3">
        <p className="text-sm text-muted-foreground">{detailText(error)}</p>
        <Button className="mt-2" variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  if (roadmap === null) {
    return (
      <div className="space-y-2" aria-busy>
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }
  if (roadmap.rows.length === 0) {
    return (
      <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
        No roadmap is in place for this brand yet.
      </p>
    );
  }

  // No written-vs-remaining tally above the plan, deliberately: production accounting is
  // the team's, and a client reads the plan itself, not a progress metre over it.
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {roadmap.rows.map((row) => (
          <RoadmapRow key={row.index} org={org} brand={roadmap.brand} singleBrand={single} row={row} />
        ))}
      </ol>
    </div>
  );
}

function RoadmapRow({
  org,
  brand,
  singleBrand,
  row,
}: {
  org: string;
  brand: string;
  singleBrand: boolean;
  row: PortalRoadmap["rows"][number];
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <li
      className={cn(
        "rounded-lg border bg-card px-4 py-3",
        row.delivered && "border-ship/20",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground">{row.index + 1}</span>
            <h3 className="text-sm font-medium text-pretty">{row.topic}</h3>
            {Object.entries(row.extras).map(([key, value]) => (
              <Badge key={key} variant="outline" className="font-normal text-muted-foreground">
                {key}: {value}
              </Badge>
            ))}
          </div>
          {row.covers !== "" ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{row.covers}</p>
          ) : null}
          {row.prompts.length > 0 ? (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls={`prompts-${row.index}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <ChevronDown
                  className={cn("size-3.5 transition-transform", open && "rotate-180")}
                  aria-hidden
                />
                {row.prompts.length === 1
                  ? "1 target search prompt"
                  : `${row.prompts.length} target search prompts`}
              </button>
              {open ? (
                <ul id={`prompts-${row.index}`} className="mt-1.5 space-y-1 border-l-2 border-border pl-3">
                  {row.prompts.map((prompt) => (
                    <li key={prompt} className="text-xs leading-relaxed text-muted-foreground">
                      {prompt}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          {row.delivered ? (
            <div className="flex flex-col items-end gap-1">
              <span className="inline-flex items-center gap-1 text-xs font-medium text-ship">
                <CheckCircle2 className="size-3.5" aria-hidden />
                Delivered
              </span>
              {row.delivered_at !== null ? (
                <span className="text-[0.7rem] text-muted-foreground">
                  {formatDate(row.delivered_at)}
                </span>
              ) : null}
              {row.topic_slug !== null ? (
                <Link
                  href={blogHref(org, brand, singleBrand, row.topic_slug)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-foreground outline-none hover:text-primary focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  Read
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              ) : null}
            </div>
          ) : (
            <Badge variant="secondary" className="font-normal">
              Planned
            </Badge>
          )}
        </div>
      </div>
    </li>
  );
}
