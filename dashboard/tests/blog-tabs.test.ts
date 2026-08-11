/**
 * THE FOUR SUBTABS PARTITION EVERY TOPIC, AND THAT IS THE WHOLE OF WHAT THIS PINS.
 *
 * The Create tab and the Blogs tab merged into one page with New, Internal review, Client review
 * and Published. The failure mode a partition has is not a wrong answer, it is a MISSING one: a
 * BlogState added later that no tab claims makes rows vanish from the operator's page with nothing
 * on screen saying so, and one that two tabs claim shows the same work twice. Neither is visible
 * from reading any single rule, so the sweep over the full BlogState union below is the point.
 *
 * The second thing worth pinning is that CLIENT REVIEW IS `clientCanSee`, not a hand-written list.
 * That predicate is what the portal serves articles by, so if the two ever disagree an operator
 * reads "with the client" over an article the client cannot open, or the reverse. Deriving it
 * cannot drift; a copy of it can, and would.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { blogTab, hasDraft, tabOfState, type BlogTab } from "../src/lib/blog-tabs.ts";
import { blogState, clientCanSee, type BlogState } from "../src/lib/blog-state.ts";
import type { TabFacts } from "../src/lib/blog-tabs.ts";

/** Every state the union names. A new one added to blog-state.ts and not here fails the count. */
const ALL_STATES: BlogState[] = [
  "generating",
  "has_questions",
  "answers_submitted",
  "internal_review",
  "client_review",
  "changes_requested",
  "approved",
  "published",
  "failed",
  "died",
  "stopped",
  "unknown",
];

/** Facts that produce a given state, so the sweep below runs over real records. */
function factsFor(state: BlogState, score: number | null = 91): TabFacts {
  const base: TabFacts = { status: "done", score };
  switch (state) {
    case "generating":
      return { ...base, status: "running", live: true, score: null };
    case "has_questions":
      return { ...base, status: "needs_review" };
    case "answers_submitted":
      return { ...base, status: "needs_review", answers_submitted: "2026-08-01T00:00:00Z" };
    case "internal_review":
      return base;
    case "client_review":
      return { ...base, sent_to_client: "2026-08-01T00:00:00Z" };
    case "changes_requested":
      return { ...base, sent_to_client: "2026-08-01T00:00:00Z", change_round_open: true };
    case "approved":
      return { ...base, sent_to_client: "2026-08-01T00:00:00Z", client_approved: "2026-08-02T00:00:00Z" };
    case "published":
      return { ...base, sent_to_client: "2026-08-01T00:00:00Z", published: "2026-08-03T00:00:00Z" };
    case "failed":
      return { ...base, status: "failed" };
    case "died":
      return { ...base, status: "failed", died: true };
    case "stopped":
      return { ...base, status: "stopped" };
    case "unknown":
      return { ...base, status: "" };
  }
}

test("every state produces the state it claims to (the fixtures are honest)", () => {
  for (const state of ALL_STATES) {
    assert.equal(blogState(factsFor(state)), state, `fixture for ${state}`);
  }
});

test("every state lands in exactly one tab", () => {
  const seen = new Map<BlogState, BlogTab>();
  for (const state of ALL_STATES) {
    const tab = blogTab(factsFor(state));
    assert.ok(
      ["new", "internal", "client", "published"].includes(tab),
      `${state} produced ${tab}, which is not a tab`,
    );
    seen.set(state, tab);
  }
  assert.equal(seen.size, ALL_STATES.length);
});

test("client review is exactly clientCanSee, minus published", () => {
  for (const state of ALL_STATES) {
    const inClientTab = blogTab(factsFor(state)) === "client";
    const expected = clientCanSee(state) && state !== "published";
    assert.equal(
      inClientTab,
      expected,
      `${state}: tab says ${inClientTab}, clientCanSee says ${expected}`,
    );
  }
});

test("published outranks every other rule, including the client's possession", () => {
  assert.equal(blogTab(factsFor("published")), "published");
  // A published article is also client-visible; the order is what stops it being in two tabs.
  assert.ok(clientCanSee("published"));
});

test("a scored draft the client has not seen is on the team's bench", () => {
  for (const state of ["internal_review", "failed", "stopped", "died"] as BlogState[]) {
    assert.equal(blogTab(factsFor(state, 72)), "internal", `${state} at 72`);
  }
});

test("no score and no client visibility falls to New, whatever the status says", () => {
  for (const state of ["internal_review", "failed", "stopped", "died", "unknown"] as BlogState[]) {
    assert.equal(blogTab(factsFor(state, null)), "new", `${state} with no score`);
  }
});

test("a blog still generating is New: nothing has been scored yet", () => {
  assert.equal(blogTab(factsFor("generating")), "new");
});

test("a HELD blog goes to Client review even with no score, and that is not a special case", () => {
  // The window is narrow and real: questions.py writes the form BEFORE the evaluator emits its
  // SCORE line, so a session dying between the two leaves a current form and no number. It needs
  // no exception here because the client can see a held article, which is the rule already.
  assert.equal(blogTab(factsFor("has_questions", null)), "client");
  assert.equal(blogTab(factsFor("has_questions", 88)), "client");
});

test("an UPLOADED blog is a draft without a score, and never files as unwritten", () => {
  const uploaded: TabFacts = { status: "done", score: null, uploaded: true };
  assert.ok(hasDraft(uploaded));
  assert.equal(blogTab(uploaded), "internal");
  // The same record without the flag is the roadmap row nothing has written.
  assert.equal(blogTab({ status: "done", score: null }), "new");
});

test("hasDraft reads the evaluator's number, not the status word", () => {
  assert.ok(hasDraft({ status: "failed", score: 41 }));
  assert.ok(!hasDraft({ status: "done", score: null }));
  assert.ok(!hasDraft({ status: "stopped", score: null }));
});

test("tabOfState answers only where a state alone can decide", () => {
  assert.equal(tabOfState("published"), "published");
  assert.equal(tabOfState("client_review"), "client");
  assert.equal(tabOfState("has_questions"), "client");
  // No score in a state, so these two are genuinely undecidable from it and say so.
  assert.equal(tabOfState("internal_review"), null);
  assert.equal(tabOfState("failed"), null);
});
