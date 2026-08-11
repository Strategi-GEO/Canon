/**
 * WHICH MONTH A BLOG FILES UNDER, and what the Blogs tab's month picker therefore shows.
 *
 * A month is a roadmap sheet plus the blogs written from it. The engine derives `month` from the
 * sheet whose row asked for the topic rather than storing it, which is sound only because
 * deleting a month's roadmap deletes that month's blogs too (api_delete_roadmap): a blog can
 * never outlive the row that answers this.
 *
 * The case worth pinning is the NULL, because it is the one a reader gets wrong. A blog with no
 * sheet row was made off-roadmap, and generation is locked to the latest month, so it belongs to
 * the latest month rather than to nothing. Filtering those rows away instead would hide an
 * operator's own manual blog from every month there is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { inMonth, monthIndex, monthOf, postInMonth } from "../src/lib/blog-month.ts";
import type { BlogSummary } from "../src/types/index.ts";

function blog(topic_slug: string, month: number | null | undefined): BlogSummary {
  return {
    topic: topic_slug,
    topic_slug,
    created: "2026-08-01T00:00:00Z",
    score: 91,
    status: "done",
    iterations: 2,
    shipped: true,
    roadmap_index: null,
    month,
  } as BlogSummary;
}

test("a blog files under the month whose sheet asked for it", () => {
  assert.equal(monthOf(blog("a", 1), 2), 1);
  assert.equal(monthOf(blog("b", 2), 2), 2);
});

test("a blog with NO sheet row files under the latest month, never nowhere", () => {
  // Off-roadmap: /create/new or a hand-upload. Generation is locked to the latest month, so it
  // was necessarily made while that month was current.
  assert.equal(monthOf(blog("manual", null), 3), 3);
  assert.equal(monthOf(blog("manual", undefined), 3), 3);
  // A brand with no roadmap at all has no month to file under, and no picker either.
  assert.equal(monthOf(blog("manual", null), null), null);
});

test("selecting a month admits that month's blogs and no other", () => {
  const blogs = [blog("m1a", 1), blog("m1b", 1), blog("m2a", 2), blog("manual", null)];
  const pick = (m: number | null) =>
    blogs.filter((b) => inMonth(b, m, 2)).map((b) => b.topic_slug).sort();

  assert.deepEqual(pick(1), ["m1a", "m1b"]);
  // The off-roadmap blog rides with the latest month, which is 2 here.
  assert.deepEqual(pick(2), ["m2a", "manual"]);
});

test("no month means EVERY month, not 'blogs with no month'", () => {
  // The absence of a filter. The client portal and anything predating the picker pass nothing
  // and must keep seeing everything.
  const blogs = [blog("m1a", 1), blog("m2a", 2), blog("manual", null)];
  assert.equal(blogs.filter((b) => inMonth(b, null, 2)).length, 3);
  assert.equal(blogs.filter((b) => inMonth(b, undefined, 2)).length, 3);
});

test("a LinkedIn or Medium post files under its SOURCE blog's month", () => {
  // A repurpose has no roadmap row of its own. The sheet planned the BLOG, and the post exists
  // because that blog did, so the two must never sit in different months: an operator crossing
  // from Blogs to LinkedIn is looking for the same work.
  const index = monthIndex([blog("m1a", 1), blog("m2a", 2), blog("manual", null)], 2);

  assert.equal(postInMonth("m1a", index, 1, 2), true);
  assert.equal(postInMonth("m1a", index, 2, 2), false);
  assert.equal(postInMonth("m2a", index, 2, 2), true);
  assert.equal(postInMonth("m2a", index, 1, 2), false);
  // Repurposed from an off-roadmap blog, which rides with the latest month, so its post does too.
  assert.equal(postInMonth("manual", index, 2, 2), true);
});

test("a post whose source blog is missing falls to the latest month, never nowhere", () => {
  // The blogs list is still loading, or the source was deleted. Filing the post under no month at
  // all would hide it from every month there is, which loses it rather than classifying it.
  const index = monthIndex([blog("m1a", 1)], 2);
  assert.equal(postInMonth("gone", index, 2, 2), true);
  assert.equal(postInMonth("gone", index, 1, 2), false);
});

test("no month means EVERY post, exactly as it means every blog", () => {
  const index = monthIndex([blog("m1a", 1), blog("m2a", 2)], 2);
  assert.equal(postInMonth("m1a", index, null, 2), true);
  assert.equal(postInMonth("m2a", index, undefined, 2), true);
});
