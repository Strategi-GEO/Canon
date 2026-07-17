"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { brandHref, useOrgs } from "@/lib/orgs-context";
import { useRoadmap } from "@/lib/use-roadmap";
import { DemoBadge, IndustryBadge, PreflightNote } from "@/components/clients/client-meta";
import { displayDomain } from "@/components/clients/brand-card";
import { ReadOnlyText } from "@/components/clients/editable-text";
import { FactsCard } from "@/components/clients/facts-card";
import { RoadmapPanel } from "@/components/clients/roadmap-panel";
import { mockReasonOf } from "@/components/roadmap/generation-copy";
import { RoadmapGenerationStatus } from "@/components/roadmap/generation-status";
import { SessionCard } from "@/components/session/session-card";
import { neverClaimOf } from "@/components/clients/wire";
import type { BlogSummary, Client } from "@/types";

/**
 * The operator's home for one brand, and the only page that renders it. An org holding
 * exactly one brand redirects here rather than rendering this inline, so a brand has one
 * canonical URL and the sidebar's active section can always match the address bar.
 */
export function BrandOverview({ orgSlug, brand }: { orgSlug: string; brand: Client }) {
  const { geoMock } = useOrgs();
  const client = brand;

  // Fetched ONCE here and handed to both cards that need it. The roadmap card and the stats
  // card each used to fetch it, so this page made two GETs for one CSV and could show two
  // different topic counts if the two landed on either side of an upload.
  const roadmap = useRoadmap(client.slug);

  // This page writes NOTHING about the brand, so it holds no copy of one and needs no way to
  // put one back. The brand arrives as a prop from the org list, which stays the one source of
  // truth the sidebar and the switcher also read, and Settings is where a change to it is made
  // and re-read.

  return (
    <div className="mx-auto w-full max-w-5xl">
      <BrandHeader orgSlug={orgSlug} client={client} />

      {/*
        A run started on the Create tab is still running when the operator navigates back here,
        and this is the page they return to, so the run has to be visible from it. The card
        takes the roadmap this page already fetched rather than fetching its own: it needs the
        rows to label each blog with the operator's own topic title instead of a slug, and a
        third GET for one CSV is the exact defect merged out of this page above.

        It renders nothing when no run is live, so it costs an idle Overview nothing.
      */}
      <SessionCard orgSlug={orgSlug} brandSlug={client.slug} roadmap={roadmap} />

      {/*
        The other thing that can be running for this brand, and the one the Overview otherwise
        hides worst: a generation is started on the Content Roadmap tab and takes a long time,
        so the operator comes back here to a brand with no roadmap and no explanation. That
        reads as a start that never happened, and the next move is to press it again and be
        409'd. It renders nothing unless a generation is actually running, so an idle Overview
        pays for one read and shows nothing.
      */}
      <RoadmapGenerationStatus
        orgSlug={orgSlug}
        brandSlug={client.slug}
        brandName={client.name}
        mock={mockReasonOf(geoMock, client.demo_mode)}
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Read only here. Settings is where this brand is configured, so Settings owns the
              edit: one field editable from two screens is two screens that can disagree, and
              the operator has no way to tell which one they are looking at once they do. */}
          <ReadOnlyText
            title="Description"
            help="What this brand is, what it sells, and who it sells to. Every writer run reads it."
            value={client.description}
            emptyText="No description yet. Settings can draft one from the live site."
          />

          {/* Read only. Uploading lives on the create page and nowhere else, so this card no
              longer takes a file and has nothing to report back up. */}
          <RoadmapPanel
            orgSlug={orgSlug}
            brandSlug={client.slug}
            hasRoadmap={client.has_roadmap}
            roadmap={roadmap}
          />
        </div>

        <div className="flex flex-col gap-4">
          <BrandStats client={client} topics={roadmap.data?.rows.length ?? null} />
          <ResourcesSummary orgSlug={orgSlug} client={client} />
          <FactsCard client={client} />
          {/* Read only for the same reason the description above it is: Settings configures
              this brand, and a field editable from two screens is two screens that can
              disagree. */}
          <ReadOnlyText
            title="Never claim"
            help="Claims the writer must never make about this brand. One rule per line."
            value={neverClaimOf(client)}
            mono
            emptyText="No rules yet. This is the one safety input an agent cannot infer from a website, and Settings is where it is written."
          />
        </div>
      </div>
    </div>
  );
}

