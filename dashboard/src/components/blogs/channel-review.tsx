"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Loader2, RotateCw, SendHorizontal, Sparkles } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { channelLabel, channelTag } from "@/lib/channel-state";
import { useRuns } from "@/lib/runs-context";
import { formatRelative } from "@/lib/format";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import { PostToChannel } from "@/components/blogs/post-to-channel";
import { CommentableArticle, type SelectionDraft } from "@/components/blogs/selection-comments";
import { useApplyingComments } from "@/components/blogs/use-blog-comments";
import type { BlogComment, ChannelPost, RepurposeChannel } from "@/types";

const MAX_IN_FLIGHT = 3;

/**
 * The review surface for one generated channel post: the piece with its comment rail, the
 * resolve-with-Claude flow, Send to client, and Mark posted. It reuses CommentableArticle
 * unchanged (the channel comment wire IS the BlogComment shape) and drives it through the
 * /channel endpoints. A channel post has no brand-instructions flow, so that door is off.
 *
 * The lifecycle it renders: created (comment / edit / send) -> sent (with the client) -> changes
 * requested (resolve, then send again) -> approved (mark posted) -> posted.
 */
export function ChannelReview(props: {
  orgSlug: string;
  brandSlug: string;
  channel: RepurposeChannel;
  topicSlug: string;
}) {
  const { orgSlug, brandSlug, channel, topicSlug } = props;
  const label = channelLabel(channel);
  const backHref = brandHref(orgSlug, brandSlug, `/${channel}`);

  const [loaded, setLoaded] = React.useState<
    { post: ChannelPost } | { error: ApiError } | null
  >(null);
  const [copied, setCopied] = React.useState(false);

  const commentsFetcher = React.useCallback(
    (signal: AbortSignal) =>
      api.channelComments(brandSlug, channel, topicSlug, signal).then((d) => d.comments),
    [brandSlug, channel, topicSlug],
  );
  const { comments, refresh: refreshComments } = useApplyingComments(
    `${brandSlug}/${channel}/${topicSlug}`,
    commentsFetcher,
    !HOSTED_READONLY,
  );

  const { runs } = useRuns();
  const live = React.useMemo(
    () =>
      runs.some(
        (r) =>
          r.kind === "repurpose" &&
          r.client === brandSlug &&
          r.live &&
          r.channel === channel &&
          r.topics.some((t) => t.source_topic_slug === topicSlug),
      ),
    [runs, brandSlug, channel, topicSlug],
  );

  const loadPost = React.useCallback(
    (signal?: AbortSignal) =>
      api.channelPost(brandSlug, channel, topicSlug, signal).then(
        (post) => setLoaded({ post }),
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setLoaded({
            error: cause instanceof ApiError ? cause : new ApiError(0, String(cause), null),
          });
        },
      ),
    [brandSlug, channel, topicSlug],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void loadPost(controller.signal);
    return () => controller.abort();
  }, [loadPost]);

  // When a live generation finishes, re-read both so the page flips from Generating to the piece.
  const prevLive = React.useRef(false);
  React.useEffect(() => {
    if (prevLive.current && !live) {
      void loadPost();
      refreshComments();
    }
    prevLive.current = live;
  }, [live, loadPost, refreshComments]);

  // A resolve-with-Claude, or an operator's own filed comment (born applying), rewrites the post
  // body server-side. The comment rail refreshes itself, but the article renders from post.content,
  // which mount was the only thing to load. Watch each comment leaving "applying" and re-read the
  // post so the applied edit shows instead of the stale body. Mirrors blog-stage's watcher.
  const seenStates = React.useRef(new Map<string, BlogComment["state"]>());
  React.useEffect(() => {
    for (const comment of comments) {
      const before = seenStates.current.get(comment.id);
      seenStates.current.set(comment.id, comment.state);
      if (before !== "applying" || comment.state === "applying") {
        continue;
      }
      void loadPost();
      if (comment.state === "resolved") {
        toast.success("Change applied", { description: comment.instruction });
      }
    }
  }, [comments, loadPost]);

  const post = loaded && "post" in loaded ? loaded.post : null;
  const notGenerated = loaded !== null && "error" in loaded && loaded.error.status === 404;
  const state = live ? "generating" : post?.state ?? "created";
  const canComment = !HOSTED_READONLY && (state === "created" || state === "changes_requested");
  const inFlight = comments.filter((c) => c.state === "applying").length;

  async function onSubmit(draft: SelectionDraft) {
    await api.addChannelComment(brandSlug, channel, topicSlug, {
      selected_text: draft.selected_text,
      instruction: draft.instruction,
      context_before: draft.context_before,
      context_after: draft.context_after,
    });
    refreshComments();
  }

  async function onResolve(comment: BlogComment) {
    try {
      await api.resolveChannelComment(brandSlug, channel, topicSlug, comment.id);
      refreshComments();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "Could not resolve the change.");
    }
  }

  async function onDismiss(comment: BlogComment) {
    try {
      await api.dismissChannelComment(brandSlug, channel, topicSlug, comment.id);
      refreshComments();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : "Could not dismiss the change.");
    }
  }

  async function copy(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: leave the text on screen for a manual select.
    }
  }

  async function regenerate() {
    try {
      await api.repurpose(brandSlug, { topic_slug: topicSlug, channel });
    } catch {
      // The run poll will show a run that registered; a failed start leaves the current piece.
    }
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              Back to {channel === "linkedin" ? "LinkedIn" : "Medium"}
            </Link>
            <h2 className="mt-1 truncate text-xl font-semibold tracking-tight text-foreground">
              {post?.source_topic ?? topicSlug}
            </h2>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
              <span>{label}</span>
              {post ? <StateTagChip tag={channelTag(state, "admin")} /> : null}
            </p>
          </div>

          {post ? (
            <div className="flex shrink-0 items-center gap-2">
              {/* Always available while viewing the piece: post it to the channel. */}
              <PostToChannel channel={channel} content={post.content ?? ""} />
              <Button size="sm" variant="outline" onClick={() => void copy(post.content ?? "")}>
                {copied ? (
                  <Check data-icon="inline-start" aria-hidden />
                ) : (
                  <Copy data-icon="inline-start" aria-hidden />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
              {!HOSTED_READONLY && state === "created" ? (
                <Button size="sm" variant="ghost" onClick={() => void regenerate()} disabled={live}>
                  <RotateCw data-icon="inline-start" aria-hidden />
                  Regenerate
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {loaded === null ? (
          <Skeleton className="h-96 w-full" />
        ) : live ? (
          <GeneratingCard label={label} />
        ) : notGenerated ? (
          <NotGeneratedCard label={label} onGenerate={() => void regenerate()} />
        ) : loaded && "error" in loaded ? (
          <ErrorCard error={loaded.error} onRetry={() => void loadPost()} />
        ) : post ? (
          <>
            {/* The delivery bar: which act the post is owed, if any. */}
            <ActionBar
              brandSlug={brandSlug}
              channel={channel}
              topicSlug={topicSlug}
              label={label}
              post={post}
              onChanged={(next) => setLoaded({ post: next })}
            />
            <Card className="mt-3">
              <CardContent className="p-6">
                <CommentableArticle
                  source={post.content ?? ""}
                  comments={comments}
                  disabled={!canComment}
                  canResolve={canComment}
                  canAddToInstructions={false}
                  deploymentLocked={HOSTED_READONLY}
                  remaining={MAX_IN_FLIGHT - inFlight}
                  onSubmit={onSubmit}
                  onResolve={(c) => void onResolve(c)}
                  onDismiss={(c) => void onDismiss(c)}
                  onAddToInstructions={async () => {}}
                />
              </CardContent>
            </Card>
          </>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/**
 * The one act the post is owed, and the button for it. created / changes_requested get Send;
 * approved gets Mark posted; sent and posted are read-only states that just say where the post is.
 */
function ActionBar({
  brandSlug,
  channel,
  topicSlug,
  label,
  post,
  onChanged,
}: {
  brandSlug: string;
  channel: RepurposeChannel;
  topicSlug: string;
  label: string;
  post: ChannelPost;
  onChanged: (post: ChannelPost) => void;
}) {
  if (HOSTED_READONLY) {
    return null;
  }
  const state = post.state;

  if (state === "created" || state === "changes_requested") {
    const resend = state === "changes_requested";
    return (
      <ConfirmAction
        title={resend ? `Send this ${label} to the client again?` : `Send this ${label} to the client?`}
        description={
          resend
            ? "The client sees the updated post as ready to post, exactly as it reads now. Re-sending resets any approval they gave: an approval belongs to one exact post."
            : "The post becomes visible in the client portal as ready to post, and the client can approve it or request changes. Finish your edits first."
        }
        trigger={
          <Button size="sm">
            <SendHorizontal data-icon="inline-start" aria-hidden />
            {resend ? "Send again" : "Send to client"}
          </Button>
        }
        confirmLabel="Send it"
        run={() => api.sendChannelPost(brandSlug, channel, topicSlug)}
        onDone={onChanged}
        toastMessage="Sent to client"
      />
    );
  }

  if (state === "approved") {
    return (
      <ConfirmAction
        title={`Mark this ${label} posted?`}
        description="The client approved this post. Marking it posted records it as live on the channel. Do this once you have published it."
        trigger={
          <Button size="sm">
            <Check data-icon="inline-start" aria-hidden />
            Mark as posted
          </Button>
        }
        confirmLabel="Mark posted"
        run={() => api.markChannelPosted(brandSlug, channel, topicSlug)}
        onDone={onChanged}
        toastMessage="Marked as posted"
      />
    );
  }

  // sent (with client) and posted: nothing owed here, the tag beside the title says where it is.
  const note =
    state === "sent"
      ? `Sent to the client${post.sent_to_client ? ` ${formatRelative(post.sent_to_client)}` : ""}. Waiting on their approval or a change request.`
      : state === "posted"
        ? `Posted${post.posted_at ? ` ${formatRelative(post.posted_at)}` : ""}.`
        : null;
  return note ? (
    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {note}
    </p>
  ) : null;
}

/** A confirmed action: a button, an AlertDialog, and one POST that returns the post's new state. */
function ConfirmAction({
  title,
  description,
  trigger,
  confirmLabel,
  run,
  onDone,
  toastMessage,
}: {
  title: string;
  description: string;
  trigger: React.ReactNode;
  confirmLabel: string;
  run: () => Promise<ChannelPost>;
  onDone: (post: ChannelPost) => void;
  toastMessage: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      setOpen(false);
      toast.success(toastMessage);
      onDone(next);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-xs wrap-anywhere text-fail">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel size="sm" disabled={busy}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            disabled={busy}
            onClick={(event) => {
              event.preventDefault();
              void go();
            }}
          >
            {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function GeneratingCard({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        <p className="mt-3 text-sm font-medium text-foreground">Generating the {label}…</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          This runs on the local engine and appears here as soon as it lands. You can leave and come
          back.
        </p>
      </CardContent>
    </Card>
  );
}

function NotGeneratedCard({ label, onGenerate }: { label: string; onGenerate: () => void }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Sparkles className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">No {label} generated yet</p>
        <p className="mx-auto mt-1 mb-4 max-w-md text-xs text-muted-foreground">
          Generate the {label} for this blog, then review it here.
        </p>
        {!HOSTED_READONLY ? (
          <Button size="sm" onClick={onGenerate}>
            <Sparkles data-icon="inline-start" aria-hidden />
            Generate {label}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ErrorCard({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Card className="border-fail/25 bg-fail-bg">
      <CardContent className="py-8 text-center">
        <p className="text-sm font-medium text-fail">
          {error.isOffline ? "Cannot reach the engine" : "The engine refused the request"}
        </p>
        <p className="machine mx-auto mt-2 max-w-md text-xs wrap-break-word text-fail/80">
          {error.message}
        </p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
