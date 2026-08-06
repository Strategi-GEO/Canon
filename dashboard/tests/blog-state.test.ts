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
  adminCommentsTag,
  adminTag,
  adminUrgency,
  blogState,
  clientActions,
  clientCan,
  clientCanSee,
  clientCommentsTag,
  clientFacingState,
  clientTag,
  type AdminAction,
  type BlogState,
  type BlogStateFacts,
  type ClientAction,
} from "../src/lib/blog-state.ts";
import { BELOW_BAR_FLOOR, SHIP_BAR, adminFailedTag, scoreChipClass, scoreTone } from "../src/lib/blog-score.ts";
import {
  ADMIN_GATE_DOORS,
  adminGateAllows,
  type GateForm,
  type GateRecord,
} from "../src/lib/gate-contract.ts";

const ALL_STATES: BlogState[] = [
  "generating",
  "has_questions",
  // ALL_STATES IS A LITERAL AND NOTHING MAKES IT TOTAL, which is why a new member has to be
  // added here by hand. Every loop in this file walks this array, so a state left out of it is
  // not tested at all and nothing anywhere reports that: the suite goes green over a state whose
  // labels, actions, visibility and urgency were never checked once.
  "answers_submitted",
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
    [
      // THE SLOT, ABOVE has_questions. The mirror keeps saying needs_review from the submit
      // until the rerun writes its terminal line, because the form is still on disk and still
      // matches the iteration. Read the status alone and the client is asked, all over again,
      // for the answers they just gave.
      "an answered form outranks the needs_review the mirror still reports",
      { status: "needs_review", answers_submitted: "t" },
      "answers_submitted",
    ],
    [
      // THE SLOT, ABOVE internal_review, failed and stopped. The rerun lands on one of those
      // three, and only the first is a pass. All three are invisible to a client, so deriving
      // them here takes the article away from someone who acted on it seconds ago.
      "a clean rerun does not strip the article from the client who answered",
      { status: "done", answers_submitted: "t" },
      "answers_submitted",
    ],
    [
      "a crashed rerun does not strip it either",
      { status: "failed", answers_submitted: "t" },
      "answers_submitted",
    ],
    [
      // THE SLOT, BELOW the delivery ladder. A send is a newer human act than the submit and is
      // what ends this state, so the client moves on to reviewing the version we released.
      "a send ends the answered state",
      { status: "done", answers_submitted: "t", sent_to_client: "t" },
      "client_review",
    ],
    [
      "and every rung above the send ends it too",
      { status: "done", answers_submitted: "t", sent_to_client: "t", client_approved: "t" },
      "approved",
    ],
    [
      // THE SLOT, BELOW generating. The rerun is the exact thing this state waits for, so while
      // it is live the true answer is that the engine is working.
      "a live rerun outranks the submit that triggered it",
      { status: "needs_review", live: true, answers_submitted: "t" },
      "generating",
    ],
    [
      "an unanswered form is untouched by the new branch",
      { status: "needs_review", answers_submitted: null },
      "has_questions",
    ],
    [
      // An engine too old to report the stamp reports no submit, and the article reads exactly
      // as it did before this state existed rather than reaching a new one dishonestly.
      "an engine that does not report the stamp degrades to the old reading",
      { status: "done" },
      "internal_review",
    ],
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
      // THE PUSH ALONE, with no send anywhere on the record. Post to CMS is offered from
      // internal review and from failed, so this is the ordinary case and not a corner: the
      // operator pushed, and the row has to say so or their own act leaves no mark.
      //
      // THE CLIENT-FACING HALF OF THIS RULE IS NOT TESTED HERE BECAUSE IT IS NOT HERE ANY MORE.
      // `published` is a word the client vocabulary also names, and clientCanSee grants it, so
      // this exact record once served an internal draft to a client who was never sent it. The
      // guard moved to lib/server/portal-data.ts, which recomputes the client's state with the
      // push dropped whenever there is no send. Asserting internal_review here again would be
      // asserting the old location of a rule that still holds.
      "a CMS push with no send still reads published to the team",
      { status: "done", published: "t" },
      "published",
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
    // internal_review's bench PLUS the rerun, because this one state covers two situations: the
    // answers are in and the rerun is still owed, or the rerun landed and the article is a
    // finished draft nobody has delivered. The row read `[]` first, which stranded the second
    // situation, and then read internal_review's bench alone, which left the first one holding
    // three controls the database refuses. A ROW VALUE IS ALL THIS TEST CHECKS: it went green on
    // both of those, so the test that actually governs this row is the lower-layer one below.
    answers_submitted: ["answer", "edit", "comments", "send"],
    // One of exactly THREE states carrying `send`: this is where the operator decides the client
    // should see the article. Publish sits beside it because the operator may post to the CMS
    // directly, before the client is ever involved.
    internal_review: ["edit", "comments", "send", "publish"],
    // Publish ONLY: every act that touches the bytes stays absent while the client reads, and
    // there is no send because the article has already been sent. Posting to the CMS is the
    // operator's call at any point and alters nothing the client is reading.
    client_review: ["publish"],
    // NO SEND. Once an article is with the client it stays with them: the portal serves the
    // latest committed bytes in this state, so resolving a comment updates what they read
    // without a second delivery, and there is no round to re-close.
    changes_requested: ["edit", "comments", "publish"],
    // The approved lock covers the bytes; publish is the one act that changes nothing the
    // client approved.
    approved: ["publish"],
    // TERMINAL AND EMPTY: the article is live in the CMS and there is nothing left to offer.
    published: [],
    // The admin-review bench plus BOTH ship doors, and the client-facing one is now `send`, the
    // same verb internal_review carries. A separate `promote` verb described the identical act
    // with a different word and put two buttons on one bench; the engine promotes a failed topic
    // inside the send route (blog_edit.promote_if_failed) instead, so the trail still reads
    // "failed at 87, then a person shipped it" and no audit line was lost with the button.
    // Retrying stays a RUN, reached by link, not a verb here.
    failed: ["edit", "comments", "send", "publish"],
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
    answers_submitted: [],
    internal_review: [],
    client_review: ["approve", "suggest"],
    // The full client_review bench survives a filed comment: the client reads the latest
    // committed version continuously, so they keep suggesting against current bytes and may
    // approve mid-round (migration 005's portal_approve_blog has no open-comment refusal).
    changes_requested: ["approve", "suggest"],
    approved: [],
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
  // Posting is the one act left on approved, because it changes nothing about the article.
  assert.equal(adminCan("approved", "publish"), true);
  // Published is terminal and offers NOTHING, publish included: the article is live in the
  // CMS and a published post is administered there, not from this bench.
  assert.deepEqual([...adminActions("published")], []);
});

test("the admin cannot touch the BYTES of an article the client is reading", () => {
  // client_review pins the client to sent_version_id, so every door that writes a version is
  // shut until they act. `publish` is deliberately NOT in this list: posting to the CMS writes
  // no version and moves nothing under the reader, and the operator may do it at any point.
  for (const action of ["edit", "comments", "send"] as AdminAction[]) {
    assert.equal(
      adminCan("client_review", action),
      false,
      `client_review: "${action}" would move the article out from under the client mid-review`,
    );
  }
  assert.deepEqual([...adminActions("client_review")], ["publish"]);
});

test("send lives in exactly three states, and a sent article stays with the client", () => {
  // The operator's rule: `send` is the act of handing the article over, so it belongs where that
  // decision is made (internal_review), where the sticky submit stamp pins a landed rerun
  // (answers_submitted), and where a sub-90 draft is released on the operator's authority
  // (failed). Once an article is with the client there is no re-send: changes_requested resolves
  // comments against bytes the client already reads.
  const withSend = ALL_STATES.filter((state) => adminCan(state, "send"));
  assert.deepEqual(withSend, ["answers_submitted", "internal_review", "failed"]);
  assert.equal(adminCan("changes_requested", "send"), false, "no re-send once it is with them");
  assert.equal(adminCan("client_review", "send"), false, "already sent");
  // THE BELOW-BAR RELEASE IS THE SAME VERB, which is the whole of the change: a failed draft the
  // operator has read leaves by the button every other shipped blog leaves by, and the engine
  // promotes it on the way (server/app.py's send route calling blog_edit.promote_if_failed).
  assert.equal(adminCan("failed", "send"), true);
  // AND THE STATES THAT MUST NOT GAIN IT WITH IT. A hold is not discharged by a release, a
  // stopped run has no verdict to release, and a live run owns the bytes.
  for (const state of ["has_questions", "stopped", "generating"] as BlogState[]) {
    assert.equal(adminCan(state, "send"), false, `${state}: nothing here is the operator's to send`);
  }
});

