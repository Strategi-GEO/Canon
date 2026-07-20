/**
 * THE GATE CONTRACT, CHECKED AGAINST THE LAYERS THAT ACTUALLY REFUSE.
 *
 * Run it with:  node --test tests/gate-contract.test.ts        (from dashboard/)
 *
 * WHAT MAKES THIS DIFFERENT FROM blog-state.test.ts, which stayed green through five rounds of
 * this defect. That file is a truth table over a HAND MODEL: it restates, in TypeScript,
 * conditions that live in SQL and in Python, and then checks that the TypeScript agrees with
 * itself. Twice the restatement was wrong in a new place and nothing anywhere reported it. A green
 * invariant over a hand model proves that the model agrees with itself and proves nothing else.
 *
 * SO THE FIRST HALF OF THIS FILE DOES NOT MODEL ANYTHING. It opens the migrations, server/app.py,
 * server/cms/gate.py and server/blog_edit.py, extracts the functions that perform the refusals,
 * and checks the contract against them.
 *
 * AND ROUND SIX WAS THIS FILE AGREEING WITH A CONTRACT THAT COVERED A FRACTION OF THE SURFACE. A
 * reviewer added a novel refusal to a gating function and everything here stayed green, because
 * that function was not one of the three the contract listed. They then changed `_require_done` in
 * server/app.py, the local engine's twin of admin_done_topic, and everything stayed green again.
 * Both are caught now, and by DIFFERENT mechanisms, which matters because a single mechanism with
 * a blind spot is what shipped last time:
 *
 *   The FINGERPRINT catches a changed body in a listed function.
 *   The ACCOUNTING catches an ADDED refusal by its own text, in any listed function, and refuses
 *   to let a refusal be neither a clause nor a named exemption.
 *   The COVERAGE test catches an act no source claims to gate.
 *   The SUPERSESSION test catches a SQL source pinned to a migration a later one replaced, which
 *   is how admin_done_topic came to be fingerprinted against text the database does not run.
 *   The WITNESS test catches a decide() that stopped computing anything.
 *
 * The second half checks what the contract DECIDES, over every form the engine can produce, and
 * the third checks that the UI actually asks it, FOR EVERY ACT. That last qualifier is its own
 * round of this defect: the binding test iterated three of the six, so the two acts that still
 * kept a private opinion, send and publish, were invisible to the one test written to stop
 * exactly that.
 *
 * NOTHING HERE COMPARES THE CONTRACT TO A SECOND MODEL OF THE SAME RULE, deliberately. Two models
 * agreeing is the thing that went green through rounds two to five, so an assertion in this file
 * is either against the real source text or against what the contract decides, and never against a
 * restatement written beside it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADMIN_GATE_DOORS,
  ALL_GATE_CLAUSES,
  GATE_SOURCES,
  adminGateAllows,
  adminGateStanding,
  adminGateVerdict,
  type GateForm,
  type GateInput,
  type GateSourceId,
} from "../src/lib/gate-contract.ts";
import {
  adminCan,
  blogState,
  type AdminAction,
  type BlogStateFacts,
} from "../src/lib/blog-state.ts";
import {
  REPO_ROOT,
  extractSymbol,
  fingerprint,
  latestSqlDefinition,
  refusalSites,
} from "./gate-extract.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_IDS = Object.keys(GATE_SOURCES) as GateSourceId[];

/** Every act the bench can hand out. Read off the table so a seventh verb cannot be missed. */
const ALL_ACTIONS = Object.keys(ADMIN_GATE_DOORS) as AdminAction[];

/** The input every "no other fact varies" assertion starts from. */
const CLEAN_INPUT: GateInput = {
  record: {
    status: "done",
    client_approved: null,
    sent_to_client: null,
    changes_requested: 0,
    change_round_open: false,
  },
  form: { stale: false, answered: true },
  applying: 0,
};

function at(patch: Partial<BlogStateFacts>): GateInput {
  return { ...CLEAN_INPUT, record: { ...CLEAN_INPUT.record, ...patch } };
}

const APPROVED_AT = "2026-07-19T10:00:00Z";

