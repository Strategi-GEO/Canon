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
import { adminGateVerdict } from "@/lib/gate-contract";
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
  review,
  onSent,
}: {
  brandSlug: string;
  topicSlug: string;
  brandName: string;
  status: BlogStatus;
  /** Where this blog sits in the review loop. The page owns the read; this renders it. */
  review: BlogReviewState;
  /** Hands back the state the POST answered with, so the chip flips without a refetch. */
  onSent: (state: BlogReviewState) => void;
}) {
  // GATED ON HOSTED_READONLY AGAIN, and this time the route behind it refuses too. The hosted
  // site is a view-and-preview window: an admin reads blogs and their status there, and every
  // act that changes something happens in the Canon app. The real gate is server-side, in
  // app/api/clients/[slug]/blogs/[topic]/send/route.ts, because a hidden button is not a gate
  // and this one exists only so an operator is never offered a control that would refuse them.
  //
  // NO FACT LEAVES THE PAGE WITH THE CONTROL, which is the trap this gate fell into the last
  // time it was written. Returning null here used to take the send and approval timestamps with
  // it, because this component rendered both the button and the chip carrying them. It no longer
  // has to: blog-stage.tsx renders ReviewStamp for when the article went out and who approved
  // it, and BlogStateTag for where it sits, both outside this component and both unaffected by
  // anything below. So the hosted build keeps every fact about the send and loses only the act.
  //
  // AND THE PAGE NOW SAYS WHERE THE ACT WENT, which this return could not and should not. Every
  // admin control on the stage disappears on this build, each behind its own gate like this one,
  // so a sentence written here would be one of five saying the same thing, and it would appear
  // only in the states that grant a send. blog-stage.tsx carries it once, keyed on the bench
  // being non-empty, which is why an operator no longer reads the tag's instruction to send and
  // then finds nothing and no explanation. Removing a control is right; going quiet is not.
  if (HOSTED_READONLY) {
    return null;
  }

  if (status === "running" || status === "unknown") {
    return null;
  }

  // AHEAD OF THE GATE CHECK NOW, AND THE ORDER IS PART OF THE FIX BELOW. blockedReason is handed
  // the real record, so the open-suggestion clause is live in it and would answer this record with
  // a greyed button carrying the layer's terse 409. That is strictly worse than what this branch
  // draws, and it is worse in the one situation the whole branch exists for. The count and the
  // resolution instructions are the SAME refusal rendered fully, so the fuller rendering is
  // reached first and the gate is asked only about what is left.
  if (review.changes_requested > 0) {
    // THE SEND IS GONE, not disabled. The blog is mid review round: the client is writing
    // and the operator is resolving, and there is no version of "send it" that means
    // anything until that finishes. A greyed button with a tooltip is an offer the operator
    // has to read and reject on every visit, so the state says what it is and shows nothing
    // to press. It comes back below, once a resolution has actually changed the article.
    // THE COUNT, not the state word. BlogStateTag already prints "Changes requested" a few
    // pixels away in this same row, so repeating it here put the identical phrase on screen
    // twice and left a reader hunting for the difference between two chips that had none. The
    // tag owns the vocabulary; this owns the number, which is the thing the tag cannot say and
    // the thing an operator actually needs: how many are left to work through.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center gap-1.5 rounded-md border border-review/25 bg-review-bg px-2.5 py-1 text-xs font-medium text-review">
            <MessageCircleQuestion className="size-3.5" aria-hidden />
            {review.changes_requested} to resolve
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          The client suggested {review.changes_requested}{" "}
          {review.changes_requested === 1 ? "change" : "changes"} from their portal. Each one is
          in the rail beside the article: resolve it with Claude or dismiss it. {OPEN_CHANGES_REASON}.
        </TooltipContent>
      </Tooltip>
    );
  }

  const blocked = blockedReason(status, review);
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
  // states the contract derives: unsent, approved, or out for review.
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

/**
 * Why this blog cannot be sent, or null when it can. It no longer MIRRORS the engine's rule and
 * migration 009's, it ASKS them: the gate contract carries admin_done_topic's own condition, the
 * approved lock and the open-suggestion WHERE clause, each with the source line beside it.
 *
 * EVERY STATUS BRANCH BELOW IS REACHABLE FROM ONE STATE ONLY, and knowing which one is what lets
 * these sentences name a real next act instead of a generic refusal. blog-stage.tsx mounts this
 * component behind `canSend`, which is `adminCan(state, "send")` ANDed with this same gate over
 * the summary record, and of the three states that grant a send, two are
 * `done` by construction: `internal_review` tests the status directly, and `changes_requested`
 * sits above a send stamp that only a done blog could ever have earned. `answers_submitted` is
 * the sole state that grants a send while carrying a not-done status, and it does so because it
 * is derived from the client's submit stamp rather than from the status at all. So a not-done
 * blog arriving here is an article whose client has ALREADY ANSWERED and whose rerun has not
 * delivered a clarified draft, and the act it is waiting on is that rerun.
 *
 * ONLY THE `needs_review` BRANCH MAY NAME THE RERUN, and the other two may not, because the record
 * does not support what they used to say. Both asserted that the rerun crashed or was stopped
 * mid-flight, and a revise that dies cannot produce either status: server/runner.py's except-arm
 * and its cancel-arm both append `prev_terminal["status"]`, which on an article held for answers is
 * `needs_review`, so a crashed or stopped revise leaves this component reading `needs_review` and
 * taking the branch above. `failed` here is a run that FINISHED and landed below the bar with
 * nothing to ask, and `stopped` is a session ended before this article ever reached a verdict.
 * Neither is a rerun that half ran, and neither has a live question form, so the Rerun strip that
 * the first sentence points at is not on the page for them. Pointing at an absent control is the
 * exact failure the first sentence was written to fix, so these two name the record instead.
 *
 * NAMING THE RERUN IS THE WHOLE FIX HERE. The old sentence told the operator to answer the
 * evaluator's questions, which on this article had been answered already, by the client, which is
 * the very reason it reached this state. It contradicted the record and pointed at a control that
 * was not on the page, because the same table that withheld `answer` was the one granting `send`.
 * The bench now grants both, so AnswerQuestions renders the Rerun strip directly above this
 * button, and these sentences point at something the operator can actually press.
 *
 * DISABLED RATHER THAN ABSENT, which is the exception blog-stage.tsx's gone-rather-than-greyed
 * rule states for itself: a greyed control is honest where the condition clears on its own, and
 * this one clears the moment the rerun lands. What made the earlier version a puzzle was not the
 * grey, it was a reason that named no act.
 */
