"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Loader2, RotateCw, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { blogState } from "@/lib/blog-state";
import { useRuns } from "@/lib/runs-context";
import { formatCount, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { sortBlogs } from "@/components/blogs/blogs-filter";
import type { BlogSummary, RepurposeChannel } from "@/types";

/**
 * The LinkedIn / Medium tab: every PUBLISHED blog for the brand, each with its channel action.
 *
 * It reads the SAME published set PostedLibrary read (api.blogs filtered to blogState
 * "published"), so the three surfaces never disagree about which blogs are posted. What it adds
 * is a per-blog channel pipeline: Generate -> Generating (a live repurpose run, watched through
 * the shared /api/runs poll) -> Review (the generated piece on its own page).
 *
 * A repurpose is generate then review, so there is no send, no score, and no approve here. The
 * output is made visible and that is the whole of it.
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
  const label = channel === "linkedin" ? "LinkedIn post" : "Medium article";

  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  const [listing, setListing] = React.useState<Record<string, { generated_at: string }>>({});
  const [error, setError] = React.useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  // Bridges the up-to-4s gap between a Generate POST landing and the runs poll first reporting the
  // run live, so the row does not sit on "Generate" inviting a second click (which would 409).
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

  const loadListing = React.useCallback(
    (signal?: AbortSignal) =>
      api.repurposeListing(brandSlug, channel, signal).then(
        (data) => setListing(data.artifacts),
        () => {
          // A missing listing is not an error worth a panel: the hosted build has no such
          // endpoint, and a transient failure just leaves rows showing Generate. The blogs load
          // owns the error surface.
        },
      ),
    [brandSlug, channel],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void loadBlogs(controller.signal);
    void loadListing(controller.signal);
    return () => controller.abort();
  }, [loadBlogs, loadListing]);

  // Which published blogs are being repurposed to THIS channel right now, straight off the shared
  // run poll. A repurpose run carries kind, channel, and each topic's source blog slug.
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

  // When a run leaves the live set its piece just landed (or it failed): re-read the listing so
  // the row flips from Generating to Review without a manual refresh. The optimistic `pending`
  // bridge is not pruned here: once a slug is live, `liveSlugs` keeps its row on Generating, and
  // the per-start backstop timer is what eventually clears the bridge.
  const prevLive = React.useRef<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    let finished = false;
    for (const slug of prevLive.current) if (!liveSlugs.has(slug)) finished = true;
    prevLive.current = liveSlugs;
    if (finished) void loadListing();
  }, [liveSlugs, loadListing]);

  async function refresh() {
    setRefreshing(true);
    await Promise.all([loadBlogs(), loadListing()]);
    setRefreshing(false);
  }

  async function start(topicSlug: string) {
    setStartError(null);
    setPending((prev) => new Set(prev).add(topicSlug));
    // Backstop: a run that fails before it ever shows live would strand the bridge, so drop it
    // after a few polls' worth of grace and re-read the listing to reflect whatever landed.
    const clear = window.setTimeout(() => {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(topicSlug);
        return next;
      });
      void loadListing();
    }, 15000);
    try {
      await api.repurpose(brandSlug, { topic_slug: topicSlug, channel });
    } catch (cause) {
      window.clearTimeout(clear);
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(topicSlug);
        return next;
      });
      const err = cause instanceof ApiError ? cause : new ApiError(0, String(cause), null);
      setStartError(
        err.status === 409
          ? `A ${label} for that blog is already generating.`
          : err.isOffline
            ? "Cannot reach the engine."
            : err.message,
      );
    }
  }

  const posted = React.useMemo(
    () => sortBlogs((blogs ?? []).filter((b) => blogState(b) === "published"), "created", "desc"),
    [blogs],
  );

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
          <RotateCw
            className={cn(refreshing && "animate-spin motion-reduce:animate-none")}
            data-icon="inline-start"
            aria-hidden
          />
          Refresh
        </Button>
      </div>

      {startError ? (
        <p className="mb-3 text-xs text-fail" role="alert">
          {startError}
        </p>
      ) : null}

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
      ) : posted.length === 0 ? (
        <NoPosted brandName={brandName} label={label} />
      ) : (
        <>
          <ul className="space-y-2">
            {posted.map((blog) => (
              <ChannelRow
                key={blog.topic_slug}
                blog={blog}
                label={label}
                href={reviewHref(blog.topic_slug)}
                generating={liveSlugs.has(blog.topic_slug) || pending.has(blog.topic_slug)}
                generatedAt={listing[blog.topic_slug]?.generated_at ?? null}
                onGenerate={() => void start(blog.topic_slug)}
              />
            ))}
          </ul>
          <p className="machine mt-3 text-xs text-muted-foreground">
            {formatCount(posted.length)} posted {posted.length === 1 ? "blog" : "blogs"}
          </p>
        </>
      )}
    </div>
  );
}

function ChannelRow(props: {
  blog: BlogSummary;
  label: string;
  href: string;
  generating: boolean;
  generatedAt: string | null;
  onGenerate: () => void;
}) {
  const { blog, label, href, generating, generatedAt, onGenerate } = props;
  const hasArtifact = generatedAt !== null;

  return (
    <li>
      <Card className="p-0">
        <CardContent className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{blog.topic}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {generating
                ? `Generating the ${label}…`
                : hasArtifact
                  ? `${label} generated ${formatRelative(generatedAt)}`
                  : `No ${label} yet`}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {generating ? (
              <Button size="sm" variant="outline" disabled>
                <Loader2 className="animate-spin motion-reduce:animate-none" data-icon="inline-start" aria-hidden />
                Generating
              </Button>
            ) : hasArtifact ? (
              <>
                {!HOSTED_READONLY ? (
                  <Button size="sm" variant="ghost" onClick={onGenerate} title="Regenerate">
                    <RotateCw data-icon="inline-start" aria-hidden />
                    Regenerate
                  </Button>
                ) : null}
                <Button size="sm" asChild>
                  <Link href={href}>
                    Review
                    <ArrowRight data-icon="inline-end" aria-hidden />
                  </Link>
                </Button>
              </>
            ) : HOSTED_READONLY ? (
              <span className="text-xs text-muted-foreground">Engine only</span>
            ) : (
              <Button size="sm" onClick={onGenerate}>
                <Sparkles data-icon="inline-start" aria-hidden />
                Generate {label}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function NoPosted({ brandName, label }: { brandName: string; label: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Send className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">Nothing posted for {brandName} yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          A blog appears here once it is approved and published, and then you can generate its{" "}
          {label}. Publish an approved blog from its own page to add it.
        </p>
      </CardContent>
    </Card>
  );
}
