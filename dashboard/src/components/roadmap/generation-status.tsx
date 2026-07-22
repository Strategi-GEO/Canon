"use client";

/**
 * NO BAR, NO PERCENTAGE, NO INVENTED STAGE LIST, exactly as the session card next to it. See
 * roadmap-generation.tsx: a generation is one agent session making an unknown number of tool
 * calls, so the elapsed clock is the only honest number, and a list of stages this engine does
 * not report would be a story rather than a status.
 */

import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useNow } from "@/components/create/use-now";
import { workingLine } from "@/components/roadmap/generation-copy";
import { formatElapsed } from "@/lib/format";
import { brandHref } from "@/lib/orgs-context";
import { useRoadmapGen } from "@/lib/use-roadmap-gen";

/**
 * A roadmap generation is running for this brand, said on the brand's Overview.
 *
 * This is the page an operator returns to, and a generation started on the Content Roadmap tab
 * is still running when they get here: without this card the Overview shows a brand with no
 * roadmap and no explanation, which reads as a start that never happened, so they go and press
 * it again and collect a 409.
 *
 * It shows RUNNING only. A settled generation's payoff is its report, the report is long, and
 * the tab it belongs to is one click away: reprinting it on a page that already carries a
 * description, a roadmap and stats would bury all of them. The link is the
 * answer, and the tab is where the operator can act on what it says.
 *
 * The clock and the poll behind it come from the same hook the Content Roadmap tab uses, so
 * the two pages cannot disagree about what is running. They are different routes and are never
 * mounted together, which is why this reads the hook directly rather than a provider.
 */
export function RoadmapGenerationStatus({
  orgSlug,
  brandSlug,
  brandName,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
}) {
  const { job } = useRoadmapGen(brandSlug);
  const running = job !== null && job.state === "running";
  const now = useNow(running);

  // Nothing at all when nothing is running, matching the session card above it. An idle "no
  // generation" box would be permanent furniture telling the operator a thing they can neither
  // act on nor want.
  if (job === null || !running) {
    return null;
  }

  // From the ENGINE's own `started`. This is the whole point: a generation begun in another
  // tab, or before a refresh, or by another operator, reads its real age here rather than
  // restarting its clock the moment this page happened to mount.
  const elapsed = now === null ? null : formatElapsed(job.started, now);

  return (
    <Card className="mt-4 border-review/25 bg-review-bg">
      {/* The elapsed stays out of the live region: it changes every second, and a region
          reciting it would talk over everything else on the page forever. */}
      <p className="sr-only" aria-live="polite">
        {`A roadmap generation is running for ${brandName}.`}
      </p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-(--card-spacing)">
        <span className="flex min-w-0 items-center gap-2">
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-review motion-reduce:animate-none"
            aria-hidden
          />
          <span className="text-sm font-medium text-foreground">
            Generating a content roadmap
          </span>
        </span>

        <span className="min-w-0 text-xs text-muted-foreground">
          {workingLine(brandName)}
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-2">
          {elapsed !== null ? (
            <span className="machine text-xs text-muted-foreground">{elapsed} elapsed</span>
          ) : null}
          {/* Outline, never the accent: the accent on this page is Create blogs and stays
              there. */}
          <Button variant="outline" size="sm" asChild>
            <Link href={brandHref(orgSlug, brandSlug, "/roadmap")}>
              Open the Content Roadmap tab
              <ArrowRight aria-hidden data-icon="inline-end" />
            </Link>
          </Button>
        </span>
      </div>
    </Card>
  );
}