function blockedReason(
  status: BlogStatus,
  review: BlogReviewState,
): string | null {
  // THE GATE DECIDES WHETHER TO BLOCK; THE STATUS ONLY PICKS THE SENTENCE. Those are two different
  // jobs and this function used to do both by enumerating statuses, which meant an unrecognised one
  // fell through the list and returned null, leaving the button pressable over a record migration
  // 009 refuses. gate-contract.ts carries admin_done_topic's own condition and
  // dashboard/tests/gate-contract.test.ts holds it against the SQL, so the decision is made once
  // and the branches below choose words rather than permissions.
  //
  // THE RECORD IS THE REAL ONE NOW, AND THE SYNTHETIC ONE IT REPLACES WAS A FAIL-OPEN WEARING A
  // GATE'S CLOTHES. This call used to pass `{ record: { status } }`, and every other field of
  // BlogStateFacts is optional with absent reading as false, so of the three facts the send door
  // actually reads only one was supplied: the approved clause and the open-suggestion clause both
  // answered `pass` against a record that simply declined to mention the approval and the count.
  // The gate said yes for a reason that had nothing to do with the article. Nothing in the types
  // resisted it, because an omitted optional field is not a type error, which is exactly why this
  // shape has to be spotted by reading rather than by compiling.
  //
  // IT WAS SAFE ONLY BY A PROPERTY OF ONE PARENT, WHICH IS NOT SAFETY. blog-stage.tsx's `canSend`
  // evaluates this same gate over the real summary before it mounts this component at all, so the
  // fail-open was masked by a caller being stricter than the callee. A second caller, or that
  // composition changing, and the refusal is live with no layer left holding it.
  //
  // EVERY FACT THE SEND CLAUSES READ IS IN SCOPE HERE, WHICH IS WHAT MAKES THREADING THE HONEST
  // FIX RATHER THAN DELETION. `status` is a prop, and the approval and the open-suggestion count
  // are both on `review`, which this component already renders chips from. The record below
  // carries every delivery fact `review` holds rather than only the three read today, because a
  // clause added to the send door tomorrow should find its fact already supplied instead of
  // finding an omission that reads as false. The two facts NOT on this component's wire are
  // `live` and `answers_submitted`: a send clause over either would have to reach this call site,
  // and until one does there is nothing here to answer them with.
  const verdict = adminGateVerdict("send", {
    record: {
      status,
      sent_to_client: review.sent_to_client,
      client_approved: review.client_approved,
      changes_requested: review.changes_requested,
      change_round_open: review.change_round_open,
      published: review.published,
    },
    form: "unread",
  });
  if (verdict.allowed) {
    return null;
  }
  if (status === "needs_review") {
    return "The answers are in and the rerun that applies them has not run yet, so there is no clarified draft to send. Start it with Rerun above: this button comes back the moment the rerun lands.";
  }
  if (status === "failed") {
    return "The last run on this article finished without a shippable draft, so the record carries no passing verdict and there is nothing to deliver. Generating this topic again is what produces one, and this button comes back once a run lands at done.";
  }
  if (status === "stopped") {
    return "This brand's session was stopped before this article reached a verdict, so the record carries no passing draft to send. Generating this topic again is what produces one, and this button comes back once a run lands at done.";
  }
  // A REFUSAL THIS FUNCTION HAS NO SENTENCE FOR. Reaching here used to mean returning null and
  // offering the button, which is how an unknown status became a press that fails.
  //
  // THE LAYER'S OWN REASON COMES FIRST, AND THE STATUS SENTENCE IS THE FALLBACK RATHER THAN THE
  // ANSWER. With the real record passed above, a refusal reaching this line is no longer
  // necessarily about the status at all: the approval clause can refuse a record whose status is a
  // perfectly good "done", and a sentence announcing that the run "recorded a status of done" over
  // that record would be both true and completely beside the point. So the blocking clause reports
  // itself, which is the same discipline the rest of this file follows: the layer that refuses is
  // the layer that explains. The status sentence stays for a refusal with no clause to name, which
  // no send clause produces today, since none of them can answer `unknowable`.
  return (
    verdict.blocking?.refusal ??
    `This article's last run recorded a status of "${status}", and only a blog the engine has landed at done can be delivered. Generating this topic again is what produces one, and this button comes back once a run lands at done.`
  );
}
