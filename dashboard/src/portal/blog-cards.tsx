"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Lock, MessageCircleQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { formatDate, formatRelative, readingTime } from "@/portal/format";
import { blogHref } from "@/portal/nav";
import { usePortal } from "@/portal/portal-context";
import type { PortalBlogCard } from "@/portal/types";
import { cn } from "@/lib/utils";

/**
 * The four visual registers of the home page, deliberately unequal:
 *
 *   ActionCard   -- loud. Amber ground, a question count, a full-card link. The portal asks a
 *                   client for answers rarely, so this card is allowed to shout. (has_questions)
 *   ReadyCard    -- inviting, on the brand's own accent. The happy ask: the article is
 *                   finished, read it and approve it, or say what should change by leaving a
 *                   note on the text itself. (client_review)
 *   FrozenRow    -- quiet rows with a lock. Nothing to do here; saying so calmly is the job.
 *                   (changes_requested, answers_submitted, and the in-flight slivers)
 *   ApprovedCard -- a clean reading library. White cards, dates, reading time, a quiet mark.
 *                   (approved and published, both locked and both only to be read)
 *
 * EVERY STATUS WORD ON THESE CARDS IS <BlogStateTag>, and none of them is written here. A card
 * that spelled its own status is a card that can disagree with the tag beside the article, with
 * the sidebar's counts, and with what the operator is looking at on the same record; that
 * disagreement is the whole reason lib/blog-state.ts exists. What each card still writes for
 * itself is the SUPPORTING sentence, the dates and counts and reading times that answer "how
 * long ago" and "how much", because those are facts about this card and not about the state.
 *
 * THE TAG IS A RADIX TOOLTIP, so every one of these renders only under the TooltipProvider that
 * PortalShell mounts. Nothing here may be rendered outside the portal shell.
 */

function cardHref(card: PortalBlogCard, singleBrand: boolean): string {
  return blogHref(card.org, card.brand, singleBrand, card.topic_slug);
}

export function BrandChip({ name }: { name: string }) {
  return (
    <Badge variant="outline" className="bg-background/60 font-normal">
      {name}
    </Badge>
  );
}

export function ActionCard({ card, showBrand }: { card: PortalBlogCard; showBrand: boolean }) {
  const { isSingleBrand } = usePortal();
  return (
    <Link
      href={cardHref(card, isSingleBrand(card.org))}
      className="group block rounded-xl border border-review/25 bg-review-bg p-4 outline-none transition-colors hover:border-review/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {showBrand ? (
            <div className="mb-1.5">
              <BrandChip name={card.brand_name} />
            </div>
          ) : null}
          <h3 className="font-serif text-base leading-snug text-pretty">{card.title}</h3>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-review">
            <BlogStateTag state={card.state} audience="client" />
            <MessageCircleQuestion className="size-3.5 shrink-0" aria-hidden />
            {card.question_count === 1
              ? "1 question from our editorial review"
              : `${card.question_count} questions from our editorial review`}
            <span className="text-muted-foreground">· asked {formatRelative(card.date)}</span>
          </p>
        </div>
        <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
          Review & answer
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </div>
    </Link>
  );
}

export function ReadyCard({ card, showBrand }: { card: PortalBlogCard; showBrand: boolean }) {
  const { isSingleBrand } = usePortal();
  return (
    <Link
      href={cardHref(card, isSingleBrand(card.org))}
      className="group block rounded-xl border border-primary/25 bg-primary/5 p-4 outline-none transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {showBrand ? (
            <div className="mb-1.5">
              <BrandChip name={card.brand_name} />
            </div>
          ) : null}
          <h3 className="font-serif text-base leading-snug text-pretty">{card.title}</h3>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-primary">
            {/* The tag replaces the hand written "Ready to post" and its icon. The sent date
                stays: it is this card's own fact, and the tag says nothing about elapsed time. */}
            <BlogStateTag state={card.state} audience="client" />
            <span className="text-muted-foreground">sent {formatRelative(card.date)}</span>
          </p>
        </div>
        <span className="mt-1 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground">
          Review & approve
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </div>
    </Link>
  );
}

