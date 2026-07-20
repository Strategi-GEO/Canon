/**
 * The state machine's specification, executable.
 *
 * Run it with:  node --test tests/blog-state.test.ts        (from dashboard/)
 *
 * Node strips the types itself, and this module imports nothing but the thing it tests, so
 * there is no test framework to install and no build step between the source and the check.
 *
 * WHY A TRUTH TABLE RATHER THAN A HANDFUL OF CASES. Every state here decides what a person is
 * allowed to do to a real article, and the failure mode is silent: a wrong entry does not
 * crash, it just quietly offers a button that should not exist or hides one that should. The
 * table below is the specification written out in full, so a change to the policy has to be a
 * change to this file, made on purpose, rather than something that slips through because no
 * case happened to cover it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adminActions,
  adminCan,
  adminTag,
  adminUrgency,
  blogState,
  clientActions,
  clientCan,
  clientCanSee,
  clientTag,
  type BlogState,
} from "../src/lib/blog-state.ts";

const ALL_STATES: BlogState[] = [
  "generating",
  "has_questions",
  "internal_review",
  "client_review",
  "changes_requested",
  "approved",
  "published",
  "failed",
  "stopped",
  "unknown",
];

test("blogState: the record maps to exactly one state", () => {
  const cases: [string, Parameters<typeof blogState>[0], BlogState][] = [
    ["a live run", { status: "running" }, "generating"],
    [
      // THE RE-RUN CASE. status.jsonl outlives its run, so a second run on a topic still folds
      // to the FIRST run's terminal status. Only the registry knows, and without it `generating`
      // was reachable only on a topic's very first run.
      "a live re-run beats the stale terminal status underneath it",
      { status: "needs_review", live: true },
      "generating",
    ],
    [
      "live wins over every delivery stamp too",
      { status: "done", live: true, sent_to_client: "t", client_approved: "t", published: "t" },
      "generating",
    ],
    [
      "an explicit live:false is believed over a stale running status",
      { status: "running", live: false, sent_to_client: "t" },
      "client_review",
    ],
    [
      "a live run outranks every stamp under it",
      { status: "running", sent_to_client: "t", client_approved: "t", published: "t" },
      "generating",
    ],
    ["held on questions", { status: "needs_review" }, "has_questions"],
    ["passed and unsent", { status: "done" }, "internal_review"],
    ["sent", { status: "done", sent_to_client: "t" }, "client_review"],
    [
      "sent with a change request",
      {
        status: "done",
        sent_to_client: "t",
        changes_requested: 1,
        change_round_open: true,
      },
      "changes_requested",
    ],
    [
      // THE BUG THIS TEST EXISTS FOR. Resolving the last suggestion takes the live count to
      // zero, and the state must NOT fall back to client_review: that state has no admin
      // actions, so the fix the admin just made could never be sent. The round stays open
      // until a re-send.
      "resolving the last suggestion keeps the round open, so Send again survives",
      {
        status: "done",
        sent_to_client: "t",
        changes_requested: 0,
        change_round_open: true,
      },
      "changes_requested",
    ],
    [
      // Same bug by a different road: a failed apply is neither open nor applying, so the
      // count drops while the client's request is still outstanding.
      "a failed apply does not end the round",
      {
        status: "done",
        sent_to_client: "t",
        changes_requested: 0,
        change_round_open: true,
      },
      "changes_requested",
    ],
    [
      "re-sending closes the round and returns the article to the client",
      {
        status: "done",
        sent_to_client: "t",
        changes_requested: 0,
        change_round_open: false,
      },
      "client_review",
    ],
    [
      // A backend too old to report rounds falls back to the live count, which is exactly the
      // behaviour it had before the field existed.
      "an engine that does not report rounds falls back to the count",
      { status: "done", sent_to_client: "t", changes_requested: 2 },
      "changes_requested",
    ],
    [
      "approved outranks the send stamp",
      { status: "done", sent_to_client: "t", client_approved: "t" },
      "approved",
    ],
    [
      "approval outranks a change request that somehow survived it",
      { status: "done", sent_to_client: "t", client_approved: "t", changes_requested: 3 },
      "approved",
    ],
    [
      "published outranks approved",
      { status: "done", sent_to_client: "t", client_approved: "t", published: "t" },
      "published",
    ],
    [
      // A publish stamp with no send stamp must NOT reach `published`, because clientCanSee
      // grants that state and the portal would then serve an article nobody released.
      "a published article that was never sent is not client-visible",
      { status: "done", published: "t" },
      "internal_review",
    ],
    ["failed", { status: "failed" }, "failed"],
    ["stopped", { status: "stopped" }, "stopped"],
    ["no readable status line", { status: "unknown" }, "unknown"],
    ["a status this app does not know", { status: "banana" }, "unknown"],
  ];
  for (const [why, facts, expected] of cases) {
    assert.equal(blogState(facts), expected, why);
  }
});

test("blogState: absent and null delivery fields read the same", () => {
  assert.equal(blogState({ status: "done" }), "internal_review");
  assert.equal(
    blogState({ status: "done", sent_to_client: null, client_approved: null, published: null }),
    "internal_review",
  );
});

test("adminActions: the full policy, state by state", () => {
  const expected: Record<BlogState, string[]> = {
    generating: [],
    has_questions: ["answer"],
    internal_review: ["edit", "comments", "send"],
    client_review: [],
    changes_requested: ["edit", "comments", "send"],
    approved: ["publish"],
    published: ["publish"],
    failed: [],
    stopped: [],
    unknown: [],
  };
  for (const state of ALL_STATES) {
    assert.deepEqual([...adminActions(state)], expected[state], state);
  }
});

test("clientActions: the full policy, state by state", () => {
  const expected: Record<BlogState, string[]> = {
    generating: [],
    has_questions: ["answer"],
    internal_review: [],
    client_review: ["approve", "suggest", "reply"],
    changes_requested: ["reply"],
    approved: ["reply"],
    published: [],
    failed: [],
    stopped: [],
    unknown: [],
  };
  for (const state of ALL_STATES) {
    assert.deepEqual([...clientActions(state)], expected[state], state);
  }
});

test("an approved article is locked for BOTH sides", () => {
  // The whole point of the approved state. If any of these flip, the record can claim the
  // client approved bytes they never read.
  for (const state of ["approved", "published"] as BlogState[]) {
    assert.equal(adminCan(state, "edit"), false, `${state}: admin must not edit`);
    assert.equal(adminCan(state, "comments"), false, `${state}: admin must not comment`);
    assert.equal(adminCan(state, "send"), false, `${state}: admin must not re-send`);
    assert.equal(clientCan(state, "suggest"), false, `${state}: client must not suggest`);
    assert.equal(clientCan(state, "approve"), false, `${state}: nothing left to approve`);
  }
  // Posting is the one act left, because it changes nothing about the article.
  assert.equal(adminCan("approved", "publish"), true);
});

test("the admin cannot touch an article the client is reading", () => {
  // client_review pins the client to sent_version_id. An edit here changes the article
  // underneath someone mid-review, so every door is shut until they act.
  assert.deepEqual([...adminActions("client_review")], []);
});

test("nobody edits an article while a run owns it", () => {
  assert.deepEqual([...adminActions("generating")], []);
  assert.deepEqual([...clientActions("generating")], []);
});

test("answering is the only door when questions are open", () => {
  assert.deepEqual([...adminActions("has_questions")], ["answer"]);
  assert.deepEqual([...clientActions("has_questions")], ["answer"]);
});

test("clientCanSee: the client never sees the team's half", () => {
  const visible: BlogState[] = [
    "has_questions",
    "client_review",
    "changes_requested",
    "approved",
    "published",
  ];
  for (const state of ALL_STATES) {
    assert.equal(clientCanSee(state), visible.includes(state), state);
  }
});

test("a client can never act on a state they cannot see", () => {
  for (const state of ALL_STATES) {
    if (!clientCanSee(state)) {
      assert.deepEqual([...clientActions(state)], [], `${state} is invisible but offers actions`);
    }
  }
});

test("both tag maps are total, and no client label leaks internal vocabulary", () => {
  const leaks = ["score", "evaluator", "iteration", "gate", "dossier", "eval"];
  for (const state of ALL_STATES) {
    const a = adminTag(state);
    assert.ok(a.label.length > 0 && a.detail.length > 0, `admin tag missing for ${state}`);
    const c = clientTag(state);
    assert.ok(c.label.length > 0 && c.detail.length > 0, `client tag missing for ${state}`);
    const text = `${c.label} ${c.detail}`.toLowerCase();
    for (const word of leaks) {
      assert.ok(!text.includes(word), `client tag for ${state} leaks "${word}": ${text}`);
    }
    assert.equal(typeof adminUrgency(state), "number", `urgency missing for ${state}`);
  }
});

test("adminUrgency ranks every state distinctly, actionable first", () => {
  const ranks = ALL_STATES.map(adminUrgency);
  assert.equal(new Set(ranks).size, ALL_STATES.length, "two states share a rank");
  // The three an operator can actually move sort above the ones they cannot.
  for (const mine of ["has_questions", "changes_requested", "internal_review"] as BlogState[]) {
    for (const theirs of ["client_review", "approved", "published"] as BlogState[]) {
      assert.ok(adminUrgency(mine) < adminUrgency(theirs), `${mine} must outrank ${theirs}`);
    }
  }
});
