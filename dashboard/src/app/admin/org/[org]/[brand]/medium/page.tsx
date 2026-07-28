"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelLibrary } from "@/components/blogs/channel-library";

/** The Medium tab for one brand: a New sub-tab of every blog (finished ones selectable) and a
 *  Created sub-tab of the generated articles, each with its own review page. Mirrors LinkedIn. */
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
          blurb={`Turn finished blogs into native Medium articles for ${brand.name}.`}
        />
      )}
    </BrandRoute>
  );
}
