"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { Building2, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineDown, FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import { NotFoundCard } from "@/components/shell/brand-route";
import { BrandCard } from "@/components/clients/brand-card";
import { AddBrandDialog } from "@/components/clients/add-brand-dialog";
import { brandHref, useOrgs, writeLastOrg } from "@/lib/orgs-context";
import type { Client, Org } from "@/types";

/**
 * The org home, and the ONE case it earns its existence: an org holding two or more brands.
 *
 * An org owns no canonical facts and no roadmap. The brand owns all
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
 * An org with no brands: what is left after its last brand is deleted, and the ONLY page that
 * can act on that state. It offers the two things an operator can want here and there is no
 * third: put a brand back under it, or delete the organisation.
 *
 * This card was unreachable code until list_orgs (server/clients.py) began listing brandless
 * orgs. Grouping orgs from the clients alone meant the last brand leaving took the org off every
 * surface at once, while the row and its live portal grant stayed in the database, so what a
 * brand delete actually produced was an invisible tenant with no door.
 */
function EmptyOrg({ org, onCreated }: { org: Org; onCreated: () => void }) {
  const router = useRouter();

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardContent className="py-10 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
            <Building2 className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">{org.name} has no brands</p>
          <p className="mx-auto mt-2 max-w-sm text-xs text-muted-foreground">
            An organisation is a grouping over brands and holds no facts of its own. Nothing
            can be written until a brand exists under it.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <AddBrandDialog
              organisations={[org.name]}
              defaultOrganisationName={org.name}
              lockOrganisation
              onCreated={async (brand) => {
                onCreated();
                router.push(brandHref(org.slug, brand.slug));
              }}
            />
            {/* An engine write, so the hosted read-only build offers it no more than it offers
                Add brand. Routing home rather than refreshing in place: this page is about an
                org that no longer exists by the time the dialog closes. */}
            {HOSTED_READONLY ? null : (
              <DeleteOrganisationCardDialog
                org={org}
                onDeleted={() => {
                  onCreated();
                  router.replace("/");
                }}
              />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The confirm for deleting an EMPTY organisation. ONE gate, not the brand delete's two, and the
 * asymmetry is the honest one: an empty org holds no blogs, no roadmap and no resources, so the
 * only thing this destroys is the grouping and its client portal login. A slug retype in front
 * of that would be ceremony teaching operators to type through confirms that do matter.
 *
 * The login is named rather than implied. It is the one consequence that reaches outside this
 * machine: whoever the client is, their password stops working the moment this is pressed.
 */
function DeleteOrganisationCardDialog({ org, onDeleted }: { org: Org; onDeleted: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function remove() {
    setSubmitting(true);
    setError(null);
    try {
      await api.deleteOrg(org.slug);
      toast.success(`Deleted ${org.name}`);
      setOpen(false);
      onDeleted();
    } catch (cause) {
      // 409 means a brand appeared under it since this page loaded, and the engine's sentence
      // names which. It belongs on screen verbatim rather than as "could not delete".
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 data-icon="inline-start" aria-hidden />
          Delete organisation
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {org.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It holds no brands, so nothing written is lost. This removes the organisation and
            revokes its client portal login, so the password sent to the client stops working. It
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <FieldError error={error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={submitting}>
            Cancel
          </AlertDialogCancel>
          <Button size="sm" variant="destructive" disabled={submitting} onClick={() => void remove()}>
            {submitting ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Delete organisation
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
            own canonical facts and roadmap, so pick the one you are writing for.
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
