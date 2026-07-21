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
          />
        </div>
      )}
    </BrandRoute>
  );
}
