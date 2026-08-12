"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Download,
  FileText,
  Globe,
  MessageCircleQuestion,
  RotateCw,
  Search,
  SendHorizontal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { inMonth } from "@/lib/blog-month";
import { adminCan, blogState } from "@/lib/blog-state";
import { BLOG_TABS, BLOG_TAB_LABELS, blogTab, type BlogTab } from "@/lib/blog-tabs";
import { adminGateAllows, type GateForm, type GateInput } from "@/lib/gate-contract";
import { formatCount } from "@/lib/format";
import {
  loadObservedReview,
  observeReview,
  reviewEdges,
  saveObservedReview,
  type ReviewSighting,
} from "@/lib/notifications";
import { useNotifications } from "@/lib/notifications-context";
import { useRuns } from "@/lib/runs-context";
import { useBlogQuestions } from "@/lib/use-blog-questions";
import { useMonthFilter } from "@/lib/use-month-filter";
import { useHotkey } from "@/lib/use-hotkey";
import { cn } from "@/lib/utils";
import { selectBlogs } from "@/components/blogs/blogs-filter";
import { BlogsTable, TRIGGER_ATTR } from "@/components/blogs/blogs-table";
import { BulkBar, type BulkAction } from "@/components/blogs/bulk-bar";
import { CreateForBrand } from "@/components/create/create-for-brand";
import { MonthPicker } from "@/components/blogs/month-picker";
import { QueueTable } from "@/components/blogs/queue-table";
import { useLibraryUrl } from "@/components/blogs/library-url";
import {
  countWaiting,
  waitingSignal,
  type WaitingSignal,
} from "@/components/blogs/questions-state";
import type { BlogSummary } from "@/types";

