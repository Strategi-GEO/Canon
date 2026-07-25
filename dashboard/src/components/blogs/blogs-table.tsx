"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown, MessageCircleQuestion } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { DeleteBlogDialog } from "@/components/blogs/delete-blog-dialog";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SortDir, SortKey } from "@/components/blogs/blogs-filter";
import type { WaitingSignal } from "@/components/blogs/questions-state";
import type { BlogState } from "@/lib/blog-state";

/**
 * The attribute the library's keyboard moves real focus through: j and k find the active
 * row's link by slug rather than by element reference, because a refresh replaces every
 * node and a slug survives it.
 */
export const TRIGGER_ATTR = "data-preview-trigger";

/**
 * What a row must carry to render here. The admin's BlogSummary satisfies it whole; the
 * client portal maps its PortalBlogCard onto it (title -> topic). Score, shipped, uploaded
 * and iterations are optional because the CLIENT WIRE NEVER CARRIES THEM by design
 * (portal/types.ts), and the client columns never render them either: the same table serves
 * both audiences precisely so the two libraries cannot drift apart visually.
 */
export type BlogTableRow = {
  topic: string;
  topic_slug: string;
  created: string;
  roadmap_index: number | null;
  /** Unaddressed client comments (open, applying, failed). Splits the changes_requested tag
   *  live in BOTH vocabularies; absent falls back to the plain state tag. */
  comments_pending?: number | null;
  score?: number | null;
  shipped?: boolean;
  uploaded?: boolean | null;
  iterations?: number | null;
};