function BrandHeader({ orgSlug, client }: { orgSlug: string; client: Client }) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-pretty text-foreground">
            {client.name}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="machine text-xs text-muted-foreground">{client.slug}</span>
            {client.domain ? (
              <a
                href={client.domain}
                target="_blank"
                rel="noreferrer noopener"
                className="machine inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                <span className="truncate">{displayDomain(client.domain)}</span>
                <ExternalLink className="size-3 shrink-0" aria-hidden />
              </a>
            ) : null}
            <IndustryBadge industry={client.industry} />
            {client.demo_mode ? <DemoBadge /> : null}
          </div>
        </div>

        {/* The view's ONE accent action, and it stays that way. The accent means "this is the
            action here", so a second accent button in the same viewport means neither is, and
            a second one carrying this same label makes the operator stop to work out whether
            the two do different things. Anything else pointing at /create from this page is
            outline or a plain link. */}
        <Button size="sm" asChild>
          <Link href={brandHref(orgSlug, client.slug, "/create")}>
            <PenLine data-icon="inline-start" aria-hidden />
            Create blogs
          </Link>
        </Button>
      </div>

      <PreflightNote preflight={client.preflight} className="mt-4" />
    </div>
  );
}

/**
 * Summarised with a link rather than inlining the upload panel, which lives on the Resources
 * page. Two upload targets for one set of files would leave an operator guessing which one
 * the researcher actually reads.
 */
function ResourcesSummary({ orgSlug, client }: { orgSlug: string; client: Client }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm font-medium text-foreground">Resources</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {client.resource_count === 0
            ? "No files yet. The researcher reads these before it searches anything external."
            : `${client.resource_count} file${client.resource_count === 1 ? "" : "s"} the researcher reads before searching anything external.`}
        </p>
        <Button size="sm" variant="outline" className="mt-3" asChild>
          <Link href={brandHref(orgSlug, client.slug, "/resources")}>
            {client.resource_count === 0 ? "Add resources" : "Manage resources"}
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

type Counts = {
  shipped: number;
  review: number;
  failed: number;
};

/**
 * Honest and small. A zero is stated plainly: dressing one up as an achievement would make
 * the numbers useless for the one thing they are for, which is seeing where work stands.
 *
 * The topic count arrives as a prop rather than from a fetch of its own, because the roadmap
 * card on this same page already holds it. Two reads of one CSV could disagree.
 */
function BrandStats({ client, topics }: { client: Client; topics: number | null }) {
  const [counts, setCounts] = React.useState<Counts | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();

    api.blogs(client.slug, controller.signal).then(
      (data) => {
        const list: BlogSummary[] = data.blogs;
        setCounts({
          shipped: list.filter((b) => b.shipped).length,
          review: list.filter((b) => b.status === "needs_review").length,
          failed: list.filter((b) => b.status === "failed").length,
        });
      },
      () => {
        // The blog scan failing costs this card its numbers, not the page its render. The
        // roadmap and resource counts below still come from data already in hand.
        setCounts({ shipped: 0, review: 0, failed: 0 });
      },
    );

    return () => controller.abort();
  }, [client.slug]);

  if (!counts) {
    return <Skeleton className="h-40" />;
  }

  return (
    <Card>
      <CardContent>
        <p className="text-sm font-medium text-foreground">Where this brand stands</p>
        <dl className="mt-3 flex flex-col gap-2">
          <StatRow label="Blogs shipped" value={counts.shipped} accent />
          <StatRow label="Needs review" value={counts.review} />
          <StatRow label="Failed" value={counts.failed} />
          <StatRow label="Resources" value={client.resource_count} />
          <StatRow label="Roadmap topics" value={topics} />
        </dl>
      </CardContent>
    </Card>
  );
}

function StatRow({
  label,
  value,
  accent = false,
}: {
  label: string;
  /** Null while the number is still unknown. A zero would be a claim, not a placeholder. */
  value: number | null;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          accent && value !== null && value > 0
            ? "machine text-sm font-medium text-primary"
            : "machine text-sm text-foreground"
        }
      >
        {value === null ? <Skeleton className="h-4 w-6" /> : value}
      </dd>
    </div>
  );
}
