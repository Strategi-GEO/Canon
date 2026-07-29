"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  isSelectable,
  resolveRowState,
  type RowFacts,
  type RowState,
} from "@/components/create/row-status";
// The colours and the state labels are shared between the two modes rather than owned here,
// so no two renderings of one row can come to describe it differently.
import { ROW_STYLES, RowNote, StateChip } from "@/components/create/row-presentation";
import { UploadBlog } from "@/components/blogs/upload-blog";
import type { RoadmapRow } from "@/types";

/**
 * The Create Blogs table: tick topics, generate blogs. One table because there is one roadmap
 * and it has one shape; the column widths below were measured against real content.
 *
 * Reviewing and REWRITING roadmap rows is deliberately not a second mode here: it lives in
 * the roadmap preview dialog, over the raw sheet, because judging a row means reading every
 * column the operator wrote and this table carries only the brief. Two earlier attempts at a
 * second mode (a per-row-delete "read" mode, then a rewrite "review" mode) both ended as the
 * roadmap displayed twice on two tabs, which is the exact drift this comment exists to stop.
 */
export function RoadmapTable(props: {
  rows: RoadmapRow[];
  /** What is live, what failed, and what the engine just refused. See row-status.ts. */
  facts: RowFacts;
  selected: Set<number>;
  /** Rows the engine called incomplete on the last submit, keyed by row index. */
  incomplete: Map<number, string[]>;
  /** `extend` is a shift-click: select every selectable row between the anchor and this one. */
  onToggle: (index: number, extend: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  /**
   * Per-row upload, the other way a topic gets a blog.
   *
   * It belongs on THIS page specifically, because this is where an operator stands looking
   * at topics deciding what to do with each one, and "upload the article I already have" is
   * an answer to that same question. Generate is one button over the whole checked set;
   * upload is inherently per row, since it carries one file for one topic.
   */
  upload: {
    brandSlug: string;
    /** Fires after an article lands, so the caller refetches rows and blogs. */
    onUploaded: () => void;
  };
  // HTMLElement, not HTMLTableRowElement: only scrollIntoView reads this map, which every
  // element has. A 409 or 422 scrolls to the refused row.
  rowRefs: React.RefObject<Map<number, HTMLElement>>;
}) {
  const { rows, facts, rowRefs, selected, upload } = props;

  // Ineligible rows are excluded from select all, and their checkbox is genuinely disabled
  // rather than merely unchecked.
  const eligible = React.useCallback(
    (row: RoadmapRow) => isSelectable(resolveRowState(row, facts)),
    [facts],
  );
  const selectable = rows.filter(eligible);
  const selectedCount = selectable.filter((r) => selected.has(r.index)).length;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const someSelected = selectedCount > 0;

  // Shift state is read off the click that caused the change rather than tracked globally:
  // Radix runs this onClick before its own handler calls onCheckedChange, so by the time the
  // toggle fires the flag describes exactly the click that fired it. A keyboard space press
  // arrives here as a click with shiftKey false, which is the correct answer for it.
  //
  // The ref stays private to this component and the rows get handlers instead. A ref handed
  // down as a prop and written to by the child is the child mutating its own props, which the
  // compiler rejects, and rightly: ownership of the value would be split across two files.
  const extending = React.useRef(false);
  const noteShift = React.useCallback((event: React.MouseEvent) => {
    extending.current = event.shiftKey;
  }, []);
  const onToggle = props.onToggle;
  const toggleRow = React.useCallback(
    (index: number) => onToggle(index, extending.current),
    [onToggle],
  );

  return (
    // ONE provider around the whole table, not one per row, and it lives here because this is
    // the component whose rows carry tooltips: Radix throws without an ancestor provider, and
    // Create Blogs had none because nothing on it used a tooltip until the upload action.
    //
    // Wrapping HERE rather than in each row is deliberate. A provider is not just a
    // requirement to satisfy, it is what makes a GROUP of tooltips behave: once one has
    // opened, moving to the next row's button opens it immediately instead of waiting out the
    // delay again. Twenty five isolated providers would satisfy Radix and lose that, because
    // they share no such state. The blogs library and the blog stage page mount theirs at the
    // same level over their own subtrees.
    <TooltipProvider>
      {/*
        The scroll container lives here rather than in ui/table, because `position: sticky`
        pins to the nearest scrolling ancestor: with the shared wrapper's overflow-x the header
        would pin to a box the height of the whole table and never actually stick. Owning the
        container is what makes the header hold on a 25 row roadmap, and it keeps the sideways
        overflow on the same element rather than on the page.

        overflow-y only, never overflow-x. The table is exactly as wide as this container and
        every cell wraps inside its share of it, so there is nothing to scroll sideways to. The
        vertical scroll stays because the sticky header pins to the nearest scrolling ancestor,
        and that is what holds the column names on a 25 row roadmap.
      */}
      <div className="max-h-[65vh] w-full overflow-x-hidden overflow-y-auto">
        {/*
          table-fixed is what makes the promise above true. Under the default `auto` layout a
          browser widens a column to fit its longest unbroken content, so one long prompt pushed
          the table past the container and produced the sideways scroll. Fixed layout hands each
          column a share of the width up front and makes the CONTENT wrap to it, which is the
          whole point: the row grows downward instead of the table growing rightward.

          The percentages are the content's real shape: a topic is a title, a scope is a sentence
          or two, and the prompts are three or four full questions, so they get the most room.

          The prompts column renders in READ MODE ONLY, by the operator's instruction: the create
          page is for ticking topics, and the prompts were the bulk of every row's height there.
          They are still the binding part of a row, so they stay on the Content Roadmap tab, which
          is the place to judge the sheet. Pick mode hands their share to topic and covers, so the
          two modes size their prose columns differently on purpose.
        */}
        <table className="w-full table-fixed caption-bottom text-sm">
          <TableHeader className="sticky top-0 z-10 bg-card [&_tr]:border-b">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-9 align-middle">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  disabled={selectable.length === 0}
                  onCheckedChange={(checked) => props.onToggleAll(checked === true)}
                  aria-label={
                    selectable.length === 0
                      ? "No topics can be generated"
                      : `Select all ${selectable.length} topics that can be generated`
                  }
                />
              </TableHead>
              {/* The row's own number, the same one the preview's "#" column shows and the same one
                  every blog written from this sheet carries. This table IS the sheet, so reading a
                  row here and finding it in the CSV should not require counting. */}
              <TableHead className="machine w-10 align-middle text-xs font-medium">#</TableHead>
              <TableHead className="machine w-[38%] align-middle text-xs font-medium">
                topic
              </TableHead>
              {/* covers carries no width class, so table-fixed hands it the whole remainder:
                  it is the last prose column. */}
              <TableHead className="machine align-middle text-xs font-medium">
                what it covers
              </TableHead>
              {/* Unlabelled on screen and named for a screen reader. A column of one icon button
                  needs no title, and "actions" over a 25 row sheet is a word that earns nothing. */}
              <TableHead className="w-12 align-middle">
                <span className="sr-only">row actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <Row
                key={row.index}
                row={row}
                state={resolveRowState(row, facts)}
                missing={props.incomplete.get(row.index) ?? null}
                selection={{
                  checked: selected.has(row.index),
                  eligible: eligible(row),
                  onCheckboxClick: noteShift,
                  onCheckboxChange: toggleRow,
                }}
                upload={upload}
                rowRefs={rowRefs}
              />
            ))}
          </TableBody>
        </table>
      </div>
    </TooltipProvider>
  );
}

