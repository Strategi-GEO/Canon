"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Loader2, Play, RotateCw, Send, SendHorizontal, Sparkles, Trash2 } from "lucide-react";
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import { brandHref } from "@/lib/orgs-context";
import { HOSTED_READONLY } from "@/lib/hosted";
import { blogState } from "@/lib/blog-state";
import { blogLabels } from "@/lib/blog-label";
import { adminFailedTag } from "@/lib/blog-score";
import { channelLabel, channelTag, isRepurposable } from "@/lib/channel-state";
import { useRuns } from "@/lib/runs-context";
import { inMonth, monthIndex, postInMonth } from "@/lib/blog-month";
import { useMonthFilter } from "@/lib/use-month-filter";
import { formatCount, formatRelative } from "@/lib/format";
import { sortBlogs, type SortDir } from "@/components/blogs/blogs-filter";
import { SortableHead } from "@/components/blogs/blogs-table";
import { BulkBar, type BulkAction } from "@/components/blogs/bulk-bar";
import { MonthPicker } from "@/components/blogs/month-picker";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import type { BlogSummary, ChannelPost, ChannelPostState, RepurposeChannel } from "@/types";

/** The Created tab's sortable columns: every column it renders. */
type PostSortKey = "num" | "post" | "status" | "updated";

/** Lifecycle order for the status sort, generating first, posted last: sorting by status is
 *  for grouping like with like, and the lifecycle is the order the group labels read in. */
const POST_STATE_ORDER: ChannelPostState[] = [
  "generating",
  "created",
  "changes_requested",
  "sent",
  "approved",
  "posted",
];

/** Hand a built .docx to the browser. Both channel downloads land here, the bulk bar's and
 *  Download all, so the two cannot drift into producing differently named files. */
