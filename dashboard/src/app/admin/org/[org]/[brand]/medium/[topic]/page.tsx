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
        <ChannelReview
          key={`${brand.slug}:${topicSlug}`}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          channel="medium"
          topicSlug={topicSlug}
        />
      )}
    </BrandRoute>
  );
}
