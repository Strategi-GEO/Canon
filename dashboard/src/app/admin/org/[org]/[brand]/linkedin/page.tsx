"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { PostedLibrary } from "@/components/blogs/posted-library";

/** Posted blogs for one brand, ready to share on LinkedIn. Same table as Blogs, filtered to
 *  the `published` ("posted") state. */
export default function LinkedInPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <PostedLibrary
          key={brand.slug}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          brandName={brand.name}
          title="LinkedIn"
          blurb={`Posted blogs ready to share on LinkedIn for ${brand.name}.`}
        />
      )}
    </BrandRoute>
  );
}
