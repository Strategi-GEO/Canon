"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { BrandOverview } from "@/components/shell/brand-overview";

export default function BrandOverviewPage() {
  return (
    <BrandRoute>
      {({ org, brand }) => <BrandOverview orgSlug={org.slug} brand={brand} />}
    </BrandRoute>
  );
}
