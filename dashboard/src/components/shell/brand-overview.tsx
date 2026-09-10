"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, ExternalLink, Paperclip, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DiscoveryCard } from "@/components/discovery/discovery-card";
import { api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { useRoadmap } from "@/lib/use-roadmap";
import { IndustryBadge, PreflightNote } from "@/components/clients/client-meta";
import { displayDomain } from "@/components/clients/brand-card";
import { ReadOnlyText } from "@/components/clients/editable-text";
import { FactsCard } from "@/components/clients/facts-card";
import { RoadmapPanel } from "@/components/clients/roadmap-panel";
import { RoadmapGenerationStatus } from "@/components/roadmap/generation-status";
import { ReportGenerationStatus } from "@/components/reports/generation-status";
import { SessionCard } from "@/components/session/session-card";
import { resourceTypeLabel } from "@/components/clients/resource-type";
import { Badge } from "@/components/ui/badge";
import type { BlogSummary, Client, Resource } from "@/types";

/**
 * The operator's home for one brand, and the only page that renders it. An org holding
 * exactly one brand redirects here rather than rendering this inline, so a brand has one
 * canonical URL and the sidebar's active section can always match the address bar.
 */
export function BrandOverview({ orgSlug, brand }: { orgSlug: string; brand: Client }) {
  const client = brand;

  // Fetched ONCE here and handed to both cards that need it. The roadmap card and the stats
  // card each used to fetch it, so this page made two GETs for one CSV and could show two
  // different topic counts if the two landed on either side of an upload.
  const roadmap = useRoadmap(client.slug);

  // The blog scan, fetched once for the same reason: the stats card counts it and the roadmap
  // card stamps each row with its blog's real status, so two reads could disagree about
  // whether a topic shipped. Null while loading; a failed scan reads as an empty list, which
  // costs the cards their statuses, not the page its render.
  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    api.blogs(client.slug, controller.signal).then(
      (data) => setBlogs(data.blogs),
      () => setBlogs([]),
    );
    return () => controller.abort();
  }, [client.slug]);

  // This page writes NOTHING about the brand, so it holds no copy of one and needs no way to
  // put one back. The brand arrives as a prop from the org list, which stays the one source of
  // truth the sidebar and the switcher also read, and Settings is where a change to it is made
  // and re-read.

  return (
    // ONE TooltipProvider for this whole surface, like blogs-library and blog-stage: the state
    // tags on the cards below (BlogTag in RoadmapPanel) are Radix tooltips and crash without it.
    <TooltipProvider>
    <div className="mx-auto w-full max-w-5xl">
      <BrandHeader
        name={client.name}
        domain={client.domain}
        industry={client.industry}
        machineLine={client.slug}
        action={
          /* The view's ONE accent action, and it stays that way. The accent means "this is
              the action here", so a second accent button in the same viewport means neither
              is. Anything else pointing at /create from this page is outline or a plain
              link. */
          <Button size="sm" asChild>
            <Link href={brandHref(orgSlug, client.slug, "/create")}>
              <PenLine data-icon="inline-start" aria-hidden />
              Create blogs
            </Link>
          </Button>
        }
        footer={<PreflightNote preflight={client.preflight} className="mt-4" />}
      />

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
      />

      {/* The third long-running thing for this brand: a monthly report generation started on the
          Reports tab. Same reason as the roadmap card above, and it too renders nothing unless a
          generation is actually running, so an idle Overview pays for one read and shows nothing. */}
      <ReportGenerationStatus
        orgSlug={orgSlug}
        brandSlug={client.slug}
        brandName={client.name}
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          {/* Read only, and read only everywhere: the description is generated from the brand
              website by the engine and is never edited by hand, so no screen offers a way to
              change it. */}
          <ReadOnlyText
            title="Description"
            help="Generated automatically from the brand website when this brand was added. Every writer run reads it."
            value={client.description}
            emptyText="No description yet. It is generated from the brand website shortly after the brand is added."
          />

          {/* Read only. Uploading lives on the Content Roadmap tab and nowhere else, so this
              card no longer takes a file and has nothing to report back up. */}
          <RoadmapPanel
            orgSlug={orgSlug}
            brandSlug={client.slug}
            hasRoadmap={client.has_roadmap}
            roadmap={roadmap}
            blogs={blogs}
          />
        </div>

        <div className="flex flex-col gap-4">
          <BrandStats
            client={client}
            topics={roadmap.data?.rows.length ?? null}
            blogs={blogs}
          />
          <ResourcesSummary orgSlug={orgSlug} client={client} />
          <FactsCard client={client} />
          {/* Beside the fact base deliberately: this card is about what the fact base is
              MISSING, and the two read together. A pointer only, never a control, because
              generating spends real quota and sending puts model-written text in front of a
              client, so both presses belong on the tab where the questions are readable. */}
          <DiscoveryCard orgSlug={orgSlug} brandSlug={client.slug} />
        </div>
      </div>
    </div>
    </TooltipProvider>
  );
}

/**
 * The brand masthead, SHARED with the client portal's overview (portal/views.tsx): name,
 * domain link and industry badge are both audiences' facts; the slug line, the accent action
 * and the preflight footer are the admin's and arrive as props, so the portal simply passes
 * none of them.
 */