// ---------------------------------------------------------------------------
// 1. Drift. The half that reads the real files.
// ---------------------------------------------------------------------------

test("every gate source still exists and its body still matches its recorded fingerprint", () => {
  for (const id of SOURCE_IDS) {
    const source = GATE_SOURCES[id];
    const extracted = extractSymbol(source.file, source.symbol, source.kind);
    const actual = fingerprint(extracted.normalized);
    const dependents = ALL_GATE_CLAUSES.filter((clause) => clause.source === id).map((c) => c.id);

    assert.equal(
      actual,
      source.fingerprint,
      `\n\n${source.file} :: ${source.symbol} HAS CHANGED.\n` +
        `  recorded ${source.fingerprint}, now ${actual}\n` +
        `  what it gates: ${source.what}\n` +
        `  acts it stands in front of: ${source.gates.join(", ")}\n` +
        `  clauses resting on it: ${dependents.join(", ") || "none"}\n\n` +
        `  DO NOT JUST UPDATE THE HASH. The fingerprint is not a version number: it moved ` +
        `because the refusals in that function are no longer the refusals ` +
        `dashboard/src/lib/gate-contract.ts describes. Read the diff, decide whether a clause ` +
        `was changed, added or removed, reconcile the clauses above, and only then re-record ` +
        `the hash. Bumping it alone rebuilds the exact silence that let this defect ship five ` +
        `times.\n`,
    );
  }
});

/**
 * THE HOLE THAT MADE THE FIRST CONTRACT PARTLY DECORATIVE.
 *
 * `create or replace function` takes no patch, so a migration changing one line restates the
 * whole body under the same name and the earlier file becomes text the database does not run. The
 * contract pinned admin_done_topic to 009 while migration 013 had replaced it, so the fingerprint
 * guarded a copy nobody executes and would have stayed green through any edit to the live one.
 */
test("every SQL source is pinned to the migration that CURRENTLY defines it", () => {
  for (const id of SOURCE_IDS) {
    const source = GATE_SOURCES[id];
    if (source.kind !== "sql") {
      continue;
    }
    const live = latestSqlDefinition(source.symbol);
    assert.equal(
      live,
      source.file,
      `\n\n${source.symbol} IS PINNED TO A SUPERSEDED MIGRATION.\n` +
        `  contract records ${source.file}\n` +
        `  the last migration to define it is ${live}\n\n` +
        `  A later migration restated this function under the same name, so the file the ` +
        `contract fingerprints is dead text and the definition the database actually runs is ` +
        `unguarded. Re-point the source at ${live}, re-derive the fingerprint from it, and ` +
        `reconcile every clause against the new body: a replacement usually ADDS a refusal, ` +
        `which is exactly what migration 013 did to admin_done_topic.\n`,
    );
  }
});

test("every clause's condition is still the verbatim text of its refusal", () => {
  for (const clause of ALL_GATE_CLAUSES) {
    const source = GATE_SOURCES[clause.source];
    const extracted = extractSymbol(source.file, source.symbol, source.kind);
    assert.ok(
      extracted.raw.includes(clause.condition),
      `\n\nCLAUSE ${clause.id} NO LONGER MATCHES ITS SOURCE.\n` +
        `  looked for: ${clause.condition}\n` +
        `  inside:     ${source.file} :: ${source.symbol}\n\n` +
        `  The gate itself changed. Reconcile the clause in dashboard/src/lib/gate-contract.ts ` +
        `with what the function now does, including its decide() body, then re-record the ` +
        `source fingerprint. Never weaken a gate to make the UI right.\n`,
    );
  }
});

test("every clause's recorded line still points at its condition", () => {
  for (const clause of ALL_GATE_CLAUSES) {
    const source = GATE_SOURCES[clause.source];
    const extracted = extractSymbol(source.file, source.symbol, source.kind);
    const offset = extracted.raw.split("\n").findIndex((line) => line.includes(clause.condition));
    const actualLine = extracted.startLine + offset;
    assert.equal(
      actualLine,
      clause.line,
      `\n\nCLAUSE ${clause.id} MOVED, and moving is not changing.\n` +
        `  ${source.file}: recorded line ${clause.line}, now line ${actualLine}\n` +
        `  The condition text is unchanged, so the gate still does what the contract says it ` +
        `does and something above it simply grew. Update the line number and move on. This is ` +
        `the benign failure; the two tests above are the ones that mean the rule changed.\n`,
    );
  }
});

