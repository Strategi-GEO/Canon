"use client";

import * as React from "react";
import { Check, CheckCheck, Loader2, MessageCircleQuestion, SendHorizontal } from "lucide-react";
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
import { HOSTED_READONLY } from "@/lib/hosted";
import { formatAbsolute, formatRelative } from "@/lib/format";
import type { BlogReviewState, BlogStatus } from "@/types";

/**
 * The engine's 409 detail when a re-send is refused over open client suggestions, mirrored
 * here VERBATIM because a disabled button never gets to make the request that would fetch
 * it. If the engine's sentence changes, this one changes with it.
 */
const OPEN_CHANGES_REASON =
  "the client's suggestions are still open; resolve or dismiss each one before sending again";

/**
 * The delivery status control: where one shipped blog sits with the client, and the one
 * button that moves it.
 *
 * Until the first send, a done blog is the team's: editable on this page and invisible to
 * the client, and the control is the Send button alone. After it, the control reads the
 * review state out loud: "Sent for client review" while the client holds it, "Changes
 * requested" while their suggestions sit open, "Approved" once they sign off. Send again
 * is the release valve that restarts the cycle, and it re-stamps the send and CLEARS any
 * approval, because the client approves an exact article and a re-send replaces it.
 *
 * THIS COMPONENT IS NOT THE GUARD: the engine refuses anything not done and refuses a
 * re-send past open suggestions, so every disable here is courtesy, exactly as
 * PublishAction says of the CMS push. The scary part is that the client can see what a
 * send releases, which is why both sends confirm.
 */
export function SendToClient({
  brandSlug,
  topicSlug,
  brandName,
  status,
  demoMode,
  review,
  onSent,
}: {
  brandSlug: string;
  topicSlug: string;
  brandName: string;
  status: BlogStatus;
  demoMode: boolean;
  /** Where this blog sits in the review loop. The page owns the read; this renders it. */
  review: BlogReviewState;
  /** Hands back the state the POST answered with, so the chip flips without a refetch. */
  onSent: (state: BlogReviewState) => void;
}) {
  // Sending stamps the record through the engine; the hosted build has none behind it.
  if (HOSTED_READONLY) {
    return null;
  }
  if (status === "running" || status === "unknown") {
    return null;
  }

  const blocked = blockedReason(status, demoMode);
  if (blocked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span wrapper: a disabled button fires no pointer events, so Radix would
              never see the hover and the reason would never open. */}
          <span className="inline-flex">
            <Button size="sm" disabled>
              <SendHorizontal data-icon="inline-start" aria-hidden />
              Send to client
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{blocked}</TooltipContent>
      </Tooltip>
    );
  }

  // Past the guards the blog is done and real, so the chips below describe exactly the
  // states the contract derives: unsent, changes requested, approved, or out for review.
  if (review.sent_to_client === null) {
    return (
      <SendControl
        brandSlug={brandSlug}
        topicSlug={topicSlug}
        brandName={brandName}
        resend={false}
        onSent={onSent}
      />
    );
  }

  if (review.changes_requested > 0) {
    return (
      <span className="inline-flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-review/25 bg-review-bg px-2.5 py-1 text-xs font-medium text-review">
              <MessageCircleQuestion className="size-3.5" aria-hidden />
              Changes requested
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            The client suggested {review.changes_requested}{" "}
            {review.changes_requested === 1 ? "change" : "changes"} from their portal. Each one
            is in the panel under the article: resolve it with Claude or dismiss it.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Button size="sm" variant="outline" disabled>
                <SendHorizontal data-icon="inline-start" aria-hidden />
                Send again
              </Button>
            </span>
          </TooltipTrigger>
          {/* The engine's own refusal, shown before the press instead of after it. */}
          <TooltipContent className="max-w-xs">{OPEN_CHANGES_REASON}</TooltipContent>
        </Tooltip>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      {review.client_approved !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-ship/25 bg-ship/10 px-2.5 py-1 text-xs font-medium text-ship">
              <CheckCheck className="size-3.5" aria-hidden />
              Approved {formatRelative(review.client_approved)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="machine">
            {formatAbsolute(review.client_approved)}
            {review.client_approved_by ? ` by ${review.client_approved_by}` : ""}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-ship/25 bg-ship/10 px-2.5 py-1 text-xs font-medium text-ship">
              <Check className="size-3.5" aria-hidden />
              Sent for client review {formatRelative(review.sent_to_client)}
            </span>
          </TooltipTrigger>
          <TooltipContent className="machine">
            {formatAbsolute(review.sent_to_client)}
            {review.sent_to_client_by ? ` by ${review.sent_to_client_by}` : ""}
          </TooltipContent>
        </Tooltip>
      )}
      <SendControl
        brandSlug={brandSlug}
        topicSlug={topicSlug}
        brandName={brandName}
        resend
        onSent={onSent}
      />
    </span>
  );
}

/**
 * The confirmed send, first or repeat. One component for both because the request and its
 * error handling are identical; only the words differ, and the words carry the difference
 * that matters: a re-send clears the client's approval, so its dialog says so.
 */
function SendControl({
  brandSlug,
  topicSlug,
  brandName,
  resend,
  onSent,
}: {
  brandSlug: string;
  topicSlug: string;
  brandName: string;
  resend: boolean;
  onSent: (state: BlogReviewState) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const state = await api.sendBlogToClient(brandSlug, topicSlug);
      setOpen(false);
      toast.success(resend ? "Sent again" : "Sent to client", {
        description: resend
          ? `${brandName} now sees the updated article as ready to post. Any earlier approval is reset.`
          : `This blog is now visible in ${brandName}'s portal as ready to post.`,
      });
      onSent(state);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
    } finally {
      setSending(false);
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
        <Button size="sm" variant={resend ? "outline" : "default"}>
          <SendHorizontal data-icon="inline-start" aria-hidden />
          {resend ? "Send again" : "Send to client"}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {resend
              ? `Send this blog to ${brandName} again?`
              : `Send this blog to ${brandName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resend
              ? "The client sees the updated article as ready to post, exactly as it reads right now. Re-sending stamps a fresh send and resets any approval they have given: an approval belongs to one exact article, so the new text asks for its own."
              : "The article becomes visible in the client portal as ready to post, exactly as it reads right now, and the client can approve it or suggest changes. Finish your edits first: this is the door out of admin review, and there is no unsend."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? <FieldError error={error} /> : null}

        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={sending}>
            Cancel
          </AlertDialogCancel>
          {/* preventDefault holds the dialog open until the request settles, so a refusal
              lands in front of the operator instead of behind a closed dialog. */}
          <AlertDialogAction
            size="sm"
            disabled={sending}
            onClick={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {sending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
            ) : null}
            Send it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Why this blog cannot be sent, or null when it can. Mirrors the engine's rule. */
function blockedReason(status: BlogStatus, demoMode: boolean): string | null {
  if (demoMode) {
    return "This brand is in demo mode. Demo blogs are placeholder text generated without research, so they are never delivered to a client.";
  }
  if (status === "needs_review") {
    return "This blog is held until you answer the evaluator's questions, whatever it scored. Only a blog the engine shipped can be sent.";
  }
  if (status === "failed") {
    return "This run failed, so there is no finished blog to send.";
  }
  if (status === "stopped") {
    return "This brand's session was stopped before the evaluator scored this blog, so there is no finished draft to send. Generate the topic again to pick it up.";
  }
  return null;
}
