"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { DiscoveryBench } from "@/components/discovery/discovery-bench";

export default function QuestionsPage() {
  return (
    <BrandRoute>
      {({ brand }) => (
        <div className="mx-auto w-full max-w-4xl">
          <DiscoveryBench key={brand.slug} brandSlug={brand.slug} brandName={brand.name} />
        </div>
      )}
    </BrandRoute>
  );
}
