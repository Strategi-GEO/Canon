"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ReportsOverview } from "@/components/reports/reports-overview";

export default function ReportsPage() {
  return (
    <BrandRoute>
      {({ brand }) => (
        <div className="mx-auto w-full max-w-6xl">
          <ReportsOverview key={brand.slug} brandSlug={brand.slug} brandName={brand.name} />
        </div>
      )}
    </BrandRoute>
  );
}
