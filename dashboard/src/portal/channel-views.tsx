"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import { PostToChannel } from "@/components/blogs/post-to-channel";
import { channelTag } from "@/lib/channel-state";
import { formatRelative } from "@/lib/format";
import { ApiError, api, detailText } from "@/portal/api";
import { CommentedArticle } from "@/portal/comments-rail";
import type {
  PortalChannelDetail,
  PortalChannelList,
  PortalChannelPost,
  SuggestBody,
} from "@/portal/types";
import type { RepurposeChannel } from "@/types";

/**
 * The client's LinkedIn / Medium tab. A near-mirror of the blog library and detail, minus
 * everything a channel post lacks (no score, no versions, no questions): the client sees the
 * posts the team sent them, in two buckets, and may request a change or approve, exactly as they
 * do a blog. The state vocabulary is the client half of lib/channel-state (Ready to post, Pending
 * comments, Approved, Posted). Medium is this file with channel="medium".
 */

const CHANNEL_NAME: Record<RepurposeChannel, string> = { linkedin: "LinkedIn", medium: "Medium" };

// ---------------------------------------------------------------------------
// The library: Ready to post / Posted
// ---------------------------------------------------------------------------

export function ChannelLibraryView({
  brand,
  channel,
}: {
  org: string;
  brand: string;
  channel: RepurposeChannel;
}) {
  const pathname = usePathname();
  const name = CHANNEL_NAME[channel];

  const [list, setList] = React.useState<PortalChannelList | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(
    (signal?: AbortSignal) =>
      api.channelList(brand, channel, signal).then(
        (data) => {
          setList(data);
          setError(null);
        },
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause)));
        },
      ),
    [brand, channel],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const detailHref = React.useCallback(
    (topic: string) => `${pathname.replace(/\/$/, "")}/${encodeURIComponent(topic)}`,
    [pathname],
  );

  if (error !== null) {
    return (
      <Card className="mx-auto max-w-md">
        <CardContent className="py-8 text-center">
          <p className="text-sm font-medium">Could not load your {name} posts</p>
          <p className="mt-1 text-xs text-muted-foreground">{detailText(error)}</p>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (list === null) {
    return <Skeleton className="mx-auto h-72 w-full max-w-3xl" />;
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="text-xl font-semibold tracking-tight">{name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {name} posts {list.brand_name} has prepared for you, ready to post or already posted.
      </p>

      <Tabs defaultValue={list.ready.length === 0 && list.posted.length > 0 ? "posted" : "ready"}>
        <TabsList className="mt-4">
          <TabsTrigger value="ready">
            Ready to post{list.ready.length ? ` (${list.ready.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="posted">
            Posted{list.posted.length ? ` (${list.posted.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ready" className="mt-4">
          <PostList
            posts={list.ready}
            channel={channel}
            detailHref={detailHref}
            empty={`Nothing ready to post yet. A ${name} post appears here once our team sends it to you.`}
          />
        </TabsContent>
        <TabsContent value="posted" className="mt-4">
          <PostList
            posts={list.posted}
            channel={channel}
            detailHref={detailHref}
            empty="No posts marked posted yet."
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PostList({
  posts,
  channel,
  detailHref,
  empty,
}: {
  posts: PortalChannelPost[];
  channel: RepurposeChannel;
  detailHref: (topic: string) => string;
  empty: string;
}) {
  if (posts.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-xs text-muted-foreground">{empty}</CardContent>
      </Card>
    );
  }
  return (
    <ul className="space-y-2">
      {posts.map((post) => (
        <li key={`${post.channel}:${post.topic_slug}`}>
          <Card className="p-0">
            <CardContent className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{post.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {post.posted
                    ? `Posted ${formatRelative(post.posted)}`
                    : post.sent
                      ? `Sent ${formatRelative(post.sent)}`
                      : null}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StateTagChip tag={channelTag(post.state, "client")} />
                <Button size="sm" variant="outline" asChild>
                  <Link href={detailHref(post.topic_slug)}>
                    {channel === "linkedin" ? "Review" : "Review"}
                    <ArrowRight data-icon="inline-end" aria-hidden />
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The detail: review, request a change, approve, and the Post button
// ---------------------------------------------------------------------------

export function ChannelPostDetailView({
  brand,
  channel,
  topic,
}: {
  org: string;
  brand: string;
  channel: RepurposeChannel;
  topic: string;
}) {
  const pathname = usePathname();
  const name = CHANNEL_NAME[channel];
  const backHref = pathname.replace(/\/[^/]+\/?$/, "");

  const [loaded, setLoaded] = React.useState<
    { post: PortalChannelDetail } | { error: ApiError } | null
  >(null);

  const load = React.useCallback(
    (signal?: AbortSignal) =>
      api.channelPost(brand, channel, topic, signal).then(
        (post) => setLoaded({ post }),
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setLoaded({ error: cause instanceof ApiError ? cause : new ApiError(0, String(cause)) });
        },
      ),
    [brand, channel, topic],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const post = loaded && "post" in loaded ? loaded.post : null;
  const canAct = post !== null && (post.state === "sent" || post.state === "changes_requested");

  async function onSuggest(draft: SuggestBody) {
    await api.suggestChannelChange(brand, channel, topic, draft);
    await load();
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to {name}
      </Link>

      {loaded === null ? (
        <Skeleton className="mt-3 h-96 w-full" />
      ) : post === null ? (
        <Card className="mt-3">
          <CardContent className="py-12 text-center">
            <p className="text-sm font-medium">This post is not available</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The link may be wrong, or the post is not with you for review yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mt-1 mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">{post.title}</h1>
              <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <span>{name} post</span>
                <StateTagChip tag={channelTag(post.state, "client")} />
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <PostToChannel channel={channel} content={post.body} />
              {canAct ? <ApproveChannelPost brand={brand} channel={channel} topic={topic} onApproved={() => void load()} /> : null}
            </div>
          </div>

          <Card>
            <CardContent className="p-6">
              <CommentedArticle
                source={post.body}
                comments={post.comments ?? []}
                onSuggest={onSuggest}
                canSuggest={canAct}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function ApproveChannelPost({
  brand,
  channel,
  topic,
  onApproved,
}: {
  brand: string;
  channel: RepurposeChannel;
  topic: string;
  onApproved: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api.approveChannelPost(brand, channel, topic);
      setOpen(false);
      onApproved();
    } catch (cause) {
      setError(cause instanceof ApiError ? detailText(cause) : String(cause));
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
      <AlertDialogTrigger asChild>
        <Button size="sm">
          <Check data-icon="inline-start" aria-hidden />
          Approve
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve this post?</AlertDialogTitle>
          <AlertDialogDescription>
            Approving tells our team the post is ready. It is locked after that, so add any changes
            you want first by selecting a passage.
          </AlertDialogDescription>
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
              void approve();
            }}
          >
            {busy ? <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden /> : null}
            Approve
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
