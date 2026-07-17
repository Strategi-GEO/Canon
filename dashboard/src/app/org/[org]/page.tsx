"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineDown } from "@/components/clients/engine-error";
import { NotFoundCard } from "@/components/shell/brand-route";
import { BrandCard } from "@/components/clients/brand-card";
import { AddBrandDialog } from "@/components/clients/add-brand-dialog";
import { brandHref, useOrgs, writeLastOrg } from "@/lib/orgs-context";
import type { Client, Org } from "@/types";

/**
 * The org home, and the ONE case it earns its existence: an org holding two or more brands.
 *
 * An org owns no canonical facts, no roadmap and no never-claim list. The brand owns all
 * three, so an org is a grouping and never a place work happens. That makes a single-brand
 * org home a floor with nothing on it, which is exactly what an operator photographed: the
 * org switcher, and then a blank column where the brand nav should be. So a single-brand org
 * redirects to its brand and this page renders a portfolio only when there is a portfolio.
 */
export default function OrgPage() {
  const params = useParams<{ org: string }>();
  const router = useRouter();
  const { findOrg, loading, error, refresh } = useOrgs();
  const org = findOrg(params.org);

  // The last org drives the / redirect only. Written here, when an org is genuinely on
  // screen, so it can never record an org the operator never reached.
  React.useEffect(() => {
    if (org) {
      writeLastOrg(org.slug);
    }
  }, [org]);

  /**
   * One brand means the org and the brand are the same entity, so the brand's own URL is the
   * only honest address for it. `replace`, not `push`: this URL is a waypoint and nothing
   * else, and leaving it in the back stack would bounce the operator straight back through
   * the redirect the moment they pressed Back.
   *
   * This also kills a whole bug class. Rendering the brand inline here left the sidebar's
   * Overview link pointing at /org/<org>/<brand> while the address bar said /org/<org>, so
   * the active-section highlight could never match. One canonical URL per brand, always.
   */
  const only = org && org.brands.length === 1 ? org.brands[0] : null;
  React.useEffect(() => {
    if (org && only) {
      router.replace(brandHref(org.slug, only.slug));
    }
  }, [org, only, router]);

  if (loading) {
    return <OrgSkeleton />;
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-md">
        <EngineDown error={error} onRetry={() => void refresh()} />
      </div>
    );
  }

  if (!org) {
    return (
      <NotFoundCard
        title="No such organisation"
        slug={params.org}
        body="No organisation with this slug is on the engine. It may have been renamed, or it may never have existed."
      />
    );
  }

  if (only) {
    // The redirect above is already in flight. A skeleton beats flashing a portfolio of one.
    return <OrgSkeleton />;
  }

  if (org.brands.length === 0) {
    return <EmptyOrg org={org} onCreated={() => void refresh()} />;
  }

  return <OrgPortfolio org={org} onCreated={() => void refresh()} />;
}

function OrgSkeleton() {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80" />
      <Skeleton className="mt-6 h-16 w-full" />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
      <span className="sr-only" role="status">
        Loading the organisation
      </span>
    </div>
  );
}

/**
 * An org with no brands is reachable only in the seconds after its last brand is deleted off
 * disk, because the grouping is derived from the clients that exist. It still needs a real
 * answer rather than a blank page.
 */
function EmptyOrg({ org, onCreated }: { org: Org; onCreated: () => void }) {
  const router = useRouter();

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardContent className="py-10 text-center">
          <Building2 className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium text-foreground">{org.name} has no brands</p>
          <p className="mx-auto mt-2 max-w-sm text-xs text-muted-foreground">
            An organisation is a grouping over brands and holds no facts of its own. Nothing
            can be written until a brand exists under it.
          </p>
          <div className="mt-5 flex justify-center">
            <AddBrandDialog
              organisations={[org.name]}
              defaultOrganisationName={org.name}
              lockOrganisation
              onCreated={async (brand) => {
                onCreated();
                router.push(brandHref(org.slug, brand.slug));
              }}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** The portfolio: what is under this org, and where the work stands across all of it. */
function OrgPortfolio({ org, onCreated }: { org: Org; onCreated: () => void }) {
  const router = useRouter();

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{org.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="machine">{org.brands.length}</span> brands. Each one keeps its
            own canonical facts, roadmap and never-claim list, so pick the one you are
            writing for.
          </p>
        </div>
        {/* Prefilled and locked: adding a brand from inside an org cannot mean another org,
            so the field states the answer rather than asking a question already settled. */}
        <AddBrandDialog
          organisations={[org.name]}
          defaultOrganisationName={org.name}
          lockOrganisation
          onCreated={async (brand) => {
            // The grouping is derived from the client list, so the new brand only has an org
            // to route to once the list has been re-read.
            onCreated();
            router.push(brandHref(org.slug, brand.slug));
          }}
        />
      </div>

      <OrgAggregate brands={org.brands} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {org.brands.map((brand) => (
          <BrandCard key={brand.slug} orgSlug={org.slug} brand={brand} />
        ))}
      </div>
    </div>
  );
}

/**
 * Totals across the org's brands, read straight off the brands the org payload already
 * carries. No fetch: every number here is a sum of fields in hand, and inventing an
 * aggregate endpoint for arithmetic over five objects would be a round trip for nothing.
 *
 * These three are the ones that change what the operator does next: blogs is the output,
 * and the other two are the two reasons a brand cannot produce any.
 */
function OrgAggregate({ brands }: { brands: Client[] }) {
  const blogs = brands.reduce((total, brand) => total + brand.blog_count, 0);
  const noRoadmap = brands.filter((brand) => !brand.has_roadmap).length;
  const unreviewed = brands.filter((brand) => brand.preflight && !brand.preflight.ok).length;

  return (
    <Card>
      <CardContent className="flex flex-wrap gap-x-10 gap-y-3">
        <Figure label="Blogs written" value={blogs} />
        <Figure
          label={noRoadmap === 1 ? "brand has no roadmap" : "brands have no roadmap"}
          value={noRoadmap}
          tone={noRoadmap > 0 ? "review" : "plain"}
        />
        <Figure
          label={unreviewed === 1 ? "brand awaits a facts review" : "brands await a facts review"}
          value={unreviewed}
          tone={unreviewed > 0 ? "review" : "plain"}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Amber only when the number is a thing to act on. A zero here is good news, so it reads as
 * plain text: colouring every figure would make the colour mean nothing.
 */
function Figure({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: number;
  tone?: "plain" | "review";
}) {
  return (
    <div className="min-w-0">
      <p
        className={
          tone === "review" && value > 0
            ? "machine text-xl font-medium text-review"
            : "machine text-xl font-medium text-foreground"
        }
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
