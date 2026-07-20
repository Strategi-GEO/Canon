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
  adminAnswerTierReady,
  adminCan,
  adminTag,
  adminUrgency,
  adminWriteTierReady,
  blogState,
  clientActions,
  clientCan,
  clientCanSee,
  clientTag,
  type AdminAction,
  type BlogState,
  type BlogStateFacts,
  type ClientAction,
} from "../src/lib/blog-state.ts";

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
    // internal_review's bench PLUS the rerun, because this one state covers two situations: the
    // answers are in and the rerun is still owed, or the rerun landed and the article is a
    // finished draft nobody has delivered. The row read `[]` first, which stranded the second
    // situation, and then read internal_review's bench alone, which left the first one holding
    // three controls the database refuses. A ROW VALUE IS ALL THIS TEST CHECKS: it went green on
    // both of those, so the test that actually governs this row is the lower-layer one below.
    answers_submitted: ["answer", "edit", "comments", "send"],
    internal_review: ["edit", "comments", "send"],
    // NOT EMPTY ANY MORE, and the one verb here is the one that changes nothing. The client may
    // reply while they read (CLIENT_ACTIONS grants it), every layer under a reply accepts one,
    // and an operator who cannot answer the person reading their article is an asymmetry rather
    // than a lock. Every act that touches the bytes is still absent.
    client_review: ["reply"],
    changes_requested: ["edit", "comments", "send"],
    // The approved lock covers the bytes and nothing else. Migration 013 says so twice, in its
    // header and in refuse_comment_when_approved's early return on parent_id.
    approved: ["publish", "reply"],
    published: ["publish", "reply"],
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
    answers_submitted: [],
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
  // client_review pins the client to sent_version_id. An edit here changes the article underneath
  // someone mid-review, so every door that writes a version is shut until they act.
  //
  // STATED AS "NOTHING THAT CHANGES THE BYTES" RATHER THAN AS AN EMPTY LIST, which is the claim
  // this test was always making and the list was only a proxy for. A reply commits no version,
  // resolves nothing and is exempt from every lock in the schema, so counting it as a touch would
  // forbid the one act that lets an operator answer the person doing the reading.
  for (const action of ["edit", "comments", "send", "publish"] as AdminAction[]) {
    assert.equal(
      adminCan("client_review", action),
      false,
      `client_review: "${action}" would move the article out from under the client mid-review`,
    );
  }
  assert.deepEqual([...adminActions("client_review")], ["reply"]);
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
 * written out there, so a rerun landing clean at >= 95 with nothing new to ask leaves the
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
const EXIT_OWNER: Record<BlogState, "run" | "client" | "admin"> = {
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
  // move the article: pressing Send does.
  changes_requested: "admin",
  // Locked, and publish is the one remaining act.
  approved: "admin",
  // Terminal, and re-publishing is still the admin's act rather than anyone else's.
  published: "admin",
  // These three leave only by generating the topic again, which is a new run and not a verb on
  // this page, so an empty bench is honest for all of them.
  failed: "run",
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
  // way out. These are exactly the three pre-delivery states, and a send is what ends each of
  // them: the submit stamp is outranked by sent_to_client, the round is closed by mark_sent, and
  // internal_review is left by the first send.
  //
  // STILL NOT ENOUGH ON ITS OWN EITHER, and the next test is the rest of it. This loop asks only
  // whether the send is GRANTED, which is a question about this table, and `answers_submitted`
  // grants one in a situation where migration 009 refuses it outright. A granted act the layer
  // below rejects is not an exit, so the send belonging on the bench and the send being usable
  // are two claims, and only the first one is checked here.
  for (const state of ["answers_submitted", "internal_review", "changes_requested"] as BlogState[]) {
    assert.equal(
      adminCan(state, "send"),
      true,
      `${state}: a send is what clears this state, so the admin must be offered one`,
    );
  }
});

