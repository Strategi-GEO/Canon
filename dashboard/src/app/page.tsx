"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { EngineDown } from "@/components/clients/engine-error";
import { orgHref, readLastOrg, useOrgs } from "@/lib/orgs-context";

/**
 * There is no global dashboard. The root is a signpost: it sends the operator to an org and
 * nothing else, because every real page in this app is scoped to a brand under an org.
 *
 * Order: the last org they used, else the first alphabetically, else /new when the engine
 * holds no clients at all. localStorage is consulted ONLY here, and only for this choice.
 */
export default function RootPage() {
  const router = useRouter();
  const { orgs, loading, error, refresh } = useOrgs();

  React.useEffect(() => {
    if (loading || error) {
      return;
    }

    if (orgs.length === 0) {
      router.replace("/new");
      return;
    }

    // A stored org can name one that was renamed or removed since, so it is a preference to
    // be validated, never a destination to be trusted.
    const stored = readLastOrg();
    const target = orgs.find((org) => org.slug === stored) ?? orgs[0];
    router.replace(orgHref(target.slug));
  }, [orgs, loading, error, router]);

  if (error) {
    return (
      <div className="mx-auto w-full max-w-md">
        <EngineDown error={error} onRetry={() => void refresh()} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="mt-4 h-64 w-full" />
      <span className="sr-only" role="status">
        Opening your clients
      </span>
    </div>
  );
}