function saveDocx(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

/**
 * The "#" column carries the source blog's grouped identifier: numbers for engine-written,
 * letters for uploaded. Numbers sort before letters, each kind in its own order, and a post
 * whose blog fell out of the listing (no label) sorts last rather than posing as row one.
 */
function labelRank(label: string | null | undefined): [number, number, string] {
  if (label === null || label === undefined) return [2, 0, ""];
  if (/^\d+$/.test(label)) return [0, Number(label), ""];
  return [1, 0, label];
}

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
  const router = useRouter();

  const [blogs, setBlogs] = React.useState<BlogSummary[] | null>(null);
  /**
   * NULL UNTIL THE LISTING LANDS, and the null is the whole point.
   *
   * This started as `[]`, which made "no posts exist" and "the posts have not arrived" the same
   * value, and the two tabs are derived from exactly that difference: New is the blogs with NO
   * post, so an empty map put EVERY blog in New. The render gate only waited on `blogs`, so both
   * fetches raced and the common outcome was the whole library rendering under New and then
   * jumping to Created a moment later, which reads as the engine losing the work and finding it
   * again. A separate `loading` flag would answer the same question one variable further from
   * the data it describes.
   */
  const [posts, setPosts] = React.useState<ChannelPost[] | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [startError, setStartError] = React.useState<string | null>(null);
  // Bridges the gap between a Generate POST landing and the runs poll first reporting the run
  // live, so a just-fired row shows Generating rather than sitting selectable and inviting a
  // second click.
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set());

  const { runs } = useRuns();

  // THE SAME HOOK THE BLOGS TAB USES, not a second implementation of the same idea. A LinkedIn
  // post and a Medium article are repurposes of a blog, so they belong to the month that planned
  // that blog, and an operator crossing from Blogs to here must find the same work under the same
  // month. Which months exist, which is the default and what happens when one is deleted are all
  // decided in lib/use-month-filter.ts, once.
  const { months, month, setMonth, latestMonth, showPicker } = useMonthFilter(brandSlug);

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
          //
          // IT MUST STILL SETTLE, because the render now waits on this state and a null that
          // never resolves is a skeleton forever. Empty is the honest fallback: with no listing
          // the app cannot know which blogs have posts, and showing them all as New is what it
          // did before this state could be null at all.
          setPosts((current) => current ?? []);
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

  // Settled posts, for everything that only cares WHAT they are rather than whether they have
  // arrived. The gate below is the one reader of the null.
  const loadedPosts = React.useMemo(() => posts ?? [], [posts]);

  const postBySlug = React.useMemo(() => {
    const m = new Map<string, ChannelPost>();
    for (const post of loadedPosts) m.set(post.source_topic_slug, post);
    return m;
  }, [loadedPosts]);

  // Sheet order, like every other blog table: the pick list and the library name the same
  // articles by the same number, so they must not disagree about the order. See DEFAULTS in
  // library-url.ts.
  const rows = React.useMemo(
    () => sortBlogs((blogs ?? []).filter((b) => inMonth(b, month, latestMonth)), "roadmap", "asc"),
    [blogs, month, latestMonth],
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

  // The Created tab's sort, local state rather than the URL: it is a sub-tab of a sub-tab, and
  // a link that deep is not a thing anyone shares. Same toggle semantics as the blogs library:
  // re-picking the active column flips, a new column starts descending.
  //
  // Opens on the source # ascending, like every other blog table. This tab's rows ARE blogs seen
  // through their posts, and an operator crossing from the library to here is looking for the
  // same article by the same number, so the two lists must not be in different orders.
  // Which tab is open, held here only so the shared control row can hide Generate on Created.
  const [tab, setTab] = React.useState("new");

  const [postSort, setPostSort] = React.useState<{ key: PostSortKey; dir: SortDir }>({
    key: "num",
    dir: "asc",
  });
  const onPostSort = React.useCallback((key: PostSortKey) => {
    setPostSort((prev) => ({
      key,
      dir: key === prev.key && prev.dir === "desc" ? "asc" : "desc",
    }));
  }, []);
  // A post has no roadmap row of its own, so its month is resolved through the blog it was
  // repurposed FROM. The index is built over every blog rather than over `rows`, because `rows`
  // is already month-filtered and a post must be able to find its source in any month.
  const monthOfBlog = React.useMemo(
    () => monthIndex(blogs ?? [], latestMonth),
    [blogs, latestMonth],
  );
  const monthPosts = React.useMemo(
    () => loadedPosts.filter((p) => postInMonth(p.source_topic_slug, monthOfBlog, month, latestMonth)),
    [loadedPosts, monthOfBlog, month, latestMonth],
  );

  const sortedPosts = React.useMemo(() => {
    const ranked = [...monthPosts].sort((a, b) => {
      if (postSort.key === "num") {
        const [ka, na, sa] = labelRank(labels.get(a.source_topic_slug));
        const [kb, nb, sb] = labelRank(labels.get(b.source_topic_slug));
        return ka - kb || na - nb || sa.localeCompare(sb);
      }
      if (postSort.key === "post") {
        return a.source_topic.localeCompare(b.source_topic, undefined, { sensitivity: "base" });
      }
      if (postSort.key === "status") {
        return POST_STATE_ORDER.indexOf(a.state) - POST_STATE_ORDER.indexOf(b.state);
      }
      return a.updated_at.localeCompare(b.updated_at);
    });
    return postSort.dir === "desc" ? ranked.reverse() : ranked;
  }, [monthPosts, postSort, labels]);
  const selectableCount = selectableSlugs.length;
  const allSelected = selectableCount > 0 && selectableSlugs.every((s) => selected.has(s));
  const someSelected = !allSelected && selectableSlugs.some((s) => selected.has(s));
  function toggleAll() {
    setSelected((prev) =>
      selectableSlugs.every((s) => prev.has(s)) ? new Set() : new Set(selectableSlugs),
    );
  }

  /**
   * THE CREATED TAB'S OWN SELECTION, and it is a SECOND one on purpose.
   *
   * `selected` above means "generate a post from these blogs"; this means "act on these posts".
   * The two tabs hold different things (blogs with no post, and posts) and offer different acts,
   * so one shared set would put a blog and a post in the same collection and make Generate and
   * Delete argue about what a tick meant. They are cleared independently for the same reason.
   */
  const [postsTicked, setPostsTicked] = React.useState<ReadonlySet<string>>(new Set());
  const visiblePostSlugs = React.useMemo(
    () => sortedPosts.map((p) => p.source_topic_slug),
    [sortedPosts],
  );
  // Narrowed to the visible rows by DERIVATION, never by pruning the stored set. Same reasoning as
  // blogs-library's `selected`: the month filter has to bound what a bulk act reaches, and an
  // effect that pruned instead would discard ticks the moment the operator glanced at another
  // month, on top of rendering the stale set once first.
  const postsPicked = React.useMemo(
    () => new Set(visiblePostSlugs.filter((slug) => postsTicked.has(slug))),
    [visiblePostSlugs, postsTicked],
  );

  function togglePost(slug: string) {
    setPostsTicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(slug)) next.add(slug);
      return next;
    });
  }
  function toggleAllPosts() {
    setPostsTicked((prev) => {
      const on = visiblePostSlugs.every((s) => prev.has(s));
      const next = new Set(prev);
      for (const slug of visiblePostSlugs) {
        if (on) next.delete(slug);
        else next.add(slug);
      }
      return next;
    });
  }
  const allPostsPicked =
    visiblePostSlugs.length > 0 && visiblePostSlugs.every((s) => postsPicked.has(s));
  const somePostsPicked =
    !allPostsPicked && visiblePostSlugs.some((s) => postsPicked.has(s));

  /**
   * THREE ACTS, NOT FOUR, and the missing one is Post to CMS.
   *
   * The CMS is the brand's own website, and a LinkedIn post goes to LinkedIn: pushing the same
   * article to the site twice is duplicate content, which is the thing the CMS gate exists to stop.
   * Posting to the channel itself is not bulkable either, because neither LinkedIn nor Medium
   * accepts a pre-filled body by URL, so PostToChannel copies the text and opens ONE composer.
   * Eight of those is eight tabs and one clipboard. It stays on the review page, one post at a
   * time, which is the only shape the platforms allow.
   */
  const pickedPosts = React.useMemo(
    () => sortedPosts.filter((p) => postsPicked.has(p.source_topic_slug)),
    [sortedPosts, postsPicked],
  );
  const postActions = React.useMemo<BulkAction[]>(() => {
    const slugs = pickedPosts.map((p) => p.source_topic_slug);
    // The same two states channel-review's own Send button mounts on. A sent post is already with
    // the client, an approved one is waiting to be marked posted, and a posted one is done.
    const sendable = pickedPosts
      .filter((p) => p.state === "created" || p.state === "changes_requested")
      .map((p) => p.source_topic_slug);
    return [
      {
        key: "download",
        label: "Download",
        icon: Download,
        eligible: slugs,
        done: "Downloaded",
        runAll: async (picked) => {
          saveDocx(
            await api.channelDownload(brandSlug, channel, picked),
            `${brandSlug}-${channel}.docx`,
          );
        },
      },
      {
        key: "send",
        label: "Send to client",
        icon: SendHorizontal,
        eligible: sendable,
        skipped: "already with the client, approved, or posted",
        done: "Sent",
        confirm: {
          title: `Send ${sendable.length} to ${brandName}?`,
          body: `Each ${label} becomes visible in the client portal as ready to post, exactly as it reads now. Posts the client already has are not included.`,
          action: "Send them",
        },
        runOne: (slug) => api.sendChannelPost(brandSlug, channel, slug),
      },
      {
        key: "delete",
        label: "Delete",
        icon: Trash2,
        eligible: slugs,
        destructive: true,
        done: "Deleted",
        confirm: {
          title: `Delete ${slugs.length} ${slugs.length === 1 ? label : `${label}s`}?`,
          body: `The post and any comments on it go. THE BLOG IS UNTOUCHED: each one returns to the New tab, tickable again, keeping its draft and its own delivery state. This cannot be undone.`,
          action: "Delete them",
        },
        runOne: (slug) => api.deleteChannelPost(brandSlug, channel, slug),
      },
    ];
  }, [pickedPosts, brandSlug, brandName, channel, label]);

  /**
   * DOWNLOAD ALL: every post the Created tab is showing, in one .docx, with nothing ticked.
   *
   * "ALL" MEANS THE RENDERED MONTH AND NOT THE BRAND, and the month picker sitting two buttons to
   * the left is the whole reason. The Created count badge already reads that way and says why: a
   * total over every month promises rows the operator then cannot find. Where a brand has one
   * month there is no picker and the two readings are the same set, which is most brands today.
   * The tooltip states the count before the press either way, so the scope is never inferred.
   *
   * It sends the visible slugs in the order the table renders them, and server/channel.py bodies()
   * returns bodies in the order it was asked for, so the cover pages run down the document in the
   * order the operator was just looking at.
   *
   * The empty case is guarded HERE as well as by the disabled button, because an empty list is the
   * one input this route reads as a different question: topicsQuery drops it, the engine sees no
   * `topics` at all, and it answers "name the posts to download" rather than sending nothing.
   */
  const [downloadingAll, setDownloadingAll] = React.useState(false);
  async function downloadAll() {
    if (downloadingAll || visiblePostSlugs.length === 0) return;
    setDownloadingAll(true);
    try {
      saveDocx(
        await api.channelDownload(brandSlug, channel, visiblePostSlugs),
        `${brandSlug}-${channel}.docx`,
      );
      toast.success(`Downloaded ${formatCount(visiblePostSlugs.length)}`);
    } catch (cause) {
      toast.error(`Could not download ${label}s`, {
        description: cause instanceof ApiError ? cause.message : String(cause),
      });
    } finally {
      setDownloadingAll(false);
    }
  }

  // ONLY THE CREATED TAB SWAPS ITS CONTROL ROW. The New tab's selection already has its answer in
  // that row and it is Generate, so replacing month and refresh there would trade two useful
  // controls for a button that is already present.
  const picking = tab === "created" && postsPicked.size > 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-4 min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{blurb}</p>
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
        ) : blogs === null || posts === null ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          /* CONTROLLED, and the reason is Generate. All three controls sit on the tabs row, but
             Generate acts on the New tab's selection alone and would be a dead button over the
             Created tab, so the row has to know which tab is open. Nothing else here reads it.
             A plain comment rather than a braced JSX one: this is a ternary's expression slot,
             not JSX children, and a braced comment there parses as an object literal. */
          <Tabs value={tab} onValueChange={setTab} className="gap-4">
            {/* NOTHING IS RIGHT-ALIGNED, matching Blogs, Create and Content Roadmap: every
                control on every tab starts at the same left edge under the heading, so the eye
                lands in one place whichever tab is open. The three used to be spread across three
                horizontal levels, then briefly right-aligned across from the tabs; both put the
                thing an operator wants somewhere they had to hunt for it. */}
            {/* EVERY GAP IN THIS HEADER IS 16px: heading block, tab strip, control row, table.
                They were 16, then 12, then 24, which is why the block read as drifting rather than
                as a stack. The pb-[5px] is the underline: the line variant hangs its bar 5px BELOW
                the trigger box, so without that padding the bar sits inside the gap and eats a
                third of it, leaving the one boundary an operator looks at hardest as the tightest
                on the page. */}
            <div className="flex flex-col items-start gap-4">
              {/* THE LINE VARIANT, matching blog-stage.tsx and instructions-viewer.tsx, which are
                  the app's only other tab surfaces. This was the one place still wearing the
                  filled pill, so the same control looked like two different controls depending on
                  which page an operator was standing on. Underlined tabs also stop competing with
                  the buttons beside them for the eye: a filled segmented block reads as heavier
                  than the Generate button it sits above, which inverts the actual hierarchy. */}
              <TabsList variant="line" className="mb-[5px]">
                <TabsTrigger value="new" className="text-xs">
                  New
                </TabsTrigger>
                <TabsTrigger value="created" className="text-xs">
                  Created
                  {/* A COUNT BADGE RATHER THAN PARENTHESES. "Created (10)" makes the number part
                      of the label, so it reads at the same weight as the word and the tab grows a
                      visible parenthesis nobody is meant to read. The count is THIS MONTH'S,
                      matching the rows the tab renders: a total over every month would promise
                      rows the operator then cannot find. */}
                  {monthPosts.length ? (
                    <span className="machine rounded-full bg-muted px-1.5 py-px text-[10px] leading-4 text-muted-foreground">
                      {monthPosts.length}
                    </span>
                  ) : null}
                </TabsTrigger>
              </TabsList>

              {/* The selection replaces the controls, exactly as it does on the Blogs tab: ticking
                  a post is a mode switch from narrowing the list to acting on a set. */}
              {picking ? (
                <BulkBar
                  count={postsPicked.size}
                  noun={label}
                  actions={postActions}
                  onClear={() => setPostsTicked(new Set())}
                  onDone={() => void refresh()}
                />
              ) : (
              <div className="flex flex-wrap items-center gap-2">
                {/* Only with TWO OR MORE months, exactly as on the Blogs tab: one month is
                    everything there is, so a picker that cannot change anything only asks a
                    question. */}
                {showPicker && months ? (
                  <MonthPicker months={months} month={month} onChange={setMonth} />
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                >
                  <RotateCw
                    className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined}
                    data-icon="inline-start"
                    aria-hidden
                  />
                  Refresh
                </Button>
                {/* CREATED TAB ONLY, for the mirror of Generate's reason below: the New tab holds
                    blogs that have no post yet, so there is nothing there to put in a document.
                    It is the no-selection door to the same bundle the bulk bar's Download builds,
                    which is the common case: an operator wanting the month rarely wants to tick
                    twelve rows first. */}
                {/* HOSTED_READONLY hides it for the reason lib/hosted.ts gives: PYTHON builds the
                    document, and the hosted build has no engine behind it, so the button would be
                    a press that can only fail. */}
                {!HOSTED_READONLY && tab === "created" ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* The span is what makes the tooltip reachable when the button is disabled:
                          a disabled button fires no pointer events, so the trigger has to sit on
                          something that does, or the one state most needing an explanation is the
                          one that cannot give it. */}
                      <span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void downloadAll()}
                          disabled={downloadingAll || visiblePostSlugs.length === 0}
                        >
                          {downloadingAll ? (
                            <Loader2
                              className="animate-spin motion-reduce:animate-none"
                              data-icon="inline-start"
                              aria-hidden
                            />
                          ) : (
                            <Download data-icon="inline-start" aria-hidden />
                          )}
                          Download all
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {visiblePostSlugs.length === 0
                        ? `No ${label}s to download`
                        : `${formatCount(visiblePostSlugs.length)} ${
                            visiblePostSlugs.length === 1 ? label : `${label}s`
                          } as one .docx`}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {/* New tab only. On Created there is nothing selected and nothing to generate, so
                    the button would be permanently disabled, which reads as broken rather than as
                    inapplicable. */}
                {!HOSTED_READONLY && tab === "new" ? (
                  <Button size="sm" onClick={() => void generate()} disabled={selected.size === 0}>
                    <Play data-icon="inline-start" aria-hidden />
                    Generate
                  </Button>
                ) : null}
              </div>
              )}
            </div>

            <TabsContent value="new">
              {startError ? (
                <p className="mb-3 text-xs text-fail" role="alert">
                  {startError}
                </p>
              ) : null}

              {/* The count stays here, above the rows it counts. Generate moved up to the tabs
                  row; this is the readout that tells the operator what pressing it will do. */}
              {!HOSTED_READONLY ? (
                <p className="machine mb-3 text-xs text-muted-foreground">
                  {selected.size > 0
                    ? `${formatCount(selected.size)} selected`
                    : `${formatCount(selectableCount)} ready to generate`}
                </p>
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
                          // Same row height as the Created tab and as the blogs table: the New tab
                          // lists the same articles, so it cannot be the one that reads shorter.
                          <TableRow key={blog.topic_slug} className="[&>td]:py-2.5">
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
                              title={blog.uploaded ? "Uploaded by hand: letters mark manual blogs" : "Written by the engine"}
                            >
                              {labels.get(blog.topic_slug) ?? "-"}
                            </TableCell>
                            <TableCell className="max-w-0">
                              {/* min-h-8 for the same reason the Created tab's link carries it: it
                                  is what makes the row 52px rather than 36px. There is no link
                                  here because a blog with no post has nothing to open. */}
                              <span className="flex min-h-8 items-center gap-2">
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

            <TabsContent value="created">
              {monthPosts.length === 0 ? (
                <NoPosts brandName={brandName} label={label} />
              ) : (
                <Card className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        {/* Select-all over the RENDERED posts, so the month filter above is how an
                            operator narrows a bulk act down. */}
                        {!HOSTED_READONLY ? (
                          <TableHead className="w-10">
                            <Checkbox
                              checked={
                                allPostsPicked ? true : somePostsPicked ? "indeterminate" : false
                              }
                              disabled={visiblePostSlugs.length === 0}
                              onCheckedChange={() => toggleAllPosts()}
                              aria-label={`Select all ${label}s`}
                            />
                          </TableHead>
                        ) : null}
                        <SortableHead
                          label="#"
                          column="num"
                          sortKey={postSort.key}
                          sortDir={postSort.dir}
                          onSort={onPostSort}
                          className="w-12"
                        />
                        <SortableHead
                          label="Post"
                          column="post"
                          sortKey={postSort.key}
                          sortDir={postSort.dir}
                          onSort={onPostSort}
                        />
                        <SortableHead
                          label="Status"
                          column="status"
                          sortKey={postSort.key}
                          sortDir={postSort.dir}
                          onSort={onPostSort}
                          className="w-40"
                        />
                        <SortableHead
                          label="Updated"
                          column="updated"
                          sortKey={postSort.key}
                          sortDir={postSort.dir}
                          onSort={onPostSort}
                          className="w-32"
                        />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedPosts.map((post) => {
                        const generating = isGenerating(post.source_topic_slug);
                        const state = generating ? "generating" : post.state;
                        // The SOURCE BLOG's identifier, the same number-or-letter the New tab
                        // and the blogs table show, so "post 3" and "blog 3" are one thing.
                        const source = rows.find((b) => b.topic_slug === post.source_topic_slug);
                        return (
                          <TableRow
                            key={post.id}
                            // The whole row opens the review page, exactly like a blogs-table
                            // row: the pointer gets the row, a screen reader and middle-click
                            // get the real link in the Post cell.
                            onClick={() => router.push(reviewHref(post.source_topic_slug))}
                            // THE SAME ROW HEIGHT AS THE BLOGS TABLE, and it takes both halves:
                            // py-2.5 on every cell and the min-h-8 target on the title link below.
                            // TableCell's own p-2 with a bare link made these rows 36px against
                            // the blogs table's 52px, so the same list of the same articles
                            // changed shape depending on which tab an operator was standing on.
                            className="cursor-pointer [&>td]:py-2.5"
                          >
                            {/* stopPropagation so ticking a row never also opens it. */}
                            {!HOSTED_READONLY ? (
                              <TableCell onClick={(event) => event.stopPropagation()}>
                                <Checkbox
                                  checked={postsPicked.has(post.source_topic_slug)}
                                  onCheckedChange={() => togglePost(post.source_topic_slug)}
                                  aria-label={`Select ${post.source_topic}`}
                                />
                              </TableCell>
                            ) : null}
                            <TableCell
                              className="machine text-xs text-muted-foreground"
                              title={source?.uploaded ? "Uploaded by hand: letters mark manual blogs" : "Written by the engine"}
                            >
                              {labels.get(post.source_topic_slug) ?? "-"}
                            </TableCell>
                            <TableCell className="max-w-0">
                              <Link
                                href={reviewHref(post.source_topic_slug)}
                                onClick={(event) => {
                                  // The row handler would otherwise fire too and navigate twice.
                                  event.stopPropagation();
                                }}
                                // Flex column, centred, matching blogs-table's title link exactly:
                                // min-h-8 is the 32px target, and under `block` the text renders at
                                // the TOP of that box with the spare height below it, which is the
                                // drift that put a title several px above the row number beside it.
                                className="flex min-h-8 w-full flex-col justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                              >
                                <span className="block truncate text-sm font-medium text-foreground">
                                  {post.source_topic}
                                </span>
                                <span className="sr-only">Open the post for review</span>
                              </Link>
                            </TableCell>
                            <TableCell>
                              <StateTagChip tag={channelTag(state, "admin")} />
                            </TableCell>
                            <TableCell className="machine text-xs text-muted-foreground">
                              {formatRelative(post.updated_at)}
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
