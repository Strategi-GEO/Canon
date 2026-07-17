"use client";

import { BrandRoute } from "@/components/shell/brand-route";
import { ResourcesPanel } from "@/components/clients/resources-panel";

/**
 * Resources are brand scoped like everything else: they are the knowledge base Agent R reads
 * before any external search, and a file under the wrong brand is a fact the writer could
 * cite into the wrong blog.
 */
export default function ResourcesPage() {
  return (
    <BrandRoute>
      {({ brand }) => (
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">Resources</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The knowledge base for {brand.name}. The researcher reads these before it
              searches anything external.
            </p>
          </div>
          <ResourcesPanel key={brand.slug} brandSlug={brand.slug} />
        </div>
      )}
    </BrandRoute>
  );
}
