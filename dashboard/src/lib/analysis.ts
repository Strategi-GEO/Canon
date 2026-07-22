/**
 * Pure helpers for the Analysis tab. The skill emits ABSOLUTE values per month, so a scorecard
 * delta is derived HERE, either from a card's own `prev_value` (Search Console and GA4 hand it over
 * directly) or, failing that, from the same card in the nearest earlier month's stored analysis.
 * No React in this file. The month math is reused from lib/reports so the two tabs never drift.
 */
import type { AnalysisMonth, AnalysisScorecardCard } from "@/types";

import { monthLabel } from "@/lib/reports";
export { monthLabel, monthShort, compact } from "@/lib/reports";

/** A month-over-month change on a scorecard card: absolute, percent (null when prior was 0). */
export type CardDelta = { abs: number; pct: number | null } | null;

/**
 * The leading number in a scorecard value, so "11/18" reads 11, "74%" reads 74, 3200 reads 3200.
 * A value with no parseable number (rare) is null, which the UI treats as "no delta".
 */
export function leadingNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const m = v.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Analyses that carry a usable scorecard, OLDEST first. The series deltas are derived against. */
export function analysisSeries(months: AnalysisMonth[]): { month: string; label: string; cards: AnalysisScorecardCard[] }[] {
  return months
    .filter((m): m is AnalysisMonth & { analysis: { scorecard: AnalysisScorecardCard[] } } =>
      !!m.analysis?.scorecard?.length)
    .map((m) => ({ month: m.month, label: monthLabel(m.month), cards: m.analysis.scorecard }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * The delta for one card. Prefers the card's own `prev_value` (the tool's own last-month figure);
 * otherwise walks back through earlier months' analyses for the same card key. Null when there is
 * nothing earlier to compare against, which is honest rather than a fabricated 0.
 */
export function cardDelta(
  card: AnalysisScorecardCard,
  month: string,
  series: ReturnType<typeof analysisSeries>,
): CardDelta {
  const cur = leadingNumber(card.value);
  if (cur === null || !card.available) return null;

  let prev = leadingNumber(card.prev_value);
  if (prev === null) {
    const i = series.findIndex((p) => p.month === month);
    for (let j = i - 1; j >= 0; j--) {
      const earlier = series[j].cards.find((c) => c.key === card.key && c.available);
      const v = earlier ? leadingNumber(earlier.value) : null;
      if (v !== null) {
        prev = v;
        break;
      }
    }
  }
  if (prev === null) return null;
  const abs = cur - prev;
  return { abs, pct: prev === 0 ? null : Math.round((abs / prev) * 100) };
}

/** The matrix cell status token: cited=good, mentioned=partial, absent=bad, null=neutral. */
export function cellTone(state: "cited" | "mentioned" | "absent" | null | undefined): {
  color: string;
  bg: string;
  label: string;
} {
  switch (state) {
    case "cited":
      return { color: "var(--primary-foreground)", bg: "var(--ship)", label: "Cited" };
    case "mentioned":
      return { color: "var(--primary-foreground)", bg: "var(--review)", label: "Named" };
    case "absent":
      return { color: "var(--primary-foreground)", bg: "var(--fail)", label: "Absent" };
    default:
      return { color: "var(--muted-foreground)", bg: "var(--muted)", label: "-" };
  }
}
