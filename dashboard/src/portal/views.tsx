"use client";

import * as React from "react";
import Link from "next/link";
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
import { ActionCard, ApprovedCard, FrozenRow, ReadyCard, SectionHeading } from "@/portal/blog-cards";
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
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { clientCan, clientCanSee } from "@/lib/blog-state";
import { ApiError, api, detailText, isStaleVersion } from "@/portal/api";
import { formatDate, formatRelative, readingTime } from "@/portal/format";
import { brandHref } from "@/portal/nav";
import { usePortal } from "@/portal/portal-context";
import { useBlogDetail } from "@/portal/use-blog-detail";
import type { PortalBlogCard, ReplyBody, SuggestBody } from "@/portal/types";

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
 * The four sections a client's library has, from the canonical state and nothing else.
 *
 * Written once and shared by both list views, because the two used to filter with their own
 * copies of the same four predicates. THE BUCKETS ARE BY WHO OWES WHAT, which is why
 * changes_requested sits with a spent hold rather than beside client_review: an article whose
 * change request is with the team asks the client for nothing, however recently they were
 * reading it, and putting it under "ready to post" would ask them to approve past their own
 * outstanding note. `published` sits with `approved` because both are locked and both are only
 * to be read; the tag on each card is what distinguishes them.
 */
