"use client";

import * as React from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BlogStateTag } from "@/components/shell/blog-state-tag";
import { StateTagChip } from "@/components/shell/state-tag-chip";
import { adminFailedTag, scoreClass } from "@/lib/blog-score";
import { blogLabels } from "@/lib/blog-label";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SortDir, SortKey } from "@/components/blogs/blogs-filter";
import type { WaitingSignal } from "@/components/blogs/questions-state";
import type { BlogState, StateTag } from "@/lib/blog-state";

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
  /**
   * The sheet's "What the Piece Covers" cell, rendered as a column on the New tab alone.
   *
   * It is on the row type rather than fetched here because New's rows ARE roadmap rows: a topic
   * nothing has written yet has a scope and an angle and nothing else, and that scope is most of
   * what an operator reads when deciding whether to tick it. Absent on a written blog, where the
   * article itself has long since replaced the brief.
   */
  covers?: string | null;
  /** Unaddressed client comments (open, applying, failed). Splits the changes_requested tag
   *  live in BOTH vocabularies; absent falls back to the plain state tag. */
  comments_pending?: number | null;
  score?: number | null;
  shipped?: boolean;
  uploaded?: boolean | null;
  iterations?: number | null;
  /** The evaluator's verdict for a draft that did not ship, or null/absent. Drives the "More
   *  info" control on a failed row; the client wire never carries it. */
  reason?: string | null;
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
  tagOf,
  audience = "admin",
  selection,
  columns = "full",
  rowAction,
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
  /**
   * Omitted where the table cannot be reordered. The New tab is the case: its rows ARE the sheet,
   * the sheet's order is the "#" column, and it used to pass a function that did nothing, so every
   * header wore a control that looked live, clicked, and changed not one row.
   */
  onSort?: (key: SortKey) => void;
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
   * THE STATUS CELL'S TAG, for rows whose state is NOT a BlogState.
   *
   * A CHANNEL POST IS THE CASE, and it is why this exists rather than a second table. Its
   * lifecycle is its own (lib/channel-state.ts: no score, no questions, no failure verdict), so
   * `stateOf` cannot describe it and BlogStateTag cannot render it. Everything else a row needs,
   * the number, the title link, the created stamp, the sort, the row rhythm, is identical, and the
   * client's LinkedIn and Medium tabs had a hand-built card list precisely because of this one
   * cell. Passing the finished tag keeps the vocabulary with the data that owns it.
   *
   * Absent is the ordinary case: the tag comes from `stateOf` exactly as it always did. Where this
   * IS passed, `stateOf`'s answer no longer reaches the screen, so a channel caller may return
   * anything from it.
   */
  tagOf?: (blog: T) => StateTag;
  /**
   * Which library this table is standing in. The client's never renders Score or Iterations,
   * because those never cross the portal wire, and its tags and chips speak the client
   * vocabulary.
   */
  audience?: "admin" | "client";
  /**
   * ROW SELECTION, and passing it is what turns the leading checkbox column on.
   *
   * Present only on the admin library. It replaces the trailing per-row delete button, which was
   * one act reachable one row at a time; the selection reaches four acts over any number of rows,
   * and delete is one of them. The client portal passes nothing, so its table has no checkboxes
   * and no controls at all, which is the same shape it had before.
   *
   * `disabled` BELOW IS NARROW, AND THE RULE IT NARROWS STILL STANDS. Eligibility is normally a
   * property of the ACT and not of the selection: the same blog can be downloadable and
   * unsendable at once, so a checkbox encoding "can this be acted on" would have to pick one act
   * to be about, which is why the bulk bar computes an eligible subset per action and says what
   * it will touch. The New tab is the exception because it has exactly ONE act. Generate, and the
   * engine answers 409 for a topic it already holds, so there ticking is not choosing between
   * acts, it is asking for the only one and being refused.
   */
  selection?: {
    selected: ReadonlySet<string>;
    onToggle: (topicSlug: string) => void;
    /** Ticks every rendered row, or clears them when they are all already ticked. */
    onToggleAll: (topicSlugs: readonly string[]) => void;
    /**
     * SHIFT-CLICK: tick every row between the last one clicked and this one, inclusive.
     *
     * The anchor and the range live in this component and not in the caller, because the range is
     * defined by the ORDER ON SCREEN and this is what holds it: the caller has a Set, which has no
     * order, and would have to re-derive the sort to answer "between". Absent means shift does
     * nothing, which is what a table without it did.
     */
    onSelectRange?: (topicSlugs: readonly string[]) => void;
    /**
     * Rows a tick may NOT reach, so the checkbox renders disabled rather than merely ignoring
     * the click. The New tab passes it for a topic the engine already holds: a run owns it, a
     * second request earns a 409, and a checkbox that ticks and then quietly does nothing is
     * worse than one that plainly cannot be ticked. Absent means every row is selectable.
     */
    disabled?: (topicSlug: string) => boolean;
  };
  /**
   * WHICH COLUMNS. "full" is the written-blog set. "brief" is the New tab, whose rows are roadmap
   * rows: it drops Created, Score and Iterations, which a topic nothing has written cannot have,
   * and adds the sheet's own scope column in their place.
   *
   * A MODE RATHER THAN A SECOND TABLE. New used to be RoadmapTable, a separate component that had
   * drifted into its own header, its own row rhythm and its own status vocabulary, and merging the
   * two tabs onto one page would have put the two side by side under one strip of tabs. Every
   * feature that lived only there (this scope column, the range select above, the upload below)
   * moved here rather than being lost or duplicated.
   */
  columns?: "full" | "brief";
  /**
   * A trailing control per row, rendered in a column of its own. The New tab passes the per-row
   * upload: an operator standing over a list of topics deciding what to do with each one is
   * exactly who wants "upload the article I already have", and unlike Generate, which acts on the
   * whole ticked set, an upload is inherently one file for one topic.
   */
  rowAction?: (blog: T) => React.ReactNode;
}) {
  const admin = audience === "admin" && columns === "full";
  const brief = columns === "brief";
  const shownSlugs = blogs.map((blog) => blog.topic_slug);
  /**
   * The rows select-all can actually reach, which is what its own checked state must be read
   * from. Counting locked rows would leave the header box permanently unchecked on a tab holding
   * one topic the engine already owns, and "select all" would then look broken every time it had
   * in fact selected everything it is allowed to.
   */
  const reachableSlugs =
    selection?.disabled === undefined
      ? shownSlugs
      : shownSlugs.filter((slug) => selection.disabled?.(slug) !== true);
  const allSelected =
    selection !== undefined && reachableSlugs.length > 0 &&
    reachableSlugs.every((slug) => selection.selected.has(slug));
  const someSelected =
    selection !== undefined && !allSelected &&
    reachableSlugs.some((slug) => selection.selected.has(slug));

  /**
   * The last row whose checkbox was clicked, and the shift flag from the click that is happening
   * right now.
   *
   * The flag is read off the checkbox's own onClick rather than tracked globally, because Radix
   * runs onClick BEFORE its onCheckedChange, so by the time the toggle fires it describes exactly
   * the click that fired it. A keyboard space press arrives with shiftKey false, which is the
   * correct answer for it: there is no anchor a keyboard user has expressed.
   */
  const anchor = React.useRef<string | null>(null);
  const extending = React.useRef(false);
  function clickRow(topicSlug: string) {
    if (!selection) {
      return;
    }
    const from = anchor.current;
    const range = selection.onSelectRange;
    // A shift-click with no prior click has no range to describe, so it is an ordinary toggle.
    if (extending.current && range && from !== null && from !== topicSlug) {
      const a = shownSlugs.indexOf(from);
      const b = shownSlugs.indexOf(topicSlug);
      if (a !== -1 && b !== -1) {
        range(shownSlugs.slice(Math.min(a, b), Math.max(a, b) + 1));
        // The anchor MOVES to the row just clicked, so a second shift-click extends from here
        // rather than replaying the original span. That is what every file list does.
        anchor.current = topicSlug;
        return;
      }
    }
    anchor.current = topicSlug;
    selection.onToggle(topicSlug);
  }
  // The source-grouped identifier for every row, computed over the WHOLE list so the running
  // counts are right: AI blogs number, uploaded blogs letter. Cheap enough to recompute per render
  // (a sort over the current page's blogs), so no memo.
  const labels = blogLabels(blogs);
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {/* Select-all over the RENDERED rows, never over the brand: the filters above this table
              are how an operator narrows a bulk act down, so ticking this must mean "everything I
              can currently see" or the narrowing was for nothing. */}
          {selection ? (
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected ? true : someSelected ? "indeterminate" : false}
                disabled={shownSlugs.length === 0}
                onCheckedChange={() => selection.onToggleAll(shownSlugs)}
                aria-label="Select all blogs"
              />
            </TableHead>
          ) : null}
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
          {/* The sheet's scope, on the New tab alone, where it is most of what an operator reads
              before ticking a row. No width class: it is the last prose column and takes the
              remainder. */}
          {brief ? (
            <TableHead className="machine align-middle text-xs font-medium text-muted-foreground">
              What it covers
            </TableHead>
          ) : (
            <SortableHead
              label="Created"
              column="created"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
              className="w-32"
            />
          )}
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
          {/* Unlabelled and named for a screen reader: a column of one icon button needs no
              title, and a word over twenty five rows earns nothing. */}
          {rowAction ? (
            <TableHead className="w-12">
              <span className="sr-only">Row actions</span>
            </TableHead>
          ) : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {blogs.map((blog) => (
          <Row
            key={blog.topic_slug}
            blog={blog}
            label={labels.get(blog.topic_slug) ?? null}
            state={stateOf(blog)}
            tag={tagOf ? tagOf(blog) : null}
            audience={audience}
            waiting={waiting.get(blog.topic_slug) ?? null}
            active={blog.topic_slug === activeSlug}
            href={hrefFor(blog)}
            onOpen={onOpen}
            selected={selection ? selection.selected.has(blog.topic_slug) : null}
            selectDisabled={selection?.disabled?.(blog.topic_slug) === true}
            onSelect={selection ? () => clickRow(blog.topic_slug) : undefined}
            onSelectMouseDown={
              selection
                ? (event) => {
                    extending.current = event.shiftKey;
                  }
                : undefined
            }
            columns={columns}
            action={rowAction ? rowAction(blog) : undefined}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function Row<T extends BlogTableRow>({
  blog,
  label,
  state,
  tag,
  audience,
  waiting,
  active,
  href,
  onOpen,
  selected,
  onSelect,
  selectDisabled = false,
  onSelectMouseDown,
  columns,
  action,
}: {
  blog: T;
  /** This blog's source-grouped identifier (number for AI, letter for uploaded), from the parent's
   *  one blogLabels pass over the full list. Null only if the blog somehow is not in that list. */
  label: string | null;
  /**
   * ONE read of where this blog is, for the whole row, resolved by the parent's stateOf. The
   * admin derives it from the summary's wire fields (blogState) so this row and the stage page
   * reach their answer through the same function; the portal's cards carry it resolved. That
   * divergence is what put a green score on one screen and a plain one on the other.
   */
  state: BlogState;
  /** A ready-made status tag from the caller, superseding `state`. Null is the ordinary case. */
  tag: StateTag | null;
  audience: "admin" | "client";
  waiting: WaitingSignal | null;
  active: boolean;
  href: string;
  onOpen: (blog: T) => void;
  /** Ticked, unticked, or null where this table has no selection at all (the client portal). */
  selected: boolean | null;
  onSelect?: () => void;
  /** The row is shown but locked: the checkbox renders disabled. See selection.disabled. */
  selectDisabled?: boolean;
  /** Records the shift key before Radix's change handler reads it. See the anchor in the parent. */
  onSelectMouseDown?: (event: React.MouseEvent) => void;
  columns: "full" | "brief";
  /**
   * The trailing control, already rendered by the parent's rowAction. UNDEFINED means this table
   * has no action column; null means it has one and this row has nothing in it. Collapsing the
   * two would drop a cell from any row whose action is conditional and shift its columns left
   * under the header.
   */
  action?: React.ReactNode;
}) {
  const brief = columns === "brief";
  const admin = audience === "admin" && !brief;
  return (
    <TableRow
      // The row is a click target for the mouse, but the LINK in the title cell is the
      // control: a screen reader gets a real named link, the pointer gets the whole row.
      onClick={() => onOpen(blog)}
      data-active={active || undefined}
      // NO STANDING HIGHLIGHT. `active` marks the row holding the table's single tab stop, and
      // activeSlug FALLS BACK TO THE FIRST VISIBLE ROW, so it is set the moment the list renders,
      // whether or not anyone has touched the keyboard. Painting it meant row one arrived tinted
      // and left-ruled on every load, reading as "selected" or "in progress" to a mouse user who
      // had selected nothing.
      //
      // Nothing is lost for the keyboard, which is the only reason this styling existed: `move`
      // focuses the row's link, and that link carries its own focus-visible ring, so a keyboard
      // user still sees exactly where they are and sees it ONLY while actually there. The roving
      // tabindex below is untouched, so j and k still work.
      className="cursor-pointer"
    >
      {/* The checkbox cell stops the row's own click, so ticking a row never also navigates to it.
          Every other cell is a click target for opening the blog, which is the behaviour a list of
          rows should have; this one cell is the exception because it is a control. */}
      {selected !== null ? (
        <TableCell className="py-2.5" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={selected}
            disabled={selectDisabled}
            onClick={onSelectMouseDown}
            onCheckedChange={() => onSelect?.()}
            aria-label={`Select ${blog.topic}`}
          />
        </TableCell>
      ) : null}
      {/* No align-top here. TableCell already centres, and this was one of two cells that opted
          out, so on a title that wrapped to two lines the row number sat at the top while every
          other column sat in the middle. The title cell sets the row height; nothing else should
          track its first line. */}
      <TableCell className="py-2.5">
        <BlogLabel label={label} uploaded={!!blog.uploaded} />
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
          // FLEX COLUMN, CENTRED, not `block`. min-h-8 keeps the link a 32px target, but under
          // `block` the text rendered at the TOP of that box and the spare height fell below it,
          // so the title sat ~6px above the row number, the date and the status pill, which all
          // centre through the table's own align-middle. items-start keeps the waiting chip at
          // its own width instead of stretching to the column.
          className="flex min-h-8 w-full flex-col justify-center items-start rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {/* TITLE ONLY. The slug used to print under every title and it cost two lines a row for
              a value that is the title lowercased with hyphens, so it read as the same sentence
              twice and made a list of ten blogs a page of thirty lines. It is still the row's
              identity everywhere it does work: TRIGGER_ATTR above carries it for the keyboard,
              href routes on it, and the filter still matches it, so searching by slug finds the
              row that no longer displays one. The stage page shows it in full. */}
          <span className="block text-sm font-medium text-pretty text-foreground">
            {blog.topic}
          </span>
          {/* Inside the link, so the chip is part of what a screen reader reads out when it
              lands on the row rather than a colour a sighted operator alone gets to see. */}
          {waiting !== null ? <WaitingChip signal={waiting} audience={audience} /> : null}
          <span className="sr-only">Open blog</span>
        </Link>
      </TableCell>
      {/* No clamp and no expander on the scope: it is a sentence or two, it wraps, and the row is
          as tall as its tallest cell needs. */}
      {brief ? (
        <TableCell className="py-2.5 text-sm leading-relaxed whitespace-normal text-pretty text-muted-foreground">
          {blog.covers || <span className="text-xs">Not given</span>}
        </TableCell>
      ) : (
        <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="machine cursor-default">{formatRelative(blog.created)}</span>
            </TooltipTrigger>
            {/* Relative time is what the operator thinks in; the exact stamp is one hover away. */}
            <TooltipContent className="machine">{formatAbsolute(blog.created)}</TooltipContent>
          </Tooltip>
        </TableCell>
      )}
      {admin ? (
        <TableCell>
          <Score score={blog.score ?? null} uploaded={blog.uploaded === true} />
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
        {tag !== null ? (
          <StateTagChip tag={tag} />
        ) : (
          <BlogStateTag
            state={state}
            audience={audience}
            commentsPending={blog.comments_pending}
            failedTag={adminFailedTag(blog.score ?? null)}
          />
        )}
      </TableCell>
      {admin ? (
        <TableCell className="machine text-xs text-muted-foreground">
          {typeof blog.iterations === "number" ? blog.iterations : ""}
        </TableCell>
      ) : null}
      {/* stopPropagation for the same reason the checkbox cell does it: this cell holds a control,
          and pressing it must not also navigate to the blog. */}
      {action !== undefined ? (
        <TableCell className="py-2.5" onClick={(event) => event.stopPropagation()}>
          {action}
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
 * The blog's identifier, which is the name the work actually goes by: "we are done with six, send
 * seven". Titles run to a dozen words and half open with the same three, so the label is what a
 * person holds in their head and quotes back.
 *
 * GROUPED BY SOURCE: an AI-generated blog is a NUMBER, a hand-uploaded one is a LETTER, each a
 * running count in creation order (see blogLabels). So the letter alone says "a person wrote this",
 * which is the whole point. The label comes pre-computed from the parent's one pass over the full
 * list; a null (a blog somehow absent from that list) shows a dash rather than inventing a count.
 */
function BlogLabel({ label, uploaded }: { label: string | null; uploaded: boolean }) {
  if (label === null) {
    return (
      <span
        title="This blog is not in the current listing, so it has no position yet."
        className="machine cursor-default text-xs text-muted-foreground/50"
      >
        -
      </span>
    );
  }
  return (
    <span
      title={uploaded ? "Uploaded by hand: letters mark manual blogs" : "Written by the engine"}
      className="machine cursor-default text-sm text-muted-foreground"
    >
      {label}
    </span>
  );
}

/** No eval, no number. Not a zero, and not a dash dressed up as one. */
function Score({
  score,
  uploaded,
}: {
  score: number | null;
  /** Uploaded blogs have no score BY DESIGN, so this column says why rather than "no score". */
  uploaded: boolean;
}) {
  if (uploaded) {
    return <span className="text-xs text-muted-foreground">uploaded</span>;
  }
  if (typeof score !== "number") {
    return <span className="text-xs text-muted-foreground">no score</span>;
  }
  // Coloured by band, not by ledger membership: at or above 90 green because the run shipped,
  // BELOW_BAR_FLOOR to SHIP_BAR-1 amber for the near miss the operator decides on, below it red. This used to paint
  // green only when the ledger held the topic, which disagreed with the stage page's own
  // score>=95 rule; scoreClass is now the one source both read.
  return <span className={cn("machine text-sm font-medium", scoreClass(score))}>{score}</span>;
}

/**
 * One sortable column header: label, live direction arrow, aria-sort. Generic over the sort
 * key so the channel Created tabs sort their own columns through the exact control this
 * table sorts by, arrows and semantics included, instead of a lookalike that drifts.
 */
export function SortableHead<K extends string>({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string;
  column: K;
  sortKey: K;
  sortDir: SortDir;
  /**
   * Omitted where the table has ONE order and cannot be reordered, which is the New tab: its rows
   * are the sheet, the sheet's order is the "#" column, and there is nothing to sort them into.
   * It used to be passed a function that did nothing, so every header wore a control that looked
   * live, clicked, and changed not one row.
   */
  onSort?: (key: K) => void;
  className?: string;
}) {
  // A plain label, not a disabled button: there is no sort to offer, so nothing should suggest
  // one is being withheld.
  if (onSort === undefined) {
    return (
      <TableHead
        className={cn("machine text-xs font-medium text-muted-foreground", className)}
      >
        {label}
      </TableHead>
    );
  }
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
