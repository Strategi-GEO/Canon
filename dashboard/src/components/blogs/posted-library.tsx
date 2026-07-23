"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RotateCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { blogState } from "@/lib/blog-state";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { sortBlogs, type SortDir, type SortKey } from "@/components/blogs/blogs-filter";
import { BlogsTable } from "@/components/blogs/blogs-table";
import type { WaitingSignal } from "@/components/blogs/questions-state";
import type { BlogSummary } from "@/types";

// A posted blog is `published`, which is terminal and never carries an open question, so the
// waiting map is always empty here. Module-level so the table gets one stable reference.
const NO_WAITING: ReadonlyMap<string, WaitingSignal> = new Map();

/**
 * The posted-blog table for one distribution channel (LinkedIn, Medium). It is the SAME
 * presentational table the Blogs library renders (BlogsTable), filtered to the `published`
 * state, which is what "posted" means: the blog was approved and then pushed out.
 *
 * DELIBERATELY NOT BlogsLibrary. That component runs the notification effect, which persists a
 * per-brand baseline (saveObservedReview) computed from whatever set it is showing. Feeding it a
 * filtered subset would overwrite the full-library baseline and re-announce every approval. This
 * view carries none of that machinery because a posted blog has nothing outstanding to announce.
 */
export function PostedLibrary(props: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  title: string;
  blurb: string;
}) {
  const router = useRouter();
  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [sortKey, setSortKey] = React.useState<SortKey>("created");
  const [sortDir, setSortDir] = React.useState<SortDir>("desc");

  const { orgSlug, brandSlug, brandName, title, blurb } = props;

  const blogHref = React.useCallback(
    (topicSlug: string) =>
      `${brandHref(orgSlug, brandSlug, "/blogs")}/${encodeURIComponent(topicSlug)}`,
    [orgSlug, brandSlug],
  );

  const load = React.useCallback(
    (signal?: AbortSignal) =>
      api.blogs(brandSlug, signal).then(
        (data) => {
          setBlogs(data.blogs);
          setError(null);
        },
        (cause: unknown) => {
          if (cause instanceof DOMException && cause.name === "AbortError") {
            return;
          }
          setError(cause instanceof ApiError ? cause : new ApiError(0, String(cause), null));
        },
      ),
    [brandSlug],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  // Only posted blogs, over the same state read the Blogs library and the stage page use, so
  // the three screens can never disagree about which blogs are published.
  const posted = React.useMemo(
    () => (blogs ?? []).filter((blog) => blogState(blog) === "published"),
    [blogs],
  );
  const shown = React.useMemo(
    () => sortBlogs(posted, sortKey, sortDir),
    [posted, sortKey, sortDir],
  );

  // The table needs one row in the tab order; the first posted row takes it.
  const activeSlug = shown[0]?.topic_slug ?? null;

  const onSort = React.useCallback(
    (key: SortKey) => {
      if (key === sortKey) {
        setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
      } else {
        setSortKey(key);
        setSortDir("desc");
      }
    },
    [sortKey],
  );

  return (
    <TooltipProvider>
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
          <Skeleton className="h-80 w-full" />
        ) : shown.length === 0 ? (
          <NoPosted brandName={brandName} />
        ) : (
          <>
            <Card className="overflow-hidden p-0">
              <BlogsTable
                blogs={shown}
                waiting={NO_WAITING}
                stateOf={blogState}
                sortKey={sortKey}
                sortDir={sortDir}
                activeSlug={activeSlug}
                onSort={onSort}
                hrefFor={(blog) => blogHref(blog.topic_slug)}
                onOpen={(blog) => router.push(blogHref(blog.topic_slug))}
                brandSlug={HOSTED_READONLY ? undefined : brandSlug}
                onDeleted={HOSTED_READONLY ? undefined : () => void refresh()}
              />
            </Card>
            <p className="machine mt-3 text-xs text-muted-foreground">
              {formatCount(shown.length)} posted {shown.length === 1 ? "blog" : "blogs"}
            </p>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}

function NoPosted({ brandName }: { brandName: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <Send className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">Nothing posted for {brandName} yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          A blog appears here once it is approved and published. Publish an approved blog from its
          own page to add it.
        </p>
      </CardContent>
    </Card>
  );
}
