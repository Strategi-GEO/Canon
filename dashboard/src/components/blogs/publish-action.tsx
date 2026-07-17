"use client";

import * as React from "react";
import { Check, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import type { BlogStatus, PublishResult } from "@/types";

/**
 * Posts one finished blog to the Strategi CMS, as a draft for a human to review.
 *
 * THIS COMPONENT IS NOT THE GUARD. The engine refuses any blog whose terminal status is not
 * "done" and answers 409, and that refusal is what actually keeps an unvetted piece away
 * from an editor who could approve it. Everything here is courtesy: disabling the button
 * saves a round trip and, more usefully, says why. A stale tab pressing anyway gets the
 * server's no.
 *
 * The browser sends a brand and a topic. It never builds the payload and never holds the
 * write key: the engine reads the blog off its own disk, so what lands in the CMS is the
 * artifact that passed the evaluator rather than whatever a page had in memory.
 */
export function PublishAction({
  brandSlug,
  topicSlug,
  topic,
  status,
  demoMode,
}: {
  brandSlug: string;
  topicSlug: string;
  topic: string;
  status: BlogStatus;
  /** A demo blog is templated placeholder text. It must never reach a client's CMS. */
  demoMode: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [result, setResult] = React.useState<PublishResult | null>(null);

  // Mid-run there is nothing to post and no question to answer, so the button stays away
  // rather than sitting there greyed out on every blog the engine is still writing.
  if (status === "running" || status === "unknown") {
    return null;
  }

  const blocked = blockedReason(status, demoMode);

  if (blocked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span wrapper: a disabled button fires no pointer events, so Radix would never
              see the hover and the tooltip explaining the refusal would never open. */}
          <span className="inline-flex">
            <Button size="sm" variant="outline" disabled>
              <Send data-icon="inline-start" aria-hidden />
              Post to CMS
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{blocked}</TooltipContent>
      </Tooltip>
    );
  }

  async function post() {
    setPosting(true);
    setError(null);
    try {
      const settled = await api.publishBlog(brandSlug, topicSlug);
      setResult(settled);
      setOpen(false);
      toast.success(describeResult(settled), {
        description: settled.slug ? `Draft: ${settled.slug}` : topic,
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setPosting(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          {result ? (
            <Check data-icon="inline-start" aria-hidden />
          ) : (
            <Send data-icon="inline-start" aria-hidden />
          )}
          {result ? "Posted to CMS" : "Post to CMS"}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Post this blog to the CMS?</AlertDialogTitle>
          <AlertDialogDescription>
            This sends the blog to the Strategi CMS as a draft. It is not published and it does
            not reach the client: an editor reviews it there and decides.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="text-sm">
          <p className="font-medium text-foreground">What goes across</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              The draft exactly as the evaluator scored it, plus its sources and its target
              prompts. Nothing is rewritten on the way, so the article an editor opens is the
              one in the blog.md tab.
            </li>
            <li>
              Posting again updates the same draft rather than making a second one. If an editor
              has already moved the post past draft, the CMS keeps their version and says so.
            </li>
            <li>
              The byline, SEO title, description, category and tag go with it, all derived from
              the draft itself rather than written fresh, so they carry the same vetting the
              article passed. A reviewer can edit any of them in the CMS.
            </li>
          </ul>
        </div>

        {error ? <FieldError error={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={posting}>
            Cancel
          </AlertDialogCancel>
          {/* preventDefault holds the dialog open until the request settles, so a 409 or a
              missing-key 503 lands in front of the operator instead of behind a closed dialog. */}
          <AlertDialogAction
            size="sm"
            disabled={posting}
            onClick={(event) => {
              event.preventDefault();
              void post();
            }}
          >
            {posting ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Post as draft
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Why this blog cannot be posted, or null when it can.
 *
 * Mirrors the engine's rule rather than inventing a softer one: only a blog the engine marked
 * done is publishable. The wording names the state, because "unavailable" sends an operator
 * looking for a bug and "this blog is needs_review" sends them to resolve the review.
 */
function blockedReason(status: BlogStatus, demoMode: boolean): string | null {
  if (demoMode) {
    return "This brand is in demo mode. Demo blogs are placeholder text generated without research, so they never reach a CMS.";
  }
  if (status === "needs_review") {
    // Named as the act that is owed, not as a defect in the draft. This blog may well be a 96: the
    // score is not what is missing, an answer is, and "needs review" sent an operator hunting the
    // draft for a flaw that was never there.
    return "This blog is held until you answer the evaluator's questions, whatever it scored. A CMS draft is directly approvable by an editor, so only a blog the engine shipped can be posted. Answer the questions and the revise settles it.";
  }
  if (status === "failed") {
    return "This run failed, so there is no finished blog to post.";
  }
  if (status === "stopped") {
    // Named as a stop rather than lumped in with the failure above, because the two send an
    // operator to different places: a failure is the engine's problem to explain, and a stop is
    // the operator's own decision with an obvious way forward. Without this arm a stopped blog
    // fell through to `null` and was offered Post to CMS, which the engine refuses with a 409:
    // a half-written draft, one dialog and one refusal later.
    return "You stopped this brand's session before the evaluator scored this blog, so there is no finished draft to post. Nothing was deleted: generate the topic again to pick it up.";
  }
  return null;
}

/** The CMS reports three outcomes and they are not the same event to an operator. */
function describeResult(result: PublishResult): string {
  if (result.skipped) {
    return "Already past draft in the CMS, so it was left alone";
  }
  if (result.updated) {
    return "Existing draft updated";
  }
  return "Draft created in the CMS";
}
