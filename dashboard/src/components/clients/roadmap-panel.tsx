"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { brandHref } from "@/lib/orgs-context";
import type { RoadmapState } from "@/lib/use-roadmap";
import type { RoadmapRow } from "@/types";
import { FieldError } from "@/components/clients/engine-error";

/** The positional contract, fixed in the engine and not obvious from any CSV header. */
const CSV_CONTRACT =
  "Columns 1, 2 and 5 are the brief: topic, what it covers, target prompts. Every other column reaches the writer as guidance, under its own header.";

/**
 * The overview shows a PREVIEW. The full selectable table is the create page, one click away,
 * so repeating forty rows here would only push everything else about the brand off screen.
 */
const PREVIEW_ROWS = 5;

/**
 * The one roadmap card, and it is READ ONLY.
 *
 * Uploading happens on the create page and nowhere else. A file input parked on the overview
 * put a destructive action (replacing the topic list) in front of an operator who came here to
 * read, and it split the roadmap across two tabs so neither was the place. Uploading a sheet
 * and picking rows from it are one task, so they live on one page, and this card is the
 * summary that sends you there.
 *
 * It used to be two cards stacked on this same overview: a summary that listed rows and a panel
 * that uploaded them. That gave the operator two "Pick topics" buttons to the same place, the
 * CSV column contract stated twice, and a separate GET behind each, so one view fetched the
 * same CSV twice and could render two different answers if the two disagreed.
 *
 * The roadmap is READ here, never owned: it is fetched once by the page and passed in, so this
 * card and the brand's stats cannot disagree about how many topics exist.
 */
export function RoadmapPanel({
  orgSlug,
  brandSlug,
  hasRoadmap,
  roadmap,
}: {
  orgSlug: string;
  brandSlug: string;
  hasRoadmap: boolean;
  roadmap: RoadmapState;
}) {
  const rows = roadmap.data?.rows ?? [];
  const complete = rows.filter((row) => row.complete).length;
  const incomplete = rows.length - complete;
  const preview = rows.slice(0, PREVIEW_ROWS);
  const remaining = rows.length - preview.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-foreground">Roadmap</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          The topic list the factory writes from. It stays read only: the app never writes
          back to the CSV you upload.
        </p>
      </CardHeader>
      <CardContent>
        {roadmap.loading ? (
          <Skeleton className="h-5 w-64" />
        ) : (
          <p className="text-sm text-foreground">
            {rows.length > 0 ? (
              <>
                <span className="machine">{rows.length}</span> topics parsed,{" "}
                <span className="machine">{complete}</span> ready to generate.
              </>
            ) : hasRoadmap ? (
              "A roadmap is saved for this brand, and it parsed to zero usable topics."
            ) : (
              "No roadmap yet. Upload a CSV on the create page to pick topics."
            )}
          </p>
        )}

        {incomplete > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="machine">{incomplete}</span> rows are missing a topic, what it
            covers, or target prompts, so they cannot be selected.
          </p>
        ) : null}

        {roadmap.data?.warnings.map((warning) => (
          <p key={warning} className="machine mt-1 text-xs text-review">
            {warning}
          </p>
        ))}

        {/* The engine refusing to READ a roadmap is a different thing from there being none,
            so it is said rather than left looking like a brand nobody has set up yet. */}
        {roadmap.error ? <FieldError error={roadmap.error} /> : null}

        {/* With no roadmap there is nothing to preview, so this card's only job is to point at
            the page that takes one. Outline, not accent: the header's "Create blogs" is this
            view's one accent action, and it already leads to the same place. */}
        {!hasRoadmap && rows.length === 0 && !roadmap.loading ? (
          <Button size="sm" variant="outline" className="mt-3" asChild>
            <Link href={brandHref(orgSlug, brandSlug, "/create")}>
              Add a roadmap
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Link>
          </Button>
        ) : null}

        {/* Stated ONCE, and here rather than on the create page's table, because it explains
            what the operator is looking at rather than what they are about to do. */}
        <p className="machine mt-3 text-xs wrap-break-word text-muted-foreground">
          {CSV_CONTRACT}
        </p>

        {preview.length > 0 ? (
          <>
            <ul className="mt-4 flex flex-col divide-y border-t">
              {preview.map((row) => (
                <li key={row.index} className="flex items-start gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-pretty text-foreground">{row.topic}</p>
                    {/* What the piece covers, in place of the slug this used to print. A title
                        and its own slugified self say one thing twice, and neither says what
                        the topic actually is. The slug is the ledger key and it is still on
                        the create page, where an operator matching a row to an output folder
                        is. Two lines, unexpandable: this card is a preview and the page that
                        reads a row in full is one click away. */}
                    {row.covers ? (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                        {row.covers}
                      </p>
                    ) : null}
                    {/* Counted, not listed. The prompts are the binding part of a row and the
                        reason to open the create page, but printing five of them per topic
                        would rebuild that page here. The number is what this card can honestly
                        carry: it says the row has queries to win and how many. */}
                    {row.prompts.length > 0 ? (
                      <p className="mt-1 text-xs text-muted-foreground/80">
                        <span className="machine">{row.prompts.length}</span>{" "}
                        {row.prompts.length === 1 ? "target prompt" : "target prompts"}
                      </p>
                    ) : null}
                  </div>
                  <RoadmapRowState row={row} />
                </li>
              ))}
            </ul>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              {/* Said, never silent. A list that simply stops at five teaches the operator
                  that five is all there is. */}
              <p className="text-xs text-muted-foreground">
                {remaining > 0 ? (
                  <>
                    <span className="machine">{remaining}</span> more{" "}
                    {remaining === 1 ? "topic" : "topics"} on the create page.
                  </>
                ) : (
                  "That is every topic in this roadmap."
                )}
              </p>
              <Button size="sm" variant="outline" asChild>
                <Link href={brandHref(orgSlug, brandSlug, "/create")}>
                  Pick topics
                  <ArrowRight data-icon="inline-end" aria-hidden />
                </Link>
              </Button>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Generated wins over incomplete: the engine refuses to run a topic that already has a blog. */
function RoadmapRowState({ row }: { row: RoadmapRow }) {
  if (row.already_generated) {
    return (
      <span className="machine shrink-0 rounded border border-ship/25 bg-ship-bg px-1.5 py-px text-[0.6875rem] leading-5 text-ship">
        {row.ledger?.score !== undefined && row.ledger !== null
          ? `generated ${row.ledger.score}`
          : "generated"}
      </span>
    );
  }

  if (!row.complete) {
    return (
      <span
        className="machine shrink-0 rounded border border-review/25 bg-review-bg px-1.5 py-px text-[0.6875rem] leading-5 text-review"
        title={`Missing: ${row.missing.join(", ")}`}
      >
        incomplete
      </span>
    );
  }

  return (
    <span className="machine shrink-0 rounded border border-border bg-muted px-1.5 py-px text-[0.6875rem] leading-5 text-muted-foreground">
      ready
    </span>
  );
}
