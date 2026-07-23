"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { PostedLibrary } from "@/components/blogs/posted-library";

/** Posted blogs for one brand, ready to publish on Medium. Same table as Blogs, filtered to
 *  the `published` ("posted") state. */
export default function MediumPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <PostedLibrary
          key={brand.slug}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          brandName={brand.name}
          title="Medium"
          blurb={`Posted blogs ready to publish on Medium for ${brand.name}.`}
        />
      )}
    </BrandRoute>
  );
}
