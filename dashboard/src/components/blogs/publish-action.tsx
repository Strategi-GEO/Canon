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
import { adminGateVerdict } from "@/lib/gate-contract";
import { HOSTED_READONLY } from "@/lib/hosted";
import type { BlogStatus, PublishResult } from "@/types";

/**
 * Publishes one finished blog live on the client's own website.
 *
 * ONE DESTINATION NOW. This button used to mean two different acts depending on the brand: an
 * internal draft filed into the Strategi CMS, or a live article on a client's public domain. The
 * CMS is gone, so it always means the second, which is why the label names the platform and the
 * dialog says the word live.
 *
 * THIS COMPONENT IS NOT THE GUARD. The engine refuses any blog whose terminal status is not
 * "done", any brand with no website connected, and any article the client has not approved, and
 * answers 409. Those refusals are what actually keep an unvetted piece off a client's site.
 * Everything here is courtesy: disabling the button saves a round trip and, more usefully, says
 * why. A stale tab pressing anyway gets the server's no.
 *
 * The browser sends a brand and a topic. It never builds the payload and never holds the site
 * credential: the engine reads the blog off its own record, so what goes live is the artifact
 * that passed the evaluator rather than whatever a page had in memory.
 */
export function PublishAction({
  brandSlug,
  topicSlug,
  topic,
  status,
  score,
  destination,
  onPublished,
}: {
  brandSlug: string;
  topicSlug: string;
  topic: string;
  status: BlogStatus;
  /**
   * The evaluator's number, and the publish door genuinely reads it now, which is why this
   * prop exists at all. `publish_promotes_scored_draft` decides on it: a FAILED blog reaches
   * the site by being promoted first (server/blog_edit.py promote_if_failed), and the one
   * thing that promotion cannot waive is a draft no evaluator ever scored. Passing the status
   * alone would answer that clause by ABSENCE and grey the button on every failed blog,
   * including the scored ones this door exists for. blockedReason's own note spells out why a
   * partial record is only ever safe when every clause on the door reads what it carries.
   */
  score: number | null;
  /**
   * WHERE THIS BRAND PUBLISHES: "wordpress", "" for no website connected, or undefined while
   * the brand record is still loading.
   *
   * IT IS A PROP RATHER THAN A LOOKUP because blockedReason owes the gate every fact its
   * clauses read, and two of them read this one. The note on blockedReason spells out why a
   * partial record is only safe by coincidence: a call site that omitted this would answer both
   * clauses by ABSENCE, and the button would grey on every blog with a sentence about a
   * destination the caller simply declined to pass.
   */
  destination?: string;
  /**
   * Fired once the site has taken the article, so the page can re-read the record.
   *
   * IT EXISTS BECAUSE THE PUSH NOW MOVES THE STATE. `published` used to require a send stamp
   * beside the push, so posting from internal review changed no state, moved no tag and needed
   * no refresh. It is the whole state on its own today: the tag flips to Published and the
   * admin bench empties, and neither happens until something re-reads the record.
   *
   * NO ARGUMENT, DELIBERATELY. The send door hands its caller the review state its POST
   * answered with, because that POST answers with exactly that. This one answers with the site's
   * own shape (post id, slug, status, url), which carries no published_at, so there is nothing
   * truthful to pass and a caller that got a synthesised stamp would render this browser's
   * clock as a database fact.
   *
   * FIRED ON `skipped` TOO. That result means somebody edited the article on their own site
   * since our last push, which is the strongest possible evidence it is out the door: the engine
   * still stamps published_at, so the record moved and the page has to follow.
   */
  onPublished?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [result, setResult] = React.useState<PublishResult | null>(null);

  // The push runs through the engine, which holds the site credential. The hosted build has
  // no engine behind it, so the button does not exist there at all.
  if (HOSTED_READONLY) {
    return null;
  }

  // Mid-run there is nothing to post and no question to answer, so the button stays away
  // rather than sitting there greyed out on every blog the engine is still writing.
  if (status === "running" || status === "unknown") {
    return null;
  }

  const blocked = blockedReason(status, score, destination);
  // The platform, so an operator reads WHERE the article is going before they press. There is
  // one kind of destination now and every press publishes live, so the fallback is the generic
  // word rather than a second destination's name.
  const target = destination ? platformName(destination) : "their site";

  if (blocked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span wrapper: a disabled button fires no pointer events, so Radix would never
              see the hover and the tooltip explaining the refusal would never open. */}
          <span className="inline-flex">
            <Button size="sm" variant="outline" disabled>
              <Send data-icon="inline-start" aria-hidden />
              Post to {target}
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
      // AFTER the toast and never in place of it. The push is the operator's act and its
      // receipt is theirs to see; the re-read is bookkeeping that happens to change the tag
      // under them, and firing it first would swap the buttons out from under the click that
      // produced them before the confirmation landed.
      onPublished?.();
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
          {result ? `Posted to ${target}` : `Post to ${target}`}
        </Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Publish this blog on {target}?</AlertDialogTitle>
          <AlertDialogDescription>
            This publishes the article live on the client&apos;s own website, where anyone can
            read it. It is the final step, which is why it waits for the client&apos;s approval.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="text-sm">
          <p className="font-medium text-foreground">What goes across</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-xs leading-relaxed text-muted-foreground">
            <li>
              The draft exactly as the evaluator scored it, plus its sources. Nothing is
              rewritten on the way, so the article a reader opens is the one in the blog.md tab.
            </li>
            <li>
              It joins the same section of their blog as their existing articles, and the byline
              is theirs: the article posts as the WordPress user whose application password
              connected the site.
            </li>
            <li>
              Publishing again updates the same article rather than making a second one. If
              somebody edited it on their site since the last push, their version is kept and
              the app says so instead of overwriting it.
            </li>
            <li>
              The SEO title and description go with it where their SEO plugin accepts them, and
              a field somebody has already filled in on their side is never overwritten.
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
            Publish
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Why this blog cannot be posted, or null when it can.
 *
 * IT USED TO ENUMERATE THE STATUSES AND THAT ENUMERATION WAS A PRIVATE RESTATEMENT. Three arms
 * named `needs_review`, `failed` and `stopped`, each with its own sentence, and together they were
 * one file's own copy of server/cms/gate.py's `if status != "done":`, which is now carried as the
 * `publish_topic_is_done` clause with that source line recorded verbatim beside it. A restatement
 * is silent when it is wrong, and this one was already wrong in the way every restatement of a
 * closed list is wrong: a status nobody enumerated fell through all three arms and returned null,
 * which reads as "nothing blocks this" and offers a Publish the gate answers with a 409.
 *
 * A FOURTH ARM WOULD HAVE BEEN THE SAME BUG WITH A LONGER LIST. The list is not short by
 * accident, it is short because it is a hand copy of a rule that is not a list at all: the gate
 * admits exactly one status and refuses every other, including ones no enum here has heard of yet.
 * So the decision is read off the clause and the refusal reported is the layer's own.
 *
 * THE RECORD CARRIES EVERY FACT THE DOOR READS, AND IT NOW READS TWO. This note used to say the
 * status alone was safe because the publish door held exactly one clause and that clause read the
 * status. That stopped being true the moment a failed blog became publishable: the door gained
 * `publish_promotes_scored_draft`, which reads the SCORE, because the promotion that lets a
 * sub-90 draft reach a client's site (server/blog_edit.py promote_if_failed) cannot waive a draft no
 * evaluator ever scored.
 *
 * THE OLD SHAPE WOULD HAVE FAILED SILENTLY AND IN THE WORST DIRECTION. Every field of a record is
 * optional and an absent one reads as absent, so a record built from the status alone answers the
 * score clause by OMISSION: every failed blog would have been greyed with "no evaluator-scored
 * draft", including the scored ones the whole door exists for, and the sentence would have been
 * the layer's own words describing a fact the caller simply declined to pass. That is why the
 * previous note ended by demanding this exact fix of whoever added such a clause.
 *
 * SO THE RULE, RESTATED AS A RULE RATHER THAN AS A PERMISSION: a call site owes this gate every
 * fact its clauses read, and a partial record is only ever safe by coincidence. The send door
 * reads the approval and the open-suggestion count, and send-to-client.tsx builds it a record
 * carrying all three for precisely this reason.
 */
function blockedReason(
  status: BlogStatus,
  score: number | null,
  destination: string | undefined,
): string | null {
  // BOUND AND NARROWED RATHER THAN READ STRAIGHT OFF THE CALL. GateVerdict is a discriminated
  // union and only its refusing arm carries `blocking`, so the allowed arm has to be answered
  // before the clause can be reached. That shape is deliberate on the contract's side: it makes
  // "the gate said yes" and "the gate said no and here is which clause" two different values a
  // caller cannot confuse, and the cost here is one branch that reads as the sentence it is.
  const verdict = adminGateVerdict("publish", {
    record: { status, score, destination },
    form: "unread",
  });
  if (verdict.allowed) {
    return null;
  }
  return verdict.blocking?.refusal ?? null;
}

/**
 * The brand's destination as a label for a button.
 *
 * `site_kind` is a PLATFORM ("wordpress"), not a host, because that is the one thing the client
 * record can carry without the credential riding along: the stored destination holds a write
 * credential for a live website, so the engine extracts only the kind in SQL and the URL never
 * reaches this surface. The exact host is on the settings card and on the chip after the push,
 * both of which read it from somewhere that legitimately has it.
 */
function platformName(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** The site reports three outcomes and they are not the same event to an operator. */
function describeResult(result: PublishResult): string {
  if (result.skipped) {
    return "Someone edited this on their site, so it was left alone";
  }
  if (result.updated) {
    return "The live article was updated";
  }
  return "Published on the client's site";
}
