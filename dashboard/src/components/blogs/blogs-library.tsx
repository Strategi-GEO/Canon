"use client";

import * as React from "react";
import Link from "next/link";
import {
  FileText,
  FlaskConical,
  MessageCircleQuestion,
  RotateCw,
  Search,
  SearchX,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { formatCount } from "@/lib/format";
import { useBlogQuestions } from "@/lib/use-blog-questions";
import { useHotkey } from "@/lib/use-hotkey";
import { cn } from "@/lib/utils";
import { selectBlogs, type StatusFilter } from "@/components/blogs/blogs-filter";
import { BlogsTable, TRIGGER_ATTR } from "@/components/blogs/blogs-table";
import { useLibraryUrl } from "@/components/blogs/library-url";
import { PreviewDrawer } from "@/components/blogs/preview-drawer";
import {
  countWaiting,
  waitingSignal,
  type WaitingSignal,
} from "@/components/blogs/questions-state";
import type { BlogSummary } from "@/types";

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "done", label: "Shipped" },
  // Named for the act it summons someone for, matching the badge. The filter an operator reaches
  // for is "what do I owe", and that is what this word now means at every score.
  { value: "needs_review", label: "Waiting on you" },
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "stopped", label: "Stopped" },
];

/**
 * One BRAND's blogs. The brand arrives as a prop and is never read from a context or the URL:
 * the route owns that, and a library that guessed its own brand could show one brand's blogs
 * under another brand's name.
 *
 * GET /api/clients/{brand}/blogs SCANS THE DISK. A blog deleted in Finder is simply gone from
 * the response, which is why nothing here is cached around that call: a cache would keep
 * offering a preview of a file that no longer exists. Refresh re-reads the disk.
 *
 * The Suspense boundary is not decoration. The view state lives in the URL, so this tree
 * calls useSearchParams, and Next bails a prerendered route out to the client up to the
 * nearest boundary. Without one here, a production build of any route that mounts this
 * library fails outright, and the route belongs to another owner.
 */
export function BlogsLibrary(props: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  demoMode: boolean;
}) {
  return (
    // One provider for the whole library. Radix requires it above every Tooltip, and context
    // reaches the drawer through its portal because a portal moves DOM, not the React tree.
    // Per-tooltip providers would be a dozen copies of the same context doing the same job.
    <TooltipProvider>
      <React.Suspense fallback={<LibrarySkeleton />}>
        <Library {...props} />
      </React.Suspense>
    </TooltipProvider>
  );
}

function LibrarySkeleton() {
  return (
    <div className="mx-auto w-full max-w-6xl">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="mt-4 h-80 w-full" />
      <span className="sr-only" role="status">
        Loading blogs
      </span>
    </div>
  );
}