/**
 * THE ACCOUNTING, AND IT IS THE TEST THE REVIEWER'S FIRST EXPERIMENT WAS DESIGNED TO DEFEAT.
 *
 * They added a brand new raise to a gating function and every test passed, because a contract
 * that lists clauses can only ever check the clauses it lists. A fingerprint would have moved for
 * a LISTED function, and it says only "something changed": a person reading that message has to
 * find the addition themselves, and the first version of this suite did not list the function at
 * all.
 *
 * So this counts. Every raise inside every listed function must be claimed by a clause or by a
 * named exemption, and the totals must agree. An added refusal is reported by its own source text,
 * which is the difference between a red build a person can act on and one they can only bump past.
 *
 * SENTINEL REFUSALS ARE OUT OF SCOPE AND SAY SO. blog_edit.mark_sent refuses by answering None,
 * and admin_send_blog_to_client's WHERE refuses by updating zero rows, so neither is a raise. The
 * exemptions carrying `raises: null` record those and are excluded from the count, which is why
 * this test proves that no RAISED refusal is undescribed rather than that no refusal is.
 */
test("every raise in every gate source is either a clause or a named exemption", () => {
  for (const id of SOURCE_IDS) {
    const source = GATE_SOURCES[id];
    const extracted = extractSymbol(source.file, source.symbol, source.kind);
    const sites = refusalSites(extracted, source.kind);

    const claimed = [
      ...ALL_GATE_CLAUSES.filter((clause) => clause.source === id).map((clause) => ({
        kind: "clause",
        id: clause.id,
        raises: clause.raises,
      })),
      ...source.exemptions.map((exemption) => ({
        kind: "exemption",
        id: exemption.id,
        raises: exemption.raises,
      })),
    ];
    const raised = claimed.filter((entry) => entry.raises !== null);

    // Direction one: everything the contract claims is still there. A refusal REMOVED from the
    // source leaves a clause deciding a condition nothing enforces any more, which fails open.
    for (const entry of raised) {
      assert.ok(
        sites.some((site) => site.text.includes(entry.raises as string)),
        `\n\n${entry.kind.toUpperCase()} ${entry.id} CLAIMS A REFUSAL THAT IS NO LONGER THERE.\n` +
          `  looked for: ${entry.raises}\n` +
          `  inside:     ${source.file} :: ${source.symbol}\n` +
          `  refusals actually present: ${sites.length}\n\n` +
          `  Either the refusal was removed, in which case delete the clause or exemption, or ` +
          `its text was reworded, in which case re-record the fragment. A clause over a refusal ` +
          `that no longer exists withholds a control for a reason the layer below has dropped.\n`,
      );
    }

    // Direction two, and this is the one the reviewer broke: everything in the source is claimed.
    const unclaimed = sites.filter(
      (site) => !raised.some((entry) => site.text.includes(entry.raises as string)),
    );
    assert.deepEqual(
      unclaimed.map((site) => `${source.file}:${site.line}`),
      [],
      `\n\n${source.file} :: ${source.symbol} REFUSES SOMETHING THE CONTRACT DOES NOT ` +
        `DESCRIBE.\n` +
        unclaimed.map((site) => `  line ${site.line}: ${site.text.slice(0, 160)}\n`).join("") +
        `\n  This function stands in front of: ${source.gates.join(", ")}.\n` +
        `  A refusal that is in neither ALL_GATE_CLAUSES nor this source's exemptions is a ` +
        `control this page will offer over a layer that says no, which is every round of this ` +
        `defect. Decide which it is and write it down:\n` +
        `    a CLAUSE, if the fact it turns on is on the wire the stage page already reads;\n` +
        `    an EXEMPTION, if it is not, WITH the reason, in this source's exemptions list.\n` +
        `  Do not delete this assertion, and do not widen the extractor to stop seeing it.\n`,
    );

    assert.equal(
      sites.length,
      raised.length,
      `\n\n${source.file} :: ${source.symbol} HAS ${sites.length} RAISES AND THE CONTRACT ` +
        `DESCRIBES ${raised.length}.\n` +
        `  The two lists above matched by text, so this is a duplicate or a missing entry rather ` +
        `than an unknown refusal. Reconcile the clause and exemption lists for this source.\n`,
    );
  }
});

