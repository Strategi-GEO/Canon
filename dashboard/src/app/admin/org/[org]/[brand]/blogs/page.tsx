"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { BlogsLibrary } from "@/components/blogs/blogs-library";

/**
 * One brand's blogs. The library reads /api/clients/{brand}/blogs, which SCANS THE DISK, so a
 * blog is reachable exactly when it exists as a file and no sooner. Nothing caches around it.
 */
export default function BlogsPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <div className="mx-auto w-full max-w-5xl">
          <BlogsLibrary
            key={brand.slug}
            orgSlug={org.slug}
            brandSlug={brand.slug}
            brandName={brand.name}
            // Straight off the client record this route already resolved, for the New tab: the
            // create flow needs all three and /api/clients carries them on every brand, so this
            // costs no fetch. custom_instructions is absent on the hosted read, coalesced to "".
            brandInstructions={brand.custom_instructions ?? ""}
            hasCanonicalFacts={brand.has_canonical_facts}
            resourceCount={brand.resource_count}
          />
        </div>
      )}
    </BrandRoute>
  );
}
