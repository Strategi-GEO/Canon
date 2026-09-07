"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ThemeTerm } from "@/components/roadmap/roadmap-theme";

/**
 * The roadmap tab's presentational pieces, shared VERBATIM between the admin roadmap tab
 * (roadmap-overview.tsx, roadmap-preview-dialog.tsx) and the client portal's roadmap view
 * (portal/roadmap-view.tsx). They moved here from the admin files unchanged, because the
 * portal mirrors the admin tab's look by request and two copies of one tile is how the two
 * surfaces drift. Everything here is pure presentation: no api import, no HOSTED_READONLY,
 * nothing admin-gated, so the portal bundle drags in nothing it cannot use.
 */

export type Tone = "plain" | "ship" | "review" | "fail" | "accent";

const TONES: Record<Tone, string> = {
  plain: "text-foreground",
  ship: "text-ship",
  review: "text-review",
  fail: "text-fail",
  accent: "text-primary",
};

/**
 * One number, big, with the sentence that says what it means.
 *
 * The note is not decoration. "Needs review: 3" and "Failed: 3" look identical at a glance and
 * mean opposite things, and the colour alone cannot carry that difference to someone who reads
 * the number before the palette.
 *
 * `href` turns the tile into a link (the client overview's tiles deep-link into the library's
 * tabs); without one it is the plain Card the admin roadmap tab renders.
 */
export function StatTile({
  label,
  value,
  note,
  tone = "plain",
  href,
}: {
  label: string;
  value: number;
  note?: string;
  tone?: Tone;
  href?: string;
}) {
  const card = (
    <Card className="h-full [--card-spacing:--spacing(6)]">
      <CardContent className="flex flex-col">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
        <p className={cn("machine mt-4 text-4xl font-semibold", TONES[tone])}>
          {formatCount(value)}
        </p>
        {note !== undefined ? (
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{note}</p>
        ) : null}
      </CardContent>
    </Card>
  );
  if (href === undefined) {
    return card;
  }
  return (
    <Link
      href={href}
      className="block h-full rounded-xl outline-none transition-shadow hover:shadow-md hover:shadow-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {card}
    </Link>
  );
}