/**
 * COVERAGE, stated as a property rather than as a list somebody keeps up to date.
 *
 * Every act the bench hands out must have at least one source declaring that it gates it, and
 * every source must declare at least one act. The first half is what turns "publish carries no
 * clauses" into a claim somebody has to defend against server/cms/gate.py rather than an omission
 * nobody noticed; the second stops a source being parked here with its gates list emptied to
 * quiet the accounting test.
 */
test("every act has at least one gate source, and every source gates at least one act", () => {
  for (const action of ALL_ACTIONS) {
    const guards = SOURCE_IDS.filter((id) => GATE_SOURCES[id].gates.includes(action));
    assert.ok(
      guards.length > 0,
      `\n\nNO GATE SOURCE CLAIMS TO STAND IN FRONT OF "${action}".\n` +
        `  Either nothing in the SQL or the Python refuses it, which is a strong claim and needs ` +
        `the function that performs the act named here to back it, or the surface was never ` +
        `enumerated. "publish" sat in the second case while server/cms/gate.py refused every ` +
        `push whose status was not done.\n`,
    );
  }
  for (const id of SOURCE_IDS) {
    assert.ok(
      GATE_SOURCES[id].gates.length > 0,
      `gate source ${id} declares no act, so nothing explains why it is listed here`,
    );
  }
});

test("every action the bench can hand out has an entry in the gate table", () => {
  // TypeScript's Record<AdminAction, ...> makes this total at compile time, so the value of this
  // check is the runtime shape: a door list that is present but malformed, or a clause pointing at
  // a source id nobody declared, are both things the type system cannot see.
  for (const action of ALL_ACTIONS) {
    for (const door of ADMIN_GATE_DOORS[action]) {
      assert.ok(door.id.length > 0, `${action}: a door with no id`);
      assert.ok(door.what.length > 0, `${action}/${door.id}: a door that does not say what it does`);
      for (const clause of door.clauses) {
        assert.ok(
          clause.source in GATE_SOURCES,
          `${action}/${door.id}: clause ${clause.id} names source ${clause.source}, which is ` +
            `not declared in GATE_SOURCES`,
        );
        assert.ok(
          ALL_GATE_CLAUSES.includes(clause),
          `${action}/${door.id}: clause ${clause.id} is not in ALL_GATE_CLAUSES, so the drift ` +
            `tests above never check it`,
        );
      }
    }
  }
});

/**
 * THE WITNESS TEST, WHICH NARROWS THE ONE GAP THE REST OF THIS FILE CANNOT REACH.
 *
 * Everything above pins the SOURCE. Nothing above pins the CORRESPONDENCE between a source
 * condition and the decide() written beside it, and the cheapest way for this whole apparatus to
 * rot is a decide() quietly edited into a constant to clear a red build: `() => "pass"` satisfies
 * the fingerprint, the condition lookup and the accounting, and it silently re-opens whatever the
 * clause was withholding.
 *
 * A constant cannot answer two ways, so requiring both answers kills that edit. It does not prove
 * the comparison is right, and gate-contract.ts's header says so in the same words: closing the
 * remainder means EVALUATING the SQL and the Python rather than restating them, which is a
 * database and an engine inside a unit suite.
 */
