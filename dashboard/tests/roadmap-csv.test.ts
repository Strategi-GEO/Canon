/**
 * The roadmap CSV serialiser, checked against RFC 4180's quoting rules and the one thing the
 * engine's padding makes non-obvious: trailing empty cells are the app's own padding and must
 * not become bare commas the operator never typed.
 *
 * Run it with:  node --test tests/roadmap-csv.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { sheetToCsv } from "../src/lib/roadmap-csv.ts";

test("plain cells serialise as one comma-joined line per row, CRLF between", () => {
  const csv = sheetToCsv(["Topic", "Scope"], [["A", "B"], ["C", "D"]]);
  assert.equal(csv, "Topic,Scope\r\nA,B\r\nC,D");
});

test("a field with a comma, quote or newline is quoted and inner quotes doubled", () => {
  const csv = sheetToCsv(
    ["h"],
    [["a,b"], ['he said "hi"'], ["line1\nline2"]],
  );
  assert.equal(csv, 'h\r\n"a,b"\r\n"he said ""hi"""\r\n"line1\nline2"');
});

test("trailing empty cells (the engine's row padding) are dropped, inner blanks kept", () => {
  // Row padded to width 4: the two trailing blanks go, the middle blank stays.
  const csv = sheetToCsv(["a", "b", "c", "d"], [["x", "", "y", ""]]);
  assert.equal(csv, "a,b,c,d\r\nx,,y");
});

test("a fully empty padded row serialises to an empty line, not commas", () => {
  const csv = sheetToCsv(["a", "b"], [["", ""]]);
  assert.equal(csv, "a,b\r\n");
});