type Selection = {
  checked: boolean;
  /** Whether this row's checkbox is enabled at all, decided by the MODE's own predicate. */
  eligible: boolean;
  /** Records whether the click held shift, before the change handler reads it. */
  onCheckboxClick: (event: React.MouseEvent) => void;
  onCheckboxChange: (index: number) => void;
};

type Upload = {
  brandSlug: string;
  onUploaded: () => void;
};

function Row({
  row,
  state,
  missing,
  selection,
  upload,
  rowRefs,
}: {
  row: RoadmapRow;
  state: RowState;
  missing: string[] | null;
  selection: Selection;
  upload: Upload;
  // HTMLElement, not HTMLTableRowElement: only scrollIntoView reads this map, which every
  // element has.
  rowRefs: React.RefObject<Map<number, HTMLElement>>;
}) {
  const style = ROW_STYLES[state];

  return (
    <TableRow
      ref={(node) => {
        if (node) {
          rowRefs.current.set(row.index, node);
        } else {
          rowRefs.current.delete(row.index);
        }
      }}
      className={cn("align-top", style?.row)}
      data-row-state={state}
      // The row's own state, named for a screen reader on the row rather than only in the
      // chip, so tabbing to the checkbox says why it is disabled.
      aria-disabled={!selection.eligible ? true : undefined}
    >
      <TableCell className="pt-4 align-top">
        <Checkbox
          checked={selection.checked}
          disabled={!selection.eligible}
          onClick={selection.onCheckboxClick}
          onCheckedChange={() => selection.onCheckboxChange(row.index)}
          // The number, so the checkbox a screen reader lands on names the row the same way
          // the screen does rather than reading a dozen words of title to say which one.
          aria-label={`Select row ${row.index + 1}, ${row.topic}`}
        />
      </TableCell>

      {/* Displayed index + 1, agreeing with the preview's "#" column, engine-error's "row N",
          and the number every blog written from this row carries in the library. */}
      <TableCell className="machine pt-4 align-top text-xs whitespace-normal text-muted-foreground">
        {row.index + 1}
      </TableCell>

      {/*
        The slug is gone from this cell. It was the topic a second time, hyphenated: the same
        words, saying nothing the title above it had not already said, and costing a line in
        every row. The slug is a machine key, useful when matching a row to an output folder on
        disk, and it is still on the blogs library and in the run status where that matching
        actually happens.
      */}
      {/*
        whitespace-normal on every cell, and it is load bearing. shadcn's TableCell ships
        `whitespace-nowrap`, which is a sane default for a data grid of short values and exactly
        wrong for prose: text physically cannot wrap, so each cell grows to its longest line and
        the table overflows its container no matter what table-fixed or the column widths say.
        That was the sideways scroll, not the min-widths alone.

        No min-w either. A min-width is a floor the browser must honour, so three of them added
        up past the container. Widths are set once on the header and every cell wraps into its
        share.
      */}
      <TableCell className="py-3 align-top whitespace-normal">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          <p className="text-sm leading-snug text-pretty text-foreground">{row.topic}</p>
          <StateChip state={state} className="mt-0.5" />
        </div>
        <RowNote row={row} state={state} missing={missing} />
      </TableCell>

      {/* No clamp and no expander: the scope is a sentence or two, it wraps, and the row is as
          tall as its tallest cell needs. */}
      <TableCell className="py-3 align-top text-sm leading-relaxed whitespace-normal text-pretty text-muted-foreground">
        {row.covers || <span className="text-xs">Not given</span>}
      </TableCell>

      <TableCell className="pt-3 align-top">
        <UploadBlog
          brandSlug={upload.brandSlug}
          row={row}
          state={state}
          onUploaded={upload.onUploaded}
        />
      </TableCell>
    </TableRow>
  );
}