function bucket(blogs: PortalBlogCard[]) {
  return {
    action: blogs.filter((blog) => blog.state === "has_questions"),
    ready: blogs.filter((blog) => blog.state === "client_review"),
    // !clientCanSee is "on this wire only because the client acted on it", and portal-data.ts
    // dropped every other such row before it became payload, so this needs no state list to
    // keep in step with the machine: it is whatever the machine says a client cannot see.
    withTeam: blogs.filter(
      (blog) => blog.state === "changes_requested" || !clientCanSee(blog.state),
    ),
    done: blogs.filter((blog) => blog.state === "approved" || blog.state === "published"),
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

  // The org chooser shows only what is OWED, so it buckets on the two states whose
  // clientActions carry an act: answer and approve. Everything else waits on the team.
  const mine = blogs.filter((blog) => blog.org === org.slug);
  const action = mine.filter((blog) => blog.state === "has_questions");
  const ready = mine.filter((blog) => blog.state === "client_review");

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-serif text-2xl tracking-tight">{org.name}</h1>
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
// Brand overview
// ---------------------------------------------------------------------------

export function BrandOverview({ org, brand: brandSlug }: { org: string; brand: string }) {
  const { blogs, brands, loading, error, refresh, isSingleBrand } = usePortal();

  if (error !== null) {
    return <ErrorCard message="Could not load this brand" detail={detailText(error)} onRetry={refresh} />;
  }
  if (loading) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const brand = brands.find((entry) => entry.slug === brandSlug && entry.org === org);
  if (brand === undefined) {
    return <BrandUnavailable />;
  }

  const mine = blogs.filter((blog) => blog.brand === brand.slug && blog.org === org);
  const { action, ready, withTeam, done } = bucket(mine);
  const recent = done.slice(0, 3);

  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-serif text-2xl tracking-tight">{brand.name}</h1>
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
              <ActionCard key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {ready.length > 0 ? (
        <section className="space-y-3" aria-label="Ready to post">
          <SectionHeading count={ready.length}>Ready to post</SectionHeading>
          <div className="space-y-3">
            {ready.map((blog) => (
              <ReadyCard key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {action.length + ready.length === 0 ? (
        withTeam.length + done.length > 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-ship/20 bg-ship-bg px-4 py-3 text-sm text-ship">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            Nothing needs your attention right now.
          </div>
        ) : (
          <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">
            Articles appear here as our team prepares and delivers them.
          </p>
        )
      ) : null}

      {withTeam.length > 0 ? (
        <section className="space-y-3" aria-label="In progress">
          <SectionHeading>In progress with our team</SectionHeading>
          <div className="space-y-2">
            {withTeam.map((blog) => (
              <FrozenRow key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="space-y-3" aria-label="Recently approved">
          <div className="flex items-baseline justify-between">
            <SectionHeading>Recently approved</SectionHeading>
            <Link
              href={brandHref(org, brand.slug, isSingleBrand(org), "/blogs")}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              All blogs
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recent.map((blog) => (
              <ApprovedCard key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blogs library
// ---------------------------------------------------------------------------

export function BlogsLibrary({ org, brand: brandSlug }: { org: string; brand: string }) {
  const { blogs, brands, loading, error, refresh } = usePortal();

  if (error !== null) {
    return <ErrorCard message="Could not load the blogs" detail={detailText(error)} onRetry={refresh} />;
  }
  if (loading) {
    return (
      <div className="space-y-4" aria-busy>
        <div className="h-24 animate-pulse rounded-xl bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="h-32 animate-pulse rounded-xl bg-muted" />
          <div className="h-32 animate-pulse rounded-xl bg-muted" />
          <div className="h-32 animate-pulse rounded-xl bg-muted" />
        </div>
      </div>
    );
  }

  const brand = brands.find((entry) => entry.slug === brandSlug && entry.org === org);
  const mine = blogs.filter((blog) => blog.brand === brandSlug && blog.org === org);
  const { action, ready, withTeam, done } = bucket(mine);

  if (brand === undefined) {
    return <BrandUnavailable />;
  }

  return (
    <div className="space-y-10">
      {action.length > 0 ? (
        <section className="space-y-3" aria-label="Waiting on you">
          <SectionHeading tone="review" count={action.length}>
            Waiting on you
          </SectionHeading>
          <p className="text-xs text-muted-foreground">
            Our editorial review needs a few answers only you can give. Each one takes a
            minute, and the article stays on hold until it has them.
          </p>
          <div className="space-y-3">
            {action.map((blog) => (
              <ActionCard key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {ready.length > 0 ? (
        <section className="space-y-3" aria-label="Ready to post">
          <SectionHeading count={ready.length}>Ready to post</SectionHeading>
          <p className="text-xs text-muted-foreground">
            Our team has finished these articles. Read each one, then approve it, or select
            any text in it to leave a note for the team.
          </p>
          <div className="space-y-3">
            {ready.map((blog) => (
              <ReadyCard key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {action.length + ready.length === 0 && withTeam.length + done.length > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-ship/20 bg-ship-bg px-4 py-3 text-sm text-ship">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          Nothing needs your attention right now.
        </div>
      ) : null}

      {withTeam.length > 0 ? (
        <section className="space-y-3" aria-label="In progress">
          <SectionHeading>In progress with our team</SectionHeading>
          <div className="space-y-2">
            {withTeam.map((blog) => (
              <FrozenRow key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {done.length > 0 ? (
        <section className="space-y-3" aria-label="Signed off">
          {/* One section for approved and published both. The client's question here is "which
              articles are finished", and the tag on each card answers the finer one. */}
          <SectionHeading>Signed off</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {done.map((blog) => (
              <ApprovedCard key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {mine.length === 0 ? (
        <div className="mx-auto max-w-md rounded-xl border bg-card p-8 text-center">
          <Inbox className="mx-auto size-6 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-sm font-medium">Nothing here yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Articles appear here as our team prepares and delivers them.
          </p>
        </div>
      ) : null}
    </div>
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
   *   approve  client_review only
   *   suggest  client_review only, so an approved article no longer collects requests
   *   reply    client_review and changes_requested, so a thread stays usable while the team
   *            works, and closes when the article is signed off
   */
  const canAnswer = clientCan(blog.state, "answer");
  const canApprove = clientCan(blog.state, "approve");
  const canSuggest = clientCan(blog.state, "suggest");
  const canReply = clientCan(blog.state, "reply");

  // Whether this payload carries the SENT article rather than the draft behind a question form.
  // The server already decided which states carry a body (portal-data.clientReadsArticle), so
  // this reads its answer instead of restating the list and letting the two drift.
  const reading = blog.body !== null && blog.state !== "has_questions";

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
            shell's TooltipProvider, like every other tag on this surface. */}
        <BlogStateTag state={blog.state} audience="client" />
      </div>

      <header className="space-y-2">
        <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {blog.brand_name}
        </p>
        <h1 className="font-serif text-3xl leading-tight tracking-tight text-pretty">
          {blog.title}
        </h1>
        {/* Dates and reading time only. The tag above already said WHERE the article is, and a
            second sentence repeating it in other words is how two vocabularies start again. */}
        <p className="text-xs text-muted-foreground">
          {blog.state === "client_review"
            ? `Sent to you ${formatRelative(blog.sent ?? blog.date)}`
            : null}
          {blog.state === "changes_requested"
            ? `You asked for changes ${formatRelative(blog.date)}`
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
          {!clientCanSee(blog.state) && blog.answered_at !== null
            ? `You answered ${formatRelative(blog.answered_at)}`
            : null}
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
          {blog.state === "client_review" ? (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
              <p className="text-sm leading-relaxed">
                This article is ready for you. Approve it and our team takes it live. To ask
                for a change, select any text in the article and leave a note beside it.
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

          {blog.state === "changes_requested" ? (
            <div className="flex items-start gap-2 rounded-lg border bg-card px-4 py-3 text-sm">
              <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="leading-relaxed">
                The changes you asked for are with our editorial team. Read the article as it
                stands and reply in any note to add to it. We send it back for your approval
                once your notes are in.
              </span>
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

      {/* With the team: the form is answered or superseded, so the client is owed nothing here.
          These states reach the portal only through the visibility addition portal-data.ts
          documents, which exists so a client who just answered does not watch their article
          disappear. The RECORD reads `generating`, `internal_review` or `failed` at three
          points in one revise, which is the whole difficulty; portal-data.ts narrows all of
          them to `generating` before they become payload, because those are the team's words
          about the client's own article. So this branch sees one state where the run has
          several. Asking clientCanSee rather than naming that state keeps the branch true
          however the run ended, which is what leaves the narrowing a wire concern instead of
          something every view has to remember. */}
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

          {blog.answers !== null ? (
            <section aria-label="Your answers" className="rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6">
              <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
                <CheckCircle2 className="size-4 text-ship" aria-hidden />
                Your answers
              </h2>
              <dl className="space-y-5">
                {blog.answers.map((answer, index) => (
                  <div key={answer.id} className="space-y-1.5">
                    <dt className="flex items-start gap-2">
                      <span className="text-xs font-semibold text-muted-foreground">
                        {index + 1}
                      </span>
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
          ) : null}
        </div>
      ) : null}
    </div>
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