/**
 * The quiet row, for every state where the article is with the team and the client is not being
 * asked for anything: a change request they filed, a form they have already answered
 * (`answers_submitted`), and the two in-flight slivers portal-data.ts keeps visible. The tag says
 * which; the sentence beside it says when they acted, because "what happened to my article" is
 * answered by the tag and "how long ago" is not.
 *
 * THE SENTENCE READS OFF `card.answered`, NOT OFF THE STATE, and that is what makes this one of
 * the few sites the new state needed no edit for. The flag means "the client's answers are
 * recorded", portal-data.ts sets it for every pre-send state including `answers_submitted`, and
 * the row asks the flag rather than listing the states that carry it.
 */
export function FrozenRow({ card, showBrand }: { card: PortalBlogCard; showBrand: boolean }) {
  const { isSingleBrand } = usePortal();
  const acted =
    card.state === "changes_requested"
      ? `you asked for changes ${formatRelative(card.date)}`
      : card.answered
        ? // "WITH our team", never "applying", and the weakening is the same correction the
          // detail page's with-the-team copy already carries. Nothing picks a portal submission
          // up on default configuration until an operator clicks Rerun, so a present-tense claim
          // that the answers are being applied can be false for as long as the client is looking
          // at the row. What is unconditionally true is where their answers are.
          `answers received ${formatRelative(card.date)}, they are with our editorial team`
        : null;
  return (
    <Link
      href={cardHref(card, isSingleBrand(card.org))}
      className="group flex items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 items-center gap-3">
        {card.answered ? (
          <CheckCircle2 className="size-4 shrink-0 text-ship" aria-hidden />
        ) : (
          <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{card.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <BlogStateTag state={card.state} audience="client" />
            {acted !== null ? <span>{acted}</span> : null}
            {/* The dot is conditional because a spent hold nobody answered has no sentence in
                front of it, and a line opening on a separator reads as a dropped word. */}
            {showBrand ? (
              <span>
                {acted !== null ? "· " : ""}
                {card.brand_name}
              </span>
            ) : null}
          </p>
        </div>
      </div>
      <ArrowRight
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}

export function ApprovedCard({ card, showBrand }: { card: PortalBlogCard; showBrand: boolean }) {
  const { isSingleBrand } = usePortal();
  return (
    <Link
      href={cardHref(card, isSingleBrand(card.org))}
      className="group flex h-full flex-col rounded-xl bg-card p-4 ring-1 ring-foreground/10 outline-none transition-shadow hover:shadow-md hover:shadow-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {showBrand ? (
        <div className="mb-2">
          <BrandChip name={card.brand_name} />
        </div>
      ) : null}
      <h3 className="font-serif text-base leading-snug text-pretty">{card.title}</h3>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-xs text-muted-foreground">
        {/* The tag distinguishes approved from published, which the old hardcoded "Approved"
            could not: both are locked and read-only, and only one of them is on the site. */}
        <BlogStateTag state={card.state} audience="client" />
        <span>{formatDate(card.date)}</span>
        {card.word_count !== null ? (
          <>
            <span aria-hidden>·</span>
            <span>{readingTime(card.word_count)}</span>
          </>
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1 font-medium text-foreground">
          Read
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </div>
    </Link>
  );
}

export function SectionHeading({
  children,
  count,
  tone = "default",
}: {
  children: React.ReactNode;
  count?: number;
  tone?: "default" | "review";
}) {
  return (
    <h2 className="flex items-baseline gap-2">
      <span
        className={cn(
          "text-sm font-semibold tracking-tight",
          tone === "review" ? "text-review" : "text-foreground",
        )}
      >
        {children}
      </span>
      {count !== undefined ? (
        <span className="text-xs text-muted-foreground">{count}</span>
      ) : null}
    </h2>
  );
}
