"use client";

import { useParams } from "next/navigation";
import { BrandRoute } from "@/components/shell/brand-route";
import { ChannelReview } from "@/components/blogs/channel-review";

/** Review one blog's generated LinkedIn post. Its own URL, so an operator can link a teammate
 *  straight to the piece. */
export default function LinkedInReviewPage() {
  const params = useParams<{ topic: string }>();
  const topicSlug = decodeURIComponent(params.topic);

  return (
    <BrandRoute>
      {({ org, brand }) => (
        <ChannelReview
          key={`${brand.slug}:${topicSlug}`}
          orgSlug={org.slug}
          brandSlug={brand.slug}
          channel="linkedin"
          topicSlug={topicSlug}
        />
      )}
    </BrandRoute>
  );
}
