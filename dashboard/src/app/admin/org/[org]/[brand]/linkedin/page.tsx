"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelLibrary } from "@/components/blogs/channel-library";

/** The LinkedIn tab for one brand: a New sub-tab of every blog (finished ones selectable) and a
 *  Created sub-tab of the generated posts, each with its own review page. Mirrors Medium. */
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
          blurb={`Turn finished blogs into native LinkedIn posts for ${brand.name}.`}
        />
      )}
    </BrandRoute>
  );
}