test("`promote` is gone as an operator verb, from the bench and from the gate table", () => {
  // THE VERB IS DELETED, NOT PARKED. It named one half of a two-door model where a below-bar
  // draft shipped through a button of its own, and the send absorbed it whole. TypeScript already
  // refuses `adminCan(state, "promote")` because AdminAction no longer carries the member, and
  // that is exactly why this assertion is written over STRINGS: `npm test` strips types without
  // checking them, so a union member restored by a future edit would be caught only by the
  // typecheck script and never by this suite.
  for (const state of ALL_STATES) {
    assert.ok(
      !(adminActions(state) as readonly string[]).includes("promote"),
      `${state}: the promote verb is on the bench again, and there is only one ship door`,
    );
  }
  // The gate table is the other half: a door surviving its verb would keep the clauses alive for
  // a control nothing can reach, and gate-contract.test.ts's coverage test reads this same map.
  assert.ok(
    !Object.keys(ADMIN_GATE_DOORS).includes("promote"),
    "the promote door outlived the promote verb",
  );
});

test("posting to the CMS is available wherever the operator may decide to", () => {
  // The operator's rule: internal review, with client, changes requested, approved and failed.
  // A failed blog is promoted first by the engine (blog_edit.promote_if_failed, the helper the
  // send door now shares), so the CMS gate still only ever sees the literal `done`.
  for (const state of [
    "internal_review",
    "client_review",
    "changes_requested",
    "approved",
    "failed",
  ] as BlogState[]) {
    assert.equal(adminCan(state, "publish"), true, `${state}: publish must be offered`);
  }
  // And nowhere a push would be meaningless or unsafe: mid-run, held for answers, already
  // live, or with no settled draft at all.
  for (const state of [
    "generating",
    "has_questions",
    "published",
    "stopped",
    "unknown",
  ] as BlogState[]) {
    assert.equal(adminCan(state, "publish"), false, `${state}: publish must not be offered`);
  }
});

test("nobody edits an article while a run owns it", () => {
  assert.deepEqual([...adminActions("generating")], []);
  assert.deepEqual([...clientActions("generating")], []);
});

test("answering is the only door when questions are open", () => {
  assert.deepEqual([...adminActions("has_questions")], ["answer"]);
  assert.deepEqual([...clientActions("has_questions")], ["answer"]);
});

/**
 * WHO OWNS THE ACT THAT LEAVES EACH STATE.
 *
 * AT MODULE SCOPE BECAUSE TWO TESTS READ IT. The empty-bench test below asks whether an
 * admin-owned exit has any admin act at all, and the lower-layer test after it asks whether that
 * act is one the layers beneath this table will actually accept. They are the same partition
 * asked at two depths, so a second copy of it is a second thing to keep in step.
 *
 * THE PARTITION FOR THE UNDELIVERABLE ARTICLE, written as a total record rather than as a case
 * about one state, because what shipped was a CLASS of bug and not an entry.
 *
 * WHY THE ACTION TABLES CANNOT CATCH THIS BY THEMSELVES. Every entry in them is a positive
 * grant, so the tables can be read only for what they OFFER and never for what they OWE. That
 * makes an empty list ambiguous in the worst possible way: `client_review` is empty because the
 * admin must not touch bytes somebody is mid-review of, `generating` is empty because a run
 * owns the artifact, and `answers_submitted` was empty because nobody noticed. Three empty
 * lists, two of them the whole point of the table and one of them a trap, and nothing in the
 * table distinguishes them.
 *
 * THE FACT THAT DISTINGUISHES THEM IS NOT IN THE TABLES AT ALL. It is who owns the act that
 * LEAVES the state, which lives partly in blogState's ladder and partly in the producers that
 * feed it. Where a run leaves the state, an empty bench costs nothing: the engine writes a
 * terminal line and the article moves whether or not anyone pressed anything. Where the client
 * leaves it, an empty ADMIN bench is the feature. Where only an admin act leaves it, an empty
 * admin bench is a permanent stall, and it is a SILENT one: no error, no disabled control with
 * a tooltip, just an article that renders normally and can never go anywhere again.
 *
 * A STICKY PRODUCER IS WHAT TURNS THAT STALL INTO THE HAPPY PATH. server/app.py applies no
 * staleness and no expiry to the answers-submitted stamp, deliberately and with the reasoning
 * written out there, so a rerun landing clean at >= 90 with nothing new to ask leaves the
 * article pinned at `answers_submitted` until a SEND moves it past. An empty bench there meant
 * the single act that clears the pin was the single act the admin could not reach, so every
 * article taking the ordinary route through the question loop became undeliverable.
 *
 * OWNERSHIP IS PER STATE AND THE ACT IS NOT, which is the limit of this record and the reason
 * the lower-layer test after it exists. `answers_submitted` is admin-owned under both of the
 * situations it covers, and the admin's act is a different one in each. This record answers
 * WHO, correctly, and can say nothing about WHICH, so a bench holding the wrong admin act
 * satisfies it completely. That is exactly what happened after the empty list was fixed.
 *
 * WHY A TOTAL RECORD IS THE RIGHT SHAPE. This is a `Record<BlogState, ...>`, so TypeScript
 * refuses the file if a state joins the union and nobody classifies it here. That is the whole
 * value: a test enumerating the sticky states we happen to know about today goes green over the
 * fourth one somebody adds next month, which is exactly how this one survived two reviewers who
 * each flagged it. Forcing a per-state answer to "can a human get out of here" makes the next
 * dead end a compile error rather than a support ticket.
 */
const EXIT_OWNER: Record<BlogState, "run" | "client" | "admin" | "terminal"> = {
  // A run is in flight and its terminal line is the exit. Nothing on the page moves this.
  generating: "run",
  // Either side may answer, and the client's own bench is what the portal renders, so the
  // client is named here. The admin's `answer` is a second door onto the same act.
  has_questions: "client",
  // ADMIN, BY EITHER OF TWO ACTS, AND NEITHER OF THEM IS AN ENGINE'S. This entry used to justify
  // itself by claiming the rerun has already landed by the time the state is derived, and that
  // claim is FALSE: the state is reached at the client's Submit, the portal has no engine behind
  // it, and the auto-pickup sweep ships disabled, so in the ordinary case nothing has run at all.
  // Where the rerun is still owed, the admin's act is the RERUN. Where it has landed and left the
  // article pinned by the sticky submit stamp, the admin's act is the SEND. An engine moves this
  // state only when an admin dispatches one, which is what makes the owner an admin either way,
  // and the false reasoning is what let a bench carrying only the second act look complete.
  answers_submitted: "admin",
  // The refining bench. The admin decides when the client sees it.
  internal_review: "admin",
  // The client owes an approval or a change request, and until one lands there is correctly
  // nothing for the admin to do.
  client_review: "client",
  // The round stays open until a re-send, so the admin resolving the last suggestion does not
  // move the article: pressing Send does. The client now shares this exit, because approving
  // mid-round also leaves the state, but the send is still the act the state exists to demand
  // and a client approval is never owed, so the admin bench is the one that must not be empty.
  changes_requested: "admin",
  // Locked, and publish is the one remaining act.
  approved: "admin",
  // TERMINAL IN THE STRICT SENSE: there is no exit because there is nowhere left to go. The
  // article is live on the client's site, and by the operator's rule this bench offers nothing
  // at all, re-publishing included. An empty bench is honest here rather than a stall, which is
  // exactly what the "terminal" classification exists to say: the liveness test below asserts a
  // non-empty bench only where a human act is genuinely owed, and nothing is owed on an article
  // that already shipped. A push that genuinely broke is re-driven from the CMS, which is where
  // a published post is administered.
  published: "terminal",
  // Two exits now, and the admin owns the one on the bench: the SEND, the operator releasing a
  // sub-90 draft they have read on their own authority. Generating the topic again remains the
  // other exit and remains a RUN (the stage links to the Create tab with the row pre-ticked),
  // but a state an admin act can leave must carry that act, which is what this classification
  // asserts of the bench below.
  failed: "admin",
  // These two leave only by generating the topic again, which is a new run and not a verb on
  // this page, so an empty bench is honest for both: a stopped topic has no verdict at all, so
  // there is nothing to release.
  stopped: "run",
  unknown: "run",
};