export function BlogsTable<T extends BlogTableRow>({
  blogs,
  waiting,
  sortKey,
  sortDir,
  activeSlug,
  onSort,
  hrefFor,
  onOpen,
  stateOf,
  audience = "admin",
  brandSlug,
  onDeleted,
}: {
  blogs: T[];
  /**
   * The blogs whose evaluator asked the operator something, keyed by topic slug. A row missing
   * from this map has nothing outstanding, either because no question was ever asked or because
   * there is nothing the operator can do about the one that was.
   */
  waiting: ReadonlyMap<string, WaitingSignal>;
  sortKey: SortKey;
  sortDir: SortDir;
  /** The row the keyboard is on. Highlighted, and the only row in the tab order. */
  activeSlug: string | null;
  onSort: (key: SortKey) => void;
  /** The blog's own page. The title is a real link, so cmd-click and middle-click work. */
  hrefFor: (blog: T) => string;
  /** The whole-row click, which the parent routes to the same page. */
  onOpen: (blog: T) => void;
  /**
   * ONE read of where each blog is, provided by the parent: the admin derives it from the
   * summary's state facts (blogState), the portal's cards already carry it resolved. Passing
   * the function keeps the derivation beside the data that feeds it.
   */
  stateOf: (blog: T) => BlogState;
  /**
   * Which library this table is standing in. The client's never renders Score or Iterations,
   * because those never cross the portal wire, and its tags and chips speak the client
   * vocabulary.
   */
  audience?: "admin" | "client";
  /**
   * The brand these blogs belong to, and a callback to refetch after one is deleted. Present
   * only on the admin library: passing both turns on the trailing delete column. The client
   * portal never passes them, so its table has no delete control at all.
   */
  brandSlug?: string;
  onDeleted?: () => void;
}) {
  const admin = audience === "admin";
  const canDelete = admin && brandSlug !== undefined && onDeleted !== undefined;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {/* First, and sortable, because sheet order is the order the work is discussed in.
              Narrow: it holds two digits and the roadmap tops out well short of a third. */}
          <SortableHead
            label="#"
            column="roadmap"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            className="w-12"
          />
          <SortableHead
            label="Title"
            column="topic"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
          />
          <SortableHead
            label="Created"
            column="created"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            className="w-32"
          />
          {admin ? (
            <SortableHead
              label="Score"
              column="score"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              className="w-20"
            />
          ) : null}
          <SortableHead
            label="Status"
            column="status"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            className="w-32"
          />
          {admin ? (
            <TableHead className="machine w-20 text-xs font-medium">Iterations</TableHead>
          ) : null}
          {/* Actions column, header intentionally blank: an icon column needs no label, and a
              screen reader gets the per-button sr-only text instead. */}
          {canDelete ? <TableHead className="w-12" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {blogs.map((blog) => (
          <Row
            key={blog.topic_slug}
            blog={blog}
            state={stateOf(blog)}
            audience={audience}
            waiting={waiting.get(blog.topic_slug) ?? null}
            active={blog.topic_slug === activeSlug}
            href={hrefFor(blog)}
            onOpen={onOpen}
            brandSlug={canDelete ? brandSlug : undefined}
            onDeleted={canDelete ? onDeleted : undefined}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function Row<T extends BlogTableRow>({
  blog,
  state,
  audience,
  waiting,
  active,
  href,
  onOpen,
  brandSlug,
  onDeleted,
}: {
  blog: T;
  /**
   * ONE read of where this blog is, for the whole row, resolved by the parent's stateOf. The
   * admin derives it from the summary's wire fields (blogState) so this row and the stage page
   * reach their answer through the same function; the portal's cards carry it resolved. That
   * divergence is what put a green score on one screen and a plain one on the other.
   */
  state: BlogState;
  audience: "admin" | "client";
  waiting: WaitingSignal | null;
  active: boolean;
  href: string;
  onOpen: (blog: T) => void;
  /** Present only when this table's parent enabled deletion (admin library). */
  brandSlug?: string;
  onDeleted?: () => void;
}) {
  const admin = audience === "admin";
  return (
    <TableRow
      // The row is a click target for the mouse, but the LINK in the title cell is the
      // control: a screen reader gets a real named link, the pointer gets the whole row.
      onClick={() => onOpen(blog)}
      data-active={active || undefined}
      className={cn(
        "cursor-pointer",
        // "You are here" for the keyboard. A left rule rather than a fill, because the fill is
        // already spoken for by hover and the two would fight.
        active && "bg-muted/60 shadow-[inset_2px_0_0_0_var(--primary)]",
      )}
    >
      <TableCell className="py-2.5 align-top">
        <RoadmapNumber index={blog.roadmap_index} />
      </TableCell>
      {/* TableCell is nowrap by default, which suits machine values but truncates a real H1.
          The title column wraps instead. */}
      <TableCell className="max-w-sm py-2.5 whitespace-normal">
        <Link
          href={href}
          {...{ [TRIGGER_ATTR]: blog.topic_slug }}
          // Roving tabindex: one stop for the whole table, so Tab crosses the library rather
          // than walking every row in it.
          tabIndex={active ? 0 : -1}
          onClick={(event) => {
            // The row handler would otherwise fire too and navigate a second time.
            event.stopPropagation();
          }}
          className="block min-h-8 w-full rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="block text-sm font-medium text-pretty text-foreground">
            {blog.topic}
          </span>
          <span className="machine mt-0.5 block text-xs wrap-anywhere text-muted-foreground">
            {blog.topic_slug}
          </span>
          {/* Inside the link, so the chip is part of what a screen reader reads out when it
              lands on the row rather than a colour a sighted operator alone gets to see. */}
          {waiting !== null ? <WaitingChip signal={waiting} audience={audience} /> : null}
          <span className="sr-only">Open blog</span>
        </Link>
      </TableCell>
      <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="machine cursor-default">{formatRelative(blog.created)}</span>
          </TooltipTrigger>
          {/* Relative time is what the operator thinks in; the exact stamp is one hover away. */}
          <TooltipContent className="machine">{formatAbsolute(blog.created)}</TooltipContent>
        </Tooltip>
      </TableCell>
      {admin ? (
        <TableCell>
          <Score
            score={blog.score ?? null}
            shipped={blog.shipped === true}
            uploaded={blog.uploaded === true}
          />
        </TableCell>
      ) : null}
      {/* ONE TAG, where three elements used to sit: the run status, a delivery chip
          re-deriving sent / approved / changes from the same fields, and a published chip.
          All three answered one question, "where is this article", in three vocabularies that
          nothing kept in agreement. blogState answers it once and the tag speaks it once.

          THE DELIVERY CHIP IS GONE OUTRIGHT. "With client", "Changes requested" and "Approved"
          are states of the tag now, so a chip repeating them is a second thing to keep honest
          for no second fact.

          THE PUBLISHED CHIP WENT TOO, and it was the closer call, because it did carry one
          fact the tag does not: the CMS's own word, live where an editor has taken the post
          out against posted where the push landed on a draft. It goes for two reasons. That
          word is null on the hosted build, so the chip degrades to "posted" on every row
          there and adds nothing at all; and it changes no act this list leads to, since
          adminActions("published") is publish either way. The stage page keeps its own fuller
          published chip, which is where an operator stands when the draft-or-live difference
          is actually the thing they came to check.

          The old fallback that printed an unmodelled status as itself is gone with the badge.
          blogState folds anything it does not recognise to `unknown`, which is the same
          refusal to guess the fallback existed for: what it must never do is alias onto
          `running` and report a finished blog as in flight, and it does not. */}
      <TableCell>
        <BlogStateTag
          state={state}
          audience={audience}
          commentsPending={blog.comments_pending}
        />
      </TableCell>
      {admin ? (
        <TableCell className="machine text-xs text-muted-foreground">
          {typeof blog.iterations === "number" ? blog.iterations : ""}
        </TableCell>
      ) : null}
      {brandSlug !== undefined && onDeleted !== undefined ? (
        <TableCell className="py-2.5 text-right align-top">
          <DeleteBlogDialog
            brandSlug={brandSlug}
            topicSlug={blog.topic_slug}
            title={blog.topic}
            onDeleted={onDeleted}
          />
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/**
 * This blog is waiting on the operator, said in the row rather than only once they open it.
 *
 * AMBER, because a question is a question: the evaluator reached the end of what research can
 * settle and asked the one source that can. That is not a failure, so this never borrows the fail
 * token.
 *
 * ONE CHIP AND ONE OBLIGATION, AT EVERY SCORE. This had two forms, a solid "2 questions to answer"
 * on a blog below 95 and an outline "shipped, 2 open questions" on one above it, and the second
 * form taught an operator that some of these chips were theirs to scroll past. They scrolled past
 * them, and two canonical-facts violations shipped at 96 that way. A row with this chip is a row
 * held for an answer, and the Status column beside it reads "waiting on you" for the same reason.
 */
function WaitingChip({
  signal,
  audience,
}: {
  signal: WaitingSignal;
  audience: "admin" | "client";
}) {
  const noun = signal.count === 1 ? "question" : "questions";
  if (signal.kind === "client_answered") {
    // The portal loop closing: the client answered, no engine ran at their submit, and
    // this row now waits on the operator's Rerun. Green, not amber: the asking is done.
    // Admin-only by construction: the client's own map never carries this kind, because
    // "rerun" is the operator's act and this sentence would summon them to it.
    return (
      <span
        title="The client answered these questions from their portal. No revise has run yet: open the blog and click Rerun to apply their answers."
        className="mt-1.5 inline-flex h-5 shrink-0 items-center gap-1 rounded border border-ship/25 bg-ship-bg px-1.5 text-[0.6875rem] leading-none font-medium text-ship"
      >
        <MessageCircleQuestion className="size-3 shrink-0" aria-hidden />
        <span className="machine">{signal.count}</span> answered by client, rerun
      </span>
    );
  }
  return (
    <span
      // The client title carries no evaluator and no score: that vocabulary never crosses
      // the portal wire, and the sweep in tests/blog-state.test.ts holds every client
      // sentence to it.
      title={
        audience === "admin"
          ? "The evaluator asked something research cannot settle, so this blog is held until you answer, whatever it scored. Open it to read the questions."
          : "Our editorial review needs an answer only you can give. Open the article to answer."
      }
      className="mt-1.5 inline-flex h-5 shrink-0 items-center gap-1 rounded border border-review/25 bg-review-bg px-1.5 text-[0.6875rem] leading-none font-medium text-review"
    >
      <MessageCircleQuestion className="size-3 shrink-0" aria-hidden />
      <span className="machine">{signal.count}</span> {noun} to answer
    </span>
  );
}

/**
 * The blog's row on the roadmap, which is the name the work actually goes by: "we are done with
 * six, send seven". Titles here run to a dozen words and half of them open with the same three,
 * so the number is what a person holds in their head and what a client quotes back.
 *
 * DISPLAYED index + 1, matching the preview's own "#" column, so a number read here finds the
 * same row there.
 *
 * A blog on no row gets a dash, never a number: the sheet was deleted or re-uploaded without
 * this topic, and inventing a position for it would be worse than admitting it has none. A wrong
 * number is not a missing number, it is blog six pointing at row nine, and the operator would act
 * on it.
 */
function RoadmapNumber({ index }: { index: number | null }) {
  if (index === null) {
    return (
      <span
        title="This blog is not on the current roadmap. Its row was deleted, or the sheet was replaced since it was written."
        className="machine cursor-default text-xs text-muted-foreground/50"
      >
        -
      </span>
    );
  }
  return <span className="machine text-sm text-muted-foreground">{index + 1}</span>;
}

/** No eval, no number. Not a zero, and not a dash dressed up as one. */
function Score({
  score,
  shipped,
  uploaded,
}: {
  score: number | null;
  shipped: boolean;
  /** Uploaded blogs have no score BY DESIGN, so this column says why rather than "no score". */
  uploaded: boolean;
}) {
  if (uploaded) {
    return <span className="text-xs text-muted-foreground">uploaded</span>;
  }
  if (typeof score !== "number") {
    return <span className="text-xs text-muted-foreground">no score</span>;
  }
  return (
    <span
      className={cn("machine text-sm", shipped ? "font-medium text-ship" : "text-foreground")}
    >
      {score}
    </span>
  );
}

function SortableHead({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sortKey === column;
  const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "machine -ml-1 inline-flex h-8 items-center gap-1 rounded px-1 text-xs font-medium",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        <Icon className="size-3" aria-hidden />
      </button>
    </TableHead>
  );
}
