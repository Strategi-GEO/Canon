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
import { ApiError, api, detailText, isStaleVersion } from "@/portal/api";
import { formatDate, formatRelative, readingTime } from "@/portal/format";
import { brandHref } from "@/portal/nav";
import { usePortal } from "@/portal/portal-context";
import { useBlogDetail } from "@/portal/use-blog-detail";
import type { PortalBlogDetail, ReplyBody, SuggestBody } from "@/portal/types";

/**
 * The client portal's views, one per resolved route. The (client) layout provides the
 * shell; the catch-all page resolves the URL against the caller's orgs and renders one of
 * these with explicit props. None reads useParams: the resolver is the single authority for
 * which org/brand/section a URL names, so a view is handed what it renders.
 */

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

  const mine = blogs.filter((blog) => blog.org === org.slug);
  const action = mine.filter((blog) => blog.state === "action");
  const ready = mine.filter((blog) => blog.state === "ready");

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
  const action = mine.filter((blog) => blog.state === "action");
  const ready = mine.filter((blog) => blog.state === "ready");
  const frozen = mine.filter((blog) => blog.state === "frozen");
  const approved = mine.filter((blog) => blog.state === "approved");
  const recent = approved.slice(0, 3);

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
        frozen.length + approved.length > 0 ? (
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

      {frozen.length > 0 ? (
        <section className="space-y-3" aria-label="In progress">
          <SectionHeading>In progress with our team</SectionHeading>
          <div className="space-y-2">
            {frozen.map((blog) => (
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
  const action = mine.filter((blog) => blog.state === "action");
  const ready = mine.filter((blog) => blog.state === "ready");
  const frozen = mine.filter((blog) => blog.state === "frozen");
  const approved = mine.filter((blog) => blog.state === "approved");

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

      {action.length + ready.length === 0 && frozen.length + approved.length > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-ship/20 bg-ship-bg px-4 py-3 text-sm text-ship">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          Nothing needs your attention right now.
        </div>
      ) : null}

      {frozen.length > 0 ? (
        <section className="space-y-3" aria-label="In progress">
          <SectionHeading>In progress with our team</SectionHeading>
          <div className="space-y-2">
            {frozen.map((blog) => (
              <FrozenRow key={blog.topic_slug} card={blog} showBrand={false} />
            ))}
          </div>
        </section>
      ) : null}

      {approved.length > 0 ? (
        <section className="space-y-3" aria-label="Approved">
          <SectionHeading>Approved</SectionHeading>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {approved.map((blog) => (
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
        <StateBadge blog={blog} />
      </div>

      <header className="space-y-2">
        <p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
          {blog.brand_name}
        </p>
        <h1 className="font-serif text-3xl leading-tight tracking-tight text-pretty">
          {blog.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {blog.state === "ready"
            ? `Sent to you ${formatRelative(blog.sent ?? blog.date)}`
            : null}
          {blog.state === "approved"
            ? `Approved ${formatDate(blog.approved ?? blog.date)}`
            : null}
          {(blog.state === "ready" || blog.state === "approved") && blog.word_count !== null
            ? ` · ${readingTime(blog.word_count)}`
            : null}
          {blog.state === "action" && blog.asked !== null
            ? `Review requested ${formatRelative(blog.asked)}`
            : null}
          {blog.state === "frozen"
            ? blog.answered_at !== null
              ? `You answered ${formatRelative(blog.answered_at)}`
              : "With our editorial team"
            : null}
        </p>
      </header>

      {blog.state === "ready" && blog.body !== null ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
            <p className="text-sm leading-relaxed">
              This article is ready for you. Approve it and our team takes it live. To ask
              for a change, select any text in the article and leave a note beside it.
            </p>
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
          </div>

          <CommentedArticle
            source={blog.body}
            comments={blog.comments ?? []}
            onSuggest={submitSuggestion}
            onReply={submitReply}
          />
        </div>
      ) : null}

      {blog.state === "approved" && blog.body !== null ? (
        <div className="space-y-6">
          <div className="flex items-start gap-2 rounded-lg border border-ship/20 bg-ship-bg px-4 py-3 text-sm text-ship">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              You approved this article {formatRelative(blog.approved ?? blog.date)}. Our
              team takes it live from here. If something still needs changing, select the
              text and leave a note: an approval is not the end of the conversation.
            </span>
          </div>
          <CommentedArticle
            source={blog.body}
            comments={blog.comments ?? []}
            onSuggest={submitSuggestion}
            onReply={submitReply}
          />
        </div>
      ) : null}

      {blog.state === "action" ? (
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
            {blog.questions !== null ? (
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

      {blog.state === "frozen" ? (
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="flex items-start gap-3 rounded-xl border bg-card p-5">
            <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="text-sm leading-relaxed text-muted-foreground">
              {blog.answers !== null
                ? "Thank you. Your answers are with our editorial team and are being applied to the article. This page updates when the article is ready for your review, or if the review needs anything further from you."
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

function StateBadge({ blog }: { blog: PortalBlogDetail }) {
  if (blog.state === "approved") {
    return (
      <Badge className="border-transparent bg-ship-bg text-ship" variant="outline">
        Approved
      </Badge>
    );
  }
  if (blog.state === "ready") {
    return (
      <Badge className="border-transparent bg-primary/10 text-primary" variant="outline">
        Ready to post
      </Badge>
    );
  }
  if (blog.state === "action") {
    return (
      <Badge className="border-transparent bg-review-bg text-review" variant="outline">
        Waiting on you
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="font-normal">
      In progress
    </Badge>
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