test("every clause demonstrates both a passing input and a refusing one", () => {
  for (const clause of ALL_GATE_CLAUSES) {
    assert.equal(
      clause.decide(clause.witness.passes),
      "pass",
      `\n\nCLAUSE ${clause.id} DOES NOT PASS ITS OWN PASSING WITNESS.\n` +
        `  ${GATE_SOURCES[clause.source].file} :: ${clause.condition}\n` +
        `  The decide() and the witness disagree, so at least one of them is wrong about what ` +
        `the source condition says. Read the condition, not the other one.\n`,
    );
    assert.equal(
      clause.decide(clause.witness.refuses),
      "refuse",
      `\n\nCLAUSE ${clause.id} DOES NOT REFUSE ITS OWN REFUSING WITNESS.\n` +
        `  ${GATE_SOURCES[clause.source].file} :: ${clause.condition}\n` +
        `  A decide() that cannot produce a refusal is a clause that withholds nothing. This is ` +
        `the assertion that catches a decide() collapsed into a constant, so do not fix it by ` +
        `weakening the witness.\n`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Agreement. The half that checks what the contract decides.
// ---------------------------------------------------------------------------

/**
 * Every status the engine can leave on a record, INCLUDING THE ONES A RESTORE ARM COPIES FORWARD.
 *
 * "running" is here even though it derives `generating`, because the bench is what excludes it and
 * this file is checking the gate rather than the bench. "nonsense" stands for a status this
 * dashboard has never seen: the gate has to refuse an unrecognised one rather than fall through.
 */
const STATUSES = ["running", "needs_review", "done", "failed", "stopped", "nonsense"];

/**
 * THE R5 WITNESS, NAMED AND ISOLATED, because a defect this file's mechanism CAUGHT deserves to
 * stay caught by name rather than only by a property.
 *
 * Round five derived the answer tier from `status === "needs_review"` alone, off a stated
 * biconditional: needs_review holds exactly when a current, answerable form exists. The engine
 * does not hold it. revise_topic's crash arm restores the artifact set only `if prev_bytes is not
 * None`, so a crash landing inside the materialize round trip restores nothing while
 * `prev_terminal` is already set, and it then appends a terminal line carrying
 * `prev_terminal["status"]`, which on an article held for answers is `needs_review`. That append
 * does NOT pass through `_enforce_terminal_status`, which is the only thing that would have
 * re-derived the status from the form, and the finally arm keeps the form because the re-stated
 * verdict is a hold. What sits on disk is a `needs_review` line beside a form that is answered and
 * whose version anchor no longer matches, and questions-state.ts `modeOf` ranks `answered` above
 * `stale`, so the panel drew "Rerun with their answers" over a form both POST doors refuse.
 *
 * That is round four's failure arriving through round five's model, which is what a proxy for a
 * fact will always eventually do.
 *
 * THIS ASSERTION IS NOT CIRCULAR, and the distinction matters because a tautology here would be
 * the fifth round again. The contract's `decide` bodies are not free to say whatever makes this
 * pass: each is pinned to a verbatim source line by the condition test, to a whole function body
 * by the fingerprint test, to the full set of that function's refusals by the accounting test, and
 * to producing two different answers by the witness test.
 */
test("the gate refuses a spent, stale form that a restore arm left sitting on needs_review", () => {
  const record: BlogStateFacts = {
    status: "needs_review",
    answers_submitted: "2026-07-19T10:00:00Z",
  };
  const form: GateForm = { stale: true, answered: true };

  // The bench is right about this record and always was. `answers_submitted` grants `answer`,
  // which is correct: the state cannot see the form and is not supposed to.
  assert.equal(blogState(record), "answers_submitted");
  assert.equal(adminCan("answers_submitted", "answer"), true);

  const verdict = adminGateVerdict("answer", { record, form, applying: 0 });
  assert.equal(verdict.allowed, false, "both doors refuse a stale form, so the gate must too");
  assert.equal(verdict.undecidable, false, "this is a refusal by the record, not a missing read");
  assert.equal(verdict.blocking?.id, "answers_form_not_stale");

  // And the status, on its own, says the opposite. This line is the defect, executable.
  assert.equal(
    record.status === "needs_review",
    true,
    "the status the restore arm copied forward still reads as a hold, which is exactly why no " +
      "predicate over it could ever have decided this",
  );
});

test("a form nobody has read yet withholds the answer control rather than guessing it", () => {
  // FAILING CLOSED IS THE RULE. Every previous round failed OPEN: it guessed a fact it did not
  // hold and rendered on the guess. A control absent for the moment a read is in flight is a
  // smaller harm than a control that argues with the record, and it is the only honest thing to
  // draw while the answer is genuinely unknown.
  const record: BlogStateFacts = { status: "needs_review" };
  const verdict = adminGateVerdict("answer", { record, form: "unread", applying: 0 });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.undecidable, true, "unread is not a refusal by the record, and says so");
  assert.equal(verdict.blocking, null);
});

test("a comment rail nobody has read yet withholds edit and comments rather than guessing", () => {
  // The same rule for the second fact this contract reads. `applying` gates a save on the hosted
  // build and the in-flight cap on the engine, so an unread rail is unknowable for both.
  for (const action of ["edit", "comments"] as AdminAction[]) {
    const verdict = adminGateVerdict(action, { ...CLEAN_INPUT, applying: "unread" });
    assert.equal(verdict.allowed, false, `${action} must not be granted over an unread rail`);
    assert.equal(verdict.undecidable, true);
  }
});

test("an omitted applying count asks a record question, and unread asks a moment one", () => {
  // THREE ANSWERS, THREE QUESTIONS, and the middle one is the case a reader will assume is a
  // loophole. Both clauses over this fact are transient, so a caller with no moment to describe
  // gets the record's answer and a caller that models the moment and has not heard fails closed.
  // Pinning both halves here is what stops the distinction decaying into "omitted means allowed".
  const { applying: _omitted, ...momentless } = CLEAN_INPUT;
  for (const action of ["edit", "comments"] as AdminAction[]) {
    assert.equal(
      adminGateAllows(action, momentless),
      true,
      `${action} with no applying count must answer about the record, because every clause over ` +
        `that count names a condition that clears while the operator watches`,
    );
    assert.equal(
      adminGateAllows(action, { ...momentless, applying: "unread" }),
      false,
      `${action} with an UNREAD rail must fail closed, because the caller says it models the ` +
        `moment and does not know it yet`,
    );
    // And the record half still decides a momentless caller, so this is not a way past the gate.
    assert.equal(adminGateAllows(action, { ...momentless, record: { status: "failed" } }), false);
  }
});

test("each door behind the answer verb opens on exactly the form its route accepts", () => {
  const record: BlogStateFacts = { status: "needs_review", answers_submitted: "t" };
  const opened = (form: GateForm) => {
    const verdict = adminGateVerdict("answer", { record, form, applying: 0 });
    return verdict.allowed ? verdict.door.id : null;
  };

  // POST /answers 409s a stale form and never consults answeredness, so an unanswered current
  // form is the submit door and an ANSWERED current form is still submittable: that is what keeps
  // a held topic's form usable after a crashed revise, which the engine's own finally arm relies
  // on when it deliberately keeps the form rather than clearing it.
  assert.equal(opened({ stale: false, answered: false }), "submit_answers");
  assert.equal(opened({ stale: false, answered: true }), "submit_answers");
  // Both doors refuse a stale form, and there is no third.
  assert.equal(opened({ stale: true, answered: false }), null);
  assert.equal(opened({ stale: true, answered: true }), null);
  // No form at all is a 404 on both routes.
  assert.equal(opened("absent"), null);
});

test("an approved article refuses the answer verb through both of its doors", () => {
  // _require_not_approved runs on api_answers and api_revise_answered alike, ahead of the form
  // checks, because an answer dispatches a revise that rewrites the draft and commits a version.
  // The bench never reaches this: `approved` grants only publish and reply. The gate holds anyway,
  // because a bench keyed by state is precisely what stopped being trusted here.
  const verdict = adminGateVerdict("answer", at({ client_approved: APPROVED_AT }));
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.blocking?.id, "not_approved_engine");
});

test("reply carries no record conditions, and the empty list is the statement", () => {
  assert.equal(ADMIN_GATE_DOORS.reply.length, 1);
  assert.deepEqual(ADMIN_GATE_DOORS.reply[0].clauses, []);
  for (const status of STATUSES) {
    assert.equal(
      adminGateAllows("reply", { record: { status }, form: "unread", applying: "unread" }),
      true,
      `reply must not be gated on the record: migration 011 carries no done gate and migration ` +
        `013 exempts a reply by name`,
    );
  }
});

test("edit, comments, send and publish all open on a done record and on nothing else", () => {
  // PUBLISH IS IN THIS LIST NOW, and it was not before. server/cms/gate.py refuses any push whose
  // terminal status is not exactly "done", so the act that was declared unconditional shares the
  // status condition with the other three.
  for (const status of STATUSES) {
    for (const action of ["edit", "comments", "send", "publish"] as AdminAction[]) {
      assert.equal(
        adminGateAllows(action, at({ status })),
        status === "done",
        `${action} at status=${status}: the done gate raises unless the terminal status is ` +
          `exactly 'done', in migration 013's admin_done_topic, in server/app.py's ` +
          `_require_done, and in server/cms/gate.py's assert_publishable`,
      );
    }
  }
});

test("an approval locks every act that changes the article and leaves publish and reply alone", () => {
  const approved = at({ client_approved: APPROVED_AT });
  for (const action of ["edit", "comments", "send"] as AdminAction[]) {
    assert.equal(
      adminGateAllows(action, approved),
      false,
      `${action} on an approved article: migration 013 locks it, and the send is the most ` +
        `damaging of the three because mark_sent CLEARS the approval as it re-stamps`,
    );
  }
  // Migration 013's own header names these two as the acts the lock leaves open.
  assert.equal(adminGateAllows("publish", approved), true);
  assert.equal(adminGateAllows("reply", approved), true);
});

test("an article out with the client refuses edit and comments, and a change round reopens them", () => {
  const withClient = at({ sent_to_client: APPROVED_AT, change_round_open: false });
  for (const action of ["edit", "comments"] as AdminAction[]) {
    const verdict = adminGateVerdict(action, withClient);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.blocking?.id, "not_with_client");
  }
  // A round open means the client asked for something and the article is back with the team, which
  // is the state whose whole purpose is to permit the edit.
  const roundOpen = at({ sent_to_client: APPROVED_AT, change_round_open: true });
  assert.equal(adminGateAllows("edit", roundOpen), true);
  assert.equal(adminGateAllows("comments", roundOpen), true);
});

test("an open client suggestion refuses the send and nothing else", () => {
  const open = at({ changes_requested: 2, change_round_open: true, sent_to_client: APPROVED_AT });
  const verdict = adminGateVerdict("send", open);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.blocking?.id, "send_no_open_suggestions_sql");
  // Resolving them is what the operator is meant to do next, so the two acts that do it stay open.
  assert.equal(adminGateAllows("edit", open), true);
  assert.equal(adminGateAllows("comments", open), true);
});

