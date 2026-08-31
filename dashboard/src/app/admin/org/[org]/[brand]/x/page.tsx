"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelLibrary } from "@/components/blogs/channel-library";

/** The X tab for one brand: a New sub-tab of every blog (finished ones selectable) and a Created
 *  sub-tab of the generated threads, each with its own review page. Mirrors LinkedIn and Medium
 *  exactly. The one difference is upstream and invisible here: a CMS publish never auto-generates
 *  an X thread (server/repurpose.py AUTO_CHANNELS), so every piece on this tab came from an
 *  operator ticking blogs and pressing Generate. */
export default function XPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <ChannelLibrary
          key={brand.slug}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          brandName={brand.name}
          channel="x"
          title="X"
          blurb={`Turn finished blogs into native X threads for ${brand.name}. Select the blogs you want, then generate.`}
        />
      )}
    </BrandRoute>
  );
}
