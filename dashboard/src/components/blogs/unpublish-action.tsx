"use client";

import * as React from "react";
import { EyeOff, Loader2 } from "lucide-react";
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
import { FieldError } from "@/components/clients/engine-error";
import { ApiError, api } from "@/lib/api";
import { HOSTED_READONLY } from "@/lib/hosted";
import type { UnpublishResult } from "@/types";

/**
 * Takes one published article back off the client's own website.
 *
 * RENDERED ONLY WHERE AN ARTICLE IS ACTUALLY ON A WEBSITE, and both halves of that are the
 * caller's job: the blog must be in the `published` state, and the destination must be a site
 * at all. An article filed in the Strategi CMS went as a draft and was never
 * public, so a control offering to take it off a website would be describing something that
 * never happened.
 *
 * THIS COMPONENT IS NOT THE GUARD, exactly as PublishAction is not. The engine refuses a
 * non-site destination, an article it never pushed, and an article edited on the client's own
 * site since our push. A stale tab pressing anyway gets the server's no, in words.
 *
 * THE SECOND PRESS IS THE POINT OF THE 409. When somebody has edited the article on the
 * client's site since we published it, the first press is refused and the dialog STAYS OPEN
 * carrying the engine's sentence and the date. The action then relabels and re-sends with
 * force. That shape exists because the engine's own publish path refuses to overwrite an
 * edited post on the ground that doing so "destroys their work silently" -- a status flip
 * destroys nothing, so the destroy half does not carry over, but the silently half does. An
 * operator who has been told, and presses again, is not being silent.
 */
export function UnpublishAction({
  brandSlug,
  topicSlug,
  destination,
  onUnpublished,
}: {
  brandSlug: string;
  topicSlug: string;
  /** The host the article is actually on, from the article's own record, never the brand's. */
  destination: string;
  onUnpublished: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [working, setWorking] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  // Set by a 409 the operator can answer. The only state this component keeps between presses.
  const [needsForce, setNeedsForce] = React.useState(false);

  if (HOSTED_READONLY) {
    return null;
  }

  const where = destination || "the client's site";

  async function act() {
    setWorking(true);
    setError(null);
    try {
      const result: UnpublishResult = await api.unpublishBlog(brandSlug, topicSlug, {
        force: needsForce,
      });
      setOpen(false);
      setNeedsForce(false);
      toast.success(
        result.skipped === "gone"
          ? "It was already gone from their site"
          : result.skipped === "already_draft"
            ? "It was already down"
            : `Taken off ${where}`,
        {
          description:
            result.skipped === "gone"
              ? "Somebody had already deleted it there. The record now agrees."
              : result.hard
                ? "It is in their Trash. They can restore it from their own admin."
                : "It is a draft on their site now. Nothing was deleted.",
        },
      );
      // AFTER the toast, and never a synthesised timestamp: the record is what moved, so the
      // page re-reads it rather than guessing what it now says.
      onUnpublished();
    } catch (cause) {
      const err = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      setError(err);
      // The one refusal the operator can answer. Anything else is theirs to fix elsewhere.
      if (err.status === 409 && /edited this on/i.test(err.message)) {
        setNeedsForce(true);
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setNeedsForce(false);
        }
      }}
    >
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <EyeOff data-icon="inline-start" aria-hidden />
          Unpublish from {where}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Take this article off {where}?</AlertDialogTitle>
          <AlertDialogDescription>
            It goes back to a draft in their site. Anyone opening its URL gets a 404. Nothing is
            deleted, and pressing Post again puts this same article back at the same address
            rather than creating a second one.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="text-sm">
          <p className="font-medium text-foreground">What stays</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              The article, its content and its full revision history, untouched on their site.
            </li>
            <li>Its URL and its slug, so putting it back puts it back where it was.</li>
            <li>
              The client&apos;s approval, the score and the ledger entry. Taking it off their
              site does not un-ship it.
            </li>
          </ul>
          <p className="mt-3 font-medium text-foreground">What you lose</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              Search drops it over the following days, and it does not return at the same rank
              when you publish again. AI engines keep citing the URL for weeks after the page
              stops answering.
            </li>
            <li>Any link anyone already has to it breaks.</li>
          </ul>
        </div>

        {error ? <FieldError error={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={working}>
            Leave it up
          </AlertDialogCancel>
          {/* preventDefault holds the dialog open until the request settles, so the
              edited-on-site 409 lands in front of the operator with the button that answers
              it, rather than behind a closed dialog. */}
          <AlertDialogAction
            size="sm"
            variant="destructive"
            disabled={working}
            onClick={(event) => {
              event.preventDefault();
              void act();
            }}
          >
            {working ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            {needsForce ? "Take it down anyway" : "Take it down"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
