"use client";

import type { RoadmapMonth } from "@/types";
import { cn } from "@/lib/utils";

/**
 * The month dropdown, shared by Blogs, LinkedIn and Medium.
 *
 * Its own component for one rule rather than for tidiness: NEWEST FIRST. The engine returns months
 * ascending and the default lands on the latest, so an unsorted list puts the default at the
 * bottom. Two tabs sorting that by hand is two chances to sort it once.
 */
export function MonthPicker({
  months,
  month,
  onChange,
}: {
  months: RoadmapMonth[];
  month: number | null;
  onChange: (month: number) => void;
}) {
  return (
    <select
      value={month ?? ""}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-label="Filter by roadmap month"
      className={cn(
        "h-8 rounded-lg border border-input bg-background px-2 text-xs",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      {[...months].sort((a, b) => b.month - a.month).map((m) => (
        <option key={m.month} value={m.month}>
          {m.label}
        </option>
      ))}
    </select>
  );
}