/**
 * WHAT THE LAYERS UNDER THIS TABLE WILL ACTUALLY ACCEPT.
 *
 * THE TEST THAT WOULD HAVE CAUGHT THE SECOND VERSION OF THE DEAD END, which every test above it
 * missed. `answers_submitted` first read `[]`, which stranded the article, and the fix read
 * ["edit", "comments", "send"]. The row-value test went green on that, the empty-bench partition
 * went green on it, and the sharper send claim went green on it, because all three ask questions
 * about THIS FILE. None of them can ask the only question that decides whether an operator can
 * move the article: does anything underneath accept the act being offered.
 *
 * THE ANSWER WAS NO, ON ALL THREE ACTS. Migration 009's admin_done_topic reads topic_rollup.status
 * and raises PORTAL:NOTDONE unless it is exactly 'done', and the send (:180), the comment (:299)
 * and the content save (:352) all pass through it. So on a blog whose client had answered and
 * whose rerun had not run, the status was still `needs_review` and the database refused the whole
 * bench. The dead end had not been removed, it had been moved down a layer and given three
 * buttons.
 *
 * SO THIS TEST IS OVER FACT RECORDS, NOT OVER STATES, and that is the point rather than a detail.
 * One state covers two situations that differ only in the status underneath it, which is precisely
 * the fact the state folds away and precisely the fact every layer below keys on. A test indexed
 * by state cannot express the difference, and a test indexed by state is what the file already had
 * three of.
 *
 * THE MODEL BELOW IS HAND-WRITTEN AND THEREFORE CAN DRIFT. That is accepted with the trade named:
 * nothing in this process can reach Postgres, so the alternative to a modelled gate is no gate
 * checked at all, which is the state that shipped the bug twice. Each rule cites the file and line
 * it mirrors so a reader can go and check it, and each takes the STRICTER of the two surfaces
 * where they differ, because a bench has to work for an operator on the hosted build as well as on
 * the local engine, and an act only one of them accepts is not a door.
 *
 * ROUND 4 SHIPPED A GREEN RUN OVER A WRONG MODEL, WHICH IS WORSE THAN NO MODEL AT ALL, and that
 * is the failure this rewrite is here to close. `answer` was modelled as `!facts.client_approved`
 * on the strength of one line of server/app.py, and the real route is seven refusals deep. So the
 * test certified a control that 409s, in the exact state the whole file exists to get right, and
 * the certification is what made the fourth round look finished.
 *
 * SO EVERY CONDITION BELOW IS ENUMERATED, NOT SUMMARISED, AND CARRIES ITS OWN file:line. A rule
 * with one citation covering four refusals is how a missing refusal hides: the reader checks the
 * line, finds it says what the comment says, and never learns that three more lines follow it.
 * The provenance is per condition so a drift check is a diff rather than a re-derivation.
 *
 * CONDITIONS THIS RECORD CANNOT EXPRESS ARE NAMED WHERE THEY ARE DROPPED, never silently omitted.
 * BlogStateFacts carries five fields and a route can refuse on facts none of them holds. Where a
 * refusal is unmodellable the comment says so and says why dropping it is safe, which is a claim
 * a reviewer can attack. An unstated omission is not.
 */
