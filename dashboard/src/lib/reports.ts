/**
 * Pure helpers for the Reports tab: the month-over-month math and the all-months series the
 * charts draw. The skill emits ABSOLUTE counts per month, so every delta and every trend point
 * is derived HERE from the stored history rather than asked of the model, which is why this file
 * is plain data with no React in it and is the one place the arithmetic lives.
 */
import type { MonthReport, ReportMetrics } from "@/types";

/** One month that actually has metrics, in the shape the charts consume. */
export type MetricPoint = { month: string; label: string; metrics: ReportMetrics };

/** A month-over-month change: absolute, percent (null when the prior value was 0), and the month
 *  it was measured against. Null when there is no earlier month to compare with. */
export type Delta = { abs: number; pct: number | null; prevMonth: string } | null;

/** A value pulled out of one month's metrics: total mentions, one engine, backlinks, etc. */
export type Selector = (m: ReportMetrics) => number | null;

/** "2026-07" -> "July 2026". Parsed as UTC so a browser west of Greenwich never shows June. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "2026-07" -> "Jul". The axis tick form. */
export function monthShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

export function mentionTotal(m: ReportMetrics | null | undefined): number | null {
  const by = m?.ai_mentions?.by_engine;
  if (!by || by.length === 0) return null;
  return by.reduce((sum, e) => sum + (Number.isFinite(e.value) ? e.value : 0), 0);
}

export const selTotal: Selector = (m) => mentionTotal(m);
export const selBacklinks: Selector = (m) =>
  typeof m.backlinks === "number" ? m.backlinks : null;
export const selReferring: Selector = (m) =>
  typeof m.referring_domains === "number" ? m.referring_domains : null;
export const selEngine =
  (engine: string): Selector =>
  (m) => {
    const e = m.ai_mentions?.by_engine?.find((x) => x.engine === engine);
    return e && Number.isFinite(e.value) ? e.value : null;
  };

/**
 * Every month that carries a usable metrics block, OLDEST first. This is the series the trend
 * line draws and every delta is computed against. A month whose working report was deleted has
 * no metrics and simply is not a point, so the line spans the gap rather than dropping to zero.
 */
export function metricSeries(reports: MonthReport[]): MetricPoint[] {
  return reports
    .filter(
      (r): r is MonthReport & { report: { metrics: ReportMetrics } } =>
        !!r.report?.metrics?.ai_mentions?.by_engine?.length,
    )
    .map((r) => ({ month: r.month, label: monthLabel(r.month), metrics: r.report.metrics }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * The change for `month` against the nearest EARLIER month in the series that has a value. Null
 * when the selected month has no value, or when it is the first month with data (nothing to
 * compare against, which is honest rather than a fabricated 0).
 */
export function deltaAt(series: MetricPoint[], month: string, sel: Selector): Delta {
  const i = series.findIndex((p) => p.month === month);
  if (i < 0) return null;
  const cur = sel(series[i].metrics);
  if (cur === null) return null;
  for (let j = i - 1; j >= 0; j--) {
    const prev = sel(series[j].metrics);
    if (prev === null) continue;
    const abs = cur - prev;
    return { abs, pct: prev === 0 ? null : Math.round((abs / prev) * 100), prevMonth: series[j].month };
  }
  return null;
}

/** Compact big numbers for a hero figure: 1284 -> "1,284", 12900 -> "12.9K", 4200000 -> "4.2M". */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/**
 * A Lighthouse score normalised to the 0 to 100 integer scale. The skill may emit 61 or 0.61 for
 * the same score (DataForSEO returns 0 to 1, the sample uses 0 to 100), so both are accepted and
 * a value at or below 1 is read as a fraction. Null stays null: an absent score is "n/a", never 0.
 */
export function lighthouseScore(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const v = value <= 1 ? value * 100 : value;
  return Math.round(v);
}

/**
 * Google's own traffic-light band for a Lighthouse score: 90+ good, 50 to 89 mid, below 50 bad.
 * Returns the app status token so the card colours match the rest of the dashboard, and matches
 * the PDF's `score_cell` thresholds exactly so the two surfaces never disagree on a colour.
 */
export function lighthouseBand(score: number | null): "good" | "mid" | "bad" | "na" {
  if (score === null) return "na";
  if (score >= 90) return "good";
  if (score >= 50) return "mid";
  return "bad";
}
