"use client";

import { useParams } from "next/navigation";
import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelReview } from "@/components/blogs/channel-review";

/** Review one blog's generated Medium article. Its own URL, so an operator can link a teammate
 *  straight to the piece. */
export default function MediumReviewPage() {
  const params = useParams<{ topic: string }>();
  const topicSlug = decodeURIComponent(params.topic);

  return (
    <BrandRoute>
      {({ org, brand }) => (
        // max-w-5xl, the same shell blogs/[topic] uses. The width is set HERE rather than inside
        // ChannelReview so all three review pages read their page width from their own route, and
        // a change to one is visibly a change to one.
        <div className="mx-auto w-full max-w-5xl">
          <ChannelReview
            key={`${brand.slug}:${topicSlug}`}
            orgSlug={org.slug}
            brandSlug={brand.slug}
            channel="medium"
            topicSlug={topicSlug}
          />
        </div>
      )}
    </BrandRoute>
  );
}
