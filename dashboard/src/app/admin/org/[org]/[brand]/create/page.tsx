"use client";

import Link from "next/link";
import { BookOpen, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BrandRoute } from "@/components/shell/brand-route";
import { CreateForBrand } from "@/components/create/create-for-brand";
import { HOSTED_READONLY } from "@/lib/hosted";
import { brandHref } from "@/lib/orgs-context";

/**
 * The ONLY place a blog starts, and it is reachable only from inside a brand.
 *
 * There is no global create page on purpose: a blog needs canonical facts and a roadmap to be
 * written at all, and every one of those belongs to exactly one brand. A global create page
 * would have to ask which brand first, which is this page.
 */
export default function CreatePage() {
  return (
    <BrandRoute>
      {({ org, brand }) => (
        <div className="mx-auto w-full max-w-5xl">
          {/* The whole create surface needs the live engine: picking rows exists to POST
              /generate, and the live view is an SSE stream from the engine's status files.
              The hosted build renders the honest state instead of a form that can only be
              refused, and points at the read views that do work here. */}
          {HOSTED_READONLY ? (
            <HostedReadOnly
              blogsHref={brandHref(org.slug, brand.slug, "/blogs")}
              roadmapHref={brandHref(org.slug, brand.slug, "/roadmap")}
            />
          ) : (
            <>
              {/* Keyed by brand, so switching brand remounts rather than leaking one brand's
                  selection or run into another's. */}
              <CreateForBrand
                key={brand.slug}
                orgSlug={org.slug}
                brandSlug={brand.slug}
                brandName={brand.name}
                // Straight off the client record this route already resolved. Generate warns when a
                // brand has neither, and the answer is on the brand the route located rather than
                // behind a fetch of its own. custom_instructions is absent on the hosted read, so
                // it is coalesced to "" there; the whole create surface is engine-only anyway.
                brandInstructions={brand.custom_instructions ?? ""}
                hasCanonicalFacts={brand.has_canonical_facts}
                resourceCount={brand.resource_count}
              />
              <LocalEngineNote />
            </>
          )}
        </div>
      )}
    </BrandRoute>
  );
}

/** What the hosted, engine-less deployment says where the create flow would be. */
function HostedReadOnly({
  blogsHref,
  roadmapHref,
}: {
  blogsHref: string;
  roadmapHref: string;
}) {
  return (
    <Card className="mx-auto mt-8 max-w-xl">
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <PenLine className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          Blogs are generated from the operator dashboard
        </p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-muted-foreground">
          This dashboard is the read-only view of the factory&apos;s record. Generating a blog
          runs research and writing sessions on the engine, which this deployment does not
          have, so topics are picked and runs are watched where the engine runs. Everything
          already written is here.
        </p>
        <div className="mt-6 flex justify-center gap-2">
          <Button size="sm" asChild>
            <Link href={blogsHref}>
              <BookOpen data-icon="inline-start" aria-hidden />
              View blogs
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href={roadmapHref}>View roadmap</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Said once, quietly, near the live view. The run lives in the local uvicorn process and
 * every status line is written to status.jsonl on disk as it happens, so this tab holds
 * nothing but a read only SSE connection. Operators do not know that, and one who believes a
 * refresh kills a 40 minute run will sit and guard a tab that needs no guarding.
 */
function LocalEngineNote() {
  return (
    <p className="mt-6 text-center text-xs text-muted-foreground">
      This runs on the local engine, so you can close this tab and come back. Nothing here
      cancels a run.
    </p>
  );
}
