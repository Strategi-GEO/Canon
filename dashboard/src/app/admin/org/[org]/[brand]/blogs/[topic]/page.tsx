"use client";

import { useParams } from "next/navigation";
import { BrandRoute } from "@/components/shell/brand-route";
import { BlogStage } from "@/components/blogs/blog-stage";

/**
 * One blog's own page: the admin-review stage. The row in the library links here, and the
 * URL is the point: a blog under review is a thing an operator sends a teammate, so it
 * needs an address, not a drawer keyed on component state.
 */
export default function BlogStagePage() {
  const params = useParams<{ topic: string }>();
  const topicSlug = decodeURIComponent(params.topic);

  return (
    <BrandRoute>
      {({ org, brand }) => (
        <div className="mx-auto w-full max-w-5xl">
          <BlogStage
            key={`${brand.slug}:${topicSlug}`}
            orgSlug={org.slug}
            brandSlug={brand.slug}
            brandName={brand.name}
            topicSlug={topicSlug}
            demoMode={brand.demo_mode}
          />
        </div>
      )}
    </BrandRoute>
  );
}