test("no state that only an admin act can leave is left with an empty admin bench", () => {
  for (const state of ALL_STATES) {
    if (EXIT_OWNER[state] === "admin") {
      assert.ok(
        adminActions(state).length > 0,
        `${state}: only an admin act leaves this state, so an empty admin action list strands ` +
          `every article that reaches it, silently and for good`,
      );
    }
    if (EXIT_OWNER[state] === "client") {
      assert.ok(
        clientActions(state).length > 0,
        `${state}: only a client act leaves this state, so an empty client action list strands it`,
      );
    }
  }

  // THE SHARPER CLAIM, stated separately because a non-empty bench is not enough on its own. A
  // state whose pinning fact is cleared by a send specifically needs SEND on the bench, and an
  // article granted `edit` and `comments` alone would pass the loop above while still having no
  // way out. These are the two PRE-DELIVERY states, and a send is what ends each of them: the
  // submit stamp is outranked by sent_to_client, and internal_review is left by the first send.
  //
  // `changes_requested` IS NOT ONE OF THEM ANY MORE, and that is the re-send leaving the product
  // rather than an omission. A sent article stays with the client: the portal serves the latest
  // committed bytes in that state, so a resolved comment reaches them without a second delivery,
  // and what leaves the state is their approval. The bench there is not empty (edit, comments,
  // publish), so the loop above still holds it to having somewhere to go.
  //
  // STILL NOT ENOUGH ON ITS OWN EITHER, and the next test is the rest of it. This loop asks only
  // whether the send is GRANTED, which is a question about this table, and `answers_submitted`
  // grants one in a situation where migration 009 refuses it outright. A granted act the layer
  // below rejects is not an exit, so the send belonging on the bench and the send being usable
  // are two claims, and only the first one is checked here.
  for (const state of ["answers_submitted", "internal_review"] as BlogState[]) {
    assert.equal(
      adminCan(state, "send"),
      true,
      `${state}: a send is what clears this state, so the admin must be offered one`,
    );
  }
});

/**
 * WHAT THE LAYERS UNDER THIS TABLE WILL ACTUALLY ACCEPT, ASKED OF THE CONTRACT RATHER THAN
 * RESTATED HERE.
 *
 * A HAND MODEL USED TO SIT AT THIS SPOT AND IT WAS THE DEFECT, NOT THE GUARD. It restated, in
 * TypeScript, the refusals that live in migration 009 and in server/app.py, each with a file and
 * line citation, on a premise written out at length: that nothing in this process can reach
 * Postgres, so a modelled gate was the only gate available. THE PREMISE IS FALSE. This process
 * cannot reach Postgres and it can trivially reach the SQL FILE, which is where the rule is
 * written, and reading the rule beats re-typing it.
 *
 * WHAT THE RESTATEMENT COST. It was wrong twice and this suite stayed green both times, because a
 * green invariant over a hand model proves only that the model agrees with itself. Round four
 * modelled the revise route as one condition out of seven and certified a control that 409s. Round
 * five replaced it with a derivation off the stated biconditional
 * "status === needs_review <=> a current answerable form exists", which the engine does not hold:
 * revise_topic's three restore arms append a terminal line carrying prev_terminal["status"]
 * without passing it through _enforce_terminal_status, so a spent or stale form sits beside
 * needs_review routinely. That derivation was written into THIS FILE as the model, so the model
 * and the code under test shared one wrong belief and agreed perfectly.
 *
 * SO THE MODEL IS GONE AND THE CONTRACT ANSWERS INSTEAD. gate-contract.ts holds each refusal as a
 * clause carrying the verbatim source line that performs it, and tests/gate-contract.test.ts
 * re-derives those lines and a fingerprint of every gating function from
 * supabase/migrations/009_admin_write_tier.sql and server/app.py on every run. Change the gate in
 * SQL and touch no TypeScript and that suite goes red. This file no longer has an opinion about
 * what the database does, which is the only way it can stop being wrong about it.
 *
 * WHAT REMAINS BELOW IS THE DELIVERY LADDER, AND IT IS NOT A RESTATEMENT. The approved lock, the
 * out-with-client refusal and the open-suggestion WHERE clause all turn on the send, approval and
 * change-round stamps, which are the very facts blogState is computed FROM. They are not facts the
 * state folds away, so there is no second key for them to come apart on, and gate-contract.ts
 * names each of them as deliberately out of its scope for that reason. Checking them here is
 * checking that this file agrees with itself about its own inputs, which is a fair thing for this
 * file to do and the only thing it is still qualified to say.
 */
function lowerLayerAccepts(
  action: AdminAction,
  facts: BlogStateFacts,
  form: GateForm,
): boolean {
  // The status and the question form, from the one definition that is checked against the SQL and
  // the Python. Nothing here re-derives either.
  if (!adminGateAllows(action, { record: facts, form })) {
    return false;
  }
  // A live run derives `generating`, whose bench is empty, so this can never actually be reached.
  // It is written anyway, because a bench that depended on an unreachable case staying unreachable
  // is the shape of guard this whole area keeps learning not to trust.
  if (facts.live) {
    return false;
  }
  switch (action) {
    // The approved lock (migration 013's refuse_version_when_approved and
    // refuse_comment_when_approved, plus _require_not_approved) and the out-with-client refusal
    // (_require_not_with_client, which is "sent AND no change round open", exactly blogState's
    // `client_review`). Both read stamps blogState is computed from.
    case "edit":
    case "comments":
      return (
        !facts.client_approved &&
        !(facts.sent_to_client && !(facts.change_round_open ?? (facts.changes_requested ?? 0) > 0))
      );
    // The approved lock again, plus mark_sent's open-suggestion WHERE clause, mirrored on the
    // hosted build by 009:202. A WHERE clause rather than a pre-check, so zero rows IS the
    // refusal, and `changes_requested` counts exactly the top-level client comments in state open
    // or applying that the clause tests.
    //
    // EVERYTHING THE ABSORBED PROMOTE DOOR USED TO CHECK IS ALREADY ANSWERED ABOVE, by the
    // contract rather than restated here: terminal failed with a scored draft on the wire
    // (DONE_TOPIC_ENGINE and PROMOTES_SCORED_DRAFT) and no live run (SEND_NOT_IN_FLIGHT). What
    // is left for this ladder is the pair every send has always carried one level down, and a
    // below-bar release ends in the same mark_sent an ordinary one does.
    case "send":
      return !facts.client_approved && (facts.changes_requested ?? 0) === 0;
    // Both doors behind this verb refuse an approved article, and the answer door is where that
    // matters: an answer dispatches a surgical revise, which rewrites the draft and commits a
    // version, so it is a full edit reached through the answer door. `approved` is a state whose
    // bench grants no `answer`, so this is belt and braces rather than the thing that saves it.
    case "answer":
      return !facts.client_approved;
    // NOT GATED ON ANY FACT IN THIS RECORD: the CMS push turns on which VERSION the client
    // approved against which is latest, which BlogStateFacts does not carry. Modelling a rule
    // this record cannot express would be inventing a refusal.
    case "publish":
      return true;
  }
}

/** One real record an article can be in, and the act it is actually waiting on. */
type Situation = {
  /** What has happened to this article, in a sentence, for the assertion message. */
  what: string;
  /** GateRecord rather than BlogStateFacts for one field: the promote door reads the score. */
  facts: GateRecord;
  /**
   * The question form this record carries, STATED rather than derived from the status.
   *
   * DERIVING IT WAS THE FIFTH ROUND OF THIS DEFECT. The comment under `moves` below used to argue
   * that a `failed` or `stopped` record cannot carry a current form, because
   * _enforce_terminal_status would have corrected the status back to needs_review if one existed.
   * That resolver is exactly what revise_topic's three restore arms skip: each appends a terminal
   * line carrying prev_terminal["status"], so the status is copied forward and never re-derived
   * from the form. A situation therefore has to say which form it holds, because the record it
   * describes does not imply one.
   */
  form: GateForm;
  /** Asserted, so a situation cannot quietly stop describing the state it claims to. */
  state: BlogState;
  /**
   * The single act that moves this article onward, or "run" where nothing on the bench does.
   *
   * "run" IS A REAL ANSWER AND NOT AN EXCUSE, and the corrected `answer` model is what forced it
   * onto this type. A rerun that crashes leaves `failed` under a submit stamp and one the operator
   * stops leaves `stopped`, and both derive `answers_submitted`. Neither carries a current
   * question form, because runner.py _enforce_terminal_status (:817) would have corrected the
   * status back to needs_review if one existed, so the rerun is refused; neither is `done`, so
   * every write act is refused too. The exit is generating the topic again, which is not a bench
   * act and never was: `failed` and `stopped` proper have carried an empty bench since this file
   * was written, for exactly the same reason.
   *
   * IT IS HELD TO A STRICTER PROPERTY THAN AN ACT IS, not a weaker one. Where a situation names
   * an act, the test asserts the act is granted AND accepted. Where it names "run", the test
   * asserts that NOTHING reaches the operator as a pressable control that the record would
   * refuse, so the escape hatch cannot be used to wave through an offered-but-refused button. It
   * is the honest liveness answer for these records rather than a hole in the invariant.
   */
  moves: AdminAction | "run";
};

