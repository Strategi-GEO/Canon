"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineDown } from "@/components/clients/engine-error";
import { brandHref, orgHref, useOrgs, type BrandLocation } from "@/lib/orgs-context";
import { parseBrandPath } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

/**
 * Resolves /org/[org]/[brand] into a real org and brand, or into an honest end state.
 *
 * Three cases matter and each gets a different answer:
 *  - the brand lives in a DIFFERENT org: redirect to where it actually lives. The operator
 *    followed a stale link, and the right answer is the page they wanted, not a 404.
 *  - the brand does not exist anywhere: a not found state that NAMES what was not found.
 *  - the engine did not answer: the engine's own reason, never an empty "no such brand",
 *    which would blame the operator for the server being down.
 */
export function BrandRoute({
  children,
}: {
  children: (location: BrandLocation) => React.ReactNode;
}) {
  const params = useParams<{ org: string; brand: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { loading, error, findBrand, refresh } = useOrgs();

  const orgSlug = params.org;
  const brandSlug = params.brand;
  const located = findBrand(brandSlug);
  const section = parseBrandPath(pathname)?.section ?? "";

  // A brand in the wrong org is a redirect, not an error, so it belongs in an effect rather
  // than in render. `replace` keeps the stale URL out of the back stack: going back should
  // return the operator to where they came from, not bounce them through the redirect again.
  const wrongOrg = located !== null && located.org.slug !== orgSlug;
  React.useEffect(() => {
    if (wrongOrg && located) {
      router.replace(brandHref(located.org.slug, located.brand.slug, section));
    }
  }, [wrongOrg, located, router, section]);

  if (loading) {
    return <BrandRouteSkeleton section={section} />;
  }

  if (error) {
    return <EngineDown error={error} onRetry={() => void refresh()} />;
  }

  if (!located) {
    return <BrandNotFound orgSlug={orgSlug} brandSlug={brandSlug} />;
  }

  if (wrongOrg) {
    // The redirect above is already in flight. A skeleton beats flashing the brand under an
    // org it does not belong to.
    return <BrandRouteSkeleton section={section} />;
  }

  return <>{children(located)}</>;
}

/**
 * Shaped per section, because a skeleton's whole job is to hold the space the real content
 * will take. Resources and Settings render inside max-w-3xl and the rest inside max-w-5xl, so
 * one shared width guaranteed a sideways jump on two of the five sections at the moment the
 * org list settled. The section is already in the path, so the right shape is free.
 */
function BrandRouteSkeleton({ section }: { section: string }) {
  const narrow = section === "/resources" || section === "/settings";

  return (
    <div className={cn("mx-auto w-full", narrow ? "max-w-3xl" : "max-w-5xl")}>
      {/* Every section opens with a heading and one line of help under it. */}
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80" />

      {narrow ? (
        <div className="mt-6 flex flex-col gap-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-4 lg:col-span-2">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      )}

      <span className="sr-only" role="status">
        Loading
      </span>
    </div>
  );
}

/** Names the thing that was not found: "not found" without a subject is a dead end. */
export function BrandNotFound({
  orgSlug,
  brandSlug,
}: {
  orgSlug: string;
  brandSlug: string;
}) {
  const { findOrg } = useOrgs();
  const org = findOrg(orgSlug);

  return (
    <NotFoundCard
      title={org ? "No such brand" : "No such organisation"}
      slug={org ? brandSlug : orgSlug}
      body={
        org
          ? `The organisation ${org.name} has no brand with this slug. It may have been renamed, or it may never have existed.`
          : "No organisation with this slug is on the engine. It may have been renamed, or it may never have existed."
      }
    />
  );
}

/**
 * A dead end that names the slug it could not resolve, then lists what DOES exist.
 *
 * A bare "not found" makes the operator's next move a guess. The engine already knows every
 * org and brand it holds, so the recovery is one click rather than a walk back to the root,
 * and seeing the real list is also how a typo explains itself.
 */
export function NotFoundCard({
  title,
  slug,
  body,
}: {
  title: string;
  slug: string;
  body: string;
}) {
  const { orgs, error } = useOrgs();

  return (
    <div className="mx-auto w-full max-w-md">
      <Card>
        <CardContent className="py-10 text-center">
          <SearchX className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
          <p className="machine mt-1.5 text-xs wrap-anywhere text-muted-foreground">{slug}</p>
          <p className="mx-auto mt-3 max-w-sm text-xs text-muted-foreground">{body}</p>

          {/* With the engine unreachable the list would be empty for a reason that has
              nothing to do with this slug, and an empty list would read as "you have no
              clients". Saying nothing is the honest option. */}
          {orgs.length > 0 && !error ? (
            <div className="mt-5 text-left">
              <p className="text-xs font-medium text-foreground">On this engine</p>
              <ul className="mt-2 flex flex-col divide-y border-y">
                {orgs.map((org) => (
                  <li key={org.slug}>
                    <Link
                      href={orgHref(org.slug)}
                      className="flex items-center gap-2 rounded-sm px-1 py-2 text-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className="min-w-0 flex-1 truncate">{org.name}</span>
                      <span className="machine shrink-0 text-xs text-muted-foreground">
                        {org.brands.length} {org.brands.length === 1 ? "brand" : "brands"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Button variant="outline" size="sm" className="mt-5" asChild>
            <Link href="/">Go to your clients</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
