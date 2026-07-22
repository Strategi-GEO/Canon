"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { AnalysisOverview } from "@/components/analysis/analysis-overview";

export default function AnalysisPage() {
  return (
    <BrandRoute>
      {({ brand }) => (
        <div className="mx-auto w-full max-w-6xl">
          <AnalysisOverview key={brand.slug} brandSlug={brand.slug} brandName={brand.name} />
        </div>
      )}
    </BrandRoute>
  );
}
