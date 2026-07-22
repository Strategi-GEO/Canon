/**
 * The Reports tab's month-over-month math. The skill emits absolute counts per month; every
 * delta and the trend line are derived here, so this is where a wrong number would ship. The
 * one non-obvious rule under test: a delta is measured against the nearest EARLIER month that
 * has a value, so a gap (a deleted month, or a metric missing one month) is stepped over rather
 * than read as a drop to zero.
 *
 * Run it with:  node --test tests/reports.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compact,
  deltaAt,
  lighthouseBand,
  lighthouseScore,
  mentionTotal,
  metricSeries,
  selBacklinks,
  selTotal,
} from "../src/lib/reports.ts";

function month(m: string, chatgpt: number, gemini: number, claude: number, backlinks: number | null) {
  return {
    month: m,
    status: "generated_unshared" as const,
    report: {
      metrics: {
        ai_mentions: {
          by_engine: [
            { engine: "ChatGPT", value: chatgpt },
            { engine: "Gemini", value: gemini },
            { engine: "Claude", value: claude },
          ],
        },
        backlinks,
        referring_domains: null,
      },
    },
    has_pdf: true,
    generated_at: null,
    generated_by: null,
    shared_at: null,
    shared_by: null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reports: any[] = [
  month("2026-07", 87, 28, 17, 408), // total 132
  month("2026-06", 49, 16, 9, 356), // total 74
  { ...month("2026-05", 0, 0, 0, 300), report: null }, // deleted: no metrics, must be skipped
  month("2026-04", 40, 12, 8, null), // total 60, backlinks missing this month
];

test("mentionTotal sums the per-engine counts", () => {
  assert.equal(mentionTotal(reports[0].report.metrics), 132);
  assert.equal(mentionTotal(null), null);
});

test("metricSeries drops months with no working metrics and sorts oldest first", () => {
  const s = metricSeries(reports);
  assert.deepEqual(s.map((p) => p.month), ["2026-04", "2026-06", "2026-07"]);
});

test("deltaAt measures against the previous month in the series", () => {
  const s = metricSeries(reports);
  const d = deltaAt(s, "2026-07", selTotal);
  // 132 (Jul) vs 74 (Jun) = +58, +78%
  assert.deepEqual(d, { abs: 58, pct: 78, prevMonth: "2026-06" });
});

test("deltaAt steps over a month whose metric is missing", () => {
  const s = metricSeries(reports);
  // Jul backlinks 408; Jun 356; the delta is Jul-vs-Jun, and Apr (null backlinks) is skipped.
  assert.deepEqual(deltaAt(s, "2026-07", selBacklinks), { abs: 52, pct: 15, prevMonth: "2026-06" });
  // Jun backlinks 356; the only earlier month (Apr) has null backlinks, so no delta.
  assert.equal(deltaAt(s, "2026-06", selBacklinks), null);
});

test("deltaAt returns null for the first month with data", () => {
  const s = metricSeries(reports);
  assert.equal(deltaAt(s, "2026-04", selTotal), null);
});

test("compact formats big numbers", () => {
  assert.equal(compact(408), "408");
  assert.equal(compact(12900), "12.9K");
  assert.equal(compact(4_200_000), "4.2M");
  assert.equal(compact(null), "n/a");
});

test("lighthouseScore normalises both 0-to-1 and 0-to-100 scales", () => {
  assert.equal(lighthouseScore(61), 61); // already 0 to 100
  assert.equal(lighthouseScore(0.61), 61); // DataForSEO 0 to 1 fraction
  assert.equal(lighthouseScore(1), 100); // 1.0 is a perfect score, not 1%
  assert.equal(lighthouseScore(0), 0); // a real zero stays zero
  assert.equal(lighthouseScore(null), null); // not measured stays null, never 0
  assert.equal(lighthouseScore(undefined), null);
});

test("lighthouseBand uses Google's own thresholds and matches the PDF", () => {
  assert.equal(lighthouseBand(100), "good");
  assert.equal(lighthouseBand(90), "good");
  assert.equal(lighthouseBand(89), "mid");
  assert.equal(lighthouseBand(50), "mid");
  assert.equal(lighthouseBand(49), "bad");
  assert.equal(lighthouseBand(0), "bad");
  assert.equal(lighthouseBand(null), "na");
});
