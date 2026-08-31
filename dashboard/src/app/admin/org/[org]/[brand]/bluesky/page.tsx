"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelLibrary } from "@/components/blogs/channel-library";

/** The Bluesky tab for one brand: a New sub-tab of every blog (finished ones selectable) and a
 *  Created sub-tab of the generated posts, each with its own review page. Mirrors LinkedIn and
 *  Medium exactly. The one difference is upstream and invisible here: a CMS publish never
 *  auto-generates a Bluesky post (server/repurpose.py AUTO_CHANNELS), so every post on this tab
 *  came from an operator ticking blogs and pressing Generate. */
export default function BlueskyPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <ChannelLibrary
          key={brand.slug}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          brandName={brand.name}
          channel="bluesky"
          title="Bluesky"
          blurb={`Turn finished blogs into native Bluesky posts for ${brand.name}. Select the blogs you want, then generate.`}
        />
      )}
    </BrandRoute>
  );
}