const SITUATIONS: Situation[] = [
  {
    // SITUATION (a). The portal has no engine, so the Submit dispatched nothing, and the
    // auto-pickup sweep returns unless GEO_ANSWERS_PICKUP=1. The mirror still reports
    // needs_review because the form is on disk and iteration-matched.
    what: "the client answered from their portal and no rerun has run",
    facts: { status: "needs_review", answers_submitted: "t" },
    // Current and answered, which is what makes the RERUN door the live one: POST /revise wants a
    // form that is not stale and IS answered, and this is the only situation in the table with
    // both.
    form: { stale: false, answered: true },
    state: "answers_submitted",
    moves: "answer",
  },
  {
    // SITUATION (b), the happy path. A rerun that lands clean at >= 90 with nothing new to ask
    // leaves the article pinned here by the sticky submit stamp, and only a send moves it.
    what: "the rerun landed clean and left the article pinned by the sticky submit stamp",
    facts: { status: "done", answers_submitted: "t" },
    // ROUND 4, PINNED AS A FORM RATHER THAN INFERRED FROM A STATUS. The clean rerun committed a
    // new blog_versions row, which moves the form's anchor, and server/sync.py spares ANSWERED
    // evaluator rows from its post-revise delete, so the spent form survives and is stale. Both
    // doors behind `answer` refuse it, which is why the send is the act here.
    form: { stale: true, answered: true },
    state: "answers_submitted",
    moves: "send",
  },
  {
    // NOT THE SAME SHAPE AS (a), WHICH IS WHAT ROUND 4 GOT WRONG HERE. This situation used to
    // claim `answer` moved it, on the reasoning that a crashed rerun leaves the answers owed
    // their revise. The record disagrees: a `failed` terminal status over a CURRENT form is
    // corrected back to needs_review by runner.py _enforce_terminal_status (:825 to :830), so a
    // form that survives beside a `failed` status is by construction not current, and
    // server/app.py:1538 refuses the rerun as stale. The answers are spent, the draft they were
    // meant to clarify is gone, and generating the topic again is the only thing left.
    what: "the rerun crashed, leaving a spent form the revise route refuses as stale",
    facts: { status: "failed", answers_submitted: "t" },
    form: { stale: true, answered: true },
    state: "answers_submitted",
    moves: "run",
  },
  {
    // The same reasoning by the stop path, which holds a topic at needs_review rather than
    // recording it stopped whenever a form is still live (runner.py:531). A `stopped` status
    // therefore also implies no current form.
    what: "the operator stopped the run, and the form it left behind is no longer current",
    facts: { status: "stopped", answers_submitted: "t" },
    form: { stale: true, answered: true },
    state: "answers_submitted",
    moves: "run",
  },
  {
    what: "passed, unsent, and sitting on the refining bench",
    facts: { status: "done" },
    form: "absent",
    state: "internal_review",
    moves: "send",
  },
  {
    // The send is refused here by the WHERE clause, correctly, and the act that moves the article
    // is working through the rail. This is the case that proves the property is "some accepted
    // act" rather than "the send is accepted".
    what: "the client's suggestions are still open",
    facts: { status: "done", sent_to_client: "t", changes_requested: 2, change_round_open: true },
    form: "absent",
    state: "changes_requested",
    moves: "comments",
  },
  {
    // THE RE-SEND IS GONE FROM THE PRODUCT, so the act that moves this article is the last
    // resolve, not a delivery. Once an article is with the client it stays with them: the
    // portal serves the latest committed bytes in this state, so resolving the final comment
    // IS the delivery, and the client reads the fix without a second send. What leaves the
    // state is their approval, which is theirs to give, and `publish` remains on the bench as
    // the operator's own act on a record they may post at any time.
    what: "every suggestion resolved, the round still open, the client reads the fix",
    facts: { status: "done", sent_to_client: "t", changes_requested: 0, change_round_open: true },
    form: "absent",
    state: "changes_requested",
    moves: "publish",
  },
  {
    what: "the client approved these exact bytes",
    facts: { status: "done", sent_to_client: "t", client_approved: "t" },
    form: "absent",
    state: "approved",
    moves: "publish",
  },
  {
    // TERMINAL: nothing on this page moves a published article, and nothing needs to. It is
    // live on the client's site, so the bench is empty by design rather than stalled, and
    // `moves: "run"` is how a situation says "no bench act owns this record" (the same value
    // the mid-run and stopped situations carry). The assertion that applies here is the
    // stronger one: not a single control renders that the record would then refuse.
    what: "already live in the CMS, where nothing on this bench applies",
    facts: { status: "done", sent_to_client: "t", client_approved: "t", published: "t" },
    form: "absent",
    state: "published",
    moves: "run",
  },
  {
    // The operator's own exit from a failure, and it is the ORDINARY send verb now. The loop
    // stalled below 90 with nothing left to ask, the best draft keeps its evaluator score on the
    // wire, and one press releases it: the route promotes it on the operator's authority
    // (blog_edit.promote_if_failed) and stamps the send in the same act. The SCORELESS failure
    // is modelled below rather than here, because the door refuses it and a situation names the
    // act that MOVES the article.
    what: "the loop stalled below 90 with nothing to ask, and the operator ships it anyway",
    facts: { status: "failed", score: 87 },
    form: "absent",
    state: "failed",
    moves: "send",
  },
  {
    // THE OTHER HALF OF THE FAILED BENCH, and it is the boundary the one ship door did not
    // widen. No evaluator ever scored a draft, so there is nothing the operator can take
    // responsibility for: the send door refuses it through PROMOTES_SCORED_DRAFT, the promotion
    // never happens, and the status stays failed. `moves: "run"` is the honest answer, and the
    // stronger assertion it carries is the one that matters here: every control this bench
    // renders over this record must be withheld or declared, never a press that fails.
    what: "the run died before any evaluator scored a draft, so there is nothing to release",
    facts: { status: "failed" },
    form: "absent",
    state: "failed",
    moves: "run",
  },
];

