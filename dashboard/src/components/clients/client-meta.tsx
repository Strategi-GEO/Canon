"use client";

import { FlaskConical, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Preflight } from "@/types";

/**
 * A demo client can never spend an API call, so it must never be mistaken for a real one.
 * The badge stays muted and off the accent: it marks a limitation, not a feature.
 */
export function DemoBadge() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 text-muted-foreground">
            <FlaskConical data-icon="inline-start" aria-hidden />
            Demo
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          Demo mode: this client produces precoded fake blogs with zero API calls. Every
          file it writes is marked demo content. It can never run the real pipeline.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The preflight gate refuses a real run when canonical-facts.md is missing or still holds
 * the PLACEHOLDER token, because every blog for the client inherits that file. This is the
 * safety net working, so it reads as a quiet amber note and never as an error.
 */
export function PreflightNote({
  preflight,
  className,
}: {
  /** Null when this response carried no preflight at all. See preflightOf in wire.ts. */
  preflight: Preflight | null | undefined;
  className?: string;
}) {
  if (!preflight || preflight.ok) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex gap-2 rounded-md border border-review/25 bg-review-bg px-2.5 py-2",
        className,
      )}
    >
      <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-review" aria-hidden />
      <div className="min-w-0">
        <p className="machine text-xs wrap-break-word text-review">{preflight.reason}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This client cannot generate real blogs until its canonical facts are reviewed.
        </p>
      </div>
    </div>
  );
}

/** Industry, quiet and secondary: it selects a reference file, it is not a headline. */
export function IndustryBadge({ industry }: { industry: string }) {
  if (!industry) {
    return null;
  }
  return (
    <Badge variant="secondary" className="machine text-muted-foreground">
      {industry}
    </Badge>
  );
}
