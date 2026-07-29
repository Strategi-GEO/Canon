"use client";

import * as React from "react";
import type { RoadmapRow } from "@/types";

/**
 * Checkbox selection over roadmap rows: toggle, shift-click ranges, select all.
 *
 * Extracted from select-state.tsx when the rewrite panel became the second surface that
 * ticks rows, because the subtle part is easy to re-derive wrongly: ranges walk ARRAY
 * POSITIONS, not row.index. The parser skips blank lines while its counter keeps going, so
 * row.index has gaps, and arithmetic on it would silently include or drop rows.
 *
 * `eligible` decides which rows a tick may reach, and the two surfaces answer it
 * differently on purpose: Create Blogs ticks what can be WRITTEN (ready, failed, below
 * bar), the rewrite panel ticks what can be REPLACED (anything without a blog on disk).
 * The predicate is a prop rather than a shared constant because that difference is the
 * point, not an accident to unify away.
 */
export function useRowSelection(
  rows: RoadmapRow[],
  eligible: (row: RoadmapRow) => boolean,
  /** Rows ticked on mount, e.g. a retry arriving pre-selected. Read once, initialiser-style. */
  initial?: () => Set<number>,
) {
  const [selected, setSelected] = React.useState<Set<number>>(initial ?? (() => new Set()));

  // The anchor for shift-click. A ref rather than state: it steers the next click and must
  // never itself cause a render.
  const anchor = React.useRef<number | null>(null);

  const toggle = React.useCallback(
    (index: number, extend: boolean) => {
      setSelected((current) => {
        const next = new Set(current);
        // The clicked row's NEW value is what the whole range takes, which is what every
        // list an operator has ever shift-clicked does.
        const selecting = !current.has(index);
        const from = anchor.current;

        if (extend && from !== null && from !== index) {
          const a = rows.findIndex((r) => r.index === from);
          const b = rows.findIndex((r) => r.index === index);
          if (a !== -1 && b !== -1) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) {
              const row = rows[i];
              // A range never picks up a locked row. Dragging across the table must not
              // select what a direct click is forbidden to select.
              if (!eligible(row)) {
                continue;
              }
              if (selecting) {
                next.add(row.index);
              } else {
                next.delete(row.index);
              }
            }
            return next;
          }
        }

        if (selecting) {
          next.add(index);
        } else {
          next.delete(index);
        }
        return next;
      });
      anchor.current = index;
    },
    [rows, eligible],
  );

  const eligibleRows = React.useMemo(() => rows.filter(eligible), [rows, eligible]);

  const toggleAll = React.useCallback(
    (checked: boolean) => {
      // Select all means every row a tick may reach; locked rows have a disabled checkbox,
      // so this cannot tick them either.
      setSelected(checked ? new Set(eligibleRows.map((r) => r.index)) : new Set());
      anchor.current = null;
    },
    [eligibleRows],
  );

  return { selected, setSelected, toggle, toggleAll, eligibleRows };
}
