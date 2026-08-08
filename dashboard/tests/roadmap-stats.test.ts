/**
 * THE ROADMAP TAB COUNTS ONE MONTH, and this pins which one.
 *
 * Run it with:  node --test tests/roadmap-stats.test.ts        (from dashboard/)
 *
 * The tab reads GET /roadmap with no month, which the engine answers with the newest sheet, so
 * `rows` IS this month and there is no month number to pass. The bug this replaces was visible
 * on screen: a month 2 sheet one day old reported ten blogs written and five shipped beside ten
 * topics remaining to write, because every one of those ten was month 1's. `remaining` had always
 * joined on the sheet and the outcomes had not, so one card contradicted the next.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { roadmapStats } from "../src/components/roadmap/roadmap-stats.ts";
import type { BlogSummary, RoadmapRow } from "../src/types/index.ts";

function row(topic_slug: string): RoadmapRow {
  return {
    index: 0,
    topic: topic_slug,
    topic_slug,
    covers: "",
    prompts: [],
    complete: true,
    missing: [],
    already_generated: false,
    ledger: null,
  } as unknown as RoadmapRow;
}

function blog(
  topic_slug: string,
  month: number | null,
  status: BlogSummary["status"] = "done",
): BlogSummary {
  return { topic: topic_slug, topic_slug, status, month } as BlogSummary;
}

test("an earlier month's blogs are counted by NO tile on this sheet", () => {
  const rows = [row("m2a"), row("m2b")];
  const blogs = [blog("m1a", 1), blog("m1b", 1, "failed"), blog("m1c", 1, "needs_review")];

  const stats = roadmapStats(rows, blogs);
  assert.equal(stats.topics, 2);
  assert.equal(stats.blogs, 0);
  assert.equal(stats.shipped, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.review, 0);
  // The contradiction the old counts produced: written and remaining now agree.
  assert.equal(stats.remaining, 2);
});

test("this month's blogs are counted, by the outcome each one ended on", () => {
  const rows = [row("a"), row("b"), row("c")];
  const blogs = [blog("a", 2), blog("b", 2, "needs_review"), blog("old", 1)];

  const stats = roadmapStats(rows, blogs);
  assert.equal(stats.blogs, 2);
  assert.equal(stats.shipped, 1);
  assert.equal(stats.review, 1);
  assert.equal(stats.remaining, 1);
});

test("an off-roadmap blog rides with THIS month, and can push blogs past topics", () => {
  // No sheet row, so it was made through /create/new while this month was current. It is the one
  // way `blogs` legitimately exceeds `topics`, and it is why the count is not just the sheet.
  const stats = roadmapStats([row("a")], [blog("a", 2), blog("manual", null)]);
  assert.equal(stats.topics, 1);
  assert.equal(stats.blogs, 2);
  assert.equal(stats.shipped, 2);
  assert.equal(stats.remaining, 0);
});
