"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelLibrary } from "@/components/blogs/channel-library";

/** Posted blogs for one brand, each generating into a native LinkedIn post. Same published set
 *  the Blogs and Medium tabs read, with a per-blog Generate -> Review pipeline. */
export default function LinkedInPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <ChannelLibrary
          key={brand.slug}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          brandName={brand.name}
          channel="linkedin"
          title="LinkedIn"
          blurb={`Turn posted blogs into native LinkedIn posts for ${brand.name}.`}
        />
      )}
    </BrandRoute>
  );
}
