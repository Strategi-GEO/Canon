"use client";

import * as React from "react";
import { BELOW_BAR_FLOOR, SHIP_BAR } from "@/lib/blog-score";
import { cn } from "@/lib/utils";
import type { RowState } from "@/components/create/row-status";
import type { RoadmapRow } from "@/types";

/**
 * How a row's state LOOKS and what it SAYS, in one place.
 *
 * row-status.ts decides what a row's state IS. This file decides how that state is worn, and
 * it is shared rather than copied so that no two renderings of one row can disagree about it:
 * "generating" in one place and "failed" in another would be two opinions about one fact, and
 * the operator would have no way to tell which one lied.
 *
 * This once said "for every view", written when a card view stood beside the table. That view
 * is deleted and the claim outlived it. Today the readers are roadmap-table's two modes,
 * Create Blogs picking rows and the Content Roadmap tab reading them, which is the same table
 * and therefore already the same colours. The sharing still earns its place: the states are
 * the operator's rules rather than one table's styling, and the next reader gets them right by
 * importing rather than by remembering.
 */

/**
 * Row colour, one entry per state.
 *
 * These are the status tokens, deliberately off the accent hue. `chip` is the redundant
 * signal that makes the roadmap usable without colour vision, so no state that paints a row
 * may leave it null.
 *
 * Every coloured `row` repeats its fill under `hover:` on purpose. The shared TableRow paints
 * `hover:bg-muted/50` on every row, which would wash a status colour to grey the moment the
 * pointer crossed it, so a green, amber or red row lost its meaning exactly when the operator
 * reached for it. Restating the fill as a hover utility lets tailwind-merge drop the muted one,
 * so the colour holds through hover. A locked row that vanishes on hover is the worst time to
 * lose the one signal saying why it cannot be picked.
 */
export const ROW_STYLES: Record<
  RowState,
  { row: string; chip: string; chipLabel: string } | null
> = {
  generated: {
    row: "bg-ship-bg hover:bg-ship-bg",
    chip: "border-ship/25 bg-ship-bg text-ship",
    chipLabel: "generated",
  },
  in_progress: {
    row: "bg-review-bg hover:bg-review-bg",
    chip: "border-review/25 bg-review-bg text-review",
    chipLabel: "generating",
  },
  // Amber, the same review token the Blogs page badge wears for this status, and the same
  // "waiting on you" words: a held blog reads identically wherever the operator meets it. It
  // shares in_progress's hue because both are the amber "not yours to touch yet" state and this
  // app keeps no fourth status hue; the chip and note carry the difference that colour cannot.
  needs_review: {
    row: "bg-review-bg hover:bg-review-bg",
    chip: "border-review/25 bg-review-bg text-review",
    chipLabel: "waiting on you",
  },
  failed: {
    row: "bg-fail-bg hover:bg-fail-bg",
    chip: "border-fail/25 bg-fail-bg text-fail",
    chipLabel: "failed",
  },
  // Yellow, the review/owed token, split off failed by score: the below-bar band is one rerun
  // from the ship bar, not a plain failure, so it carries the same "below bar" meaning the Blogs
  // tab tag does. The band's edges live in lib/blog-score and are never written out here.
  // The hue is shared with the amber states above and the chip label carries the difference colour
  // cannot. Selectable like failed, because retrying for 90 is exactly what an operator wants.
  below_bar: {
    row: "bg-review-bg hover:bg-review-bg",
    chip: "border-review/25 bg-review-bg text-review",
    chipLabel: "below bar",
  },
  // Incomplete is not one of the three coloured states. It stays neutral on purpose: red now
  // means "the last run failed, tick it to retry", and painting an unwritable row the same
  // colour would tell the operator to retry something the engine refuses with a 422.
  incomplete: null,
  ready: null,
};

/** Machine values render in a stable, locale free shape so two operators read the same date. */
export function formatDate(iso: string | null): string {
  if (!iso) {
    return "an unknown date";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toISOString().slice(0, 10);
}

/** The state as a word, next to the state as a colour. Never one without the other. */
export function StateChip({ state, className }: { state: RowState; className?: string }) {
  const style = ROW_STYLES[state];
  if (!style) {
    return null;
  }
  return (
    <span
      className={cn(
        "machine inline-flex h-5 shrink-0 items-center rounded border px-1.5 text-[0.6875rem] leading-none",
        style.chip,
        className,
      )}
    >
      {style.chipLabel}
    </span>
  );
}

/**
 * The text label every coloured row carries. Colour alone is not a signal an operator can
 * rely on, and the label is also where the state stops being a hue and starts being a
 * sentence someone can act on.
 */
export function RowNote({
  row,
  state,
  missing,
}: {
  row: RoadmapRow;
  state: RowState;
  /** Fields the engine itself named in a 422, or null if it has not refused this row. */
  missing: string[] | null;
}) {
  // A 422 names the fields the engine itself refused, so it outranks the row's own missing
  // list: the engine read the archived sheet, the browser only read the parse of it.
  if (missing) {
    return (
      <p className="mt-1.5 text-xs text-fail">
        The engine refused this row. Missing:{" "}
        <span className="machine">{missing.join(", ")}</span>
      </p>
    );
  }

  if (state === "in_progress") {
    return <p className="mt-1.5 text-xs text-review">Generating now.</p>;
  }

  if (state === "generated") {
    return (
      <p className="mt-1.5 text-xs text-ship">
        Generated. Scored{" "}
        <span className="machine">{row.ledger?.score ?? "an unrecorded score"}</span> on{" "}
        <span className="machine">{formatDate(row.ledger?.generated_at ?? null)}</span>.
      </p>
    );
  }

  if (state === "needs_review") {
    return (
      <p className="mt-1.5 text-xs text-review">
        Waiting on you. This blog is held until you answer its open questions on the Blogs page,
        so it cannot be picked here.
      </p>
    );
  }

  if (state === "failed") {
    return <p className="mt-1.5 text-xs text-fail">Last run failed. Tick it to try again.</p>;
  }

  if (state === "below_bar") {
    return (
      // FROM THE CONSTANTS, NEVER FROM LITERALS. This sentence said "85 to 89" for as long as the
      // floor was 85 and kept saying it after the floor moved to 80, so the chip and the sentence
      // explaining it named two different bands on the same row. A number an operator reads off
      // the screen has to be the number the code compares against.
      <p className="mt-1.5 text-xs text-review">
        Scored <span className="machine">{BELOW_BAR_FLOOR}</span> to{" "}
        <span className="machine">{SHIP_BAR - 1}</span>, below the{" "}
        <span className="machine">{SHIP_BAR}</span> ship bar. Tick it to rerun for{" "}
        <span className="machine">{SHIP_BAR}</span>.
      </p>
    );
  }

  if (state === "incomplete") {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground">
        Not selectable. Missing: <span className="machine">{row.missing.join(", ")}</span>
      </p>
    );
  }

  return null;
}
