/**
 * The blog-identifier rule, executable: AI-generated blogs wear their ROADMAP ROW number,
 * manually uploaded blogs are lettered A, B, C... in upload-date order. The failure mode is
 * silent (a wrong label reads as the wrong blog), so the mixed example lives here.
 *
 * Run:  node --test tests/blog-label.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { blogLabels } from "../src/lib/blog-label.ts";

// roadmap_index is ZERO-based, displayed as index + 1: row 1 is roadmap_index 0.
const ai = (slug: string, created: string, roadmapIndex: number | null) => ({
  topic_slug: slug,
  created,
  uploaded: false,
  roadmap_index: roadmapIndex,
});
const up = (slug: string, created: string, roadmapIndex: number | null = null) => ({
  topic_slug: slug,
  created,
  uploaded: true,
  roadmap_index: roadmapIndex,
});

test("AI blogs show their roadmap row, uploaded blogs letter by upload order", () => {
  // rows 1,2,3 (AI), an upload (A), an AI blog on row 4, another upload (B)  ->  1 2 3 A 4 B
  const labels = blogLabels([
    ai("a", "2026-01-01", 0),
    ai("b", "2026-01-02", 1),
    ai("c", "2026-01-03", 2),
    up("d", "2026-01-04"),
    ai("e", "2026-01-05", 3),
    up("f", "2026-01-06"),
  ]);
  assert.equal(labels.get("a"), "1");
  assert.equal(labels.get("b"), "2");
  assert.equal(labels.get("c"), "3");
  assert.equal(labels.get("d"), "A");
  assert.equal(labels.get("e"), "4"); // its roadmap row, unaffected by the upload
  assert.equal(labels.get("f"), "B");
});

test("uploaded letters follow upload date, not the order they arrive in", () => {
  const labels = blogLabels([
    up("second", "2026-02-02"),
    up("first", "2026-02-01"),
    ai("row", "2026-02-03", 4),
  ]);
  assert.equal(labels.get("first"), "A");
  assert.equal(labels.get("second"), "B");
  assert.equal(labels.get("row"), "5");
});

test("an uploaded article ON a roadmap row still gets a letter, never that row's number", () => {
  const labels = blogLabels([
    ai("r1", "2026-01-01", 0), // row 1 -> "1"
    up("onrow", "2026-01-02", 1), // row 2, but uploaded -> "A" (no blog shows "2")
    ai("r3", "2026-01-03", 2), // row 3 -> "3"
  ]);
  assert.equal(labels.get("r1"), "1");
  assert.equal(labels.get("onrow"), "A");
  assert.equal(labels.get("r3"), "3");
});

test("an AI blog on no roadmap row has no number", () => {
  const labels = blogLabels([
    ai("r1", "2026-01-01", 0),
    ai("orphan", "2026-01-02", null), // engine blog whose row was deleted -> dash
  ]);
  assert.equal(labels.get("r1"), "1");
  assert.equal(labels.get("orphan"), null);
});

test("uploaded letters roll past Z to AA", () => {
  const blogs = [];
  for (let i = 0; i < 27; i++) {
    blogs.push(up("u" + i, "2026-01-" + String(i + 1).padStart(2, "0")));
  }
  const labels = blogLabels(blogs);
  assert.equal(labels.get("u0"), "A");
  assert.equal(labels.get("u25"), "Z");
  assert.equal(labels.get("u26"), "AA");
});
