/**
 * The editable blog title (topics.title) is TOP precedence on every read surface: an operator
 * rename outranks the ledger topic and the writer's H1. That precedence is restated in FOUR
 * places — the hosted admin route, the client portal, and the engine's _blog_history override
 * (plus download-all, which shares the override's expression). A silent reorder in any one of
 * them re-buries the rename behind the H1 on that surface alone, which no single-surface test
 * would catch. This pins all four against the real source text, the same way gate-contract does.
 *
 * It does NOT model the precedence in TypeScript and check the model against itself (the failure
 * mode blog-state.test.ts documents): it asserts topics.title comes FIRST in the actual source.
 *
 * Run it with:  node --test tests/blog-title-precedence.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("hosted admin route lists topic.title first in the title precedence", () => {
  const src = read("../src/app/api/clients/[slug]/blogs/route.ts");
  assert.match(src, /topic:\s*topic\.title\s*\|\|\s*entry\?\.topic\s*\|\|\s*version\.h1_title\s*\|\|\s*topic\.slug/);
});

test("client portal lists topic.title first in the title precedence", () => {
  const src = read("../src/lib/server/portal-data.ts");
  assert.match(src, /title:\s*topic\.title\s*\|\|\s*entry\?\.topic\s*\|\|\s*latestVersion\.h1_title\s*\|\|\s*topic\.slug/);
});

test("engine _blog_history applies the topics.title override (non-null wins) and download-all shares it", () => {
  const src = read("../../server/app.py");
  // The override loop: a non-null topics.title replaces the entry's shown topic.
  assert.match(src, /select slug, title from topics where client_id = %s and deleted_at is null/);
  assert.match(src, /entries\[topic_slug\]\["topic"\] = edited/);
  // download-all derives its cover label AND its sort tiebreak from the same precedence helper,
  // so a sheet-less blog is never ordered by a title different from the one on its cover.
  assert.match(src, /return topic_title or \(led\.get\(topic_slug\) or \{\}\)\.get\("topic"\) or fallback/);
});

test("the rename endpoint refuses a blank title and caps its length", () => {
  const src = read("../../server/app.py");
  // Whitespace is collapsed (a title is a single-line label), then blank and over-long are 422.
  assert.match(src, /title = " "\.join\(body\.title\.split\(\)\)/);
  assert.match(src, /if not title:/);
  assert.match(src, /if len\(title\) > 300:/);
});