function lowerLayerAccepts(action: AdminAction, facts: BlogStateFacts): boolean {
  switch (action) {
    // POST /api/clients/{slug}/blogs/{topic}/content, server/app.py api_save_blog_content, and
    // POST .../comments, api_add_blog_comment. Their refusals, in the order each route runs them:
    //
    //   demo brand                app.py:1968 / :1778.       NOT MODELLED: demoMode is a property
    //                             of the CLIENT and is not a BlogStateFacts field. blog-stage.tsx
    //                             ANDs it into every flag on the page, so it can never be the
    //                             thing that makes a bench dishonest.
    //   unknown topic             app.py:1970 / :1780.       Unreachable: the page is rendered
    //                             from a topic the same record produced.
    //   status is not 'done'      app.py:1971 / :1781 via _require_done (:1640), and on the
    //                             hosted build migration 009's admin_done_topic (009:145, restated
    //                             013:137) raising PORTAL:NOTDONE from admin_save_blog_content
    //                             (009:352) and admin_add_comment (009:299). MODELLED.
    //   client approved           app.py:1976 / :1787 via _require_not_approved (:1652), plus
    //                             013's refuse_version_when_approved and
    //                             refuse_comment_when_approved triggers, plus 013:141 inside
    //                             admin_done_topic. MODELLED, and it is subsumed by the status
    //                             test only by accident, so it is written out.
    //   out with the client       app.py:1982 / :1796 via _require_not_with_client (:1716), which
    //                             is "sent AND no change round open", exactly blogState's
    //                             `client_review`. MODELLED.
    //   a run is live             app.py:1983 / :1797. Modelled through `live`, which derives
    //                             `generating`, whose bench is empty, so it can never be reached.
    case "edit":
    case "comments":
      return (
        facts.status === "done" &&
        !facts.client_approved &&
        !(facts.sent_to_client && !(facts.change_round_open ?? (facts.changes_requested ?? 0) > 0)) &&
        !facts.live
      );
    // POST .../send, server/app.py api_send_blog_to_client:
    //
    //   demo brand                app.py:2028. Not modelled, as above.
    //   unknown topic             app.py:2030. Unreachable, as above.
    //   status is not 'done'      app.py:2031 via _require_done (:1640), and 009:180 resolving
    //                             through admin_done_topic (009:145). MODELLED.
    //   client approved           app.py:2042 via _require_not_approved (:1652), and 013:141
    //                             inside the same admin_done_topic. MODELLED.
    //   open client suggestions   mark_sent's own WHERE clause, answered as None and turned into
    //                             a 409 at app.py:2045, mirrored on the hosted build by 009:202.
    //                             A WHERE clause rather than a pre-check, so zero rows IS the
    //                             refusal. MODELLED through changes_requested, which counts
    //                             exactly the top-level client comments in state open or
    //                             applying that the clause tests.
    case "send":
      return (
        facts.status === "done" &&
        !facts.client_approved &&
        (facts.changes_requested ?? 0) === 0
      );
    // POST .../revise, server/app.py api_revise_answered, THE ROUTE ROUND 4 MODELLED WITH ONE
    // CONDITION OUT OF SEVEN. In the order the route runs them:
    //
    //   demo brand                app.py:1526. Not modelled, as above.
    //   unknown topic             app.py:1528. Unreachable, as above.
    //   client approved           app.py:1532 via _require_not_approved (:1652). MODELLED.
    //   no question form at all   app.py:1534 to :1536, NoQuestions raised by
    //                             questions.describe_questions (server/questions.py:336) becomes
    //                             a 404. MODELLED, see the status derivation below.
    //   THE FORM IS STALE         app.py:1538. questions.py:375 computes it as the form's version
    //                             anchor having moved OR its iteration having moved. MODELLED,
    //                             and its absence is the entire round-4 defect.
    //   the form is unanswered    app.py:1544. NOT REACHABLE while `answers_submitted` is set:
    //                             that stamp means every question of the newest evaluator round
    //                             carries a CLIENT reply (server/app.py:1280 to :1301 and the
    //                             hosted twin at blogs/route.ts:208 to :219), while
    //                             questions.py:376 computes `answered` author-agnostically over
    //                             the same round, so the stamp implies the flag. Named rather
    //                             than dropped, because the implication is the reason and it is
    //                             not obvious.
    //   a run is live             app.py:1550. Derives `generating`, as above.
    //   the rerun is claimed      app.py:1558, client_answers.claim. Another machine's engine is
    //                             mid-rerun on this topic. NOT MODELLED: no field carries it, it
    //                             is transient, and it clears itself when that task settles.
    //
    // THE STALE ARM IS DERIVED FROM THE STATUS RATHER THAN RESTATED, which is what makes it
    // checkable at all from a record that carries no form anchor. server/runner.py
    // _enforce_terminal_status (:817) is symmetric on the question axis and says so at :825 to
    // :830: a claimed needs_review with nothing CURRENT to answer is corrected to done or failed,
    // and a claimed done or failed over a CURRENT form is corrected back to needs_review. The
    // stop path does the same in the same direction (runner.py:531, which holds the topic at
    // needs_review rather than recording it stopped when a form is live). So the terminal status
    // and the form's currency are two names for one fact:
    //
    //     status === "needs_review"  <=>  a current, answerable form exists.
    //
    // Every other terminal status therefore implies the form is stale or gone, which is exactly
    // the 409 at :1538 and the 404 at :1536. That is a DERIVATION off a named invariant, not a
    // guess, and it is why this arm can be trusted from five fields.
    //
    // AND IT IS WHY `done` WITH A SUBMIT STAMP IS THE SHARPEST CASE. A clean rerun commits a new
    // blog_versions row, which moves the form's anchor, while server/sync.py:546 to :551 spares
    // ANSWERED evaluator rows from the post-revise delete. So the answered form survives in the
    // record, the submit stamp survives with it, questions-state.ts modeOf (:60) tests `answered`
    // BEFORE `stale` and returns "answered", and answer-questions.tsx:208 draws the Rerun button
    // over a form the route refuses as stale.
    case "answer":
      return facts.status === "needs_review" && !facts.client_approved && !facts.live;
    // POST .../comments/{id}/reply, server/app.py api_reply_blog_comment (:1898). Its docstring
    // at :1912 states the absences and the reason: no demo refusal and no done gate, because
    // those exist to protect an act that spends API credits on an article worth polishing, and a
    // reply spends neither. Migration 011's admin_reply_comment (011:32) is the hosted twin and
    // carries the same three refusals and no more: unknown topic (011:47), an empty body
    // (011:53), and an unknown parent comment (011:62). Migration 013 exempts replies from the
    // approved lock explicitly, at 013:18 and again in refuse_comment_when_approved's
    // `new.parent_id is not null` early return (013:88).
    //
    // So NOTHING in the record refuses a reply, which is the finding rather than a shrug: it is
    // what makes the missing admin grant on `approved` a real asymmetry against
    // CLIENT_ACTIONS.approved, and not a permission the database would have refused anyway.
    case "reply":
      return true;
    // NOT GATED ON ANY FACT IN THIS RECORD, so it is modelled as accepted rather than guessed at.
    // The CMS push runs its own gate in server/cms/gate.py, and that gate turns on which VERSION
    // the client approved against which version is latest, which is not a field BlogStateFacts
    // carries. Modelling a rule this record cannot express would be inventing a refusal.
    case "publish":
      return true;
  }
}