test("every admin bench offers an act the layers under it will accept", () => {
  for (const situation of SITUATIONS) {
    const state = blogState(situation.facts);
    assert.equal(state, situation.state, `${situation.what}: derives ${state}, not the state claimed`);

    // The acts that actually reach the operator as a pressable control AND survive the record.
    // Both halves of that matter and neither is enough: a grant the offer layers withhold is not
    // a door, and a control the record refuses is not one either.
    const usable = adminActions(state).filter(
      (action) =>
        isOffered(action, situation.facts, situation.form) &&
        lowerLayerAccepts(action, situation.facts, situation.form),
    );

    if (situation.moves === "run") {
      // NO BENCH ACT MOVES THIS RECORD, and the claim being checked is that the page is honest
      // about it rather than that it is empty. `usable` may be zero here, so the liveness
      // assertion below does not apply, and in its place this asserts the STRONGER thing: not one
      // control renders that the record would then refuse. The honesty test enumerates the same
      // property over every reachable record; this states it on the situation, where the
      // sentence naming the real exit lives.
      const offeredAndRefused = adminActions(state).filter(
        (action) =>
          isOffered(action, situation.facts, situation.form) &&
          !lowerLayerAccepts(action, situation.facts, situation.form),
      );
      assert.deepEqual(
        offeredAndRefused.filter((action) => !DECLARED_REFUSALS[`${state}:${action}`]),
        [],
        `${state} where ${situation.what}: the exit here is generating the topic again, so every ` +
          `bench act must be withheld or must explain itself, and these do neither`,
      );
      continue;
    }

    // THE GRANT AND THE ACCEPTANCE, ASSERTED SEPARATELY, because the two failures they catch are
    // opposite and the messages have to say which one happened. A missing grant is this table
    // withholding a control; a refused act is this table offering one that argues with the record.
    assert.ok(
      adminCan(state, situation.moves),
      `${state} where ${situation.what}: the act that moves this article is "${situation.moves}", ` +
        `and the admin bench does not carry it, so the operator has no way to move it`,
    );
    assert.ok(
      lowerLayerAccepts(situation.moves, situation.facts, situation.form),
      `${state} where ${situation.what}: "${situation.moves}" is on the bench and the layer below ` +
        `refuses it for this exact record, so the control is offered and cannot work`,
    );

    // The property itself, stated over the whole bench. It is implied by the pair above, and it is
    // written out because it is the sentence a reader needs: every article has a reachable act.
    assert.ok(
      usable.length > 0,
      `${state} where ${situation.what}: every act on the bench (${adminActions(state).join(", ")}) ` +
        `is refused by a layer below, so this article is a dead end with buttons on it`,
    );
  }

  // EVERY ADMIN-OWNED STATE IS MODELLED HERE. Without this, a state added to the union with an
  // admin exit is classified in EXIT_OWNER, passes the non-empty check, and is never once tested
  // against a layer that could refuse its bench. That is the gap this whole test exists to close,
  // so leaving it open one level up would be the same mistake in a different file.
  const modelled = new Set(SITUATIONS.map((situation) => situation.state));
  for (const state of ALL_STATES) {
    if (EXIT_OWNER[state] === "admin") {
      assert.ok(modelled.has(state), `${state} is admin-owned and no situation above models it`);
    }
  }
});

test("the two situations inside answers_submitted want different acts", () => {
  // THE BUG, PINNED AS A PAIR, because neither half of it is wrong on its own and the whole
  // failure is that one bench was asked to serve both. This is the assertion that fails on the
  // empty list AND on the ["edit", "comments", "send"] that replaced it.
  const rerunOwed: BlogStateFacts = { status: "needs_review", answers_submitted: "t" };
  const rerunLanded: BlogStateFacts = { status: "done", answers_submitted: "t" };
  // THE FORMS ARE STATED, NOT INFERRED FROM THE STATUSES ABOVE, and that is round five's whole
  // correction. This test used to hold that `needs_review` implied a current form and every other
  // status implied a spent or absent one, off a biconditional the engine does not enforce:
  // revise_topic's restore arms copy a terminal line forward without ever re-deriving it from the
  // form. Situation (a)'s form is current and answered because the portal recorded answers and
  // dispatched nothing; situation (b)'s is stale because the clean rerun committed a new version
  // and moved the anchor, while sync.py spared the answered row from its delete.
  const owedForm: GateForm = { stale: false, answered: true };
  const landedForm: GateForm = { stale: true, answered: true };

  assert.equal(blogState(rerunOwed), "answers_submitted");
  assert.equal(blogState(rerunLanded), "answers_submitted", "one state, deliberately, for the client's sake");

  // The database is RIGHT to refuse this and the UI is what has to reconcile. admin_done_topic
  // reads the fold and a blog mid question loop is not done, so sending it would deliver an
  // article whose answers nobody has applied.
  assert.equal(
    lowerLayerAccepts("send", rerunOwed, owedForm),
    false,
    "migration 009 refuses a send on a blog that is not done, which is why a second act is needed",
  );
  assert.equal(lowerLayerAccepts("send", rerunLanded, landedForm), true);

  // So the bench has to carry the rerun as well, and `answer` is what that control is called:
  // AnswerQuestions renders the Rerun strip for a client-answered form, and blog-stage.tsx mounts
  // it behind adminCan(state, "answer"). Withhold it and situation (a) has nothing at all.
  assert.equal(
    adminCan("answers_submitted", "answer"),
    true,
    "the rerun is the only act situation (a) can take, and `answer` is the control that dispatches it",
  );
  assert.equal(
    adminCan("answers_submitted", "send"),
    true,
    "and situation (b) still needs the send, which is why the row carries both rather than swapping one for the other",
  );
  assert.equal(
    lowerLayerAccepts("answer", rerunOwed, owedForm),
    true,
    "the revise route needs a form that is not stale and IS answered, which is this one exactly",
  );

  // ROUND 4, PINNED, and this is the assertion the previous fix could not have made. The revise
  // route does NOT gate on approval alone: it refuses a stale form at server/app.py:1538, and a
  // rerun that has landed has committed a new version, which is what makes the form stale. So the
  // rerun is refused in exactly the situation the send is accepted, and the two acts partition
  // this state rather than overlapping in it.
  assert.equal(
    lowerLayerAccepts("answer", rerunLanded, landedForm),
    false,
    "the rerun has already run and its form is spent, so a second dispatch 409s as stale",
  );
  // AND THE CONTROL IS WITHHELD RATHER THAN LEFT TO ARGUE, which is the half that lives in the
  // components. Round 4 granted `answer` here with nothing in front of it, on a comment claiming
  // AnswerQuestions would find no form: it finds the answered one, because sync.py spares
  // answered rows from the post-revise delete, and it draws the Rerun button over it.
  assert.equal(
    isOffered("answer", rerunLanded, landedForm),
    false,
    "blog-stage.tsx must not mount the Rerun strip over a form the revise route refuses",
  );
  assert.equal(
    isOffered("answer", rerunOwed, owedForm),
    true,
    "and it must mount it where the rerun works",
  );
});

/**
 * THE OTHER HALF OF THE PROPERTY, AND THE HALF THAT HAS NEVER BEEN ASSERTED.
 *
 * The test above proves LIVENESS: every admin-owned state offers at least one act that the layers
 * beneath it accept, so no article is a dead end. That is a real property and it is not the one
 * this bug keeps escaping through. An article can satisfy it completely while still handing the
 * operator two controls that argue with the record, because "some act works" says nothing about
 * the acts that do not, and `usable.length > 0` is true of a bench that is three quarters refused.
 *
 * SO THIS TEST ASSERTS HONESTY: no state offers an act that the layers beneath it refuse. It is
 * the exact claim the previous two fixes were defended with and the exact claim nothing checked.
 * Round 1 read `[]` and stranded the article. Round 2 read ["edit", "comments", "send"] and moved
 * the dead end down a layer. Round 3 read ["answer", "edit", "comments", "send"], which bought
 * liveness with `answer` and left `edit` and `comments` sitting there refused by migration 009 for
 * the entire pre-rerun window. Every one of those went green above.
 *
 * IT IS INDEXED BY RECORD AND ENUMERATES ALL OF THEM PER STATE, which is the whole mechanism. The
 * defect is not a wrong row: it is that ADMIN_ACTIONS is keyed by STATE while every layer under it
 * gates on STATUS, and `answers_submitted` deliberately folds two statuses into one state. A
 * single representative record per state cannot express that, so a suite built on representatives
 * will keep certifying a bench that is right for one of the two situations and wrong for the
 * other. REACHABLE below carries every record a state can actually hold.
 *
 * AN EXCEPTION IS A DECISION ON THE RECORD, NEVER AN OVERSIGHT. There are real cases where an act
 * is offered while the record refuses it and that is the correct experience, because a layer in
 * front of the button either withholds it or greys it with a sentence naming what to do instead.
 * Those are legitimate and they are also indistinguishable, from inside this file, from the bug.
 * The difference is made by declaring them: an act refused with no entry in DECLARED_REFUSALS
 * fails, and an entry that no record exercises fails too, so the table cannot rot into a list of
 * excuses covering acts nobody offers any more.
 */
/**
 * EVERY SHAPE THE QUESTION FORM CAN BE IN, walked against every record below.
 *
 * THE CROSS PRODUCT IS THE POINT, and assuming the form from the status is precisely the mistake
 * round five made. The status does not fix the form: revise_topic's restore arms copy a terminal
 * line forward without re-deriving it, so a `needs_review` record can carry a form that is
 * current, spent, stale or gone. Enumerating one plausible form per record would rebuild that
 * assumption inside the test, so every record is audited against all of them and the bench has to
 * be honest for each.
 *
 * "unread" is in the list because a page that has not heard back yet is a real situation on every
 * record, and it is the one every previous round guessed its way through.
 */
