"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  Clock,
  Inbox,
  Loader2,
  Lock,
} from "lucide-react";
import { ActionCard, ReadyCard, SectionHeading } from "@/portal/blog-cards";
import { AnswerForm } from "@/portal/answer-form";
import { MarkdownView } from "@/portal/markdown-view";
import { CommentedArticle } from "@/portal/comments-rail";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { BlogsTable } from "@/components/blogs/blogs-table";
import { BrandHeader, ResourcesSummaryCard, StatRow } from "@/components/shell/brand-overview";
import { ReadOnlyText } from "@/components/clients/editable-text";
import {
  PREVIEW_ROWS,
  PreviewFooter,
  PreviewList,
} from "@/components/clients/roadmap-panel";
import { clientCan, clientCanSee } from "@/lib/blog-state";
import { ApiError, api, detailText, isStaleVersion } from "@/portal/api";
import { formatDate, formatRelative, readingTime } from "@/portal/format";
import { blogHref, brandHref } from "@/portal/nav";
import type { SortDir, SortKey } from "@/components/blogs/blogs-filter";
import type { WaitingSignal } from "@/components/blogs/questions-state";
import { cn } from "@/lib/utils";
import { usePortal } from "@/portal/portal-context";
import { useBlogDetail } from "@/portal/use-blog-detail";
import type { PortalAnswerView, PortalBlogCard, ReplyBody, SuggestBody } from "@/portal/types";

/**
 * The client portal's views, one per resolved route. The (client) layout provides the
 * shell; the catch-all page resolves the URL against the caller's orgs and renders one of
 * these with explicit props. None reads useParams: the resolver is the single authority for
 * which org/brand/section a URL names, so a view is handed what it renders.
 *
 * NO AFFORDANCE ON THIS SURFACE DECIDES FOR ITSELF WHETHER IT IS OFFERED. `clientCan(state,
 * act)` decides, from the table in lib/blog-state.ts, and these views ask it. Writing the
 * condition inline instead is how the portal came to offer a suggestion on an approved article
 * that the record then refused: the affordance and the rule were two different sentences in two
 * different files, and only one of them was ever updated.
 *
 * THE UI IS NOT THE ENFORCEMENT LAYER. Migration 013's triggers refuse a change request on an
 * approved article whatever this file renders, and that is the guarantee. What these gates buy
 * is that a client is never SHOWN a door the record will slam: an affordance that always fails
 * is worse than no affordance, because it costs someone the effort of writing the request first.
 */

/**
 * The library's groups, from the canonical state and nothing else. Written once and shared by the
 * overview statistics and the blogs tabs, so the two can never count the same article differently.
 *
 * THE PARTITION IS TOTAL: every card portal-data.ts sends lands in exactly one group, so nothing a
 * client can see ever falls out of the library. Which TAB a group belongs to is decided by the
 * reader below, not here:
 *   needsAnswers  has_questions        -> Needs answers tab, "Waiting on you"
 *   answered      answers_submitted    -> Needs answers tab, tagged "Answered" (ready for our rerun)
 *   clientReview  client_review        -> Ready to post tab, "Ready for your review"
 *   commented     changes_requested    -> Ready to post tab, same section: once sent, the
 *                                         approve path never closes, so a round of comments is
 *                                         still an approvable card, tagged by where the notes
 *                                         stand rather than filed away with the team
 *   withTeam      the generating       -> Ready to post tab, the quiet "In progress" rows
 *                 slivers (!clientCanSee)
 *   signedOff     approved, published  -> Approved tab; the tag on each card says which
 *
 * `answered` is split out from the other with-the-team states DELIBERATELY, at the operator's
 * request: the client answered the review questions, so it sits beside the questions it settles
 * rather than beside work that is the team's alone. The !clientCanSee arm catches the
 * `generating` slivers portal-data.ts keeps visible, so they are grouped, never lost.
 */
function partition(blogs: PortalBlogCard[]) {
  return {
    needsAnswers: blogs.filter((blog) => blog.state === "has_questions"),
    answered: blogs.filter((blog) => blog.state === "answers_submitted"),
    clientReview: blogs.filter((blog) => blog.state === "client_review"),
    commented: blogs.filter((blog) => blog.state === "changes_requested"),
    withTeam: blogs.filter((blog) => !clientCanSee(blog.state)),
    signedOff: blogs.filter((blog) => blog.state === "approved" || blog.state === "published"),
  };
}

