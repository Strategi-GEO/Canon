"use client";

import Link from "next/link";
import { ArrowRight, ExternalLink, FileText, Map, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { brandHref } from "@/lib/orgs-context";
import type { Client } from "@/types";
import { DemoBadge, IndustryBadge, PreflightNote } from "@/components/clients/client-meta";

/**
 * One BRAND: the engine's unit of work, and the only place blogs can be created.
 *
 * A brand owns exactly one canonical-facts.md, one never-claim list, one entity-name set and
 * one roadmap. Its org is a grouping above it, never a merge: if two brands shared a fact
 * base the writer could cite brand A's verified facts inside brand B's blog.
 *
 * The org and the brand both arrive as data, and the URLs are built from lib/orgs-context,
 * which owns the route shape. This card never reads either slug from a context or the URL.
 */
export function BrandCard({ orgSlug, brand }: { orgSlug: string; brand: Client }) {
  return (
    <Card className="group relative flex flex-col transition-colors hover:border-primary/40 focus-within:border-primary/40">
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/*
              The whole card opens the brand, via one link stretched over it by the ::after
              rather than by an Open button in the corner. Two reasons. A card in a grid reads
              as one target, so anything less than the whole card is a hit area the operator
              has to aim for. And an Open button plus a clickable title would be the same
              duplicate-path defect twice on one card. Everything that is NOT "open this
              brand" has to sit above the overlay on its own z layer.
            */}
            <h3 className="truncate text-sm font-semibold text-foreground">
              <Link
                href={brandHref(orgSlug, brand.slug)}
                className="outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
              >
                {brand.name}
              </Link>
            </h3>
            <p className="machine mt-0.5 truncate text-xs text-muted-foreground">
              {brand.slug}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {brand.demo_mode ? <DemoBadge /> : null}
            {/* Points where the card goes. Motion is suppressed globally under reduced motion. */}
            <ArrowRight
              className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <IndustryBadge industry={brand.industry} />
          {brand.domain ? (
            <a
              href={brand.domain}
              target="_blank"
              rel="noreferrer noopener"
              className="machine relative z-10 inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <span className="truncate">{displayDomain(brand.domain)}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </a>
          ) : null}
        </div>

        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <Stat icon={FileText} label="blogs" value={String(brand.blog_count)} />
          <Stat icon={Paperclip} label="resources" value={String(brand.resource_count)} />
          <Stat icon={Map} label="roadmap" value={brand.has_roadmap ? "yes" : "none"} />
        </dl>

        <PreflightNote preflight={brand.preflight} className="mt-auto" />

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          {/*
            Creating blogs is only ever reachable from inside a brand, and this is a shortcut
            to that one place, not a second way to open the card. z-10 lifts it off the
            overlay above: without it the stretched link would swallow the click and send the
            operator to the overview instead of to create, which is the exact bug this
            pattern is known for.
          */}
          <Button size="sm" variant="outline" className="relative z-10" asChild>
            <Link href={brandHref(orgSlug, brand.slug, "/create")}>Create blogs</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <Icon className="size-3 shrink-0" aria-hidden />
      <dt className="sr-only">{label}</dt>
      <dd>
        <span className="machine text-foreground">{value}</span> {label}
      </dd>
    </div>
  );
}

/** The domain without its scheme, so a card column stays scannable. */
export function displayDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
