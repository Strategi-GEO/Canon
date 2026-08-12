"use client";

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * /create IS NOW /blogs?tab=new, and this is the redirect that keeps every old link working.
 *
 * Creating a blog and reading the blogs it produced were two tabs describing one pipeline, and
 * they are one page with four subtabs now. This route stays because nine places link to it: the
 * brand overview, the brand card, the roadmap panel, the sessions indicator, the session card,
 * two /create children, the blogs empty state, and the blog stage's own Retry.
 *
 * THE QUERY STRING IS CARRIED THROUGH, and that is the whole reason this is a component rather
 * than a redirect in next.config. `?retry=<slug>` is how a failed blog's page sends its topic back
 * pre-ticked, and dropping it would turn every retry into an unfiltered list the operator has to
 * search. SelectState admits a retried row whatever its state, so the row is on the New tab
 * waiting even though the partition would otherwise have filed it under Internal review.
 *
 * REPLACE, not push, so Back goes where the operator came from rather than bouncing through here.
 */
export default function CreateRedirectPage() {
  const params = useParams<{ org: string; brand: string }>();
  const search = useSearchParams();
  const router = useRouter();

  const org = encodeURIComponent(params.org);
  const brand = encodeURIComponent(params.brand);
  const rest = search.toString();
  const href = `/admin/org/${org}/${brand}/blogs?tab=new${rest ? `&${rest}` : ""}`;

  React.useEffect(() => {
    router.replace(href);
  }, [router, href]);

  // A skeleton rather than nothing: this renders for one frame, and a blank page in that frame
  // reads as a route that failed to load.
  return (
    <div className="mx-auto w-full max-w-6xl">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-4 h-80 w-full" />
      <span className="sr-only" role="status">
        Opening blogs
      </span>
    </div>
  );
}
