"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2 } from "lucide-react";
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
import { BlogsTable } from "@/components/blogs/blogs-table";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import { PostToChannel } from "@/components/blogs/post-to-channel";
import { channelTag } from "@/lib/channel-state";
import { ApiError, api, detailText } from "@/portal/api";
import { CommentedArticle } from "@/portal/comments-rail";
import { usePortal } from "@/portal/portal-context";
import { TabCount } from "@/portal/views";
import type {
  PortalChannelDetail,
  PortalChannelList,
  PortalChannelPost,
  SuggestBody,
} from "@/portal/types";
import type { SortDir, SortKey } from "@/components/blogs/blogs-filter";
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
        {name} posts {list.brand_name} has prepared for you, waiting on you or already approved.
      </p>

      {/* THE BLOGS TAB'S OWN TAB SHAPE, not a second one. The line variant with a count chip is
          what the client's Blogs tab wears, and this wore the filled pill with the count in
          parentheses, so the same control looked like two different controls depending on which
          sidebar entry the client had clicked. TabCount is imported from the blogs views rather
          than reimplemented, which is the whole point: one component, one look, one place to
          change it. */}
      <Tabs
        defaultValue={list.ready.length === 0 && list.approved.length > 0 ? "approved" : "ready"}
        className="mt-4 gap-6"
      >
        <TabsList variant="line" className="w-full justify-start gap-4">
          <TabsTrigger value="ready" className="flex-none">
            Ready to post
            {/* Amber, because every row in this tab is waiting on the client. */}
            <TabCount n={list.ready.length} tone={list.ready.length > 0 ? "review" : "default"} />
          </TabsTrigger>
          <TabsTrigger value="approved" className="flex-none">
            Approved
            <TabCount n={list.approved.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ready">
          <PostList
            posts={list.ready}
            detailHref={detailHref}
            empty={`Nothing ready to post yet. A ${name} post appears here once our team sends it to you.`}
          />
        </TabsContent>
        <TabsContent value="approved">
          <PostList
            posts={list.approved}
            detailHref={detailHref}
            empty={`Posts you approve collect here, including the ones already live on ${name}.`}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * THE BLOGS TABLE, NOT A CARD LIST. Same component, same columns, same row rhythm, same keyboard
 * behaviour as the client's Blogs tab, so a person moving between the two sidebar entries is
 * reading one interface. This was a hand-built list of Cards: a title, a relative stamp and a
 * Review button, which answered the same questions the table already answers and answered them in
 * a different shape, at a different height, sorted a different way.
 *
 * TWO THINGS THE TABLE NEEDED, AND ONLY TWO. `tagOf`, because a channel post's lifecycle is its
 * own vocabulary and BlogStateTag cannot speak it; and the "#" resolved from the client's own blog
 * cards, because a post has no roadmap row of its own. Its number is its SOURCE BLOG's, which is
 * the same rule the admin's channel table follows, so "post 3" and "blog 3" are one thing on both
 * sides of the wire.
 */
function PostList({
  posts,
  detailHref,
  empty,
}: {
  posts: PortalChannelPost[];
  detailHref: (topic: string) => string;
  empty: string;
}) {
  const router = useRouter();
  const { blogs } = usePortal();
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({
    key: "roadmap",
    dir: "asc",
  });

  // topic_slug -> the source blog's roadmap row, from the cards the portal already holds. A post
  // whose blog is not in that list keeps a blank cell rather than posing as row one.
  const indexBySlug = React.useMemo(
    () => new Map(blogs.map((card) => [card.topic_slug, card.roadmap_index])),
    [blogs],
  );

  const rows = React.useMemo(() => {
    const mapped = posts.map((post) => ({
      ...post,
      // The table's row shape is the admin's: `topic` is the title's wire name there.
      topic: post.title,
      roadmap_index: indexBySlug.get(post.topic_slug) ?? null,
      // The client is never told how a change is being applied, only that some are outstanding,
      // which is exactly what the shared tag renders from this field.
      comments_pending: post.comments_pending,
    }));
    const compare = (a: (typeof mapped)[number], b: (typeof mapped)[number]): number => {
      switch (sort.key) {
        case "roadmap":
          return (a.roadmap_index ?? Infinity) - (b.roadmap_index ?? Infinity);
        case "topic":
          return a.topic.localeCompare(b.topic);
        case "status":
          return a.state.localeCompare(b.state);
        default:
          return a.created.localeCompare(b.created);
      }
    };
    return [...mapped].sort((a, b) => (sort.dir === "asc" ? compare(a, b) : -compare(a, b)));
  }, [posts, indexBySlug, sort]);

  if (posts.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-xs text-muted-foreground">{empty}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden p-0">
      <BlogsTable
        blogs={rows}
        // No questions on this track: a channel post has no evaluator form, so nothing here ever
        // waits on an answer and the chip never renders.
        waiting={EMPTY_WAITING}
        // Never reaches the screen: tagOf below supersedes it. The tag is the channel vocabulary.
        stateOf={() => "client_review"}
        tagOf={(row) => channelTag(row.state, "client")}
        audience="client"
        sortKey={sort.key}
        sortDir={sort.dir}
        activeSlug={null}
        onSort={(key) =>
          setSort((cur) =>
            cur.key === key
              ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
              : { key, dir: key === "roadmap" || key === "topic" ? "asc" : "desc" },
          )
        }
        hrefFor={(row) => detailHref(row.topic_slug)}
        onOpen={(row) => router.push(detailHref(row.topic_slug))}
      />
    </Card>
  );
}

/** Hoisted so its identity is stable: a fresh Map every render would defeat the table's memos. */
const EMPTY_WAITING = new Map<string, never>();

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
