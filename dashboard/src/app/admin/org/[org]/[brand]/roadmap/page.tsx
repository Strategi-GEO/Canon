"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { RoadmapOverview } from "@/components/roadmap/roadmap-overview";

/**
 * The content roadmap, brand scoped like everything else.
 *
 * One brand owns exactly one roadmap, the same way it owns one canonical-facts.md, so there
 * is no global roadmap page to write: it would have to ask which brand first, and that
 * question is this route.
 *
 * This tab is the roadmap's own place: what is planned, what is written, what is left. Create
 * Blogs picks topics FROM it and is a different job, which is why it is a different tab and
 * why the rows themselves live there rather than here.
 */
export default function RoadmapPage() {
  return (
    <BrandRoute>
      {({ brand }) => (
        <div className="mx-auto w-full max-w-5xl">
          {/* Keyed by brand, so switching brand remounts rather than leaking one brand's
              roadmap, a half open delete confirm, or a generation dialog holding another
              brand's URL, into another's.

              The domain is passed rather than looked up: the ROUTE owns which brand this is,
              and a dialog that resolved its own would be one refactor away from prefilling the
              wrong company's site into a live research session. */}
          <RoadmapOverview
            key={brand.slug}
            brandSlug={brand.slug}
            brandName={brand.name}
            brandDomain={brand.domain}
          />
        </div>
      )}
    </BrandRoute>
  );
}