const AUDIT_FORMS: [string, GateForm][] = [
  ["absent", "absent"],
  ["unread", "unread"],
  ["current and unanswered", { stale: false, answered: false }],
  ["current and answered", { stale: false, answered: true }],
  ["stale and unanswered", { stale: true, answered: false }],
  ["stale and answered", { stale: true, answered: true }],
];

// GateRecord rather than BlogStateFacts, for exactly one field: both ship doors read the
// evaluator's score off the admin wire, and the failed rows below enumerate both sides of it.
const REACHABLE: Record<BlogState, GateRecord[]> = {
  // Both roads into a live run: a first run with no terminal line behind it, and a re-run whose
  // registry liveness beats the stale terminal status the fold still reports.
  generating: [{ status: "running" }, { status: "needs_review", live: true }],
  has_questions: [{ status: "needs_review" }],
  // FOUR RECORDS, AND THEY ARE THE WHOLE POINT OF THIS FILE. The state is derived from the submit
  // stamp rather than from the status, so it carries whatever status the topic last wrote, and it
  // is reached at the client's Submit rather than at any engine's verdict. `needs_review` is the
  // ordinary case: the portal dispatches nothing and the auto-pickup sweep ships disabled, so the
  // form is still on disk and iteration-matched. `done` is the rerun landing clean. `failed` and
  // `stopped` are what the topic's own loop last wrote where no revise has restated it.
  answers_submitted: [
    { status: "needs_review", answers_submitted: "t" },
    { status: "done", answers_submitted: "t" },
    { status: "failed", answers_submitted: "t" },
    { status: "stopped", answers_submitted: "t" },
  ],
  // `done` BY CONSTRUCTION: the state is derived from `status === "done"` directly, so no other
  // status reaches it. It used to carry a SECOND record, the published-but-never-sent article,
  // back when blogState refused to call that `published`. It does call it that now, so the
  // record moved to the `published` list below and this one is a single case again.
  internal_review: [{ status: "done" }],
  // A SEND STAMP IMPLIES A DONE STATUS, which is why every record below the delivery ladder here
  // carries `done`. admin_send_blog_to_client resolves through admin_done_topic (:180), so the
  // send that produced the stamp could not have been made from any other status, and nothing on
  // these benches writes a terminal line that would replace it. A record pairing a send stamp with
  // `needs_review` is therefore not enumerated: it is not reachable, and inventing it here would
  // fail these benches for a situation the system cannot produce.
  client_review: [{ status: "done", sent_to_client: "t" }],
  changes_requested: [
    { status: "done", sent_to_client: "t", changes_requested: 2, change_round_open: true },
    { status: "done", sent_to_client: "t", changes_requested: 0, change_round_open: true },
  ],
  approved: [{ status: "done", sent_to_client: "t", client_approved: "t" }],
  // TWO RECORDS, and the second is the whole point of the state now. The first is the article
  // that went the full distance: sent, approved, then pushed. The second is a CMS push made from
  // internal review or from a failed blog, which Post to CMS offers and which therefore carries
  // no send stamp and no approval. Both benches are empty, which is the rule the operator asked
  // for: once it is in the CMS there is nothing further to do to it here.
  published: [
    { status: "done", sent_to_client: "t", client_approved: "t", published: "t" },
    { status: "done", published: "t" },
  ],
  // TWO RECORDS, split by the fact the ship doors turn on. The scored one is the ordinary
  // failure (a loop that stalled below 90 keeps its best draft's score on the wire) and is what
  // exercises the send's accepted below-bar path. The scoreless one is the crash or preflight
  // refusal with nothing shippable in it: both doors refuse it, `publish` is withheld outright
  // and the send is the declared refusal above, so its only exit really is generating again.
  failed: [{ status: "failed", score: 87 }, { status: "failed" }],
  stopped: [{ status: "stopped" }],
  unknown: [{ status: "unknown" }],
};

/**
 * WHAT ACTUALLY REACHES THE OPERATOR AS A PRESSABLE CONTROL, which is the bench filtered by the
 * gate the record has to pass. A bench grant is a permission, never a rendering.
 *
 * IT IS THE SAME EXPRESSION blog-stage.tsx COMPOSES, and that is the whole design rather than a
 * convenience: `adminCan(state, action) && adminGateAllows(action, {record, form})` is what the
 * page evaluates for canEdit, canComment and canAnswer, so this test exercises the real decision
 * instead of a description of it. Round four defended `answer` with a comment claiming
 * AnswerQuestions withheld the control itself, and nothing here could tell that the comment was
 * wrong; round five moved the claim into a predicate and got it wrong in a new place.
 *
 * `send` IS THE ONE ACT STILL DECLARED RATHER THAN EVALUATED, and it is the CONSERVATIVE reading
 * on purpose. SendToClient carries its own blockedReason, which greys the button with a sentence
 * chosen per status, and whether that sentence or nothing at all reaches the operator is a
 * rendering decision inside a React component this process cannot call. Assuming the control is
 * OFFERED is the strict direction: it forces every gate-refused send to be explained in
 * DECLARED_REFUSALS below, where the explanation is written down and checked for rot. Evaluating
 * the gate here instead would make the entries vanish and the demand with them, which is the
 * weaker suite, not the more accurate one.
 */
function isOffered(action: AdminAction, facts: BlogStateFacts, form: GateForm): boolean {
  if (!adminCan(blogState(facts), action)) {
    return false;
  }
  if (action === "send") {
    return true;
  }
  return adminGateAllows(action, { record: facts, form });
}

/**
 * ACTS THAT ARE OFFERED WHILE THE RECORD REFUSES THEM, ON PURPOSE, each with the reason and the
 * place the refusal is explained to the operator. Keyed `state:action`.
 *
 * THE BAR FOR AN ENTRY IS THAT THE CONTROL EXPLAINS ITSELF. A greyed button whose tooltip names
 * the act that comes first is better than an absent one, because the condition clears on its own
 * and the operator learns what clears it. A button that simply fails when pressed is the bug, and
 * an entry here claiming otherwise is a lie a reviewer can check against the file it names.
 */
const DECLARED_REFUSALS: Record<string, string> = {
  "answers_submitted:send":
    "TWO LAYERS, and either one alone is enough. blog-stage.tsx (:481) mounts SendToClient behind " +
    "`adminCan(state, 'send') && adminGateAllows('send', gateInput)`, so over the summary record " +
    "the control is simply absent. Where the component is reached anyway, because its `review` " +
    "prop is polled separately from the summary and can disagree with it, send-to-client.tsx " +
    "blockedReason greys the button and names the act that comes first, a DIFFERENT act per " +
    "status, which is what makes one entry honest across four records: needs_review points at " +
    "the rerun strip directly above it, failed says no evaluator ever scored a draft, and " +
    "stopped says the session ended before this article reached a verdict. Each one names " +
    "generating the topic again as what produces a sendable draft, so the operator is told what " +
    "clears it rather than pressing a control that fails",
  "failed:send":
    "THE ONE FAILED RECORD THE SINGLE SHIP DOOR STILL REFUSES: no evaluator ever scored a draft, " +
    "so PROMOTES_SCORED_DRAFT refuses, the promotion never happens and the status stays failed. " +
    "The same two layers cover it. blog-stage.tsx (:481) withholds the mount over the summary " +
    "record, and send-to-client.tsx blockedReason greys it with the scoreless sentence, which is " +
    "the only failed sentence left now that below bar is sendable. THE REAL EXIT IS ON THE BENCH " +
    "BESIDE IT: blog-stage.tsx mounts the 'Retry this topic' link on `state === \"failed\"` alone, " +
    "deliberately not on the send door, precisely so this record keeps its way out",
};

