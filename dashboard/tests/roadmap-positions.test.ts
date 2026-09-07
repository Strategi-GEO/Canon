/**
 * THE PROMPTS COLUMN HAS MOVED TWICE (5, then 8, now 7) and every move was silent on this side:
 * a grid that labels the wrong column "Target prompts", or reads a row's prompts out of a
 * neighbouring cell, still renders, still typechecks, and still looks like a spreadsheet. So this
 * pins the two dashboard readers to server/roadmap.py's own COL_PROMPTS rather than to a number
 * retyped here, which is the only way the constant and its readers cannot drift.
 *
 * It also pins the shape of roadmap_rows.extras, for the same reason: it is a jsonb ARRAY of
 * {label, value}, the preview grid looks each column up BY HEADER, and reading the array as an
 * object keyed every extra by "0", "1", "2" with the value "[object Object]". Nothing threw, no
 * type complained, and the client saw every figure column of their own sheet as an empty cell.
 *
 * Source-text assertions, in the idiom blog-title-precedence.test.ts uses, because buildRoadmap
 * talks to PostgREST and modelling it here would only test the model.
 *
 * Run it with:  node --test tests/roadmap-positions.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The engine's own constant, read out of the file that owns the contract. */
function enginePromptsIndex(): number {
  const found = /^COL_PROMPTS = (\d+)$/m.exec(read("../../server/roadmap.py"));
  assert.notEqual(found, null, "server/roadmap.py no longer declares COL_PROMPTS");
  return Number(found![1]);
}

test("both grids key the prompts column on the engine's COL_PROMPTS", () => {
  const prompts = enginePromptsIndex();

  // The admin preview's column role labels.
  assert.match(
    read("../src/components/roadmap/shared.tsx"),
    new RegExp(`if \\(index === ${prompts}\\) return "Target prompts";`),
  );
  // The portal rebuilds the same grid from the wire instead of the raw CSV.
  assert.match(
    read("../src/portal/roadmap-view.tsx"),
    new RegExp(`if \\(index === ${prompts}\\) return row\\.prompts\\.join`),
  );
});

test("the portal reads extras as an array of {label, value}, never as an object", () => {
  const src = read("../src/lib/server/portal-data.ts");
  assert.match(src, /extras: \{ label: string; value: string \}\[\] \| null;/);
  assert.match(src, /for \(const \{ label, value \} of row\.extras \?\? \[\]\)/);
  assert.doesNotMatch(src, /Object\.entries\(row\.extras/);
});

test("the portal reads a month's rows from ONE sheet, header and rows together", () => {
  const src = read("../src/lib/server/portal-data.ts");
  // Rows filtered by sheet_id: without it the no-month branch mixed every month's rows into
  // one grid under the latest month's header.
  assert.match(src, /roadmap_rows\?select=[^`]*`\s*\+\s*\n\s*`&client_id=eq\.\$\{brand\.client_id\}&sheet_id=eq\.\$\{sheet\.id\}/);
  // And the header row comes from that same sheet.
  assert.match(src, /columns: sheet\?\.columns \?\? \[\],/);
});