export function BrandHeader({
  name,
  domain,
  industry,
  machineLine,
  action,
  footer,
}: {
  name: string;
  domain: string;
  industry: string;
  /** The admin's slug line. Absent on the portal: a client is never shown machine ids. */
  machineLine?: string;
  action?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-pretty text-foreground">
            {name}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {machineLine !== undefined ? (
              <span className="machine text-xs text-muted-foreground">{machineLine}</span>
            ) : null}
            {domain ? (
              <a
                href={domain}
                target="_blank"
                rel="noreferrer noopener"
                className="machine inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
              >
                <span className="truncate">{displayDomain(domain)}</span>
                <ExternalLink className="size-3 shrink-0" aria-hidden />
              </a>
            ) : null}
            <IndustryBadge industry={industry} />
          </div>
        </div>

        {action}
      </div>

      {footer}
    </div>
  );
}

/** How many files the Overview names before it defers the rest to the Resources page. */
const RESOURCE_PREVIEW = 5;

/**
 * The first few files by name, then a link to the full page. It previews rather than inlining
 * the upload panel, which lives on the Resources page: two upload targets for one set of files
 * would leave an operator guessing which one the researcher actually reads.
 *
 * The count comes from the client record the org list already carries, so the empty state and
 * the header render before the file list lands. The names are a second read, and a failed one
 * costs this card its list, not its render.
 */
function ResourcesSummary({ orgSlug, client }: { orgSlug: string; client: Client }) {
  const [resources, setResources] = React.useState<Resource[] | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    api.resources(client.slug, controller.signal).then(
      (data) => setResources(data.resources),
      () => setResources([]),
    );
    return () => controller.abort();
  }, [client.slug]);

  return (
    <ResourcesSummaryCard
      total={client.resource_count}
      resources={resources}
      href={brandHref(orgSlug, client.slug, "/resources")}
    />
  );
}

/**
 * The card itself, SHARED with the client portal's overview: same preview list, same badge,
 * same defer-to-the-page button. The data arrives as props because the two surfaces fetch on
 * different wires (engine api here, the portal's Supabase routes there).
 */
export function ResourcesSummaryCard({
  total,
  resources,
  href,
}: {
  total: number;
  resources: Pick<Resource, "name" | "content_type">[] | null;
  href: string;
}) {
  const shown = resources?.slice(0, RESOURCE_PREVIEW) ?? [];
  const hidden = resources ? resources.length - shown.length : 0;

  return (
    <Card>
      <CardContent>
        <p className="text-sm font-medium text-foreground">Resources</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {total === 0
            ? "No files yet. The researcher reads these before it searches anything external."
            : `${total} file${total === 1 ? "" : "s"} the researcher reads before searching anything external.`}
        </p>

        {total > 0 ? (
          resources === null ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
              <Skeleton className="h-5" />
            </div>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {shown.map((resource) => (
                <li key={resource.name} className="flex items-center gap-2">
                  <Paperclip
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="machine min-w-0 flex-1 truncate text-xs text-foreground">
                    {resource.name}
                  </span>
                  <Badge variant="secondary" className="machine shrink-0">
                    {resourceTypeLabel(resource)}
                  </Badge>
                </li>
              ))}
              {hidden > 0 ? (
                <li className="text-xs text-muted-foreground">and {hidden} more</li>
              ) : null}
            </ul>
          )
        ) : null}

        <Button size="sm" variant="outline" className="mt-3" asChild>
          <Link href={href}>
            {total === 0 ? "Add resources" : "View resources"}
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Honest and small. A zero is stated plainly: dressing one up as an achievement would make
 * the numbers useless for the one thing they are for, which is seeing where work stands.
 *
 * The topic count and the blog list arrive as props rather than from fetches of their own,
 * because the roadmap card on this same page already holds both. Two reads of one thing
 * could disagree.
 */
function BrandStats({
  client,
  topics,
  blogs,
}: {
  client: Client;
  topics: number | null;
  blogs: BlogSummary[] | null;
}) {
  if (blogs === null) {
    return <Skeleton className="h-40" />;
  }

  const counts = {
    shipped: blogs.filter((b) => b.shipped).length,
    review: blogs.filter((b) => b.status === "needs_review").length,
    failed: blogs.filter((b) => b.status === "failed").length,
  };

  return (
    <Card>
      <CardContent>
        <p className="text-sm font-medium text-foreground">Where this brand stands</p>
        <dl className="mt-3 flex flex-col gap-2">
          <StatRow label="Blogs shipped" value={counts.shipped} accent />
          {/* The act, not a judgement on the draft: these blogs are held for an answer, and some
              of them are passing drafts whose question is still owed. */}
          <StatRow label="Waiting on you" value={counts.review} />
          <StatRow label="Failed" value={counts.failed} />
          <StatRow label="Resources" value={client.resource_count} />
          <StatRow label="Roadmap topics" value={topics} />
        </dl>
      </CardContent>
    </Card>
  );
}

/** One label/number line of the stats card. SHARED with the client portal's overview. */
export function StatRow({
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