test("an apply in flight greys the edit rather than removing it, and fills the cap at three", () => {
  // The transient flag is what splits these two answers, and it lives on the clause because the
  // distinction is a property of the refusal rather than of the control.
  const oneApplying: GateInput = { ...CLEAN_INPUT, applying: 1 };
  const editStanding = adminGateStanding("edit", oneApplying);
  assert.equal(editStanding.act, false, "migration 010 raises PORTAL:APPLYING on this save");
  assert.equal(editStanding.mount, true, "an apply lands on its own, so the control stays and greys");
  assert.equal(editStanding.waitingOn?.id, "no_apply_in_flight");

  // One apply does not fill the cap: the composer renders two remaining.
  assert.equal(adminGateAllows("comments", oneApplying), true);
  const full: GateInput = { ...CLEAN_INPUT, applying: 3 };
  const commentStanding = adminGateStanding("comments", full);
  assert.equal(commentStanding.act, false);
  assert.equal(commentStanding.mount, true);
  assert.equal(commentStanding.waitingOn?.id, "comment_in_flight_cap");

  // A PERMANENT refusal removes the control, which is the other half of the same rule.
  const notDone = adminGateStanding("edit", at({ status: "failed" }));
  assert.equal(notDone.mount, false);
  assert.equal(notDone.waitingOn, null);
});