/** One real record an article can be in, and the act it is actually waiting on. */
type Situation = {
  /** What has happened to this article, in a sentence, for the assertion message. */
  what: string;
  facts: BlogStateFacts;
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
    state: "answers_submitted",
    moves: "answer",
  },
  {
    // SITUATION (b), the happy path. A rerun that lands clean at >= 95 with nothing new to ask
    // leaves the article pinned here by the sticky submit stamp, and only a send moves it.
    what: "the rerun landed clean and left the article pinned by the sticky submit stamp",
    facts: { status: "done", answers_submitted: "t" },
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
    state: "answers_submitted",
    moves: "run",
  },
  {
    // The same reasoning by the stop path, which holds a topic at needs_review rather than
    // recording it stopped whenever a form is still live (runner.py:531). A `stopped` status
    // therefore also implies no current form.
    what: "the operator stopped the run, and the form it left behind is no longer current",
    facts: { status: "stopped", answers_submitted: "t" },
    state: "answers_submitted",
    moves: "run",
  },
  {
    what: "passed, unsent, and sitting on the refining bench",
    facts: { status: "done" },
    state: "internal_review",
    moves: "send",
  },
  {
    // The send is refused here by the WHERE clause, correctly, and the act that moves the article
    // is working through the rail. This is the case that proves the property is "some accepted
    // act" rather than "the send is accepted".
    what: "the client's suggestions are still open",
    facts: { status: "done", sent_to_client: "t", changes_requested: 2, change_round_open: true },
    state: "changes_requested",
    moves: "comments",
  },
  {
    what: "every suggestion resolved, the round still open, the fix owed a delivery",
    facts: { status: "done", sent_to_client: "t", changes_requested: 0, change_round_open: true },
    state: "changes_requested",
    moves: "send",
  },
  {
    what: "the client approved these exact bytes",
    facts: { status: "done", sent_to_client: "t", client_approved: "t" },
    state: "approved",
    moves: "publish",
  },
  {
    what: "already in the CMS, where a re-push updates the same post",
    facts: { status: "done", sent_to_client: "t", client_approved: "t", published: "t" },
    state: "published",
    moves: "publish",
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
      (action) => isOffered(action, situation.facts) && lowerLayerAccepts(action, situation.facts),
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
          isOffered(action, situation.facts) && !lowerLayerAccepts(action, situation.facts),
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
      lowerLayerAccepts(situation.moves, situation.facts),
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

  assert.equal(blogState(rerunOwed), "answers_submitted");
  assert.equal(blogState(rerunLanded), "answers_submitted", "one state, deliberately, for the client's sake");

  // The database is RIGHT to refuse this and the UI is what has to reconcile. admin_done_topic
  // reads the fold and a blog mid question loop is not done, so sending it would deliver an
  // article whose answers nobody has applied.
  assert.equal(
    lowerLayerAccepts("send", rerunOwed),
    false,
    "migration 009 refuses a send on a blog that is not done, which is why a second act is needed",
  );
  assert.equal(lowerLayerAccepts("send", rerunLanded), true);

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
    lowerLayerAccepts("answer", rerunOwed),
    true,
    "the revise route needs a current form, and needs_review is exactly the status that has one",
  );

  // ROUND 4, PINNED, and this is the assertion the previous fix could not have made. The revise
  // route does NOT gate on approval alone: it refuses a stale form at server/app.py:1538, and a
  // rerun that has landed has committed a new version, which is what makes the form stale. So the
  // rerun is refused in exactly the situation the send is accepted, and the two acts partition
  // this state rather than overlapping in it.
  assert.equal(
    lowerLayerAccepts("answer", rerunLanded),
    false,
    "the rerun has already run and its form is spent, so a second dispatch 409s as stale",
  );
  // AND THE CONTROL IS WITHHELD RATHER THAN LEFT TO ARGUE, which is the half that lives in the
  // components. Round 4 granted `answer` here with nothing in front of it, on a comment claiming
  // AnswerQuestions would find no form: it finds the answered one, because sync.py spares
  // answered rows from the post-revise delete, and it draws the Rerun button over it.
  assert.equal(
    isOffered("answer", rerunLanded),
    false,
    "blog-stage.tsx must not mount the Rerun strip over a form the revise route refuses",
  );
  assert.equal(isOffered("answer", rerunOwed), true, "and it must mount it where the rerun works");
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
const REACHABLE: Record<BlogState, BlogStateFacts[]> = {
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
  // `done` BY CONSTRUCTION, both of them: the state is derived from `status === "done"` directly,
  // so no other status reaches it. The second record is the published-but-never-sent article,
  // which blogState deliberately refuses to call `published`.
  internal_review: [{ status: "done" }, { status: "done", published: "t" }],
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
  published: [{ status: "done", sent_to_client: "t", client_approved: "t", published: "t" }],
  failed: [{ status: "failed" }],
  stopped: [{ status: "stopped" }],
  unknown: [{ status: "unknown" }],
};

