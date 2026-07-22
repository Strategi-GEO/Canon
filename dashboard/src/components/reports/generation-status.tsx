"use client";

/**
 * A monthly-report generation is running for this brand, said on the brand's Overview. An exact
 * twin of RoadmapGenerationStatus: report generation is a long engine session started on the
 * Reports tab, so an operator who navigates back to the Overview would otherwise see a brand
 * with no new report and no explanation, read it as a start that never happened, and press it
 * again into a 409. The clock and the poll come from the same hook the Reports tab uses, so the
 * two pages cannot disagree about what is running.
 *
 * RUNNING only, matching the session and roadmap cards above it. A settled report's payoff is
 * the dashboard on its own tab, one click away; reprinting it here would bury the Overview.
 */

import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNow } from "@/components/create/use-now";
import { formatElapsed } from "@/lib/format";
import { brandHref } from "@/lib/orgs-context";
import { monthLabel } from "@/lib/reports";
import { useReportGen } from "@/lib/use-report-gen";

export function ReportGenerationStatus({
  orgSlug,
  brandSlug,
  brandName,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
}) {
  const { job } = useReportGen(brandSlug);
  const running = job !== null && job.state === "running";
  const now = useNow(running);

  if (job === null || !running) {
    return null;
  }

  // From the ENGINE's own `started`, so a generation begun in another tab or before a refresh
  // reads its real age rather than restarting its clock when this page mounted.
  const elapsed = now === null ? null : formatElapsed(job.started, now);

  return (
    <Card className="mt-4 border-review/25 bg-review-bg">
      <p className="sr-only" aria-live="polite">
        {`A ${monthLabel(job.month)} report is being generated for ${brandName}.`}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-(--card-spacing)">
        <span className="flex min-w-0 items-center gap-2">
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-review motion-reduce:animate-none"
            aria-hidden
          />
          <span className="text-sm font-medium text-foreground">
            Generating the {monthLabel(job.month)} report
          </span>
        </span>

        <span className="min-w-0 text-xs text-muted-foreground">
          This runs a full audit across DataForSEO and the live site, so it takes a few minutes.
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2">
          {elapsed !== null ? (
            <span className="machine text-xs text-muted-foreground">{elapsed} elapsed</span>
          ) : null}
          <Button variant="outline" size="sm" asChild>
            <Link href={brandHref(orgSlug, brandSlug, "/reports")}>
              Open the Reports tab
              <ArrowRight aria-hidden data-icon="inline-end" />
            </Link>
          </Button>
        </span>
      </div>
    </Card>
  );
}