// ---------------------------------------------------------------------------
// 3. The last link: the UI asks the contract rather than predicting it.
// ---------------------------------------------------------------------------

/**
 * WITHOUT THIS TEST THE CHAIN HAS A HOLE AT THE TOP, and the hole is where round five lived.
 *
 * The drift tests bind the contract to the SQL and the Python. Nothing else binds the COMPONENT to
 * the contract, and a component is free to keep its own predicate and ignore the whole apparatus.
 * That is not hypothetical: it is precisely what blog-stage.tsx did, with a status derived tier
 * flag sitting beside a state bench, and every test in the repo passed.
 *
 * AND THE FIRST VERSION OF THIS TEST HAD THE SAME SHAPE OF HOLE AS THE CONTRACT IT GUARDED. It
 * iterated ["edit", "comments", "answer"], three of the six acts, so `canSend` and `canPublish`
 * kept private opinions that the one test written to stop exactly that never looked at. It now
 * iterates the table's own key set, so a seventh verb is covered the day it is added and a sixth
 * cannot be quietly skipped.
 *
 * It is a crude check and it is the right crude check: what has to be true is a fact about the
 * TEXT of that file, namely that the decision is delegated and no second predicate stands in its
 * place, and a test that instantiated React to discover the same thing would be checking
 * behaviour the delegation already determines.
 */
