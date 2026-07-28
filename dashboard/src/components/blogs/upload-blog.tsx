"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FileUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HOSTED_READONLY } from "@/lib/hosted";
import { brandHref } from "@/lib/orgs-context";
import type { RoadmapRow, UploadBlogResult } from "@/types";
import type { RowState } from "@/components/create/row-status";

/**
 * The upload icon on a roadmap row. It LEADS TO A PAGE, /create/upload/<slug>, which is the upload
 * twin of /create/new: the same paste-and-preview editor, except it already knows this topic's
 * title, slug and prompts from the row, so it asks for none of them. This component is only the
 * entry point and its refusals; the page does the actual upload.
 *
 * WHY A PAGE, NOT A DIALOG: uploading is pasting a whole article, the same act as writing one, and
 * the create-new editor is a full page for the room it needs. A dialog cramped the same editor.
 *
 * GATED ON HOSTED_READONLY: the hosted build has no upload route, so this button exists only where
 * the act does. The real gate is server-side; a hidden button is not a gate, only a courtesy that
 * never offers a control that would refuse. Nothing is lost by hiding it whole, since the row keeps
 * rendering its topic, state and ledger stamp with or without it.
 */
export function UploadBlog({
  row,
  state,
}: {
  /** Kept for call-site compatibility; the href is built from the route's own org/brand params. */
  brandSlug: string;
  row: RoadmapRow;
  /** How this row reads right now, which decides whether uploading is offered at all. */
  state: RowState;
  /** Kept for call-site compatibility. The upload now happens on its own page, which the create
   *  tab refetches on return, so nothing inline needs refreshing here. */
  onUploaded?: (result: UploadBlogResult) => void;
}) {
  // org and brand from the CURRENT route, which this row is already rendered under: the href points
  // at a sub-page of this very brand, not a guess at which brand's data to read.
  const params = useParams<{ org: string; brand: string }>();

  // After the hook, matching the lint rule's view of a build-time constant as a conditional call.
  if (HOSTED_READONLY) {
    return null;
  }

  const blocked = blockedReason(state);
  // A topic that already has a blog is a replace, which the page confirms in its own copy.
  const replacing = state === "generated";
  const href = brandHref(
    params.org,
    params.brand,
    `/create/upload/${row.topic_slug}?title=${encodeURIComponent(row.topic)}&replace=${replacing ? "1" : "0"}`,
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A span wrapper because a disabled control fires no pointer events, so Radix would never
            see the hover and the reason would never open. */}
        <span className="inline-flex">
          {blocked !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-foreground"
              disabled
            >
              <FileUp aria-hidden />
              <span className="sr-only">Upload a written article for {row.topic}</span>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-foreground"
              asChild
            >
              <Link href={href}>
                <FileUp aria-hidden />
                {/* Named, not "Upload": one sheet carries twenty five of these buttons, and the
                    topic is the only thing that tells them apart to a screen reader. */}
                <span className="sr-only">Upload a written article for {row.topic}</span>
              </Link>
            </Button>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {blocked ?? `Upload a finished article for "${row.topic}" instead of generating it.`}
      </TooltipContent>
    </Tooltip>
  );
}

/** Why this row cannot take an upload, or null when it can. Mirrors the engine's refusals. */
function blockedReason(state: RowState): string | null {
  if (state === "in_progress") {
    return "This topic is generating right now. Upload once the run finishes, so the engine's own writes are not raced.";
  }
  if (state === "needs_review") {
    return "This blog is held for an answer the evaluator asked for. Answer its questions before replacing it with an uploaded article.";
  }
  return null;
}