function Library({
  orgSlug,
  brandSlug,
  brandName,
  demoMode,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  demoMode: boolean;
}) {
  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [picked, setPicked] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const url = useLibraryUrl();

  // The engine is an external system, so this subscribes to it and writes state only from
  // the settled callbacks rather than synchronously inside the effect body.
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

  /**
   * Which blogs are waiting on a person, read once per brand.
   *
   * A blog whose evaluator asked the operator something is stopped until they answer, and an
   * operator with twelve blogs will not click into each one to discover which four those are. The
   * signal has to be in the LIST, so the list reads the questions.
   */
  const topicSlugs = React.useMemo(() => (blogs ?? []).map((blog) => blog.topic_slug), [blogs]);
  const { byTopic, reload: reloadQuestions } = useBlogQuestions(brandSlug, topicSlugs);

  const waiting = React.useMemo(() => {
    const signals = new Map<string, WaitingSignal>();
    for (const [slug, entry] of byTopic) {
      const signal = waitingSignal(entry.payload);
      if (signal !== null) {
        signals.set(slug, signal);
      }
    }
    return signals;
  }, [byTopic]);

  async function refresh() {
    setRefreshing(true);
    reloadQuestions();
    await load();
    setRefreshing(false);
  }

  /**
   * Both reads again, together. Answering files an answers.json, which changes what the
   * questions endpoint says about this topic, and the revise it starts changes the blog's score:
   * re-reading one without the other would show the new state of a blog beside the old answer to
   * whether it is still waiting.
   */
  const questionsSettled = React.useCallback(() => {
    void load();
    reloadQuestions();
  }, [load, reloadQuestions]);

  const shown = React.useMemo(
    () => selectBlogs(blogs ?? [], url.query, url.status, url.sortKey, url.sortDir),
    [blogs, url.query, url.status, url.sortKey, url.sortDir],
  );

  // The keyboard's row. A filter can hide whatever was picked, and a row that is not rendered
  // must not hold the table's only tab stop, so it falls back to the first visible row.
  const candidate = picked ?? url.previewSlug;
  const activeSlug =
    shown.find((blog) => blog.topic_slug === candidate)?.topic_slug ??
    shown[0]?.topic_slug ??
    null;

  const previewing = url.previewSlug !== null;
  // The URL names a slug; the DISK decides whether it exists. A blog deleted in Finder leaves
  // a link that still resolves to this page, and the honest answer is that it is gone.
  const previewBlog = blogs?.find((blog) => blog.topic_slug === url.previewSlug) ?? null;
  const previewMissing = previewing && blogs !== null && previewBlog === null;

  /** Moves the keyboard through the list by moving real focus, so Enter needs no handler of
   *  its own: the row's button is focused and Enter activates it natively. */
  const move = React.useCallback(
    (delta: number) => {
      if (shown.length === 0) {
        return;
      }
      const index = shown.findIndex((blog) => blog.topic_slug === activeSlug);
      const next = Math.min(Math.max((index === -1 ? 0 : index) + delta, 0), shown.length - 1);
      const slug = shown[next].topic_slug;
      setPicked(slug);
      const row = document.querySelector<HTMLElement>(
        `[${TRIGGER_ATTR}="${CSS.escape(slug)}"]`,
      );
      row?.focus();
      // block: nearest, so a row already on screen does not yank the page around it.
      row?.scrollIntoView({ block: "nearest" });
    },
    [shown, activeSlug],
  );

  // Disabled while the drawer is open: Radix owns the keyboard inside it, and j is a letter
  // someone may be typing into the search field. useHotkey already guards text fields.
  const keys = { enabled: !previewing };
  useHotkey("j", () => move(1), keys);
  useHotkey("k", () => move(-1), keys);
  // Arrows only steer the list once the operator is IN it. Before that they scroll the page,
  // which is what an arrow key means everywhere else, and hijacking that would be rude.
  const engaged = { enabled: !previewing && picked !== null };
  useHotkey("arrowdown", () => move(1), engaged);
  useHotkey("arrowup", () => move(-1), engaged);
  useHotkey("/", () => searchRef.current?.focus(), keys);

  const total = blogs?.length ?? 0;
  const filtering = url.query.trim() !== "" || url.status !== "all";

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Blogs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything the factory has written for {brandName}.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              type="search"
              value={url.query}
              onChange={(event) => url.setQuery(event.target.value)}
              placeholder="Search titles"
              aria-label="Search blogs by title or slug"
              className="h-8 w-52 pl-8 text-xs"
            />
          </div>
          <select
            value={url.status}
            onChange={(event) => url.setStatus(event.target.value as StatusFilter)}
            aria-label="Filter by status"
            className={cn(
              "h-8 rounded-lg border border-input bg-background px-2 text-xs",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            )}
          >
            {FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RotateCw
              className={cn(refreshing && "animate-spin motion-reduce:animate-none")}
              data-icon="inline-start"
              aria-hidden
            />
            Refresh
          </Button>
        </div>
      </div>

      {demoMode ? (
        // Persistent, not dismissible. A demo artifact that gets mistaken for a researched
        // blog is the one failure demo mode exists to prevent.
        <Card className="mb-4">
          <CardContent className="flex gap-2 py-3">
            <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {brandName} is a demo brand. These blogs are precoded, written with no research
              and no API calls behind them, and every file is marked demo content at the top.
              They are not for publication.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <WaitingOnYou signals={waiting} />

      {previewMissing ? <MissingBlog slug={url.previewSlug} onClear={url.closePreview} /> : null}

      {error ? <EngineError error={error} onRetry={() => void refresh()} /> : null}

      {!error && blogs === null ? <Skeleton className="h-80 w-full" /> : null}

      {!error && blogs !== null ? (
        total === 0 ? (
          <NoBlogs brandName={brandName} createHref={brandHref(orgSlug, brandSlug, "/create")} />
        ) : (
          <>
            <Card className="overflow-hidden p-0">
              {shown.length === 0 ? (
                <NoMatches onClear={url.clearFilters} />
              ) : (
                <BlogsTable
                  blogs={shown}
                  waiting={waiting}
                  sortKey={url.sortKey}
                  sortDir={url.sortDir}
                  activeSlug={activeSlug}
                  onSort={url.setSort}
                  onPreview={(blog) => {
                    setPicked(blog.topic_slug);
                    url.openPreview(blog.topic_slug);
                  }}
                />
              )}
            </Card>

            <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <p className="machine text-xs text-muted-foreground">
                {filtering
                  ? `${formatCount(shown.length)} of ${formatCount(total)} blogs`
                  : `${formatCount(total)} ${total === 1 ? "blog" : "blogs"}`}
              </p>
              <p className="text-xs text-muted-foreground">
                <kbd className="machine">j</kbd> and <kbd className="machine">k</kbd> to move,{" "}
                <kbd className="machine">enter</kbd> to open, <kbd className="machine">/</kbd> to
                search
              </p>
            </div>

            {(blogs ?? []).some((blog) => blog.status === "needs_review") ? (
              // Quiet, and never styled as an error: needs_review is the pipeline working.
              //
              // It says questions rather than reasons because that is now the whole of what the
              // status means, and the engine enforces it: a run with nothing to ask settles on
              // its score instead. The old wording taught the opposite, naming the four iteration
              // cap and a sourcing top-up as causes in their own right, which is exactly how a
              // blog ended up held for an act nobody could name.
              //
              // The score is deliberately absent from the definition now. A 96 DOES land here, and
              // saying otherwise is what let the old rule ship two canonical-facts violations at
              // 96: questions on a passing draft were an offer, so they were declined.
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                Needs review is not a failure and not a verdict. It means one thing: the evaluator
                has a question only you can answer, because research cannot settle what it asked.
                Open one to read the question and answer it. The score does not release a blog from
                this: a <span className="machine">96</span> waits here exactly as an{" "}
                <span className="machine">88</span> does, because a high score says the draft reads
                well, not that the claim it asks about is true.
              </p>
            ) : null}
          </>
        )
      ) : null}

      {/* demoMode reaches the drawer for the Post button alone: a demo blog is templated
          placeholder text, and the CMS has no way to know that once it arrives. */}
      <PreviewDrawer
        brandSlug={brandSlug}
        blog={previewBlog}
        demoMode={demoMode}
        questions={previewBlog ? byTopic.get(previewBlog.topic_slug) : undefined}
        onQuestionsSettled={questionsSettled}
        onClose={url.closePreview}
      />
    </div>
  );
}

/**
 * The blogs waiting on a person, said once at the top of the list.
 *
 * The review tone, never the failure one, and the wording carries the difference the tone cannot:
 * a blog with questions is not broken. The evaluator reached something no amount of research
 * settles and asked the one source that can settle it, which is the operator.
 *
 * ONE COUNT, because there is one obligation. This split the number in two, blocking against
 * optional, and told the operator the optional ones "cannot cost you the score you have". They
 * declined them, and two canonical-facts violations shipped at 96. A held blog is a held blog at
 * every score, so the banner names one queue and no invitation.
 */
function WaitingOnYou({ signals }: { signals: ReadonlyMap<string, WaitingSignal> }) {
  const { total } = countWaiting(signals);
  if (total === 0) {
    return null;
  }
  return (
    <Card className="mb-4 border-review/25 bg-review-bg">
      <CardContent className="flex gap-2 py-3">
        <MessageCircleQuestion className="mt-0.5 size-3.5 shrink-0 text-review" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs font-medium text-review">
            <span className="machine">{total}</span> {total === 1 ? "blog is" : "blogs are"} held
            until you answer the evaluator
          </p>
          <p className="mt-1 text-xs leading-relaxed text-review/90">
            The evaluator asks only where a human answer changes the outcome: a fact the client
            holds, a citation to confirm, a suspected inaccuracy. Research cannot close those and a
            passing score does not close them either, so the blog waits whatever it scored. Open it
            to read the questions and answer them.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** A shared link whose blog is no longer on disk. The link is not broken and the operator is
 *  not wrong: the file went away, which is exactly what the disk being the truth means. */
function MissingBlog({ slug, onClear }: { slug: string | null; onClear: () => void }) {
  return (
    <Card className="mb-4 border-review/25 bg-review-bg">
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
        <SearchX className="size-4 shrink-0 text-review" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-review">This link names a blog that is gone</p>
          <p className="machine mt-0.5 text-xs wrap-anywhere text-review/90">{slug}</p>
        </div>
        <Button variant="outline" size="sm" onClick={onClear}>
          Clear
        </Button>
      </CardContent>
    </Card>
  );
}

function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm text-muted-foreground">No blogs match this search.</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

function NoBlogs({ brandName, createHref }: { brandName: string; createHref: string }) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <FileText className="mx-auto size-5 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium text-foreground">No blogs for {brandName} yet</p>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
          This list reads the disk, so a blog appears here the moment the engine writes it.
          Pick topics from the roadmap to start.
        </p>
        <Button size="sm" className="mt-4" asChild>
          <Link href={createHref}>Create blogs</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** The engine's own reason, never a generic message: it is the only thing worth reading. */
function EngineError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Card className="border-fail/25 bg-fail-bg">
      <CardContent className="py-8 text-center">
        <TriangleAlert className="mx-auto size-5 text-fail" aria-hidden />
        <p className="mt-3 text-sm font-medium text-fail">
          {error.isOffline ? "Cannot reach the engine" : "The engine refused the request"}
        </p>
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-fail/80">
          {error.isOffline
            ? "Nothing answered on the API host. The blogs are still on disk; this list cannot ask for them."
            : `The request reached the engine and came back ${error.status}.`}
        </p>
        {/* The engine's own words, carried through untouched. */}
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