test("no admin bench offers an act the layers under it refuse", () => {
  const exercised = new Set<string>();

  for (const state of ALL_STATES) {
    const records = REACHABLE[state];
    assert.ok(
      records.length > 0,
      `${state}: no record enumerated, so this state's bench is never checked against a layer`,
    );

    for (const facts of records) {
      assert.equal(
        blogState(facts),
        state,
        `${JSON.stringify(facts)} is filed under ${state} and does not derive it`,
      );

      for (const [formName, form] of AUDIT_FORMS) {
      for (const action of adminActions(state)) {
        if (!isOffered(action, facts, form)) {
          // A layer in front of the bench already withheld this control, so nothing was offered
          // and there is nothing to be honest or dishonest about.
          continue;
        }
        if (lowerLayerAccepts(action, facts, form)) {
          continue;
        }
        const key = `${state}:${action}`;
        exercised.add(key);
        assert.ok(
          DECLARED_REFUSALS[key],
          `${state} with ${JSON.stringify(facts)} and a form that is ${formName}: "${action}" ` +
            `renders for this record and the ` +
            `layer beneath it refuses it, so the operator is handed a control that argues with ` +
            `the record. Either withhold it, put a discriminating layer in front of it, or ` +
            `declare it in DECLARED_REFUSALS with the reason the refusal is the right experience`,
        );
      }
      }
    }
  }

  // THE TABLE CANNOT ROT. An entry nobody exercises is a refusal that has already been fixed or
  // never existed, and leaving it standing quietly re-licenses the act the next time a bench
  // changes. Declaring an exception is a decision, so withdrawing one has to be a decision too.
  for (const key of Object.keys(DECLARED_REFUSALS)) {
    assert.ok(
      exercised.has(key),
      `DECLARED_REFUSALS carries "${key}" and no reachable record exercises it, so the ` +
        `exception is stale and would silently cover the next act granted there`,
    );
  }
});

/**
 * THE SAME AUDIT, ON THE OTHER BENCH, WHICH NOTHING HAS EVER CHECKED.
 *
 * CLIENT_ACTIONS is keyed by BlogState exactly as ADMIN_ACTIONS is, and the layers under it gate
 * on facts the state folds away exactly as the admin's do: portal_submit_answers reads the form's
 * anchor, and portal_approve_blog, portal_suggest_change and portal_reply_comment all read the
 * send stamp. Every test above this one asks questions about the client bench's ROW VALUES. Not
 * one asks whether the layer beneath a client act would accept it, which is precisely the gap
 * that let the admin bench ship broken four times.
 *
 * IT IS BUILT ON THE SAME REACHABLE TABLE, deliberately, so the two benches are audited against
 * one enumeration of records rather than two that can drift apart. A record the admin audit
 * considers and the client audit does not would be the same hole one surface over.
 */
function clientLowerLayerAccepts(action: ClientAction, facts: BlogStateFacts): boolean {
  switch (action) {
    // migration 014_form_staleness.sql, portal_submit_answers (:45). Its refusals:
    //
    //   not authenticated       014:71.  Structural, never a bench question.
    //   malformed body          014:74.  The form builds it, not the bench.
    //   unknown brand or topic  014:95 / :116.
    //   wrong role              014:105. A property of the ACCOUNT, not the article, so no bench
    //                           keyed by state can express it and none should try.
    //   no form at all          014:127.  MODELLED through the status, below.
    //   THE FORM IS STALE       014:170.  Version anchor OR iteration, the same rule
    //                           questions.py:375 computes and the same one server/app.py:1538
    //                           enforces. MODELLED through the status, below.
    //   ALREADY ANSWERED        014:179.  AUTHOR-AGNOSTIC: any reply on any question of the round
    //                           refuses the whole submit. The `answers_submitted` stamp counts
    //                           CLIENT replies only, so it implies this refusal but is not implied
    //                           by it. MODELLED in the direction the stamp supports, and the
    //                           residue is named: an OPERATOR-answered form would refuse a client
    //                           submit while the stamp is still null. That record is transient
    //                           rather than reachable, because an operator's answer dispatches its
    //                           revise at submit time, which makes the topic live and derives
    //                           `generating`, whose client bench is empty.
    //   incomplete answers      014:207.  The form's own validation, not the bench's.
    //
    // The status derivation is the admin side's, unchanged and for the same reason: runner.py
    // _enforce_terminal_status (:817, :825 to :830) makes `needs_review` and "a current answerable
    // form exists" two names for one fact.
    case "answer":
      return facts.status === "needs_review" && !facts.answers_submitted;
    // migration 005_client_review.sql, portal_approve_blog (:434): not sent (005:492), already
    // approved (005:495), and a version anchor moving under the reader (005:501). The third is a
    // fact about the REQUEST rather than the record, since the client posts the version they were
    // shown, so it is named and not modelled.
    case "approve":
      return Boolean(facts.sent_to_client) && !facts.client_approved;
    // portal_suggest_change (005:186): not sent (005:255), and ten suggestions already open
    // (005:272). Migration 013's refuse_comment_when_approved trigger closes it on an approved
    // article too, from the other side of the same insert. The ten-cap is modelled off
    // changes_requested, which counts the same top-level open rows the cap counts.
    case "suggest":
      return (
        Boolean(facts.sent_to_client) &&
        !facts.client_approved &&
        (facts.changes_requested ?? 0) < 10
      );
  }
}

test("no client bench offers an act the layers under it refuse", () => {
  // The enumeration that proves the claim rather than asserting it. Every state, every record
  // that state can hold, every act its client bench grants.
  const checked: string[] = [];

  for (const state of ALL_STATES) {
    for (const facts of REACHABLE[state]) {
      assert.equal(blogState(facts), state, `${JSON.stringify(facts)} does not derive ${state}`);

      for (const action of clientActions(state)) {
        checked.push(`${state}:${action}`);
        assert.ok(
          clientLowerLayerAccepts(action, facts),
          `${state} with ${JSON.stringify(facts)}: the portal offers "${action}" and the ` +
            `definer function behind it refuses this exact record, so the client presses a ` +
            `control that errors`,
        );
      }
    }
  }

  // THE ENUMERATION IS THE FINDING, so it is asserted rather than left implicit. These
  // pairs are every client act the bench grants anywhere, and every one of them is accepted by
  // its layer for every record its state can hold. The client bench does NOT carry the defect
  // the admin bench carried four times, and this is the list that says so. changes_requested
  // appears twice per act because both of its reachable records are audited.
  assert.deepEqual(checked, [
    "has_questions:answer",
    "client_review:approve",
    "client_review:suggest",
    "changes_requested:approve",
    "changes_requested:suggest",
    "changes_requested:approve",
    "changes_requested:suggest",
  ]);
});

test("clientCanSee: the client never sees the team's half", () => {
  const visible: BlogState[] = [
    "has_questions",
    // The row must NOT vanish for the person who just answered. This is the one entry here whose
    // absence would be invisible in the portal: the article simply stops being listed, moments
    // after the client acted on it, with nothing on screen saying why.
    "answers_submitted",
    "client_review",
    "changes_requested",
    "approved",
    "published",
  ];
  for (const state of ALL_STATES) {
    assert.equal(clientCanSee(state), visible.includes(state), state);
  }
});

/**
 * THE ONE PLACE THE ADMIN AND CLIENT VOCABULARIES GENUINELY DISAGREE, pinned from both sides.
 *
 * `published` means "it is in the CMS" to the team and "live on your site" to the client, and
 * Post to CMS is offered from internal review and from failed, so the two readings come apart
 * on any push made before a send. blogState answers the team; clientFacingState answers the
 * client by recomputing without the push.
 *
 * THIS IS A RE-CLOSED HOLE AND NOT A NEW RULE. The guard used to live inside blogState as a
 * `&& facts.sent_to_client` conjunct, which closed it for the client by making the admin's own
 * tag wrong: an operator who pushed saw no change at all. Before that conjunct existed the
 * portal served internal drafts to clients as their published article. Neither half is
 * hypothetical, so both are asserted here rather than one being left to a comment.
 */