// THE STATUS DROPDOWN IS GONE and the FILTERS list with it. The four subtabs partition every
// blog by exactly the fact that dropdown selected, so keeping both would be two controls that can
// disagree: choosing "Approved" while standing in Internal review shows an empty table with
// nothing on screen explaining why. selectBlogs still takes a status argument for the callers
// that have one; this page pins it to "all".

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
  /**
   * Three facts off the CLIENT RECORD the route already resolved, threaded through for the New
   * tab alone: they are what the create flow needs and what it used to receive from its own page.
   * They ride as props rather than being fetched here for the same reason they always did, which
   * is that /api/clients carries all three on every brand and a second read could disagree.
   */
  brandInstructions: string;
  hasCanonicalFacts: boolean;
  resourceCount: number;
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
  brandInstructions,
  hasCanonicalFacts,
  resourceCount,
}: {
  orgSlug: string;
  brandSlug: string;
  brandName: string;
  brandInstructions: string;
  hasCanonicalFacts: boolean;
  resourceCount: number;
}) {
  const router = useRouter();
  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [picked, setPicked] = React.useState<string | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const url = useLibraryUrl();

  /** A blog's own page, the admin-review stage. The row links here and the whole-row
   *  click navigates here; one builder so the two can never disagree. */
  const blogHref = React.useCallback(
    (topicSlug: string) =>
      `${brandHref(orgSlug, brandSlug, "/blogs")}/${encodeURIComponent(topicSlug)}`,
    [orgSlug, brandSlug],
  );

  // The drawer this library used to open lived at ?blog=<slug>, and those links were sent
  // around: to clients, in Slack, in notification clicks. Every one of them now lands on
  // the blog's own page. replace, not push, so Back does not bounce through the redirect.
  const legacyPreview = url.previewSlug;
  React.useEffect(() => {
    if (legacyPreview !== null) {
      router.replace(blogHref(legacyPreview));
    }
  }, [legacyPreview, blogHref, router]);

  // Shared with the LinkedIn and Medium tabs, because all three group by the month of the
  // roadmap that planned the work and every rule about which month is on screen has to match.
  const { months, month, setMonth, latestMonth, showPicker, label: monthLabel } =
    useMonthFilter(brandSlug);

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
  const {
    byTopic,
    checking: questionsChecking,
    reload: reloadQuestions,
  } = useBlogQuestions(brandSlug, topicSlugs);

  /**
   * The month the picker is showing, before the search box and the status filter touch it. The
   * two notices on this page are counted against THIS and not against `blogs`: a banner naming
   * three held blogs on a month whose list holds none of them is a banner about somebody else's
   * month, and the operator cannot act on one row of it. Not `shown` either, because typing in
   * the search box must not silence a blog that is still held.
   */
  const monthBlogs = React.useMemo(
    () => (blogs ?? []).filter((blog) => inMonth(blog, month, latestMonth)),
    [blogs, month, latestMonth],
  );

  const waiting = React.useMemo(() => {
    const inScope = new Set(monthBlogs.map((blog) => blog.topic_slug));
    const signals = new Map<string, WaitingSignal>();
    for (const [slug, entry] of byTopic) {
      const signal = waitingSignal(entry.payload);
      // Every row the table renders is in this month, so scoping here can never strip a signal
      // off a visible row. It only stops another month's holds being counted in the banner.
      if (signal !== null && inScope.has(slug)) {
        signals.set(slug, signal);
      }
    }
    return signals;
  }, [byTopic, monthBlogs]);

  /**
   * The bell hears about the portal HERE, at the reads that discover it, because the portal
   * has no channel into this app: a client answers a form, suggests changes, or approves a
   * sent article on their side, and the first this dashboard can know is its own next read.
   * Answered forms come off the questions read; the review loop's two edges, changes
   * requested and approved, come off the summaries' own fields.
   *
   * WHAT IS ANNOUNCED IS THE CHANGE BETWEEN TWO READS, never what a read found, and
   * lib/notifications carries the rule plus the two bugs that shape it. Nothing is persisted,
   * so announcing on what a read FOUND rang every approval the brand had ever collected on
   * every fresh tab, and keying a round of suggestions on the send stamp meant a second round
   * inside one send rang nothing at all.
   *
   * BOTH SOURCES HAVE TO BE IN before a comparison means anything. The questions read settles
   * after the summaries do, so a sighting taken while it is still in flight records "no form
   * answered" for every topic, and the real answer landing a moment later then reads as the
   * client having just answered twelve of them.
   */
  const { runs } = useRuns();
  const { log, notify } = useNotifications();
  const observedRef = React.useRef<{ brand: string; seen: ReadonlyMap<string, ReviewSighting> }>({
    brand: brandSlug,
    seen: new Map(),
  });
  React.useEffect(() => {
    if (blogs === null || questionsChecking) {
      return;
    }
    const sightings: ReviewSighting[] = blogs.map((blog) => {
      const questions = byTopic.get(blog.topic_slug)?.payload ?? null;
      const answered =
        questions !== null && questions.answered && questions.answered_by === "client";
      return {
        topicSlug: blog.topic_slug,
        answeredIter: answered ? questions.iter : null,
        answeredCount: answered ? questions.questions.length : 0,
        changes: blog.changes_requested ?? 0,
        approved: blog.client_approved ?? null,
      };
    });

    // A brand switch without a remount would otherwise diff this brand's topics against
    // another brand's, and a slug that exists under both would announce one brand's approval
    // under the other's name. A brand this tab has not read yet falls back to the STORED
    // baseline rather than to nothing: with the client's half of the loop no longer polled,
    // the first read after a page load is the read that has to report what the client did,
    // and diffing against nothing reports nothing. See loadObservedReview.
    const before =
      observedRef.current.brand === brandSlug
        ? observedRef.current.seen
        : loadObservedReview(brandSlug);
    const seen = observeReview(sightings);
    observedRef.current = { brand: brandSlug, seen };
    saveObservedReview(brandSlug, seen);

    for (const edge of reviewEdges(before, sightings, new Date().toISOString())) {
      const key = `${brandSlug}/${edge.topicSlug}/${edge.stamp}`;
      // The edge is the dedup, and this is the guard behind it: notify() drops a repeat id
      // from the LIST but still toasts it, so an event the log already carries would flash a
      // line with no row behind it.
      if (log.some((note) => note.id === `${edge.kind}:${key}`)) {
        continue;
      }
      notify({ kind: edge.kind, brandSlug, key, topicCount: edge.topicCount });
    }
  }, [byTopic, blogs, questionsChecking, brandSlug, log, notify]);

  async function refresh() {
    setRefreshing(true);
    reloadQuestions();
    await load();
    setRefreshing(false);
  }

  /**
   * EVERY BLOG THE MONTH HOLDS, SPLIT BY TAB. See lib/blog-tabs.ts for the rules; this only
   * counts them, so each tab can carry its own number without four passes over the list.
   *
   * A blog that files under `new` is NOT here as a row: New renders ROADMAP rows, and a topic with
   * no scored draft is represented there by its sheet row rather than by the empty record the
   * engine may or may not hold for it. The count is still taken, because it is what tells an
   * operator whether the tab is worth opening.
   */
  const byTab = React.useMemo(() => {
    const out: Record<BlogTab, BlogSummary[]> =
      { new: [], internal: [], client: [], published: [] };
    for (const blog of monthBlogs) {
      out[blogTab(blog)].push(blog);
    }
    return out;
  }, [monthBlogs]);

  /**
   * The rows on screen: the OPEN TAB's blogs, then the search box and the sort.
   *
   * selectBlogs still owns the search and the sort, and its status argument is pinned to "all"
   * because the tabs ARE the status filter now. Keeping both would be two controls that can
   * disagree: picking "Approved" while standing in Internal review shows nothing, with nothing on
   * screen saying why.
   */
  const shown = React.useMemo(
    () =>
      selectBlogs(byTab[url.tab], url.query, "all", url.sortKey, url.sortDir, month, latestMonth),
    [byTab, url.tab, url.query, url.sortKey, url.sortDir, month, latestMonth],
  );

  /**
   * THE TICKED ROWS, and everything the bulk bar acts on.
   *
   * Kept as slugs rather than as blogs, because a poll replaces every BlogSummary object while a
   * selection has to survive it: identity here is the slug, exactly as it is for the keyboard's
   * `picked` above and for `activeSlug`.
   *
   * `selected` is `ticked` NARROWED TO THE VISIBLE ROWS, derived and never stored. A bar reading
   * "3 selected" over a table showing none of them is a Delete aimed at rows the operator cannot
   * see, so the filters have to bound the selection. Doing it as a DERIVATION rather than as an
   * effect that prunes `ticked` matters twice over: an effect renders once with the stale set
   * before correcting itself, and pruning is destructive, so glancing at another month and coming
   * back would silently discard the ticks. Here the ticks survive out of sight and simply do not
   * count while they are.
   */
  const [ticked, setTicked] = React.useState<ReadonlySet<string>>(new Set());
  const selected = React.useMemo(
    () => new Set(shown.map((blog) => blog.topic_slug).filter((slug) => ticked.has(slug))),
    [shown, ticked],
  );

  const toggle = React.useCallback((topicSlug: string) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(topicSlug)) {
        next.add(topicSlug);
      }
      return next;
    });
  }, []);
  // Select-all reaches ONLY the rows it was rendered over, in both directions, so it can neither
  // tick nor clear a row behind a filter. Anything else would make one checkbox mean two things.
  const toggleAll = React.useCallback((topicSlugs: readonly string[]) => {
    setTicked((prev) => {
      const on = topicSlugs.every((slug) => prev.has(slug));
      const next = new Set(prev);
      for (const slug of topicSlugs) {
        if (on) next.delete(slug);
        else next.add(slug);
      }
      return next;
    });
  }, []);
  // Shift-click: the table computed the span from its own on-screen order, so this only has to
  // add it. Additive rather than toggling, which is what a drag across a list means everywhere.
  const selectRange = React.useCallback((topicSlugs: readonly string[]) => {
    setTicked((prev) => new Set([...prev, ...topicSlugs]));
  }, []);
  const clearSelection = React.useCallback(() => setTicked(new Set()), []);

  /**
   * WHAT THE FOUR BULK ACTS WILL ACTUALLY TOUCH, decided here because only this page holds the
   * facts each gate reads.
   *
   * Send and Post to CMS run through `adminCan` AND `adminGateAllows`, the same pair blog-stage
   * gates its own two buttons on, so a row the bar offers to send is a row the stage page would
   * also send. Restating either rule here is how the two screens start disagreeing about one
   * record, which is the defect gate-contract.ts exists to prevent.
   *
   * The question form is real rather than assumed: `byTopic` is already read for the waiting
   * chips, so each blog's gate input carries its own form, and a topic whose read has not landed
   * degrades to "unread" and FAILS CLOSED, dropping out of the eligible set rather than being
   * offered on a guess.
   *
   * `applying` is deliberately OMITTED, not passed as "unread". See GateInput: omitting it asks a
   * question about the RECORD, which is what a bulk bar is asking, and the two transient clauses
   * over mid-flight applies describe a moment this list is not looking at. Passing "unread" would
   * fail closed on every row and offer nothing at all.
   */
  const gateOf = React.useCallback(
    (blog: BlogSummary): GateInput => {
      const entry = byTopic.get(blog.topic_slug);
      const form: GateForm =
        entry === undefined || entry.error !== null
          ? "unread"
          : entry.payload === null
            ? "absent"
            : { stale: entry.payload.stale, answered: entry.payload.answered };
      return { record: blog, form };
    },
    [byTopic],
  );

  const selectedBlogs = React.useMemo(
    () => shown.filter((blog) => selected.has(blog.topic_slug)),
    [shown, selected],
  );

  const eligible = React.useMemo(() => {
    const pick = (test: (blog: BlogSummary) => boolean) =>
      selectedBlogs.filter(test).map((blog) => blog.topic_slug);
    return {
      // A blog still generating has no committed draft for the engine to put in the document. It
      // is the ONE state where that is knowable from the wire; past it, the engine's own query is
      // the authority and a row with no body simply is not in the .docx.
      download: pick((blog) => blogState(blog) !== "generating"),
      send: pick(
        (blog) => adminCan(blogState(blog), "send") && adminGateAllows("send", gateOf(blog)),
      ),
      publish: pick(
        (blog) => adminCan(blogState(blog), "publish") && adminGateAllows("publish", gateOf(blog)),
      ),
      // Everything. The engine refuses a delete while a run for this brand is live, and that is a
      // 409 with a sentence on it rather than a fact this list holds.
      delete: selectedBlogs.map((blog) => blog.topic_slug),
    };
  }, [selectedBlogs, gateOf]);

  const bulkActions = React.useMemo<BulkAction[]>(
    () => [
      {
        key: "download",
        label: "Download",
        icon: Download,
        eligible: eligible.download,
        skipped: "still being written",
        done: "Downloaded",
        // ONE request, not one per blog: the engine bundles them into a single .docx and fanning
        // this out would hand the operator eight separate documents.
        runAll: async (slugs) => {
          const blob = await api.blogsDownloadAll(brandSlug, slugs);
          const href = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = href;
          link.download = `${brandSlug}-blogs.docx`;
          link.click();
          URL.revokeObjectURL(href);
        },
      },
      {
        key: "send",
        label: "Send to client",
        icon: SendHorizontal,
        eligible: eligible.send,
        skipped: "already with the client, or holding an open question",
        done: "Sent",
        confirm: {
          title: `Send ${eligible.send.length} to ${brandName}?`,
          body: "Each one becomes visible in the client portal for review, exactly as it reads now. Blogs the client already has, and blogs holding an open question, are not included.",
          action: "Send them",
        },
        runOne: (slug) => api.sendBlogToClient(brandSlug, slug),
      },
      {
        key: "publish",
        label: "Post to CMS",
        icon: Globe,
        eligible: eligible.publish,
        skipped: "not in a state the CMS door accepts",
        done: "Posted to the CMS",
        confirm: {
          title: `Post ${eligible.publish.length} to the CMS?`,
          body: "Each one is pushed to the brand's site with its own excerpt, SEO title, description, category and tags. A blog already posted is updated in place.",
          action: "Post them",
        },
        runOne: (slug) => api.publishBlog(brandSlug, slug),
      },
      {
        key: "delete",
        label: "Delete",
        icon: Trash2,
        eligible: eligible.delete,
        destructive: true,
        done: "Deleted",
        confirm: {
          title: `Delete ${eligible.delete.length} ${eligible.delete.length === 1 ? "blog" : "blogs"}?`,
          body: "The draft, its evaluation, its comments and its scratch files all go, and the roadmap row frees up so the topic can be written again. This cannot be undone.",
          action: "Delete them",
        },
        runOne: (slug) => api.deleteBlog(brandSlug, slug),
      },
    ],
    [eligible, brandSlug, brandName],
  );

  // The keyboard's row. A filter can hide whatever was picked, and a row that is not rendered
  // must not hold the table's only tab stop, so it falls back to the first visible row.
  const activeSlug =
    shown.find((blog) => blog.topic_slug === picked)?.topic_slug ??
    shown[0]?.topic_slug ??
    null;

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

  // j is a letter someone may be typing into the search field; useHotkey guards text fields.
  useHotkey("j", () => move(1));
  useHotkey("k", () => move(-1));
  // Arrows only steer the list once the operator is IN it. Before that they scroll the page,
  // which is what an arrow key means everywhere else, and hijacking that would be rude.
  const engaged = { enabled: picked !== null };
  useHotkey("arrowdown", () => move(1), engaged);
  useHotkey("arrowup", () => move(-1), engaged);
  useHotkey("/", () => searchRef.current?.focus());

  // The month on screen is the whole list as far as this page's counts and empty state are
  // concerned.
  const total = monthBlogs.length;
  const filtering = url.query.trim() !== "" || url.status !== "all";

  /**
   * IS ANY BLOG RUN LIVE, ANYWHERE. Not just this brand's: TOPIC_SEMAPHORE admits GEO_CONCURRENCY
   * blogs REPO-WIDE, so another brand's run is a real reason this one waits. Repurpose runs are
   * excluded because they take the same slot but are not blogs, and a Generate relabelled by a
   * LinkedIn rewrite would be describing the wrong queue.
   */
  const anyRunLive = runs.some((run) => run.kind !== "repurpose" && run.live);

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/* CONTROLLED FROM THE URL, so /create's redirect can land on ?tab=new and a link to a tab
          is a link to a tab. See library-url.ts: every other view control on this page already
          lives there, and a tab kept in state would be the one thing a shared URL forgot. */}
      <Tabs value={url.tab} onValueChange={(next) => url.setTab(next as BlogTab)}>
      {/* THE CONTROLS SIT BELOW THE HEADING, NOT BESIDE IT. They were in a justify-between with
          the title, so a wide screen strung search, month, status, refresh and download along the
          right of one line and a narrow one wrapped them into a ragged block that moved as the
          window changed. Under the heading they start at the same left edge on every width, which
          is also where the Create and Content Roadmap tabs put theirs. */}
      <div className="mb-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Blogs</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every blog for {brandName}, from the roadmap row to the published article.
          </p>
        </div>

        {/* THE TAB STRIP AND THE MONTH, ON ONE ROW, the month right-aligned. The month is the only
            control here that applies to all four tabs at once, so it belongs beside the tabs
            rather than in the row below, which changes with the selection. */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <TabsList variant="line" className="mb-[5px]">
            {BLOG_TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} className="text-xs">
                {BLOG_TAB_LABELS[tab]}
              </TabsTrigger>
            ))}
          </TabsList>
          {/* Only with TWO OR MORE months. One month is every blog there is, so a picker that
              cannot change anything is a control that only asks the operator a question. */}
          {showPicker && months ? (
            <MonthPicker months={months} month={month} onChange={setMonth} />
          ) : null}
        </div>
        {/* THE SELECTION REPLACES THE CONTROLS, rather than sitting beside them. Ticking a row is
            a mode switch: the operator has stopped narrowing the list and started acting on a set,
            and leaving search, month, status and refresh on screen under four bulk acts makes them
            re-read the whole row to find the two controls that now matter. Clear puts it all back,
            so nothing is lost and the filters are one click away. */}
        {selected.size > 0 ? (
          <div className="mt-3">
            <BulkBar
              count={selected.size}
              noun="blog"
              actions={bulkActions}
              onClear={clearSelection}
              onDone={() => void refresh()}
            />
          </div>
        ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RotateCw
              className={cn(refreshing && "animate-spin motion-reduce:animate-none")}
              data-icon="inline-start"
              aria-hidden
            />
            Refresh
          </Button>
        </div>
        )}
      </div>

      {/* Above the panels, because a held blog is held whichever tab is open and the operator
          should not have to find the right one to learn that. */}
      <WaitingOnYou signals={waiting} />

      {error ? <EngineError error={error} onRetry={() => void refresh()} /> : null}

      {!error && blogs === null ? <Skeleton className="h-80 w-full" /> : null}

      {/* NEW IS THE OLD CREATE PAGE, embedded. It renders roadmap rows rather than blogs, so it
          owns its own fetch, its own selection and its own Generate: everything this file does
          below is about articles that exist. See select-state.tsx's `embedded` prop for what the
          flag actually changes, which is the heading and nothing else. */}
      <TabsContent value="new">
        {!error ? (
          <CreateForBrand
            key={brandSlug}
            orgSlug={orgSlug}
            brandSlug={brandSlug}
            brandName={brandName}
            brandInstructions={brandInstructions}
            hasCanonicalFacts={hasCanonicalFacts}
            resourceCount={resourceCount}
            embedded
            queueing={anyRunLive}
          />
        ) : null}
        {/* UNDER the pick list, because the reading order is "what could I start" then "what is
            already going". It renders nothing at all when the engine is idle, so an operator with
            no runs sees the table they came for and no empty shell below it. */}
        <QueueTable brandSlug={brandSlug} onChanged={() => void refresh()} />
      </TabsContent>

      {!error && blogs !== null ? (
        total === 0 ? (
          <NoBlogs
            brandName={brandName}
            // Only with a picker on screen. With one month there is nothing to name, and "no
            // blogs in Month 1" would suggest a month the operator could switch away from.
            monthLabel={showPicker ? monthLabel : null}
            createHref={brandHref(orgSlug, brandSlug, "/blogs?tab=new")}
          />
        ) : (
          <TabsContent value={url.tab}>
            <Card className="overflow-hidden p-0">
              {shown.length === 0 ? (
                <NoMatches onClear={url.clearFilters} />
              ) : (
                <BlogsTable
                  blogs={shown}
                  waiting={waiting}
                  // The one read of where each blog is, over the same wire fields the stage
                  // page folds, so the two screens can never disagree about a row's state.
                  stateOf={blogState}
                  sortKey={url.sortKey}
                  sortDir={url.sortDir}
                  activeSlug={activeSlug}
                  onSort={url.setSort}
                  hrefFor={(blog) => blogHref(blog.topic_slug)}
                  onOpen={(blog) => {
                    setPicked(blog.topic_slug);
                    router.push(blogHref(blog.topic_slug));
                  }}
                  // No checkboxes on the hosted mirror: every act the bar offers is a write, and
                  // this build refuses all of them, so a selection there could only ever lead to
                  // four buttons that answer 501.
                  // NO CHECKBOXES ON PUBLISHED, by instruction, and it is the right shape: the
                  // article is live on the brand's site, so Send and Post to CMS are spent and a
                  // bulk Delete over things a reader can currently open is not an act to make one
                  // click away. Editing or unpublishing one is still reachable from its own page.
                  //
                  // None on the hosted mirror either: every act the bar offers is a write, and
                  // that build refuses all of them, so a selection could only lead to buttons
                  // that answer 501.
                  selection={
                    HOSTED_READONLY || url.tab === "published"
                      ? undefined
                      : {
                          selected,
                          onToggle: toggle,
                          onToggleAll: toggleAll,
                          onSelectRange: selectRange,
                        }
                  }
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

            {/* Scoped to the month on screen, exactly as the banner above is. This explains rows
                the operator can see, so last month's holds must not summon it onto a month whose
                list has none. */}
            {monthBlogs.some((blog) => blog.status === "needs_review") ? (
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
          </TabsContent>
        )
      ) : null}
      </Tabs>
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

function NoBlogs({
  brandName,
  monthLabel,
  createHref,
}: {
  brandName: string;
  /** The month on screen, when a picker is offering more than one. Null means say nothing. */
  monthLabel: string | null;
  createHref: string;
}) {
  return (
    <Card>
      <CardContent className="py-14 text-center">
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted">
          <FileText className="size-5 text-muted-foreground" aria-hidden />
        </div>
        <p className="mt-3 text-sm font-medium text-foreground">
          No blogs for {brandName}
          {monthLabel ? ` in ${monthLabel}` : ""} yet
        </p>
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
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-fail/10">
          <TriangleAlert className="size-5 text-fail" aria-hidden />
        </div>
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
