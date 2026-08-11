"use client";

import * as React from "react";
import { api } from "@/lib/api";
import type { RoadmapMonth } from "@/types";

/**
 * THE MONTH A TAB IS SHOWING, owned in one place because three tabs now ask the same question.
 *
 * Blogs, LinkedIn and Medium all group by the month of the roadmap that planned the work, and
 * every rule below has to be identical across them: which months exist, which one is the default,
 * and what happens when the one on screen stops existing. A second copy of "default to the latest
 * month, once" is a second copy that drifts, and the failure is silent, one tab quietly showing a
 * different month from its neighbour.
 *
 * THE OPTIONS ARE THE ROADMAPS THAT EXIST, never a range derived from the content. A month is a
 * roadmap sheet plus the work written from it, and deleting the sheet deletes that work, so the
 * sheets ARE the month list and a month can never appear with nothing behind it.
 */
export type MonthFilter = {
  /** Null while loading. [] for a brand with no roadmap, which is the ordinary empty state. */
  months: RoadmapMonth[] | null;
  /** The month on screen. Null before the default lands, and for a brand with no roadmap. */
  month: number | null;
  setMonth: (month: number) => void;
  /** The newest month the brand holds: the default, and where off-roadmap work files. */
  latestMonth: number | null;
  /** Whether a picker is worth rendering. One month is everything there is, so a control that
   *  cannot change anything would only ask the operator a question. */
  showPicker: boolean;
  /** The operator-facing name of the month on screen ("Month 2 Roadmap"), or null. */
  label: string | null;
};

export function useMonthFilter(brandSlug: string): MonthFilter {
  const [months, setMonths] = React.useState<RoadmapMonth[] | null>(null);
  const [month, setMonth] = React.useState<number | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    // Reset on a brand switch, so one brand's month cannot survive onto another's list and
    // filter every row away under a number that brand has never had.
    setMonths(null);
    setMonth(null);
    api.roadmapMonths(brandSlug, controller.signal).then(
      (data) => setMonths(data.months),
      // A brand with no roadmap is the ordinary empty state, not an error worth a banner: the
      // picker simply does not render and everything shows.
      () => setMonths([]),
    );
    return () => controller.abort();
  }, [brandSlug]);

  const latestMonth = React.useMemo(
    () => (months?.length ? Math.max(...months.map((m) => m.month)) : null),
    [months],
  );

  // Default to the latest ONCE, and never again: re-applying it on every render would drag the
  // operator back to this month the moment a poll refreshed the list under them.
  React.useEffect(() => {
    setMonth((current) => (current === null ? latestMonth : current));
  }, [latestMonth]);

  // A month the brand no longer has (its roadmap was deleted while this list was open) would
  // filter everything away and leave the operator on an empty tab with no way back.
  React.useEffect(() => {
    if (month !== null && months && months.length > 0 && !months.some((m) => m.month === month)) {
      setMonth(latestMonth);
    }
  }, [month, months, latestMonth]);

  return {
    months,
    month,
    setMonth,
    latestMonth,
    showPicker: (months?.length ?? 0) > 1,
    label: months?.find((m) => m.month === month)?.label ?? null,
  };
}
