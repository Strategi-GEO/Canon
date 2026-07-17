"use client";

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
import { StatusBadge } from "@/components/shell/status-badge";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isKnownStatus, type SortDir, type SortKey } from "@/components/blogs/blogs-filter";
import type { WaitingSignal } from "@/components/blogs/questions-state";
import type { BlogSummary } from "@/types";

/**
 * The attribute the library focuses through after the drawer closes. The trigger cannot be
 * held as an element reference: a deep link opens the drawer with no trigger ever clicked,
 * and a refresh replaces every node. A slug survives both, so the row is found by name.
 */
export const TRIGGER_ATTR = "data-preview-trigger";

export function BlogsTable({
  blogs,
  waiting,
  sortKey,
  sortDir,
  activeSlug,
  onSort,
  onPreview,
}: {
  blogs: BlogSummary[];
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
  onPreview: (blog: BlogSummary) => void;
}) {
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
          <SortableHead
            label="Score"
            column="score"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            className="w-20"
          />
          <SortableHead
            label="Status"
            column="status"
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={onSort}
            className="w-32"
          />
          <TableHead className="machine w-20 text-xs font-medium">Iterations</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {blogs.map((blog) => (
          <Row
            key={blog.topic_slug}
            blog={blog}
            waiting={waiting.get(blog.topic_slug) ?? null}
            active={blog.topic_slug === activeSlug}
            onPreview={onPreview}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function Row({
  blog,
  waiting,
  active,
  onPreview,
}: {
  blog: BlogSummary;
  waiting: WaitingSignal | null;
  active: boolean;
  onPreview: (blog: BlogSummary) => void;
}) {
  return (
    <TableRow
      // The row is a click target for the mouse, but the BUTTON in the title cell is the
      // control: a screen reader gets a real named button, the pointer gets the whole row.
      onClick={() => onPreview(blog)}
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
        <button
          type="button"
          {...{ [TRIGGER_ATTR]: blog.topic_slug }}
          // Roving tabindex: one stop for the whole table, so Tab crosses the library rather
          // than walking every row in it.
          tabIndex={active ? 0 : -1}
          onClick={(event) => {
            // The row handler would otherwise fire too and push the same history entry twice.
            event.stopPropagation();
            onPreview(blog);
          }}
          className="block min-h-8 w-full rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <span className="block text-sm font-medium text-pretty text-foreground">
            {blog.topic}
          </span>
          <span className="machine mt-0.5 block text-xs wrap-anywhere text-muted-foreground">
            {blog.topic_slug}
          </span>
          {/* Inside the button, so the chip is part of what a screen reader reads out when it
              lands on the row rather than a colour a sighted operator alone gets to see. */}
          {waiting !== null ? <WaitingChip signal={waiting} /> : null}
          <span className="sr-only">Open preview</span>
        </button>
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
      <TableCell>
        <Score score={blog.score} shipped={blog.shipped} />
      </TableCell>
      <TableCell>
        <Status status={blog.status} />
      </TableCell>
      <TableCell className="machine text-xs text-muted-foreground">
        {typeof blog.iterations === "number" ? blog.iterations : ""}
      </TableCell>
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
function WaitingChip({ signal }: { signal: WaitingSignal }) {
  const noun = signal.count === 1 ? "question" : "questions";
  return (
    <span
      title="The evaluator asked something research cannot settle, so this blog is held until you answer, whatever it scored. Open it to read the questions."
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
function Score({ score, shipped }: { score: number | null; shipped: boolean }) {
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

/**
 * The engine really does send status "unknown" for a topic with a blog.md and no status.jsonl,
 * and StatusBadge maps an unmodelled value onto "running", which would tell an operator that a
 * finished blog is still in flight. Anything outside the modelled set is labelled as itself.
 */
function Status({ status }: { status: string }) {
  if (isKnownStatus(status)) {
    return <StatusBadge status={status} />;
  }
  return (
    <span className="machine inline-flex h-5 shrink-0 items-center rounded border border-border bg-muted px-1.5 text-[0.6875rem] leading-none text-muted-foreground">
      {status}
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