test("a CMS push reaches the team's tag and never the client's article", () => {
  const pushedNeverSent: BlogStateFacts = { status: "done", published: "t" };
  assert.equal(blogState(pushedNeverSent), "published", "the operator's own act is on the row");
  assert.equal(
    clientFacingState(pushedNeverSent),
    "internal_review",
    "and the client sees a draft that is still with the team",
  );
  assert.equal(
    clientCanSee(clientFacingState(pushedNeverSent)),
    false,
    "which is not theirs to see at all",
  );

  // A push on a FAILED blog goes through the promote door first, so its status reads done by the
  // time published_at is stamped. The scoreless-failure shape is asserted anyway: the recompute
  // must return the article's real state whatever that is, never a fixed fallback.
  assert.equal(
    clientFacingState({ status: "failed", published: "t" }),
    "failed",
    "the recompute returns the real state, not a hardcoded internal_review",
  );

  // A client who answered and is standing on the page keeps their state through a push. The
  // recompute can only ever REMOVE `published`, so it cannot take a row out from under them.
  assert.equal(
    clientFacingState({ status: "needs_review", answers_submitted: "t", published: "t" }),
    "answers_submitted",
    "a push does not evict the client who just answered",
  );

  // THE FULL DISTANCE, where the two answers agree and must: sent, approved, then pushed.
  const released: BlogStateFacts = {
    status: "done",
    sent_to_client: "t",
    client_approved: "t",
    published: "t",
  };
  assert.equal(blogState(released), "published");
  assert.equal(clientFacingState(released), "published", "a real release reads published to both");

  // Nothing else moves. clientFacingState is blogState everywhere `published` is not the answer,
  // so a bug that widened it beyond the push would show up here rather than in the portal.
  const untouched: BlogStateFacts[] = [
    { status: "done" },
    { status: "done", sent_to_client: "t" },
    { status: "done", sent_to_client: "t", change_round_open: true },
    { status: "done", sent_to_client: "t", client_approved: "t" },
    { status: "needs_review" },
    { status: "failed" },
    { status: "stopped" },
    { status: "running" },
  ];
  for (const facts of untouched) {
    assert.equal(clientFacingState(facts), blogState(facts), JSON.stringify(facts));
  }
});

test("a client can never act on a state they cannot see", () => {
  for (const state of ALL_STATES) {
    if (!clientCanSee(state)) {
      assert.deepEqual([...clientActions(state)], [], `${state} is invisible but offers actions`);
    }
  }
});

test("a client who answered keeps the article, read-only", () => {
  // Stated on its own rather than left to the visibility table above, because the two halves
  // only make sense together: the client keeps the article on screen AND can do nothing to it,
  // which is what "we have your answers, sit tight" looks like as a policy.
  assert.equal(clientCanSee("answers_submitted"), true);
  assert.deepEqual([...clientActions("answers_submitted")], []);
  assert.equal(clientCan("answers_submitted", "answer"), false, "the form is already spent");
  assert.equal(clientCan("answers_submitted", "approve"), false, "nothing has been sent yet");
});

test("clientCommentsTag: pending splits the changes_requested vocabulary", () => {
  // Pending > 0 is the CLIENT_TAGS entry itself, by reference, so the two can never drift.
  assert.equal(clientCommentsTag(3), clientTag("changes_requested"));
  assert.equal(clientCommentsTag(1).label, "Pending comments");

  const resolved = clientCommentsTag(0);
  assert.equal(resolved.label, "Comments resolved");
  assert.equal(resolved.tone, "ship", "resolved reads green: the round of notes ended well");

  // The same leak standard the totality test below holds every client tag to. The resolved
  // variant is not in CLIENT_TAGS, so that sweep never sees it and this one has to.
  const leaks = ["score", "evaluator", "iteration", "gate", "dossier", "eval"];
  for (const tag of [clientCommentsTag(1), resolved]) {
    const text = `${tag.label} ${tag.detail}`.toLowerCase();
    for (const word of leaks) {
      assert.ok(!text.includes(word), `clientCommentsTag leaks "${word}": ${text}`);
    }
  }
});

test("adminCommentsTag: the admin face of the same split, on the same count", () => {
  // Pending > 0 is the ADMIN_TAGS entry itself, by reference, so the two can never drift.
  assert.equal(adminCommentsTag(2), adminTag("changes_requested"));
  assert.equal(adminCommentsTag(1).label, "Changes requested");

  // Every comment addressed: the ball is back with the client, so the label says so. Tone
  // waiting, not ship: nothing has shipped, the operator just owes nothing right now.
  const resolved = adminCommentsTag(0);
  assert.equal(resolved.label, "With client");
  assert.equal(resolved.tone, "waiting");

  // The split answers the user's requirement that the two audiences move TOGETHER: at the
  // moment the client's tag turns "Comments resolved", the admin's stops claiming changes
  // are still requested. Both fold the same failed-inclusive count, so a failed apply keeps
  // BOTH on the pending face rather than one on each.
  assert.equal(clientCommentsTag(0).label, "Comments resolved");
  assert.equal(adminCommentsTag(1), adminTag("changes_requested"));
  assert.equal(clientCommentsTag(1), clientTag("changes_requested"));
});

test("scoreTone: the three bands, and no score", () => {
  // Read off the constants, never off the numbers they hold today. The bar has moved once, from
  // 95 to 90, and a suite that spelled the old one out failed as a stale assertion rather than as
  // a policy change anybody made on purpose.
  assert.ok(BELOW_BAR_FLOOR < SHIP_BAR, "the amber band has to sit under the bar");
  assert.equal(scoreTone(SHIP_BAR), "ship", "the bar itself ships");
  assert.equal(scoreTone(100), "ship");
  assert.equal(scoreTone(SHIP_BAR - 1), "owed", "just below the bar is amber, not red");
  assert.equal(scoreTone(BELOW_BAR_FLOOR), "owed", "the below bar floor is inside the amber band");
  assert.equal(scoreTone(BELOW_BAR_FLOOR - 1), "trouble");
  assert.equal(scoreTone(0), "trouble");
  assert.equal(scoreTone(null), null, "no score has no tone");
});

test("adminFailedTag: the near miss band is Below bar, under it is Failed", () => {
  // The failed tag splits on the score, the fact the state cannot carry, exactly as
  // changes_requested splits on the comment count. Both bands are the `failed` STATE, so the
  // bench and the retry-by-roadmap exit are unchanged; only the label and its tone move.
  for (const score of [BELOW_BAR_FLOOR, BELOW_BAR_FLOOR + 1, SHIP_BAR - 1]) {
    assert.equal(adminFailedTag(score).label, "Below bar", `${score} is below bar`);
    assert.equal(adminFailedTag(score).tone, "owed", `${score} reads amber, not the fail red`);
  }
  // The band is bounded ABOVE as well, which is the half a floor-only test misses: a promoted
  // draft sitting on a stale failed row scored at or over the bar and is not one point short.
  for (const score of [0, 50, BELOW_BAR_FLOOR - 1, SHIP_BAR, 100]) {
    assert.equal(adminFailedTag(score), adminTag("failed"), `${score} is the plain failure`);
    assert.equal(adminFailedTag(score).label, "Failed");
  }
  assert.equal(adminFailedTag(null), adminTag("failed"), "no score reads as the plain failure");
  // The split is a LABEL change, not a new state: the failed bench is untouched, so both bands
  // keep the full bench (edit, comments, and BOTH ship doors) and the retry-by-roadmap exit.
  // A Below bar draft is therefore releasable to the client or straight to the CMS on the
  // operator's authority, exactly as a plain failure is, and by the SAME `send` verb every
  // shipped blog leaves by.
  assert.deepEqual([...adminActions("failed")], ["edit", "comments", "send", "publish"]);
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

test("a score wears its own band everywhere, chip form included", () => {
  // The Create tab painted its score trail by terminal STATUS, so `done` took the brand primary
  // and a shipped 91 rendered amber beside a green "shipped" tag, in the one view whose whole
  // job is showing the climb. Both forms now read the same two constants, so the number means
  // its band on every surface.
  const bands: [number, "ship" | "owed" | "trouble"][] = [
    [100, "ship"],
    [SHIP_BAR, "ship"],
    [91, "ship"],
    [SHIP_BAR - 1, "owed"],
    [85, "owed"],
    [BELOW_BAR_FLOOR, "owed"],
    [BELOW_BAR_FLOOR - 1, "trouble"],
    [72, "trouble"],
    [0, "trouble"],
  ];
  for (const [score, tone] of bands) {
    assert.equal(scoreTone(score), tone, `${score} should be ${tone}`);
    assert.match(scoreChipClass(score), /border-.+ bg-.+ text-.+/, `${score} chip is incomplete`);
  }

  // The three bands must be visually DISTINCT, or the trail says nothing it did not already say.
  const chips = new Set([90, 85, 72].map((s) => scoreChipClass(s)));
  assert.equal(chips.size, 3, "ship, owed and trouble must not share a chip class");

  // Green for ships, amber for below bar, red under the floor: the operator's own words.
  assert.match(scoreChipClass(91), /text-ship/);
  assert.match(scoreChipClass(85), /text-review/);
  assert.match(scoreChipClass(72), /text-fail/);

  // No score is not a band, and must not borrow one.
  assert.equal(scoreTone(null), null);
  assert.match(scoreChipClass(null), /text-muted-foreground/);
});