function ErrorCard({ message, detail, onRetry }: { message: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
      <p className="text-sm font-medium">{message}</p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
      {onRetry ? (
        <Button className="mt-4" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function BrandUnavailable() {
  return (
    <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
      <p className="text-sm font-medium">This brand is not available</p>
      <p className="mt-1 text-xs text-muted-foreground">
        To view a brand you must be signed in with its organisation&apos;s account.
      </p>
      <Button className="mt-4" variant="outline" size="sm" asChild>
        <Link href="/">Back to your workspace</Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org chooser: only reached for a MULTI-brand org (a single-brand org resolves straight to
// its brand). Waiting-on-you across the org, then the brand grid.
// ---------------------------------------------------------------------------

export function OrgChooser({ org: orgSlug }: { org: string }) {
  const { orgs, blogs, loading, error, refresh, isSingleBrand } = usePortal();
  const org = orgs.find((entry) => entry.slug === orgSlug);
  const single = isSingleBrand(orgSlug);

  if (error !== null) {
    return <ErrorCard message="Could not load this organisation" detail={detailText(error)} onRetry={refresh} />;
  }
  if (loading) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-28 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }
  if (org === undefined) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">This space belongs to another organisation</p>
        <p className="mt-1 text-xs text-muted-foreground">
          To view it, sign in with that organisation&apos;s account.
        </p>
      </div>
    );
  }

  // The org chooser shows only what is OWED, so it buckets on the states whose clientActions
  // carry an act: answer, and approve, which client_review and changes_requested both grant
  // now that a round of comments no longer closes the approve path. Everything else waits on
  // the team. One filter over both states, so the incoming newest-activity order is preserved
  // rather than reassembled from two groups.
  const mine = blogs.filter((blog) => blog.org === org.slug);
  const action = mine.filter((blog) => blog.state === "has_questions");
  const ready = mine.filter(
    (blog) => blog.state === "client_review" || blog.state === "changes_requested",
  );

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{org.name}</h1>
        {action.length > 0 ? (
          <p className="mt-1 text-sm text-review">
            {action.length === 1
              ? "1 article is waiting on you"
              : `${action.length} articles are waiting on you`}
          </p>
        ) : null}
      </div>

      {action.length > 0 ? (
        <section className="space-y-3" aria-label="Waiting on you">
          <SectionHeading tone="review" count={action.length}>
            Waiting on you
          </SectionHeading>
          <div className="space-y-3">
            {action.map((blog) => (
              <ActionCard key={`${blog.brand}/${blog.topic_slug}`} card={blog} showBrand />
            ))}
          </div>
        </section>
      ) : null}

      {ready.length > 0 ? (
        <section className="space-y-3" aria-label="Ready to post">
          <SectionHeading count={ready.length}>Ready to post</SectionHeading>
          <div className="space-y-3">
            {ready.map((blog) => (
              <ReadyCard key={`${blog.brand}/${blog.topic_slug}`} card={blog} showBrand />
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3" aria-label="Brands">
        <SectionHeading>Your brands</SectionHeading>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {org.brands.map((brand) => (
            <Link
              key={brand.slug}
              href={brandHref(org.slug, brand.slug, single)}
              className="group flex items-center justify-between gap-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10 outline-none transition-shadow hover:shadow-md hover:shadow-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex min-w-0 items-center gap-3">
                <Box className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm font-medium">{brand.name}</span>
              </span>
              <ArrowRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand overview: STATISTICS, not a second copy of the blogs list. The old overview and the
// blogs library rendered the same sections, which is the duplication this split removes. Every
// tile links into the blogs tab (or the roadmap) that holds the articles it counts, so the
// overview answers "how many" and one click answers "which".
// ---------------------------------------------------------------------------

export function BrandOverview({ org, brand: brandSlug }: { org: string; brand: string }) {
  const { blogs, brands, loading, error, refresh, isSingleBrand } = usePortal();
  const single = isSingleBrand(org);

  // The roadmap card numbers: total topics and the not-yet-delivered remainder. SECONDARY by
  // design: a brand with no roadmap, or a transient read error, drops those rows rather than
  // blocking the overview. Tagged with the brand rather than reset in the effect, so switching
  // brands reads as null until its own fetch lands.
  const [sheetFor, setSheetFor] = React.useState<{ brand: string; topics: number } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    api
      .roadmap(brandSlug, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setSheetFor({ brand: brandSlug, topics: data.rows.length });
        }
      })
      .catch(() => {
        // No roadmap in place, or a transient failure. The row hides itself; nothing on the
        // overview depends on it.
      });
    return () => controller.abort();
  }, [brandSlug]);
  const topics = sheetFor !== null && sheetFor.brand === brandSlug ? sheetFor.topics : null;

  // The resources preview, same card the admin overview renders (ResourcesSummaryCard), over
  // the portal's own wire. A failed read costs the card its list, not the page its render.
  const [resourcesFor, setResourcesFor] = React.useState<{
    brand: string;
    resources: { name: string; content_type: string }[];
  } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    api.resources(brandSlug, controller.signal).then(
      (data) => setResourcesFor({ brand: brandSlug, resources: data.resources }),
      () => setResourcesFor({ brand: brandSlug, resources: [] }),
    );
    return () => controller.abort();
  }, [brandSlug]);
  const resources = resourcesFor?.brand === brandSlug ? resourcesFor.resources : null;

  if (error !== null) {
    return <ErrorCard message="Could not load this brand" detail={detailText(error)} onRetry={refresh} />;
  }
  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6" aria-busy>
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="h-64 animate-pulse rounded-xl bg-muted lg:col-span-2" />
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    );
  }

  const brand = brands.find((entry) => entry.slug === brandSlug && entry.org === org);
  if (brand === undefined) {
    return <BrandUnavailable />;
  }

  const mine = blogs.filter((blog) => blog.brand === brand.slug && blog.org === org);
  const { needsAnswers, clientReview, commented } = partition(mine);
  const delivered = mine.filter(
    (blog) => blog.state === "approved" || blog.state === "published",
  ).length;
  const reviewable = clientReview.length + commented.length;

  const attention = [
    needsAnswers.length > 0
      ? needsAnswers.length === 1
        ? "1 article waiting on your answers"
        : `${needsAnswers.length} articles waiting on your answers`
      : null,
    reviewable > 0
      ? reviewable === 1
        ? "1 ready for you to approve"
        : `${reviewable} ready for you to approve`
      : null,
  ].filter(Boolean);

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* The ADMIN overview's own masthead (components/shell/brand-overview.tsx), minus what
          a client is never shown: no slug line, no preflight, no Create button. The footer
          carries the one sentence a client actually needs on arrival. */}
      <BrandHeader
        name={brand.name}
        domain={brand.domain}
        industry={brand.industry}
        footer={
          <p
            className={cn(
              "mt-2 text-sm",
              attention.length > 0 ? "text-review" : "text-muted-foreground",
            )}
          >
            {attention.length > 0
              ? attention.join(" \u{b7} ")
              : mine.length > 0
                ? "Nothing needs your attention right now."
                : "Articles appear here as our team prepares and delivers them."}
          </p>
        }
      />

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <ReadOnlyText
            title="Description"
            help="How we describe your brand to the writers. Generated from your website."
            value={brand.description}
            emptyText="No description yet. It is generated from your website shortly after your brand is added."
          />
          <RecentBlogsCard cards={mine} href={brandHref(org, brand.slug, single, "/blogs")} />
        </div>

        <div className="flex flex-col gap-4">
          {/* The admin's "Where this brand stands" card, with the client's own numbers: no
              failed count and no score-bearing rows, which never cross this wire at all. */}
          <Card>
            <CardContent>
              <p className="text-sm font-medium text-foreground">Where this brand stands</p>
              <dl className="mt-3 flex flex-col gap-2">
                <StatRow label="Blogs delivered" value={delivered} accent />
                <StatRow label="Waiting on you" value={needsAnswers.length} />
                <StatRow label="Resources" value={resources === null ? null : resources.length} />
                <StatRow label="Roadmap topics" value={topics} />
              </dl>
            </CardContent>
          </Card>
          <ResourcesSummaryCard
            total={resources?.length ?? 0}
            resources={resources}
            href={brandHref(org, brand.slug, single, "/resources")}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The admin overview's roadmap card shape (clients/roadmap-panel.tsx PreviewList and
 * PreviewFooter, the same components), filled with the client's own articles: newest first,
 * each wearing the roadmap number the Blogs tabs also show and the same client-safe state
 * tag, with one outline door into the full library.
 */
function RecentBlogsCard({ cards, href }: { cards: PortalBlogCard[]; href: string }) {
  const recent = [...cards].sort((a, b) => b.created.localeCompare(a.created));
  const preview = recent.slice(0, PREVIEW_ROWS);
  const remaining = recent.length - preview.length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-foreground">Blogs</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">
          Your articles, newest first. Open the Blogs tab to read, answer, or approve them.
        </p>
      </CardHeader>
      <CardContent>
        {preview.length === 0 ? (
          <p className="text-sm text-foreground">
            No articles yet. They appear here as our team prepares and delivers them.
          </p>
        ) : (
          <>
            <PreviewList
              items={preview.map((card) => ({
                key: `${card.brand}/${card.topic_slug}`,
                /* The same roadmap number the Blogs tabs print, so a row read here is
                   findable there. Absent when the row is gone from the sheet, exactly as
                   the table leaves that cell blank. */
                number: card.roadmap_index !== null ? card.roadmap_index + 1 : undefined,
                title: card.title,
                meta: formatRelative(card.created),
                right: <BlogStateTag state={card.state} audience="client" />,
              }))}
            />
            <PreviewFooter
              note={
                remaining > 0 ? (
                  <>
                    <span className="machine">{remaining}</span> more in the Blogs tab.
                  </>
                ) : (
                  "That is every article so far."
                )
              }
              href={href}
              cta="View all blogs"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}


const BLOG_TABS = ["needs-answers", "ready", "approved"] as const;
type BlogTab = (typeof BLOG_TABS)[number];

function isBlogTab(value: string | null): value is BlogTab {
  return value !== null && (BLOG_TABS as readonly string[]).includes(value);
}

/** A small count beside a tab label. Absent at zero: a tab that wants nothing says nothing. */
function TabCount({ n, tone = "default" }: { n: number; tone?: "default" | "review" }) {
  if (n === 0) {
    return null;
  }
  return (
    <span
      className={cn(
        "ml-1.5 rounded-full px-1.5 py-0.5 text-[0.6875rem] font-medium tabular-nums",
        // Amber on the needs-answers tab: those articles are waiting on the client, and the
        // count is the one glanceable cue of that before the tab is even opened.
        tone === "review" ? "bg-review-bg text-review" : "bg-foreground/10 text-muted-foreground",
      )}
    >
      {n}
    </span>
  );
}

function EmptyTab({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-dashed bg-card p-8 text-center">
      <Inbox className="mx-auto size-6 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

export function BlogsLibrary({ org, brand: brandSlug }: { org: string; brand: string }) {
  const { blogs, brands, loading, error, refresh } = usePortal();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  if (error !== null) {
    return <ErrorCard message="Could not load the blogs" detail={detailText(error)} onRetry={refresh} />;
  }
  if (loading) {
    // Shaped like what it becomes: header card, tab line, then stacked article cards. The old
    // three-column grid skeleton resolved into a stacked list, so the page visibly rearranged
    // itself the moment real data landed.
    return (
      <div className="space-y-5" aria-busy>
        <div className="h-16 animate-pulse rounded-lg bg-muted" />
        <div className="h-8 w-72 animate-pulse rounded-lg bg-muted" />
        <div className="space-y-3">
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
          <div className="h-24 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    );
  }

  const brand = brands.find((entry) => entry.slug === brandSlug && entry.org === org);
  if (brand === undefined) {
    return <BrandUnavailable />;
  }

  const mine = blogs.filter((blog) => blog.brand === brandSlug && blog.org === org);

  // A brand with nothing at all skips the tab bar entirely: three empty tabs read as broken,
  // where one honest "nothing yet" reads as new.
  if (mine.length === 0) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center">
        <Inbox className="mx-auto size-6 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium">Nothing here yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Articles appear here as our team prepares and delivers them.
        </p>
      </div>
    );
  }

  const { needsAnswers, answered, clientReview, commented, withTeam, signedOff } = partition(mine);
  const needsCount = needsAnswers.length + answered.length;
  // ONE approvable list for the Ready tab: client_review and changes_requested render the same
  // ReadyCard, because a round of comments no longer closes the approve path. Merged and sorted
  // by newest activity rather than concatenated by group, so a fresh send and a round the team
  // just moved interleave in honest order. `date` is each card's newest-activity stamp.
  const reviewable = [...clientReview, ...commented].sort((a, b) => b.date.localeCompare(a.date));
  const readyCount = reviewable.length + withTeam.length;
  const doneCount = signedOff.length;

  // The active tab defaults to whatever most wants attention, but a ?tab= from a link always
  // wins: the overview tiles deep-link straight to the group they count, and the "In progress"
  // tile links with NO tab, which this fallback then resolves to the tab that actually holds
  // those articles (needs-answers when answers are in, ready otherwise).
  const fallback: BlogTab = needsCount > 0 ? "needs-answers" : readyCount > 0 ? "ready" : "approved";
  const requested = params.get("tab");
  const active: BlogTab = isBlogTab(requested) ? requested : fallback;

  const setTab = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("tab", value);
    // replace, not push: flipping a tab is not a place in history to press Back through.
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-5">
      {/* The same header card Resources and Reports open with, so every tab in the sidebar
          lands on the same shape: what this page is, in one sentence, then the content. */}
      <div className="rounded-lg border bg-card px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Your articles</h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
          Everything we write for {brand.name}, in three stages: questions only you can answer,
          finished drafts waiting for your approval, and the library of what you have signed off.
        </p>
      </div>

      <Tabs value={active} onValueChange={setTab} className="gap-6">
      <TabsList variant="line" className="w-full justify-start gap-4">
        <TabsTrigger value="needs-answers" className="flex-none">
          Needs answers
          {/* Amber only where open questions are actually waiting on the client; articles
              already answered sit in this tab too but summon nobody. */}
          <TabCount n={needsCount} tone={needsAnswers.length > 0 ? "review" : "default"} />
        </TabsTrigger>
        <TabsTrigger value="ready" className="flex-none">
          Ready to post
          <TabCount n={readyCount} />
        </TabsTrigger>
        <TabsTrigger value="approved" className="flex-none">
          Approved
          <TabCount n={doneCount} />
        </TabsTrigger>
      </TabsList>

      {/* Each tab is the ADMIN's own BlogsTable (audience="client"): #, Title, Created,
          Status, and never Score or Iterations, which the portal wire does not even carry.
          The tag and the questions chip say everything the cards used to. */}
      <TabsContent value="needs-answers" className="space-y-3">
        {needsCount > 0 ? (
          <>
            <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
              Our editorial review needs a few answers only you can give. Each one takes a
              minute, and the article stays on hold until it has them. Articles you have
              already answered stay here, marked Answered, until they move on.
            </p>
            <LibraryTable cards={[...needsAnswers, ...answered]} />
          </>
        ) : (
          <EmptyTab
            title="No open questions"
            body="When our editorial review needs something only you can answer, it appears here."
          />
        )}
      </TabsContent>

      <TabsContent value="ready" className="space-y-3">
        {readyCount > 0 ? (
          <>
            <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
              Read each article, leave a note on any text, and approve when you are happy. If you
              leave notes, the article stays here and updates as our team works them in. Rows
              marked In progress are still with our team and appear ready as soon as they finish.
            </p>
            <LibraryTable cards={[...reviewable, ...withTeam]} />
          </>
        ) : (
          <EmptyTab
            title="Nothing ready to post"
            body="Finished articles appear here for your review before they go live."
          />
        )}
      </TabsContent>

      <TabsContent value="approved" className="space-y-3">
        {doneCount > 0 ? (
          <>
            <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
              Everything you have approved. The tag on each article shows whether it is approved
              and on its way, or already live on your site.
            </p>
            <LibraryTable cards={signedOff} />
          </>
        ) : (
          <EmptyTab
            title="Nothing approved yet"
            body="Articles you approve, and ones already live on your site, collect here."
          />
        )}
      </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * One tab's articles in the SHARED BlogsTable, the same component the admin library renders.
 * audience="client" drops Score and Iterations at the component, and the wire never carried
 * them anyway. Sorting is local to the tab: created desc to start, any header toggles.
 */
function LibraryTable({ cards }: { cards: PortalBlogCard[] }) {
  const { isSingleBrand } = usePortal();
  const router = useRouter();
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({
    key: "created",
    dir: "desc",
  });

  const rows = React.useMemo(() => {
    const compare = (a: PortalBlogCard, b: PortalBlogCard): number => {
      switch (sort.key) {
        case "roadmap":
          return (a.roadmap_index ?? Infinity) - (b.roadmap_index ?? Infinity);
        case "topic":
          return a.title.localeCompare(b.title);
        case "status":
          return a.state.localeCompare(b.state);
        default:
          return a.created.localeCompare(b.created);
      }
    };
    const sorted = [...cards].sort((a, b) => {
      const order = compare(a, b);
      return sort.dir === "asc" ? order : -order;
    });
    // The table's row shape is the admin's: `topic` is the title's wire name there.
    return sorted.map((card) => ({ ...card, topic: card.title }));
  }, [cards, sort]);

  // The questions chip, from the card's own count: only an OPEN form summons anybody, so only
  // has_questions rows enter the map, and the client never sees the admin's rerun variant.
  const waiting = React.useMemo(
    () =>
      new Map<string, WaitingSignal>(
        cards
          .filter((card) => card.state === "has_questions" && (card.question_count ?? 0) > 0)
          .map((card) => [
            card.topic_slug,
            { kind: "held" as const, count: card.question_count ?? 0 },
          ]),
      ),
    [cards],
  );

  return (
    <Card className="overflow-hidden p-0">
      <BlogsTable
        blogs={rows}
        waiting={waiting}
        stateOf={(row) => row.state}
        audience="client"
        sortKey={sort.key}
        sortDir={sort.dir}
        activeSlug={null}
        onSort={(key) =>
          setSort((cur) =>
            cur.key === key
              ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
              : { key, dir: key === "created" ? "desc" : "asc" },
          )
        }
        hrefFor={(row) => blogHref(row.org, row.brand, isSingleBrand(row.org), row.topic_slug)}
        onOpen={(row) =>
          router.push(blogHref(row.org, row.brand, isSingleBrand(row.org), row.topic_slug))
        }
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Blog detail
// ---------------------------------------------------------------------------

export function BlogDetail({ org, brand, topic }: { org: string; brand: string; topic: string }) {
  const portal = usePortal();
  const blogsHref = brandHref(org, brand, portal.isSingleBrand(org), "/blogs");
  // The read, and the 15 second watch while the article is with the client. The hook owns
  // the loop and the hidden-tab pause; this view owns what the page does with what lands.
  const { blog, error, refetch, reload: hardReload } = useBlogDetail(brand, topic);

  // Every re-read here also refreshes the overview, because the shell's own counts (waiting
  // on you, ready to post) are derived from it: acting on an article and watching the
  // sidebar keep the old number is the two surfaces disagreeing about the same record.
  const refresh = React.useCallback(() => {
    refetch();
    portal.refresh();
  }, [refetch, portal]);

  const reload = React.useCallback(() => {
    hardReload();
    portal.refresh();
  }, [hardReload, portal]);

  const submitSuggestion = React.useCallback(
    async (draft: SuggestBody) => {
      await api.suggestChange(brand, topic, draft);
      refresh();
    },
    [brand, topic, refresh],
  );

  const submitReply = React.useCallback(
    async (draft: ReplyBody) => {
      await api.replyComment(brand, topic, draft);
      refresh();
    },
    [brand, topic, refresh],
  );

  if (error !== null) {
    return (
      <div className="mx-auto max-w-md rounded-xl border bg-card p-6 text-center">
        <p className="text-sm font-medium">
          {error.status === 404 ? "This article is not available" : "Could not load the article"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{detailText(error)}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={blogsHref}>Back to the blogs</Link>
          </Button>
          {error.status !== 404 ? (
            <Button variant="outline" size="sm" onClick={reload}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  if (blog === null) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="h-5 w-32 animate-pulse rounded bg-muted" />
        <div className="h-9 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  /*
   * THE FOUR ACTS, ASKED OF THE TABLE RATHER THAN OF THE BRANCH THEY SIT IN. Read together
   * they are the whole of what a client may do to an article, and each one is a lookup rather
   * than a condition this file invented:
   *   answer   has_questions only
   *   approve  client_review and changes_requested: once sent, the approve path never closes,
   *            and approving mid-round is the client saying the remaining notes no longer
   *            block them
   *   suggest  client_review and changes_requested, always against the latest version this
   *            page shows; an approved article still collects no new requests
   *   reply    client_review, changes_requested and approved, so a thread stays usable while
   *            the team works and a question can still be answered after sign-off
   */
  const canAnswer = clientCan(blog.state, "answer");
  const canApprove = clientCan(blog.state, "approve");
  const canSuggest = clientCan(blog.state, "suggest");
  const canReply = clientCan(blog.state, "reply");

  // The one fact the changes_requested state cannot carry: how many of this client's notes are
  // still unaddressed. open + applying + failed all count, matching the server's
  // comments_pending: a failed apply is the team's retry, never named to the client, and a note
  // it failed on was not addressed. Only resolved and dismissed are done. Computed once here so
  // the header tag and the banner below read the same number and cannot disagree.
  const pendingComments = (blog.comments ?? []).filter(
    (comment) =>
      comment.state === "open" || comment.state === "applying" || comment.state === "failed",
  ).length;

  // Whether this payload carries the SENT article rather than the ANCHORED DRAFT a question
  // form is about. Both arrive in `body`, so the state is the only thing that tells them apart,
  // and getting it wrong is not a cosmetic error: the released branch below renders the approve
  // banner, the suggestion rail and the reply threads, so a draft falling into it would invite a
  // client to approve an article nobody sent them.
  //
  // BOTH DRAFT STATES ARE EXCLUDED, not just the one. portal-data.clientReadsDraft is the server
  // side of this same sentence and it names has_questions and answers_submitted together,
  // because answering a form does not re-anchor it. This file cannot import that function: it is
  // a client component and portal-data.ts carries the PostgREST client with it. So the list is
  // restated, and the two comments name each other so a third state added to one is looked for
  // in the other.
  const draft = blog.state === "has_questions" || blog.state === "answers_submitted";
  const reading = blog.body !== null && !draft;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={blogsHref}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Blogs
        </Link>
        {/* The one badge, in the client's vocabulary, from the one state. Inside the portal
            shell's TooltipProvider, like every other tag on this surface. commentsPending only
            matters in changes_requested, where it splits Pending comments from Comments
            resolved; every other state ignores it. */}
        <BlogStateTag state={blog.state} audience="client" commentsPending={pendingComments} />
      </div>

      <header className="space-y-2">
        <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {blog.brand_name}
        </p>
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-pretty">
          {blog.title}
        </h1>
        {/* Dates and reading time only. The tag above already said WHERE the article is, and a
            second sentence repeating it in other words is how two vocabularies start again. */}
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          {blog.state === "client_review"
            ? `Sent to you ${formatRelative(blog.sent ?? blog.date)}`
            : null}
          {blog.state === "changes_requested"
            ? `You left notes ${formatRelative(blog.date)}`
            : null}
          {blog.state === "approved"
            ? `Approved ${formatDate(blog.approved ?? blog.date)}`
            : null}
          {blog.state === "published" ? `Published ${formatDate(blog.date)}` : null}
          {/* word_count is populated only for the released states, so it gates itself. */}
          {blog.word_count !== null ? ` · ${readingTime(blog.word_count)}` : null}
          {blog.state === "has_questions" && blog.asked !== null
            ? `Review requested ${formatRelative(blog.asked)}`
            : null}
          {/* THE STATE TEST IS GONE FROM THIS ONE, because the wire already applied it and the
              copy of it here had gone wrong. It used to read `!clientCanSee(blog.state)`, which
              was true of every state a submit could produce until `answers_submitted` became one
              a client CAN see: the receipt would have vanished from the header at the exact
              moment it was worth reading. portal-data.ts nulls answered_at for every state at or
              past a send, so a non-null stamp already means "before the send, and they
              answered", and asking the field is asking the one authority rather than a second
              guess at it. */}
          {blog.answered_at !== null ? `You answered ${formatRelative(blog.answered_at)}` : null}
        </p>
      </header>

      {/*
        ONE released branch for all four states that carry the sent article, because the
        article, its threads and its rail are identical in every one of them and only the
        banner and the permitted acts differ. Four copies of this block is what let the
        approved copy drift into promising something the record refuses.

        The body test is repeated rather than folded into `reading` because a boolean cannot
        narrow `blog.body` for the reader below it, and only the narrowing satisfies the type.
      */}
      {reading && blog.body !== null ? (
        <div className="space-y-6">
          {/* ONE approvable banner for client_review AND changes_requested, because the two
              states offer the same acts now: canApprove covers both, this page always shows the
              newest version, and a round of notes never closes the approve path. Only the
              sentence differs, and in changes_requested it splits on the same pendingComments
              the tag above reads, so banner and tag cannot contradict. */}
          {blog.state === "client_review" || blog.state === "changes_requested" ? (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
              <p className="text-sm leading-relaxed">
                {blog.state === "client_review"
                  ? "This article is ready for you. Approve it and our team takes it live. To " +
                    "ask for a change, select any text in the article and leave a note beside it."
                  : pendingComments > 0
                    ? "Our team is working through your notes. This page always shows the " +
                      "newest version of the article, so you can follow along, add more notes, " +
                      "or approve when you are happy."
                    : "All your notes are addressed. Read the updated article and approve it, " +
                      "or add another note."}
              </p>
              {canApprove ? (
                <div className="mt-3 flex shrink-0 items-center gap-2 sm:mt-0">
                  {/* Approve stands alone. Nothing beside it offers a mode, because there is
                      no mode: a selection is always an invitation to comment. */}
                  <ApproveAction
                    brand={blog.brand}
                    topic={blog.topic_slug}
                    version={blog.version}
                    onSettled={refresh}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {/*
            THE APPROVED BANNER IS AN ENDING NOW, and the old line offering "an approval is not
            the end of the conversation" is gone with the affordance it described. Migration
            013's trigger refuses a change request on an approved article from BOTH sides, the
            admin's included, so a suggestion box here would collect a request nobody is
            permitted to apply. Saying the article is locked is the honest version of a door
            that was already shut.
          */}
          {blog.state === "approved" ? (
            <div className="flex items-start gap-2 rounded-lg border border-ship/20 bg-ship-bg px-4 py-3 text-sm text-ship">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="leading-relaxed">
                You approved this article {formatRelative(blog.approved ?? blog.date)}, so it is
                locked: these are the exact words going out, and nobody edits them from here,
                our team included. It is on its way to your site.
              </span>
            </div>
          ) : null}

          {blog.state === "published" ? (
            <div className="flex items-start gap-2 rounded-lg border border-ship/20 bg-ship-bg px-4 py-3 text-sm text-ship">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span className="leading-relaxed">
                This article is live on your site. It stays here so you can read exactly what
                went out.
              </span>
            </div>
          ) : null}

          <CommentedArticle
            source={blog.body}
            comments={blog.comments ?? []}
            onSuggest={submitSuggestion}
            onReply={submitReply}
            canSuggest={canSuggest}
            canReply={canReply}
          />
        </div>
      ) : null}

      {blog.state === "has_questions" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="order-2 lg:order-1">
            {blog.body !== null ? (
              <article className="rounded-xl bg-card p-6 ring-1 ring-foreground/10 sm:p-10">
                <p className="mb-6 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  This is the current draft, shown so you can answer in context. It is not
                  final and will change once your answers are applied.
                </p>
                <MarkdownView source={blog.body} />
              </article>
            ) : null}
          </div>
          <aside className="order-1 rounded-xl border border-review/25 bg-card p-5 lg:sticky lg:top-6 lg:order-2">
            <h2 className="text-sm font-semibold text-review">
              {blog.questions !== null && blog.questions.length === 1
                ? "1 question before this can be finalised"
                : `${blog.questions?.length ?? 0} questions before this can be finalised`}
            </h2>
            <p className="mt-1 mb-5 text-xs leading-relaxed text-muted-foreground">
              Our editorial review found points only you can settle. Answer below and the
              team takes it from there.
            </p>
            {/* canAnswer is the table's word, and it is true for exactly this state. Asking it
                rather than trusting the branch is what keeps the affordance and the rule the
                same sentence when a state is added to the machine. */}
            {blog.questions !== null && canAnswer ? (
              <AnswerForm
                brand={blog.brand}
                topic={blog.topic_slug}
                questions={blog.questions}
                onSubmitted={reload}
              />
            ) : null}
          </aside>
        </div>
      ) : null}

      {/*
        ANSWERS SUBMITTED: the one window where the client keeps BOTH halves of what they did.
        The draft they answered against on the left, their own answers on the right, and no act
        offered on either, because clientActions gives this state nothing.

        THE DRAFT HERE IS THE ANCHORED ONE AND THAT IS THE POINT OF THE BLOCK. A rerun that lands
        clean commits a NEW version and goes to internal review, which is not theirs to see; a
        rerun that asks again replaces the form and moves them to the next round. Either way the
        bytes below are the ones review_notes anchored the answered form to, chosen server-side
        in portal-data.buildDetail, so this view renders a draft rather than picking one.

        It is a SEPARATE BLOCK from the with-the-team one below rather than a branch inside it,
        because the two differ in what they can show and not merely in wording: this one has an
        article, and the slivers below never do.
      */}
      {blog.state === "answers_submitted" ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
          <div className="order-2 lg:order-1">
            {blog.body !== null ? (
              <article className="rounded-xl bg-card p-6 ring-1 ring-foreground/10 sm:p-10">
                <p className="mb-6 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  This is the draft your answers are about, kept here so you can see what you
                  answered against. It is not final: our team is working your answers into it.
                </p>
                <MarkdownView source={blog.body} />
              </article>
            ) : null}
          </div>
          {/* NOT sticky, unlike the question form's aside. That one is short and is a control the
              reader scrolls the article beside; this is a transcript that can run past the
              viewport, and pinning it would trap its own tail off screen. */}
          <aside className="order-1 space-y-4 lg:order-2">
            <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ship" aria-hidden />
              {/* The same weakened sentence the with-the-team block uses, for the same reason it
                  was weakened there: on default configuration nothing picks a portal submission
                  up until an operator clicks Rerun, so a present-tense claim that work is under
                  way can be false all weekend. "With our team" is true either way. */}
              <p className="text-sm leading-relaxed text-muted-foreground">
                Thank you. Your answers are with our editorial team. This page updates when the
                article is ready for your review, or if the review needs anything further from
                you.
              </p>
            </div>
            {blog.answers !== null ? <YourAnswers answers={blog.answers} /> : null}
          </aside>
        </div>
      ) : null}

      {/* With the team, and NARROWER than it looks: portal-data.ts folds the ordinary answered
          window to `answers_submitted` now, which the block above owns, so what reaches here are
          the two slivers where the record honestly reads `generating`. One is a rerun actually in
          flight; the other is a mirror still claiming a hold whose form is absent or stale. The
          RECORD reads `generating`, `internal_review` or `failed` at several points in one
          revise, and portal-data.ts narrows all of them to `generating` before they become
          payload, because those are the team's words about the client's own article. So this
          branch sees one state where the run has several. Asking clientCanSee rather than naming
          that state keeps the branch true however the run ended, which is what leaves the
          narrowing a wire concern instead of something every view has to remember.

          NO ARTICLE IS SHOWN HERE and that is the wire's decision, not this file's: a body is
          withheld in these two states because a live rerun is rewriting the very bytes an anchor
          would point at. The client keeps their answers, which is what they wrote. */}
      {!clientCanSee(blog.state) ? (
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            {/* "WITH our team", never "being applied", and the difference is not a nicety.
                The revise a client's answers are owed is dispatched by an engine, and the
                sweep that would pick a PORTAL submission up ships DISABLED:
                server/client_answers.py documents it as opt-in behind GEO_ANSWERS_PICKUP=1
                for a billing reason, and server/app.py returns before starting it unless that
                is set. So on default configuration the primary dispatch is an operator
                clicking Rerun, and a client who answers on Friday evening has nothing running
                on their article until Monday. The old copy told them work was under way for
                the whole weekend, in the present tense, on a page whose entire job is to say
                truthfully where their article sits.

                THE WEAKER SENTENCE IS UNCONDITIONAL BECAUSE NO CLAIM SIGNAL REACHES HERE.
                portal_revise_claims is what knows whether an engine has actually picked the
                topic up, and it is service-path only: migration 002 revokes it from
                authenticated outright, so this surface, which reads as the caller, cannot ask.
                Rather than invent a mechanism to justify the stronger claim, the copy makes
                the claim that holds either way. "With our team" is true while the form waits
                for an operator AND true while a revise runs, so it never goes stale and never
                overstates. What the client is owed here is the next event, and both sentences
                below promise exactly that: this page updates when something changes. */}
            <div className="text-sm leading-relaxed text-muted-foreground">
              {blog.answers !== null
                ? "Thank you. Your answers are with our editorial team. This page updates when the article is ready for your review, or if the review needs anything further from you."
                : "This article is with our editorial team. This page updates when it is ready for your review, or if the review needs anything from you."}
            </div>
          </div>

          {blog.answers !== null ? <YourAnswers answers={blog.answers} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The client's own answers, read-only, rendered identically wherever they are shown.
 *
 * IT IS A COMPONENT BECAUSE IT HAS TWO CALLERS NOW, and two copies of a transcript is how one of
 * them quietly stops matching the other. `answers_submitted` shows it beside the draft it was
 * written about; the with-the-team slivers show it alone, because no draft is served there. The
 * markup is the same in both, because it is the same act being reported.
 */
function YourAnswers({ answers }: { answers: PortalAnswerView[] }) {
  return (
    <section
      aria-label="Your answers"
      className="rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6"
    >
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <CheckCircle2 className="size-4 text-ship" aria-hidden />
        Your answers
      </h2>
      <dl className="space-y-5">
        {answers.map((answer, index) => (
          <div key={answer.id} className="space-y-1.5">
            <dt className="flex items-start gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{index + 1}</span>
              <span className="text-sm leading-snug font-medium text-pretty">
                {answer.question}
                {answer.area !== null ? (
                  <Badge variant="secondary" className="ml-2 align-middle font-normal">
                    {answer.area}
                  </Badge>
                ) : null}
              </span>
            </dt>
            <dd className="ml-5 rounded-md bg-muted/60 px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
              {answer.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The approve control, behind a confirm because it is the one client act with weight on
 * the other side: the team reads an approval as the signal to take the article live.
 * The dialog stays open until the request settles, so a refusal lands in front of the
 * client instead of behind a closed dialog.
 *
 * THE APPROVAL NAMES THE VERSION IT IS FOR. The team can send a newer article while
 * somebody is halfway down this one, and an approval carrying no version would stamp bytes
 * the client never read: the record would say they signed off on an article that arrived
 * after they pressed the button. The record refuses that, and this dialog is where the
 * refusal has to be readable, because it is the ONE case where the client's act did not
 * land and the page around them changed underneath it. Every other refusal here means the
 * record simply moved past the button, so re-reading the page answers it without a word.
 */
function ApproveAction({
  brand,
  topic,
  version,
  onSettled,
}: {
  brand: string;
  topic: string;
  /** The version the client is reading, straight off the detail payload. */
  version: string | null;
  /** The page re-reads the record here, so the view renders from what is true. */
  onSettled: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);

  async function approve() {
    setPending(true);
    setError(null);
    try {
      await api.approveBlog(brand, topic, { version });
      setOpen(false);
      onSettled();
    } catch (cause) {
      if (cause instanceof ApiError && isStaleVersion(cause)) {
        // The article changed while it was being read. The dialog STAYS OPEN and says so:
        // closing it here would leave a client who pressed Approve looking at a page that
        // quietly swapped its article and never took their approval.
        setStale(true);
        onSettled();
        return;
      }
      if (cause instanceof ApiError && cause.status === 409) {
        // Already approved, in another tab or by another person on the account. The record
        // has moved past this button, so the page re-reads and renders what is actually
        // true; an error message would only argue with it.
        setOpen(false);
        onSettled();
        return;
      }
      setError(cause instanceof ApiError ? detailText(cause) : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setError(null);
          setStale(false);
        }
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
          <AlertDialogTitle>
            {stale ? "This article changed" : "Approve this article?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {stale
              ? "Our team sent a newer version while you were reading. Your approval has not been recorded. The page now shows the new article: please read it again, then approve it."
              : "The team takes it live after your approval."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error !== null ? (
          <p
            role="alert"
            className="rounded-md border border-fail/20 bg-fail-bg px-3 py-2 text-xs font-medium text-fail"
          >
            {error}
          </p>
        ) : null}

        <AlertDialogFooter>
          {stale ? (
            <AlertDialogAction size="sm">Read the new version</AlertDialogAction>
          ) : (
            <>
              <AlertDialogCancel size="sm" disabled={pending}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                disabled={pending}
                onClick={(event) => {
                  event.preventDefault();
                  void approve();
                }}
              >
                {pending ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" aria-hidden />
                ) : null}
                Approve
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
