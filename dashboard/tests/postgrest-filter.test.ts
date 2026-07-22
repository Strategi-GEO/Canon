/**
 * The scalar eq-filter encoding for arbitrary strings (resource filenames).
 *
 * The regression this pins: eqValue once wrapped the value in double quotes, on the belief
 * that PostgREST strips them the way it does inside in.(...) lists. It does not for scalar
 * filters, so the quoted value matched the literal `"…"` and every resource whose name came
 * through here 404'd ("no resource ... for client ..."), starting with
 * "Blr Brewing Knowledge Base.docx.pdf". Verified against the live PostgREST: the unquoted
 * percent-encoded name matches the row, the quoted one matches nothing.
 *
 * Run it with:  node --test tests/postgrest-filter.test.ts        (from dashboard/)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { eqValue, inList } from "../src/lib/server/postgrest.ts";

test("eqValue never quotes: a real filename with spaces and dots", () => {
  assert.equal(
    eqValue("Blr Brewing Knowledge Base.docx.pdf"),
    "Blr%20Brewing%20Knowledge%20Base.docx.pdf",
  );
});

test("eqValue encodes parentheses, which PostgREST reads as logic grouping", () => {
  assert.equal(eqValue("price sheet (2026).csv"), "price%20sheet%20%282026%29.csv");
});

test("eqValue encodes commas, which separate filter arguments", () => {
  assert.equal(eqValue("a,b.txt"), "a%2Cb.txt");
});

test("inList keeps its quotes: in.(...) is the one place PostgREST strips them", () => {
  assert.equal(inList(["a", "b"]), 'in.("a","b")');
});