/**
 * WHAT ACTUALLY REACHES THE OPERATOR AS A PRESSABLE CONTROL, which is the bench filtered by every
 * layer that sits in FRONT of it. A bench grant is a permission, not a rendering, and two acts
 * already have a layer between the grant and the button.
 *
 * MODELLED HERE ONLY WHERE THIS PROCESS CAN EVALUATE IT. `send` is discriminated by its own
 * renderer, which imports React and cannot be called from a state-machine test, so its refusal is
 * DECLARED below rather than modelled. `edit`, `comments` and `answer` are discriminated by
 * predicates exported from blog-state.ts precisely so that this test can call them: a
 * discriminating layer nothing can check is how every previous round was defended.
 *
 * `answer` MOVED FROM THE DEFAULT ARM INTO A CALLED PREDICATE, and that move is the fix. It sat
 * under `default: return true` on the strength of a comment saying AnswerQuestions withheld the
 * control itself, which is exactly the shape of claim this function exists to stop accepting. The
 * comment was wrong, nothing here could tell, and the suite went green over a button that 409s.
 */
function isOffered(action: AdminAction, facts: BlogStateFacts): boolean {
  if (!adminCan(blogState(facts), action)) {
    return false;
  }
  switch (action) {
    // blog-stage.tsx composes the bench with adminWriteTierReady for exactly these two, which is
    // the layer they were missing. Calling the real function rather than restating its rule is the
    // point: a discriminating layer this test cannot evaluate is a claim, and a claim in a comment
    // is what defended both previous rounds.
    case "edit":
    case "comments":
      return adminWriteTierReady(facts);
    // The same composition, for the verb whose layer was asserted rather than written.
    // blog-stage.tsx ANDs adminAnswerTierReady into canAnswer, so the Rerun strip is mounted only
    // where a current form exists for it to act on.
    case "answer":
      return adminAnswerTierReady(facts);
    default:
      return true;
  }
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
    "send-to-client.tsx blockedReason (:325) greys the button for every status that is not done " +
    "and names the act that comes first, and it names a DIFFERENT act per status, which is what " +
    "makes one entry honest across four records: needs_review points at the rerun above, while " +
    "failed and stopped say the record carries no passing draft and that generating the topic " +
    "again is what produces one. The operator is told what clears it rather than pressing a " +
    "control that fails",
  "changes_requested:send":
    "send-to-client.tsx replaces the button entirely with the count of suggestions still to " +
    "resolve, mirroring the open-suggestion WHERE clause at 009:190, so nothing is offered to " +
    "press while the round is mid flight",
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

      for (const action of adminActions(state)) {
        if (!isOffered(action, facts)) {
          // A layer in front of the bench already withheld this control, so nothing was offered
          // and there is nothing to be honest or dishonest about.
          continue;
        }
        if (lowerLayerAccepts(action, facts)) {
          continue;
        }
        const key = `${state}:${action}`;
        exercised.add(key);
        assert.ok(
          DECLARED_REFUSALS[key],
          `${state} with ${JSON.stringify(facts)}: "${action}" renders for this record and the ` +
            `layer beneath it refuses it, so the operator is handed a control that argues with ` +
            `the record. Either withhold it, put a discriminating layer in front of it, or ` +
            `declare it in DECLARED_REFUSALS with the reason the refusal is the right experience`,
        );
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
    //   demo brand              014:109. A property of the CLIENT, as on the admin side.
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
    // portal_reply_comment (005:307): not sent (005:375), no such parent comment (005:389), and a
    // thread already long enough (005:399). The last two are facts about a COMMENT, and the rail
    // renders no reply box where there is no comment to reply to, so the send stamp is the only
    // one this record can carry. Migration 013 exempts replies from the approved lock by name.
    case "reply":
      return Boolean(facts.sent_to_client);
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

  // THE ENUMERATION IS THE FINDING, so it is asserted rather than left implicit. These six pairs
  // are every client act the bench grants anywhere, and every one of them is accepted by its
  // layer for every record its state can hold. The client bench does NOT carry the defect the
  // admin bench carried four times, and this is the list that says so.
  assert.deepEqual(checked, [
    "has_questions:answer",
    "client_review:approve",
    "client_review:suggest",
    "client_review:reply",
    "changes_requested:reply",
    "changes_requested:reply",
    "approved:reply",
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