/** The "What these blogs are about" card: recurring terms counted from the sheet. */
export function ThemeCard({ theme }: { theme: ThemeTerm[] }) {
  return (
    <Card className="mt-4">
      <CardContent className="py-8">
        <p className="text-sm font-medium text-foreground">What these blogs are about</p>
        {theme.length > 0 ? (
          <>
            <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              The terms that recur across the topics, counted from the sheet. The number is
              how many topics carry each one.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {theme.map((term) => (
                <li
                  key={term.term}
                  className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
                >
                  {term.term}
                  <span className="machine text-xs text-muted-foreground">
                    {formatCount(term.topics)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            This roadmap has no single recurring theme: no term appears in more than one
            topic. That is a real answer about the sheet rather than a gap, and a roadmap
            of unrelated topics is a legitimate thing to have.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * What each column DOES, by position. Nothing here is decoration: this is the engine's actual
 * contract and it is invisible in any header text.
 *
 * The house sheet is ten columns and only three of them are binding: 1 Content Topic,
 * 2 What the Piece Covers, 8 Target Prompts. Columns 4 to 7 and 9 to 10 ARE the justification,
 * the live figures that argue the row to the client, and they carry the same role as column 3:
 * guidance handed to the writer under its own header, never a fact the draft may cite. There is
 * no prose Justification column beside them, because a sentence explaining a number belongs next
 * to the number it explains, and a column whose content is an argument about the other columns
 * goes stale the moment any of them is re-pulled. Prompts sit at 8 rather than 5 so those figures
 * stay together between the scope and the prompts.
 *
 * There is no "ignored" case any more and there must never be one again. The factory used to
 * read three columns and drop the rest, so this map marked the other columns Ignored and greyed
 * them out. It now registers EVERY column, which is how a Content Type of "Comparison anchor"
 * reaches the agent that acts on it. A column labelled Ignored in this preview while its value
 * was steering the draft would be the worst kind of wrong: a confident, specific lie about the
 * operator's own file.
 */
function roleOf(index: number): string {
  if (index === 0) return "Topic";
  if (index === 1) return "Scope";
  if (index === 7) return "Target prompts";
  return "Guidance";
}

/**
 * The review affordance the ADMIN preview threads into the grid: a checkbox per data row, a
 * per-row lock reason, and a per-row "rewriting" state. Pure presentation contract, callbacks
 * in and nothing else, so this file stays portal-safe: the portal passes no `review` and
 * renders the exact grid it always has. Row indices here are 0-based DATA row positions, the
 * same numbering RoadmapRow.index and the "#" column carry.
 */
export type SheetReview = {
  /** Why row i cannot be ticked, or null when it can. Renders as the checkbox's tooltip. */
  blocked: (rowIndex: number) => string | null;
  /** True while a running rewrite batch owns row i. Locks the row and marks it working. */
  rewriting: (rowIndex: number) => boolean;
  selected: ReadonlySet<number>;
  /** `extend` is a shift-click: range-select between the anchor and this row. */
  onToggle: (rowIndex: number, extend: boolean) => void;
};

/**
 * Sticky header, sticky row numbers, and the scroll living HERE rather than on the page. The
 * page must never scroll sideways to accommodate a wide CSV: the sheet is arbitrary width, so
 * letting it size the document would let one operator's spreadsheet break the whole layout.
 *
 * min-w-0 and min-h-0 are what make that work at all. This is a grid child, grid children
 * default to min-width:auto and min-height:auto, and an auto-sized child sizes to its content
 * instead of scrolling it. Both axes need saying: with only min-w-0 the sheet scrolled
 * sideways and grew downwards past the dialog, and the sticky header had no scroll of its own
 * to hold against, so the column role labels scrolled away with the page and left six
 * anonymous columns behind, which is the exact misreading this dialog exists to prevent.
 *
 * The prop is the shape it reads, not the admin RoadmapSheet: the portal cannot fetch the raw
 * CSV (admin_roadmap_sheets is admin-gated) and rebuilds these cells from its own wire, so the
 * grid asks only for what it renders and both callers satisfy it.
 *
 * `review` adds the tick column the rewrite flow needs, on the LEFT of the row numbers where
 * the operator asked for it. It is optional and the portal never passes it.
 */
export function SheetGrid({
  sheet,
  review,
}: {
  sheet: { columns: string[]; rows: string[][] };
  review?: SheetReview;
}) {
  // Shift state is read off the click that caused the change, before the change handler
  // fires: the same private-ref pattern roadmap-table uses, for the same Radix ordering
  // reason. Held here so the grid stays a drop-in for callers that pass no review.
  const extending = React.useRef(false);

  if (sheet.rows.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        This sheet has a header row and no data rows under it.
      </p>
    );
  }

  return (
    <div className="min-h-0 min-w-0 overflow-auto rounded-lg ring-1 ring-foreground/10">
      <table className="w-max border-separate border-spacing-0 text-left">
        <thead>
          <tr>
            {review ? (
              // No select-all: rejecting EVERY topic is not a rewrite, it is a sheet worth
              // deleting and regenerating, so the header cell only names the column.
              <th className="sticky top-0 left-0 z-30 w-9 border-b border-border bg-muted px-2.5 py-2.5">
                <span className="sr-only">tick topics to rewrite</span>
              </th>
            ) : null}
            {/* Sticky in both axes, so it outranks both the header row and the number column
                it sits at the corner of. */}
            <th
              className={cn(
                "sticky top-0 z-30 border-b border-border bg-muted px-3 py-2.5 text-xs font-medium text-muted-foreground",
                review ? "left-9" : "left-0",
              )}
            >
              #
            </th>
            {/* Every column is rendered at full weight. Nothing here is greyed out, because
                nothing in the sheet is dead weight any more: what is not the brief is guidance,
                and guidance reaches the writer. */}
            {sheet.columns.map((column, index) => (
              <th
                key={index}
                className="sticky top-0 z-20 min-w-44 max-w-80 border-b border-l border-border bg-muted px-3 py-2.5 align-bottom"
              >
                <span className="machine block text-xs font-medium wrap-break-word text-foreground">
                  {column.trim() === "" ? "(no header)" : column}
                </span>
                <span className="mt-1 block text-[10px] tracking-wide text-primary uppercase">
                  {roleOf(index)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => {
            const rewriting = review?.rewriting(rowIndex) ?? false;
            const blocked = review?.blocked(rowIndex) ?? null;
            // The amber wash says "in flight" the way the create table's rows do; it must
            // also sit under the sticky number cell or the tint would break at the frozen
            // column and read as two different rows.
            const tint = rewriting ? "bg-review-bg" : "bg-card";
            return (
              <tr key={rowIndex} className={rewriting ? "bg-review-bg" : undefined}>
                {review ? (
                  <td className={cn("sticky left-0 z-10 border-b border-border px-2.5 py-2 align-top", tint)}>
                    {rewriting ? (
                      // The checkbox is REPLACED, not disabled: a row a running batch owns is
                      // not a choice the operator is being offered, and the spinner says what
                      // is actually happening to it.
                      <Loader2
                        className="size-4 animate-spin text-review motion-reduce:animate-none"
                        aria-label={`Row ${rowIndex + 1} is being rewritten`}
                      />
                    ) : (
                      <Checkbox
                        checked={review.selected.has(rowIndex)}
                        disabled={blocked !== null}
                        title={blocked ?? undefined}
                        onClick={(event) => {
                          extending.current = event.shiftKey;
                        }}
                        onCheckedChange={() => review.onToggle(rowIndex, extending.current)}
                        aria-label={
                          blocked !== null
                            ? `Row ${rowIndex + 1} cannot be rewritten: ${blocked}`
                            : `Tick row ${rowIndex + 1} to rewrite it`
                        }
                      />
                    )}
                  </td>
                ) : null}
                <td
                  className={cn(
                    "machine sticky z-10 border-b border-border px-3 py-2 align-top text-xs text-muted-foreground",
                    review ? "left-9" : "left-0",
                    tint,
                  )}
                >
                  {rowIndex + 1}
                </td>
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    // Target prompts arrive several to one quoted cell, newline separated on an
                    // operator's sheet and " | " joined on a generated one, so those newlines are
                    // content and collapsing them would misrepresent the file.
                    // Every cell reads at full contrast: half of them used to be dimmed to say
                    // the engine threw them away, and the engine no longer does.
                    className="machine max-w-80 border-b border-l border-border px-3 py-2 align-top text-xs whitespace-pre-line wrap-break-word text-foreground"
                  >
                    {cellIndex === 0 && rewriting ? (
                      <span className="mb-1 flex items-center gap-1.5 text-[0.6875rem] text-review">
                        <Loader2
                          className="size-3 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                        rewriting
                      </span>
                    ) : null}
                    {cell}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
