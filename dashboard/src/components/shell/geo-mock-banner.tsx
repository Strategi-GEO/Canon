"use client";

import { TriangleAlert } from "lucide-react";
import { useOrgs } from "@/lib/orgs-context";

/**
 * A forgotten GEO_MOCK env switch quietly fills a live brand with unresearched drafts that
 * are saved exactly like real ones, so this warning has to be impossible to miss. Amber,
 * never the accent: the accent means a thing is working.
 */
export function GeoMockBanner() {
  const { geoMock } = useOrgs();

  if (!geoMock) {
    return null;
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 border-b border-review/30 bg-review-bg px-4 py-2.5 sm:px-6"
    >
      <TriangleAlert className="mt-px size-4 shrink-0 text-review" aria-hidden />
      <p className="text-xs leading-relaxed text-review">
        <span className="machine font-semibold">GEO_MOCK</span> is on. Every brand,
        including real ones, is producing fake precoded output and saving it as if it were
        real.
      </p>
    </div>
  );
}
