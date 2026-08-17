"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, RotateCw, SendHorizontal, Sparkles } from "lucide-react";
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
import { formatAbsolute, formatCount, formatRelative } from "@/lib/format";
import { blogLabels, titleFromSlug } from "@/lib/blog-label";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import { MarkdownActions } from "@/components/blogs/markdown-actions";
import { PostToChannel } from "@/components/blogs/post-to-channel";
import { CommentableArticle, type SelectionDraft } from "@/components/blogs/selection-comments";
import { useApplyingComments } from "@/components/blogs/use-blog-comments";
import { countWords } from "@/components/blogs/metrics";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { BlogComment, BlogSummary, ChannelPost, RepurposeChannel } from "@/types";

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

  /**
   * THE BRAND'S BLOGS, READ FOR ONE FACT: this post's source blog NUMBER.
   *
   * That number is the name the work actually goes by, "the LinkedIn for blog 6", and it is what
   * the library, the Create tab and the blogs table all title a row with. This page showed no
   * number at all, so an operator arriving from a list of numbered rows lost the only handle they
   * had on which article they were looking at.
   *
   * IT CANNOT BE COMPUTED FROM THE POST, which is why this is a whole extra read for one string.
   * blogLabels numbers ENGINE-WRITTEN blogs and letters HAND-UPLOADED ones, each a running count
   * over the brand's full list, so the label of any one blog is a function of every other blog the
   * brand has. A post carries its source slug and title and nothing about its siblings.
   *
   * A failed read falls to [], which is the same as "not known": the number is simply absent from
   * the heading and the title beside it still reads. Nothing on this page is gated on it.
   */
  const [blogs, setBlogs] = React.useState<BlogSummary[]>([]);
  React.useEffect(() => {
    const controller = new AbortController();
    api.blogs(brandSlug, controller.signal).then(
      (data) => setBlogs(data.blogs),
      () => setBlogs([]),
    );
    return () => controller.abort();
  }, [brandSlug]);
  const sourceBlog = React.useMemo(
    () => blogs.find((blog) => blog.topic_slug === topicSlug) ?? null,
    [blogs, topicSlug],
  );
  const blogLabel = React.useMemo(
    () => blogLabels(blogs).get(topicSlug) ?? null,
    [blogs, topicSlug],
  );

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

  async function regenerate() {
    try {
      await api.repurpose(brandSlug, { topic_slug: topicSlug, channel });
    } catch {
      // The run poll will show a run that registered; a failed start leaves the current piece.
    }
  }

  // The blog this piece was cut from, said the way every other surface says it. The post's own
  // copy of the title is authoritative once it lands; the listing covers the case where the post
  // was never generated; the slug covers the moment before either read settles.
  const sourceTitle =
    post?.source_topic ?? sourceBlog?.topic ?? titleFromSlug(topicSlug);
  const words = post?.content ? countWords(post.content) : null;

  return (
    <TooltipProvider delayDuration={200}>
      {/* THE BLOG STAGE'S OWN SHAPE, and not a lookalike: a ghost Back button, the numbered
          heading, one meta line, then ONE action row. The page shell sets max-w-5xl to match
          blogs/[topic] as well. It used to be max-w-3xl with the title left and a cluster of
          controls floated right, and with Send sitting BELOW in a bar of its own, so an operator
          crossing from a blog to its LinkedIn post met a narrower page, a different heading and
          two separate places to look for an act. Three channels each inventing their own header
          is exactly the drift this removes. */}
      <div>
        <Button size="sm" variant="ghost" className="-ml-2 mb-3" asChild>
          <Link href={backHref}>
            <ArrowLeft data-icon="inline-start" aria-hidden />
            {channel === "linkedin" ? "LinkedIn" : "Medium"}
          </Link>
        </Button>

        <div>
          <div className="min-w-0">
            {/* THE SOURCE BLOG'S NUMBER AND TITLE, because that is what this piece IS: a repurpose
                of blog 6, not a document of its own. The number is rendered exactly as blog-stage
                renders it, machine type and a trailing dot, so "6." means the same thing and looks
                the same on both pages. No TitleEditor here: the title belongs to the blog, and the
                place to rename it is the blog. */}
            <h2 className="text-xl leading-snug font-semibold tracking-tight text-pretty text-foreground">
              {blogLabel !== null ? (
                <span
                  className="machine mr-1.5 font-normal text-muted-foreground"
                  title={
                    sourceBlog?.uploaded
                      ? "Uploaded by hand: letters mark manual blogs"
                      : "Written by the engine"
                  }
                >
                  {blogLabel}.
                </span>
              ) : null}
              {sourceTitle}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <span className="text-sm text-muted-foreground">{label}</span>
              {post ? <StateTagChip tag={channelTag(state, "admin")} /> : null}
              {words !== null ? (
                <span className="machine text-xs text-muted-foreground">
                  {formatCount(words)} words
                </span>
              ) : null}
              {post ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="machine cursor-default text-xs text-muted-foreground">
                      {formatRelative(post.updated_at)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="machine">
                    {formatAbsolute(post.updated_at)}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </div>

          {/* ONE ROW, AND IT IS THE WHOLE BENCH. Facts first, then the act the post is owed, then
              the always-available ones: the same left-to-right reading order blog-stage uses for
              its published chip, send stamp, Post to CMS and Send. */}
          {post ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DeliveryAct
                brandSlug={brandSlug}
                channel={channel}
                topicSlug={topicSlug}
                label={label}
                post={post}
                onChanged={(next) => setLoaded({ post: next })}
              />
              {/* Always available while viewing the piece: post it to the channel, take the
                  markdown away, or run the generation again. */}
              <PostToChannel channel={channel} content={post.content ?? ""} />
              <MarkdownActions
                raw={post.content ?? null}
                filename={`${topicSlug}-${channel}.md`}
                what={label}
              />
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
          <Skeleton className="mt-4 h-96 w-full" />
        ) : live ? (
          <div className="mt-4">
            <GeneratingCard label={label} />
          </div>
        ) : notGenerated ? (
          <div className="mt-4">
            <NotGeneratedCard label={label} onGenerate={() => void regenerate()} />
          </div>
        ) : loaded && "error" in loaded ? (
          <div className="mt-4">
            <ErrorCard error={loaded.error} onRetry={() => void loadPost()} />
          </div>
        ) : post ? (
          <>
            {/* THE SAME CARD SHAPE THE BLOG STAGE USES: a bordered header strip over the document,
                then the document. gap-0 overflow-hidden p-0 are what let the strip sit flush inside
                the card's own border instead of floating in padding. */}
            <Card className="mt-4 gap-0 overflow-hidden p-0">
              {/* TAKING THE MARKDOWN AWAY BELONGS TO THE DOCUMENT, NOT TO THE RECORD, which is the
                  split blog-stage already draws and this page did not: Send and Mark posted act on
                  where the piece IS, so they stay in the bench above, while Copy markdown and
                  Download act on the text right here and now sit on it. They were in the bench, so
                  the text card carried no controls at all and an operator reading the post had to
                  look back up the page for the two acts about the thing they were looking at.

                  NOTHING SITS ON THE LEFT because there is nothing to put there. The blog stage
                  spends that side on Blog / Eval / Dossier; a channel post is ONE document, and the
                  label and its tag are already stated in the header above. */}
              <div className="flex flex-wrap items-center justify-end gap-2 border-b px-4 py-2">
                <div className="flex items-center gap-1.5">
                  <MarkdownActions
                    raw={post.content ?? null}
                    filename={`${topicSlug}-${channel}.md`}
                    what={label}
                  />
                </div>
              </div>
              <CardContent className="px-4 py-6 sm:px-6">
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
 *
 * IT RENDERS INLINE, as one item in the page's single action row, which is what its old name
 * ActionBar had stopped describing: it was a bar of its own, below the article's own controls, so
 * "send this piece" and "copy this piece" lived in two places an operator had to find separately.
 * The read-only note goes inline for the same reason and in the same shape blog-stage's send stamp
 * uses: a fact belongs beside the controls it explains, not in a panel above them.
 */
function DeliveryAct({
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

  // sent (with client) and posted: nothing owed here, so this is a STAMP and not a control.
  //
  // Short, because it shares a row with buttons now. The old wording spelled out "Waiting on their
  // approval or a change request", which is the tag beside the title saying the same thing twice
  // and at four times the width, so the row read as a sentence with controls stuck on the end.
  // What only this line can carry is WHEN, so that is what it keeps.
  const note =
    state === "sent"
      ? `Sent${post.sent_to_client ? ` ${formatRelative(post.sent_to_client)}` : ""}`
      : state === "posted"
        ? `Posted${post.posted_at ? ` ${formatRelative(post.posted_at)}` : ""}`
        : null;
  return note ? (
    <span className="machine text-xs whitespace-nowrap text-muted-foreground">{note}</span>
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
