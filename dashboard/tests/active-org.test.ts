/**
 * WHICH ORGANISATION A ROUTE IS STANDING IN, pinned.
 *
 * Run it with:  node --test tests/active-org.test.ts        (from dashboard/)
 *
 * The sidebar's brand list, the switcher's label and tick, and the add-brand form's "this org
 * already exists" line all read this one answer, so a wrong entry here is not a crash: it is the
 * column quietly resetting to the org list while the form beside it is addressed to a specific
 * organisation, which is the defect this function exists to close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveActiveOrg } from "../src/components/shell/nav.ts";
import type { Client, Org } from "../src/types/index.ts";

const brand = (slug: string, name: string) => ({ slug, name }) as Client;

const ORGS: Org[] = [
  { slug: "learning-edge", name: "Learning Edge", brands: [brand("cucoon", "Cucoon")] },
  {
    slug: "new-india-electricals",
    name: "New India Electricals",
    brands: [brand("nie-retail", "NIE Retail"), brand("nie-trade", "NIE Trade")],
  },
];

test("the path wins wherever it names an org", () => {
  assert.equal(resolveActiveOrg(ORGS, "/admin/org/learning-edge", "")?.slug, "learning-edge");
  // Inside a brand too: the org is the first segment, whatever follows it.
  assert.equal(
    resolveActiveOrg(ORGS, "/admin/org/new-india-electricals/nie-trade/roadmap", "")?.slug,
    "new-india-electricals",
  );
  // A path org outranks a query one rather than being blended with it.
  assert.equal(
    resolveActiveOrg(ORGS, "/admin/org/learning-edge", "New India Electricals")?.slug,
    "learning-edge",
  );
});

test("?org= holds the org through the add-brand form", () => {
  assert.equal(
    resolveActiveOrg(ORGS, "/admin/new", "New India Electricals")?.slug,
    "new-india-electricals",
  );
  // ?org= carries a NAME, matched the way the engine matches it: case and padding are noise,
  // and the slug is not the key, so a hand-typed slug finds nothing rather than the wrong org.
  assert.equal(resolveActiveOrg(ORGS, "/admin/new", "  learning EDGE  ")?.slug, "learning-edge");
  assert.equal(resolveActiveOrg(ORGS, "/admin/new", "learning-edge"), null);
});

test("no org named is null, and so is one that does not exist yet", () => {
  assert.equal(resolveActiveOrg(ORGS, "/admin/new", ""), null);
  assert.equal(resolveActiveOrg(ORGS, "/admin/new", "   "), null);
  // The org-first flow: naming an org that does not exist creates it, so there is no brand list
  // to show and null is the honest answer rather than a near match.
  assert.equal(resolveActiveOrg(ORGS, "/admin/new", "Learning"), null);
  assert.equal(resolveActiveOrg(ORGS, "/admin/org/no-such-org", ""), null);
  assert.equal(resolveActiveOrg(ORGS, "/admin", ""), null);
});
