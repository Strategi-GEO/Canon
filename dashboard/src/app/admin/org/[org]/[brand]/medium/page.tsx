"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelLibrary } from "@/components/blogs/channel-library";

/** Posted blogs for one brand, each generating into a native Medium article. Same published set
 *  the Blogs and LinkedIn tabs read, with a per-blog Generate -> Review pipeline. */
export default function MediumPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <ChannelLibrary
          key={brand.slug}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          brandName={brand.name}
          channel="medium"
          title="Medium"
          blurb={`Turn posted blogs into native Medium articles for ${brand.name}.`}
        />
      )}
    </BrandRoute>
  );
}
