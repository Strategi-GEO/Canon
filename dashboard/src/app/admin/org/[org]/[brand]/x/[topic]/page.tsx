"use client";

import { useParams } from "next/navigation";
import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelReview } from "@/components/blogs/channel-review";

/** Review one blog's generated X thread. Its own URL, so an operator can link a teammate
 *  straight to the piece. */
export default function XReviewPage() {
  const params = useParams<{ topic: string }>();
  const topicSlug = decodeURIComponent(params.topic);

  return (
    <BrandRoute>
      {({ org, brand }) => (
        // max-w-5xl, the same shell blogs/[topic] uses. The width is set HERE rather than inside
        // ChannelReview so every review page reads its page width from its own route, and a
        // change to one is visibly a change to one.
        <div className="mx-auto w-full max-w-5xl">
          <ChannelReview
            key={`${brand.slug}:${topicSlug}`}
            orgSlug={org.slug}
            brandSlug={brand.slug}
            channel="x"
            topicSlug={topicSlug}
          />
        </div>
      )}
    </BrandRoute>
  );
}
