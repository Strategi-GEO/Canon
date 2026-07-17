"use client";

import * as React from "react";
import { FileText, TriangleAlert } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownView } from "@/components/blogs/markdown-view";
import { ApiError, api } from "@/lib/api";
import type { Client } from "@/types";

type Loaded = { text: string } | { error: ApiError };

/**
 * The brand's canonical-facts.md, summarised and readable in place.
 *
 * The file is the most load bearing thing this app holds: it is BINDING for every blog written
 * for the brand, every draft is scored against it, and an operator reading a piece that says
 * something surprising has exactly one question, which is what the fact base actually says. Up
 * to now the only answer was to open the file on the machine running the engine.
 *
 * READ ONLY, and that is the feature rather than a gap in it. Editing a file the pipeline treats
 * as binding is a review, not a keystroke, so it stays a deliberate act on disk. What belongs
 * here is the seeing.
 */
export function FactsCard({ client }: { client: Client }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Card>
      <CardContent>
        <p className="text-sm font-medium text-foreground">Canonical facts</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {client.has_canonical_facts
            ? "The binding fact base for this brand. Every blog is written against it, and no draft may contradict it."
            : "No fact base yet. The first blog run drafts one from the site and the resources before it writes anything."}
        </p>
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => setOpen(true)}
          disabled={!client.has_canonical_facts}
        >
          <FileText data-icon="inline-start" aria-hidden />
          View canonical facts
        </Button>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent className="w-full gap-0 p-0 data-[side=right]:sm:max-w-2xl lg:data-[side=right]:sm:max-w-3xl">
            <SheetHeader className="gap-0 border-b p-4 pr-14">
              <SheetTitle className="text-base leading-snug">Canonical facts</SheetTitle>
              <SheetDescription className="machine mt-1 text-xs wrap-anywhere">
                clients/{client.slug}/canonical-facts.md
              </SheetDescription>
            </SheetHeader>
            <ScrollArea className="h-[calc(100svh-5.5rem)]">
              <div className="px-4 py-6 sm:px-6">
                {/* Mounted only while open, so the file is read when the operator asks for it and
                    not on every visit to this page. Closing unmounts it, which is also what makes
                    the next open a fresh read: the engine writes this file during a run, so a copy
                    kept from the last open could describe a fact base that has since changed. */}
                {open ? <FactsBody brandSlug={client.slug} /> : null}
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>
      </CardContent>
    </Card>
  );
}

function FactsBody({ brandSlug }: { brandSlug: string }) {
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    api.facts(brandSlug, controller.signal).then(
      (text) => setLoaded({ text }),
      (cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setLoaded({
          error: cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
        });
      },
    );
    return () => controller.abort();
  }, [brandSlug]);

  if (loaded === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-32 w-full" />
        <span className="sr-only" role="status">
          Loading canonical facts
        </span>
      </div>
    );
  }

  if ("error" in loaded) {
    return <FactsError error={loaded.error} />;
  }

  if (loaded.text.trim() === "") {
    return <p className="text-sm text-muted-foreground">This file is on disk but empty.</p>;
  }

  // `document`, not `article`: this is a file scanned for a claim, and its tables are wide.
  return <MarkdownView source={loaded.text} variant="document" />;
}

function FactsError({ error }: { error: ApiError }) {
  const missing = error.status === 404;
  return (
    <div className="rounded-md border border-fail/25 bg-fail-bg p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-fail">
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        {error.isOffline
          ? "Cannot reach the engine to read canonical-facts.md"
          : missing
            ? "This brand has no canonical-facts.md"
            : "Could not read canonical-facts.md"}
      </p>
      <p className="mt-2 text-xs text-fail/80">
        {error.isOffline
          ? "The file may well be on disk. Nothing could ask for it."
          : missing
            ? "The first blog run drafts one before it writes anything. This card reads the disk rather than a cache, so a file added since will appear on the next open."
            : "The engine answered with this:"}
      </p>
      {/* The engine's own words. A generic message would hide the reason to act on. */}
      <p className="machine mt-1 text-xs wrap-anywhere text-fail/80">{error.message}</p>
    </div>
  );
}
