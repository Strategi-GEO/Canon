"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { CreateForBrand } from "@/components/create/create-for-brand";
import { useOrgs } from "@/lib/orgs-context";

/**
 * The ONLY place a blog starts, and it is reachable only from inside a brand.
 *
 * There is no global create page on purpose: a blog needs canonical facts, a roadmap and a
 * never-claim list to be written at all, and every one of those belongs to exactly one brand.
 * A global create page would have to ask which brand first, which is this page.
 */
export default function CreatePage() {
  const { geoMock } = useOrgs();

  return (
    <BrandRoute>
      {({ org, brand }) => (
        <div className="mx-auto w-full max-w-5xl">
          {/* Keyed by brand, so switching brand remounts rather than leaking one brand's
              selection or run into another's. */}
          <CreateForBrand
            key={brand.slug}
            orgSlug={org.slug}
            brandSlug={brand.slug}
            brandName={brand.name}
            // Straight off the client record this route already resolved. Generate warns when a
            // brand has neither, and the answer is on the brand the route located rather than
            // behind a fetch of its own.
            hasCanonicalFacts={brand.has_canonical_facts}
            resourceCount={brand.resource_count}
            demoMode={brand.demo_mode}
            geoMock={geoMock}
          />
          <LocalEngineNote />
        </div>
      )}
    </BrandRoute>
  );
}

/**
 * Said once, quietly, near the live view. The run lives in the local uvicorn process and
 * every status line is written to status.jsonl on disk as it happens, so this tab holds
 * nothing but a read only SSE connection. Operators do not know that, and one who believes a
 * refresh kills a 40 minute run will sit and guard a tab that needs no guarding.
 */
function LocalEngineNote() {
  return (
    <p className="mt-6 text-center text-xs text-muted-foreground">
      This runs on the local engine, so you can close this tab and come back. Nothing here
      cancels a run.
    </p>
  );
}