test("blog-stage composes EVERY write control from the gate contract, not from a proxy", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "dashboard/src/components/blogs/blog-stage.tsx"),
    "utf8",
  );

  for (const action of ALL_ACTIONS) {
    const asks =
      source.includes(`adminGateAllows("${action}", gateInput)`) ||
      source.includes(`adminGateStanding("${action}", gateInput)`);
    assert.ok(
      asks,
      `\n\nblog-stage.tsx does not gate "${action}" on the contract.\n` +
        `  Every control that writes must ask adminGateAllows or adminGateStanding, because the ` +
        `bench alone is keyed by state and the layers below are keyed by the status, the ` +
        `approval, the send, the open suggestions and the question form.\n` +
        `  This assertion used to run over three of the six acts, and the two it skipped, send ` +
        `and publish, were the two still keeping their own opinion. Do not narrow it again.\n`,
    );
  }

  // The two round-five predicates by name, so a revert reintroduces a red build rather than a
  // silent regression. They were deleted from blog-state.ts rather than moved.
  for (const dead of ["adminWriteTierReady", "adminAnswerTierReady"]) {
    assert.ok(
      !source.includes(`${dead}(`),
      `blog-stage.tsx calls ${dead}, which is a predicate over the record standing in for a gate ` +
        `that lives in SQL or in Python. That restatement is the defect, not its contents.`,
    );
  }

  // All three facts have to actually reach the gate. A gateInput built from the record alone would
  // pass every check above and reproduce round five exactly, and one without `applying` reproduces
  // the hand written `applying > 0` that sat under a canEdit which knew nothing about it.
  for (const fact of ["record: blog", "form: questionForm", "applying: applyingFact"]) {
    assert.ok(
      source.includes(fact),
      `blog-stage.tsx must pass "${fact}" into the gate input. The whole of round five was a ` +
        `gate asked to decide a question about a fact it was never given.`,
    );
  }
});

test("blog-state exports no predicate that stands in for a gate", () => {
  const source = readFileSync(path.join(REPO_ROOT, "dashboard/src/lib/blog-state.ts"), "utf8");
  for (const dead of ["adminWriteTierReady", "adminAnswerTierReady"]) {
    assert.ok(
      !source.includes(`export function ${dead}`),
      `blog-state.ts exports ${dead} again. A predicate over BlogStateFacts cannot decide a rule ` +
        `that lives in migration 009 or in server/app.py; it can only restate it, and a ` +
        `restatement is what shipped five times. Put the rule in gate-contract.ts, where the ` +
        `drift tests will hold it against its source.`,
    );
  }
});
