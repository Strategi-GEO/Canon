/**
 * COLUMN WIDTHS ARE A SUBSTRING TABLE AND THE FIRST HIT WINS, so this pins the ten house
 * headers to the widths they are meant to get.
 *
 * Run it with:  node --test tests/roadmap-xlsx.test.ts        (from dashboard/)
 *
 * The failure it exists to catch is silent: a rule keyed on a word two headers share ("content",
 * "query") sizes the second column for the first one's content, and the .xlsx still opens and
 * still looks like a spreadsheet. Nothing else in the app reads these numbers back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRoadmapSheet } from "../src/lib/roadmap-xlsx.ts";

const HOUSE = [
  "Content Topic",
  "What the Piece Covers",
  "Content Type",
  "Keyword Volume",
  "AI Search Volume",
  "Cost Per Click",
  "Keyword Difficulty",
  "Target Prompts",
  "Query Volume",
  "Query Intent",
];

test("every house header gets its own column's width", () => {
  const { columns } = buildRoadmapSheet(HOUSE, [], "Month 1 Roadmap");
  const width = Object.fromEntries(HOUSE.map((h, i) => [h, columns[i].width]));

  // Prose columns are wide, and the two widest are the two the writer actually reads.
  assert.equal(width["Target Prompts"], 52);
  assert.equal(width["What the Piece Covers"], 44);
  assert.equal(width["Content Topic"], 34);

  // Content Type must not inherit Content Topic's width, and Query Intent must not inherit
  // Query Volume's: those are the two shared first words in the contract.
  assert.equal(width["Content Type"], 18);
  assert.equal(width["Query Intent"], 18);

  // The three volume columns share one rule because each holds a bare number.
  assert.equal(width["Keyword Volume"], 14);
  assert.equal(width["AI Search Volume"], 14);
  assert.equal(width["Query Volume"], 14);
  assert.equal(width["Keyword Difficulty"], 14);
  assert.equal(width["Cost Per Click"], 12);
});

test("an operator's own header falls through to the middle width", () => {
  const { columns } = buildRoadmapSheet(["Notes to self"], []);
  assert.equal(columns[0].width, 26);
});
