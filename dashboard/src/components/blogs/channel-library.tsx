"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Loader2, Play, RotateCw, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { blogState } from "@/lib/blog-state";
import { blogLabels } from "@/lib/blog-label";
import { adminFailedTag } from "@/lib/blog-score";
import { channelLabel, channelTag, isRepurposable } from "@/lib/channel-state";
import { useRuns } from "@/lib/runs-context";
import { formatCount, formatRelative } from "@/lib/format";
import { sortBlogs } from "@/components/blogs/blogs-filter";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import type { BlogSummary, ChannelPost, RepurposeChannel } from "@/types";

/**
 * The LinkedIn / Medium tab, two horizontal sub-tabs over ONE brand's work:
 *
 *  - NEW: every blog for the brand, each with its own blog-state tag plus a channel tag. A blog
 *    with no post yet is selectable (only a FINISHED blog is); tick any number and Generate turns
 *    each into a post. A blog that already has a post is shown but NOT selectable, tagged Created
 *    (yellow) until it is posted, then Posted (green).
 *  - CREATED: the generated posts themselves, each opening its own review page (comments ->
 *    resolve with Claude -> send to client -> mark posted).
 *
 * Medium is this component with channel="medium"; the two tabs are identical in every respect.
 */
export function ChannelLibrary(props: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  channel: RepurposeChannel;
  title: string;
  blurb: string;
}) {
  const { orgSlug, brandSlug, brandName, channel, title, blurb } = props;
  const label = channelLabel(channel);

  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  const [posts, setPosts] = React.useState<ChannelPost[]>([]);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [startError, setStartError] = React.useState<string | null>(null);
  // Bridges the gap between a Generate POST landing and the runs poll first reporting the run
  // live, so a just-fired row shows Generating rather than sitting selectable and inviting a
  // second click.
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());

  const { runs } = useRuns();

  const reviewHref = React.useCallback(
    (topicSlug: string) =>
      `${brandHref(orgSlug, brandSlug, `/${channel}`)}/${encodeURIComponent(topicSlug)}`,
    [orgSlug, brandSlug, channel],
  );

  const loadBlogs = React.useCallback(
    (signal?: AbortSignal) =>
      api.blogs(brandSlug, signal).then(
        (data) => {
          setBlogs(data.blogs);
          setError(null);
        },
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
        },
      ),
    [brandSlug],
  );

  const loadPosts = React.useCallback(
    (signal?: AbortSignal) =>
      api.channelPosts(brandSlug, channel, signal).then(
        (data) => setPosts(data.posts),
        () => {
          // A missing listing is not a panel: the blogs load owns the error surface, and a
          // transient failure just leaves the Created tab as it was.
        },
      ),
    [brandSlug, channel],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void loadBlogs(controller.signal);
    void loadPosts(controller.signal);
    return () => controller.abort();
  }, [loadBlogs, loadPosts]);

  // Which blogs are being generated to THIS channel right now, off the shared run poll.
  const liveSlugs = React.useMemo(() => {
    const s = new Set<string>();
    for (const run of runs) {
      if (run.kind !== "repurpose" || run.client !== brandSlug || !run.live) continue;
      if (run.channel !== channel) continue;
      for (const topic of run.topics) {
        if (topic.source_topic_slug) s.add(topic.source_topic_slug);
      }
    }
    return s;
  }, [runs, brandSlug, channel]);

  // When a run leaves the live set its post just landed (or it failed): re-read the posts so the
  // row flips from Generating to a Created tag without a manual refresh.
  const prevLive = React.useRef<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    let finished = false;
    for (const slug of prevLive.current) if (!liveSlugs.has(slug)) finished = true;
    prevLive.current = liveSlugs;
    if (finished) void loadPosts();
  }, [liveSlugs, loadPosts]);

  const postBySlug = React.useMemo(() => {
    const m = new Map<string, ChannelPost>();
    for (const post of posts) m.set(post.source_topic_slug, post);
    return m;
  }, [posts]);

  const rows = React.useMemo(
    () => sortBlogs(blogs ?? [], "created", "desc"),
    [blogs],
  );

  const isGenerating = React.useCallback(
    (slug: string) => liveSlugs.has(slug) || pending.has(slug),
    [liveSlugs, pending],
  );

  const isSelectable = React.useCallback(
    (blog: BlogSummary) =>
      !HOSTED_READONLY &&
      isRepurposable(blogState(blog)) &&
      !postBySlug.has(blog.topic_slug) &&
      !isGenerating(blog.topic_slug),
    [postBySlug, isGenerating],
  );

  // Drop selections that stopped being selectable (a post landed, a run started) so Generate never
  // fires on a row the table now shows as taken.
  React.useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      for (const slug of prev) {
        const blog = rows.find((b) => b.topic_slug === slug);
        if (blog && isSelectable(blog)) next.add(slug);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [rows, isSelectable]);

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function refresh() {
    setRefreshing(true);
    await Promise.all([loadBlogs(), loadPosts()]);
    setRefreshing(false);
  }

  async function generate() {
    const slugs = Array.from(selected);
    if (slugs.length === 0) return;
    setStartError(null);
    setSelected(new Set());
    setPending((prev) => {
      const next = new Set(prev);
      for (const s of slugs) next.add(s);
      return next;
    });
    // Backstop: a run that fails before it ever shows live would strand the bridge, so clear the
    // pending marks after a few polls' grace and re-read the posts to reflect whatever landed.
    const clear = window.setTimeout(() => {
      setPending((prev) => {
        const next = new Set(prev);
        for (const s of slugs) next.delete(s);
        return next;
      });
      void loadPosts();
    }, 15000);
    const results = await Promise.allSettled(
      slugs.map((topic_slug) => api.repurpose(brandSlug, { topic_slug, channel })),
    );
    const failed = results.filter(
      (r) => r.status === "rejected" && !(r.reason instanceof ApiError && r.reason.status === 409),
    );
    if (failed.length > 0) {
      window.clearTimeout(clear);
      const reason = failed[0];
      const err =
        reason.status === "rejected" && reason.reason instanceof ApiError
          ? reason.reason
          : new ApiError(0, "Could not start the generation.", null);
      setStartError(err.isOffline ? "Cannot reach the engine." : err.message);
      setPending((prev) => {
        const next = new Set(prev);
        for (const s of slugs) next.delete(s);
        return next;
      });
      void loadPosts();
    }
  }

  // The New tab shows blogs that do NOT yet have a channel post: the moment a post exists the blog
  // moves out to the Created tab. A blog mid-generation has no committed post yet, so it stays here
  // (checkbox disabled, a small "generating" hint) until its post lands, then it moves too.
  const newRows = React.useMemo(
    () => rows.filter((b) => !postBySlug.has(b.topic_slug)),
    [rows, postBySlug],
  );

  const selectableSlugs = React.useMemo(
    () => newRows.filter((b) => isSelectable(b)).map((b) => b.topic_slug),
    [newRows, isSelectable],
  );
  // The source-grouped identifier (number for AI, letter for uploaded), computed over the WHOLE
  // brand list so the counts match the blogs table even though this tab renders only a subset.
  const labels = React.useMemo(() => blogLabels(blogs ?? []), [blogs]);
  const selectableCount = selectableSlugs.length;
  const allSelected = selectableCount > 0 && selectableSlugs.every((s) => selected.has(s));
  const someSelected = !allSelected && selectableSlugs.some((s) => selected.has(s));
  function toggleAll() {
    setSelected((prev) =>
      selectableSlugs.every((s) => prev.has(s)) ? new Set() : new Set(selectableSlugs),
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RotateCw
              className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}
              data-icon="inline-start"
              aria-hidden
            />
            Refresh
          </Button>
        </div>

        {error ? (
          <Card className="border-fail/25 bg-fail-bg">
            <CardContent className="py-8 text-center">
              <p className="text-sm font-medium text-fail">
                {error.isOffline ? "Cannot reach the engine" : "The engine refused the request"}
              </p>
              <p className="machine mx-auto mt-2 max-w-md text-xs wrap-break-word text-fail/80">
                {error.message}
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => void refresh()}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : blogs === null ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <Tabs defaultValue="new">
            <TabsList>
              <TabsTrigger value="new">New</TabsTrigger>
              <TabsTrigger value="created">Created{posts.length ? ` (${posts.length})` : ""}</TabsTrigger>
            </TabsList>

            <TabsContent value="new" className="mt-4">
              {startError ? (
                <p className="mb-3 text-xs text-fail" role="alert">
                  {startError}
                </p>
              ) : null}

              {!HOSTED_READONLY ? (
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="machine text-xs text-muted-foreground">
                    {selected.size > 0
                      ? `${formatCount(selected.size)} selected`
                      : `${formatCount(selectableCount)} ready to generate`}
                  </p>
                  <Button onClick={() => void generate()} disabled={selected.size === 0}>
                    <Play data-icon="inline-start" aria-hidden />
                    Generate
                  </Button>
                </div>
              ) : null}

              {newRows.length === 0 ? (
                rows.length === 0 ? (
                  <NoBlogs brandName={brandName} />
                ) : (
                  <AllGenerated label={label} />
                )
              ) : (
                <Card className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {!HOSTED_READONLY ? (
                          <TableHead className="w-10">
                            <Checkbox
                              checked={allSelected ? true : someSelected ? "indeterminate" : false}
                              disabled={selectableCount === 0}
                              onCheckedChange={() => toggleAll()}
                              aria-label="Select all blogs"
                            />
                          </TableHead>
                        ) : null}
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>Blog</TableHead>
                        <TableHead className="w-32">Created</TableHead>
                        <TableHead className="w-40">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {newRows.map((blog) => {
                        const state = blogState(blog);
                        const generating = isGenerating(blog.topic_slug);
                        const selectable = isSelectable(blog);
                        return (
                          <TableRow key={blog.topic_slug}>
                            {!HOSTED_READONLY ? (
                              <TableCell>
                                <Checkbox
                                  checked={selected.has(blog.topic_slug)}
                                  disabled={!selectable}
                                  onCheckedChange={() => toggle(blog.topic_slug)}
                                  aria-label={`Select ${blog.topic}`}
                                />
                              </TableCell>
                            ) : null}
                            <TableCell
                              className="machine text-xs text-muted-foreground"
                              title={blog.uploaded ? "Uploaded by hand — letters mark manual blogs" : "Written by the engine"}
                            >
                              {labels.get(blog.topic_slug) ?? "—"}
                            </TableCell>
                            <TableCell className="max-w-0">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-foreground">
                                  {blog.topic}
                                </span>
                                {generating ? (
                                  <span className="machine inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                    <Loader2
                                      className="size-3 animate-spin motion-reduce:animate-none"
                                      aria-hidden
                                    />
                                    generating {label}…
                                  </span>
                                ) : null}
                              </span>
                            </TableCell>
                            <TableCell className="machine text-xs text-muted-foreground">
                              {formatRelative(blog.created)}
                            </TableCell>
                            <TableCell>
                              <BlogStateTag
                                state={state}
                                audience="admin"
                                failedTag={adminFailedTag(blog.score ?? null)}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="created" className="mt-4">
              {posts.length === 0 ? (
                <NoPosts brandName={brandName} label={label} />
              ) : (
                <Card className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Post</TableHead>
                        <TableHead className="w-40">Status</TableHead>
                        <TableHead className="w-32">Updated</TableHead>
                        <TableHead className="w-24 text-right">Review</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {posts.map((post) => {
                        const generating = isGenerating(post.source_topic_slug);
                        const state = generating ? "generating" : post.state;
                        return (
                          <TableRow key={post.id}>
                            <TableCell className="max-w-0">
                              <span className="block truncate text-sm font-medium text-foreground">
                                {post.source_topic}
                              </span>
                            </TableCell>
                            <TableCell>
                              <StateTagChip tag={channelTag(state, "admin")} />
                            </TableCell>
                            <TableCell className="machine text-xs text-muted-foreground">
                              {formatRelative(post.updated_at)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button size="sm" variant="ghost" asChild>
                                <Link href={reviewHref(post.source_topic_slug)}>
                                  Open
                                  <ArrowRight data-icon="inline-end" aria-hidden />
                                </Link>
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        )}
      </div>
    </TooltipProvider>
  );
}

function NoBlogs({ brandName }: { brandName: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Send className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">No blogs for {brandName} yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          Once a blog is written for this brand it appears here, and you can turn a finished one
          into a post.
        </p>
      </CardContent>
    </Card>
  );
}

function AllGenerated({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Sparkles className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">Every blog has a {label}</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          Each blog with a post now lives in the Created tab. New blogs appear here to generate
          from.
        </p>
      </CardContent>
    </Card>
  );
}

function NoPosts({ brandName, label }: { brandName: string; label: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Sparkles className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          No {label}s generated for {brandName} yet
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          Pick one or more finished blogs in the New tab and press Generate. Each one appears here
          for review.
        </p>
      </CardContent>
    </Card>
  );
}
