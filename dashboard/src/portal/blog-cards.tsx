"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, FileCheck2, Lock, MessageCircleQuestion } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatRelative, readingTime } from "@/portal/format";
import { blogHref } from "@/portal/nav";
import { usePortal } from "@/portal/portal-context";
import type { PortalBlogCard } from "@/portal/types";
import { cn } from "@/lib/utils";

/**
 * The four visual registers of the home page, one per state, deliberately unequal:
 *
 *   action    -- loud. Amber ground, a question count, a full-card link. The portal asks a
 *                client for answers rarely, so this card is allowed to shout.
 *   ready     -- inviting, on the brand's own accent. The happy ask: the article is
 *                finished, read it and approve it, or say what should change by leaving a
 *                note on the text itself.
 *   frozen    -- quiet rows with a lock. Nothing to do here; saying so calmly is the job.
 *   approved  -- a clean reading library. White cards, dates, reading time, a quiet
 *                approved mark. This replaced the old "delivered" register: delivery is no
 *                longer the end of the story, the client's approval is.
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
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-review">
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
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-primary">
            <FileCheck2 className="size-3.5 shrink-0" aria-hidden />
            Ready to post
            <span className="text-muted-foreground">· sent {formatRelative(card.date)}</span>
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

export function FrozenRow({ card, showBrand }: { card: PortalBlogCard; showBrand: boolean }) {
  const { isSingleBrand } = usePortal();
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
          <p className="text-xs text-muted-foreground">
            {card.answered
              ? `Answers received ${formatRelative(card.date)} · our team is applying your input`
              : "With our editorial team"}
            {showBrand ? ` · ${card.brand_name}` : ""}
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
      <div className="mt-auto flex items-center gap-2 pt-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 font-medium text-ship">
          <CheckCircle2 className="size-3.5" aria-hidden />
          Approved
        </span>
        <span aria-hidden>·</span>
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
