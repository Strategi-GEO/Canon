/**
 * THE ONE DEFINITION OF WHAT THE LAYERS BELOW THIS UI WILL ACTUALLY REFUSE.
 *
 * ADMIN_ACTIONS in blog-state.ts is keyed by BlogState. Every layer that PERFORMS one of those
 * acts gates on the STATUS, on the approval, on the send, on the open suggestions and on the
 * question form, which are facts the state deliberately folds away. Those are not the same key,
 * nothing made the two agree, and so five separate rounds of patching each granted an act the
 * layer below refused, in a new place every time: an empty bench, then a send migration 009
 * refuses, then an edit and a comment the same migration refuses, then an answer POST /revise
 * refuses, then an answer tier resting on an invariant the engine does not hold.
 *
 * THE TESTS NEVER CAUGHT ANY OF IT BECAUSE THEY MODELLED THE LOWER LAYERS BY HAND. The guard test
 * restated, in TypeScript, conditions that live in SQL and in Python. Twice the restatement was
 * wrong in a new place and the suite stayed green, because a green invariant over a hand model
 * proves only that the model agrees with itself. THAT is the defect this file exists to remove.
 * The bench is downstream of it.
 *
 * SO THIS IS NOT A BETTER MODEL. It is a table of clauses, each one carrying the VERBATIM source
 * line that performs the refusal and the file and symbol it lives in, and
 * `dashboard/tests/gate-contract.test.ts` re-derives all of it from the real SQL and the real
 * Python on every run.
 *
 * ROUND SIX WAS THE CONTRACT ITSELF, AND IT IS WHY THIS FILE IS NOW LONG. The first version of
 * this table fingerprinted THREE functions, and a reviewer demonstrated twice over that the same
 * defect had simply moved into it. They added a brand new refusal to a gating function and the
 * full suite stayed green, because that function was not one of the three. They then changed
 * `_require_done` in server/app.py, which is the local engine's twin of admin_done_topic and
 * gates edit, comments and send on the build that does the actual writing, and the full suite
 * stayed green again, because it was in neither the source list nor the clause list. A contract
 * that covers a fraction of a surface certifies an agreement it has not checked, which is the
 * same failure as a hand model with better manners.
 *
 * A SECOND THING THE SAME REVIEW EXPOSED: IT WAS FINGERPRINTING TEXT NOBODY RUNS. The table
 * pinned admin_done_topic to 009_admin_write_tier.sql. `create or replace function` takes no
 * patch, so migration 013 restated the whole body under the same name to add the approved lock,
 * and from that moment 009's copy is dead text the database does not execute. Every SQL source
 * here is now checked against `latestSqlDefinition`, which finds the LAST migration to declare a
 * symbol, so a future migration replacing one of these functions goes red instead of silently
 * orphaning the clauses that rest on it.
 *
 * FOUR THINGS FAIL IN THE TEST AND THEY FAIL FOR DIFFERENT REASONS:
 *
 *   1. A CONDITION LOOKUP. The verbatim text recorded on a clause must still appear inside the
 *      function it claims to come from. Edit the condition and the lookup misses.
 *   2. A FINGERPRINT. Each source function carries a hash of its own normalized body, so a
 *      refusal ADDED to a function nobody touched otherwise still moves the hash.
 *   3. AN ACCOUNTING. Every raise inside every source function is either a clause or a NAMED
 *      exemption, and the counts must agree. This is what makes the coverage claim checkable
 *      rather than asserted: a novel refusal added to any listed function is reported by its own
 *      text, not merely as "the hash moved".
 *   4. A WITNESS. Every clause must demonstrate both a passing input and a refusing one. A
 *      decide() quietly edited into a constant, which is how a table like this rots, fails here.
 *
 * WHAT THIS TABLE COVERS. Every function in supabase/migrations and in server/ that can refuse
 * one of the six admin acts, on either build: the hosted definer functions, and the local
 * engine's routes and the helpers they call. Each is listed in GATE_SOURCES with every one of its
 * refusals accounted for. A refusal becomes a CLAUSE when the fact it turns on is on the wire
 * this page already reads, and a documented EXEMPTION when it is not, with the reason beside it.
 *
 * FAILING CLOSED IS A RULE HERE AND NOT A DEFAULT. A clause whose fact the caller could not supply
 * returns `unknowable`, and an action with an unknowable clause and no other passing door is NOT
 * allowed. The previous rounds all failed OPEN: they guessed a fact they did not have, rendered a
 * control on the guess, and the operator found out when the database raised. A control that is
 * absent for a moment while the form loads is a smaller harm than a control that argues with the
 * record, and it is the only honest thing to draw when the answer genuinely is not known yet.
 *
 * THE KNOWN FLOOR, STATED RATHER THAN IMPLIED. Each clause's `decide` is a hand written
 * TypeScript restatement of a condition that lives in another language. The fingerprint pins the
 * SOURCE TEXT and the accounting pins the SET OF REFUSALS; neither pins the CORRESPONDENCE
 * between a condition and the decide() written beside it. The witness pairs narrow that gap and
 * do not close it: they prove a decide() actually reads the fact it names and produces both
 * answers, so a stubbed clause or one collapsed into a constant fails, while a decide() reading
 * the right field with the wrong comparison would still pass. Closing the remainder needs the
 * condition EVALUATED rather than restated, which means a live database and a running engine
 * inside the dashboard's unit suite. That is the trade this file makes, and it is written here so
 * nobody has to rediscover it by being wrong.
 */
import type { AdminAction, BlogStateFacts } from "@/lib/blog-state";

/**
 * The two fields of the question form that every door behind `answer` actually gates on.
 *
 * BOTH ARE ALREADY ON THE WIRE and that is what makes this fix possible without a backend change.
 * `BlogQuestions` in types carries `stale` and `answered`, GET blogQuestions returns them, and
 * `useBlogQuestions` already reads them for every topic in the library. The previous round derived
 * the same question from the STATUS instead, off a stated biconditional between `needs_review` and
 * a current answerable form, and the engine does not hold that biconditional: `revise_topic`'s
 * three restore arms append a terminal line carrying `prev_terminal["status"]`, which on an
 * article held for answers is `needs_review`, and they do it WITHOUT passing through
 * `_enforce_terminal_status`, which is the only thing that would have re-derived the status from
 * the form. A status copied from an earlier verdict is not a function of the form at all, so no
 * predicate over the status can stand in for one.
 */
export type GateFormFacts = {
  /** The form's version anchor or its iteration has moved. Both POST doors refuse a stale form. */
  stale: boolean;
  /** An answers.json exists for this iteration. POST /revise REQUIRES it; POST /answers ignores it. */
  answered: boolean;
};

/**
 * What the caller knows about the question form.
 *
 * "absent" and "unread" are two different answers and collapsing them is how a control gets
 * offered over a 404. "absent" is the engine saying it holds no questions.json for this topic,
 * which is a real fact and most topics. "unread" is this page not having heard back yet, or
 * having heard an error, which is not a fact about anything and must never be treated as one.
 */
export type GateForm = GateFormFacts | "absent" | "unread";

/**
 * How many top-level comments on this article are mid-apply, or "unread" before the rail lands.
 *
 * TWO REFUSALS TURN ON THIS AND BOTH WERE INVISIBLE TO THE FIRST CONTRACT. Migration 010's
 * admin_save_blog_content raises PORTAL:APPLYING when any top-level comment is in state
 * 'applying', and server/app.py's comment route raises when the count has reached
 * blog_edit.MAX_IN_FLIGHT. The stage page has ALWAYS held this number: it filters the comment
 * rail for 'applying' and renders the remainder beside the composer. It simply never reached the
 * gate, so the Edit control was granted while a refusal stood, and a hand written `applying > 0`
 * disabled it one layer down. That is the restatement pattern in miniature: the page deciding for
 * itself what migration 010 does.
 *
 * "unread" is the same rule as the form's. The rail is fetched, so before it lands the count is
 * not a fact and the clauses over it answer `unknowable` rather than guessing zero.
 */
export type GateApplying = number | "unread";

/**
 * The record a gate reads: the state facts, plus the evaluator's score.
 *
 * `score` is DELIBERATELY NOT a BlogStateFacts member. The state never reads it, the portal
 * producers never supply it (tests/portal_check.py bans the token from the client surface
 * outright), and exactly two doors need it: send and publish, each of which promotes a failed
 * topic before its own gate runs and refuses a failed record with no evaluator-scored draft.
 * It rides here because the admin wire already carries
 * it (BlogSummary.score), and blog-stage's gateInput record is the merged BlogSummary, so the
 * fact is on the page without touching either state-facts producer. Absent reads as refuse in
 * the one clause that consults it, which is the true answer rather than a guess: a scoreless
 * failed record has nothing shippable in it.
 */
export type GateRecord = BlogStateFacts & { score?: number | null };

export type GateInput = {
  record: GateRecord;
  form: GateForm;
  /**
   * OPTIONAL, AND THE THREE ANSWERS ARE THREE DIFFERENT QUESTIONS. Read this before omitting it.
   *
   * A NUMBER is the fact: this many changes are mid-apply right now.
   *
   * "unread" is a caller that MODELS this fact and has not heard back. It fails closed, exactly as
   * an unread question form does: a page that cannot say how many applies are running must not
   * claim there are none, and every earlier round of this defect failed OPEN by guessing.
   *
   * OMITTED is a caller that is not asking a moment question at all, and that is a real and
   * separate case rather than a loophole. Both clauses over this fact are TRANSIENT: they name a
   * condition that clears while the operator watches, an apply landing or a cap draining, and
   * neither is a property of the record. A caller asking "will this RECORD take the act", which is
   * what a bench truth table and send-to-client.tsx are both asking, has no moment to describe, so
   * the transient clauses are skipped and the answer is about the record. `verdictOver` implements
   * that, and a test pins both halves so the distinction cannot rot into an accident.
   *
   * THE COST IS NAMED RATHER THAN HIDDEN. A caller that SHOULD have supplied the count and forgot
   * gets the record answer, so an Edit control can render while an apply is in flight and the save
   * comes back a 409. That is a transient refusal with a sentence on it, the behaviour this page
   * had before the fact reached the gate at all, and it is the price of not forcing every caller
   * to invent a moment. gate-contract.test.ts asserts blog-stage.tsx passes the count, which is
   * where forgetting it would actually matter.
   */
  applying?: GateApplying;
};

/** What one clause says about one record. `unknowable` is a real answer and never a failure. */
export type ClauseVerdict = "pass" | "refuse" | "unknowable";

export type GateSourceId =
  | "admin_brand_id"
  | "admin_done_topic"
  | "admin_send_blog_to_client"
  | "admin_save_blog_content"
  | "admin_add_comment"
  | "admin_dismiss_comment"
  | "refuse_version_when_approved"
  | "refuse_comment_when_approved"
  | "client_or_404"
  | "topic_or_404"
  | "require_done"
  | "require_reviewable"
  | "require_not_approved"
  | "require_not_with_client"
  | "api_answers"
  | "api_revise_answered"
  | "answers_refuse_topic_in_flight"
  | "api_save_blog_content"
  | "api_add_blog_comment"
  | "api_resolve_blog_comment"
  | "api_delete_blog_comment"
  | "api_send_blog_to_client"
  | "api_publish_blog"
  | "assert_publishable"
  | "promote_if_failed"
  | "cms_record_blog"
  | "edit_refuse_if_approved"
  | "edit_refuse_live_run"
  | "edit_refuse_moved_record"
  | "edit_add_comment"
  | "edit_mark_sent";

/**
 * A refusal this contract has read and deliberately gives no clause.
 *
 * AN EXEMPTION IS A DECISION AND THE POINT OF WRITING IT DOWN IS THAT A GAP IS NOT. Before this
 * existed, the difference between "we read this refusal and no control can predict it" and
 * "nobody ever looked at this function" was invisible, and the reviewer's first experiment landed
 * squarely inside that invisibility. Now every raise in every listed function is one or the other,
 * by name, and the accounting test refuses to let a third category exist.
 */
export type GateExemption = {
  /** Stable id, used in the accounting test's failure message. */
  id: string;
  /**
   * A distinctive VERBATIM fragment of the refusal, as it reads in the source.
   *
   * `null` means this refusal is a SENTINEL RETURN rather than a raise: blog_edit.mark_sent
   * answers None for an approved article and for an open client suggestion. The extractor finds
   * raises only, so a sentinel is excluded from the count and rests on the fingerprint over the
   * whole body, plus the clause covering the same fact from the route above it.
   */
  raises: string | null;
  /** Why no clause. For whoever is deciding whether to add one. */
  why: string;
};

/**
 * Something a gate's body NAMES rather than contains, whose text joins that gate's fingerprint.
 *
 * THE DEFECT THIS CLOSES IS THAT THE FINGERPRINT DID NOT FOLLOW THE CALL. A hash over a function's
 * own body says nothing about the helpers and constants it calls, and a gate is usually one line
 * of dispatch over a decision made somewhere else. Three mutations proved the gap, and every one
 * of them left the listed function byte identical and the whole suite green:
 *
 *   `_topic_status` in server/app.py forced to return "done". `_require_done` still reads
 *   `if status != "done":` and still raises, so its own text is untouched, and the DONE_TOPIC
 *   clause becomes a statement about nothing while its fingerprint stays valid.
 *
 *   `_with_client_since` inverted from `if sent_at is None or round_open:` to
 *   `if sent_at is not None and not round_open:`, which swaps exactly who gets refused.
 *   `_require_not_with_client` is unchanged: it asks the helper a question and raises on the
 *   answer, and the answer is now the opposite one.
 *
 *   `blog_edit.MAX_IN_FLIGHT` changed from 3. api_add_blog_comment compares against the NAME, so
 *   no body moves, and the contract's cap clause goes on refusing at 3 whatever the engine does.
 *   The `= 1` direction FAILS OPEN, which is the direction that matters: the page offers a comment
 *   control for a second apply the engine refuses.
 *
 * A DEPENDENCY IS NOT A SOURCE, and the distinction is why this is a separate list rather than
 * four more GATE_SOURCES rows. A source is a function that REFUSES, and it owes the accounting
 * test a clause or a named exemption for every raise in it. `_topic_status` refuses nothing: it
 * answers a question, and the raise belongs to its caller. Listing it as a source would demand an
 * accounting of raises it does not have and would say the wrong thing about what it is.
 */
export type GateDependency = {
  /** Repo relative, from the geo-factory root. Needs no `kind`: it inherits the source's. */
  file: string;
  /** A function, extracted as its whole body. Exactly one of `symbol` or `constant` is set. */
  symbol?: string;
  /** A module level constant, extracted as its assignment line. */
  constant?: string;
  /** What the gate above it actually rests on, for whoever the red build wakes up. */
  why: string;
};

/**
 * A function in the SQL or the Python that refuses admin writes, and the fingerprint of its body
 * as it stood when this contract was last reconciled with it.
 *
 * THE FINGERPRINT IS NOT A VERSION NUMBER AND MUST NEVER BE BUMPED TO CLEAR A RED BUILD. It is the
 * hash of the normalized body, so a moved fingerprint means the refusals in that function are not
 * the refusals this table describes. The correct response is to read the diff and reconcile the
 * clauses; updating the hash alone re-creates the exact silence that let five rounds ship.
 *
 * WHERE `dependsOn` IS SET THE HASH COVERS THOSE BODIES TOO, joined into one fingerprint rather
 * than recorded as several. One hash means a red build names the GATE and brings its `what`
 * sentence and its clause list with it, instead of naming a helper and leaving the reader to
 * rediscover which gate rested on it. An empty or absent list hashes exactly as the body alone.
 */
export type GateSource = {
  /**
   * Repo relative, from the geo-factory root.
   *
   * For SQL this must be the migration that CURRENTLY defines the symbol, which is the LAST one
   * to declare it and not the one that introduced it. The test asserts exactly that, because a
   * contract pinned to a superseded copy fingerprints text the database never runs.
   */
  file: string;
  symbol: string;
  kind: "sql" | "python";
  /** sha256 of the comment stripped, whitespace collapsed body, first 16 hex chars. */
  fingerprint: string;
  /** Which of the six acts this function stands in front of. */
  gates: readonly AdminAction[];
  /** Why this function is a gate at all, in one sentence, for whoever the red build wakes up. */
  what: string;
  /** Refusals read and given no clause, each with its reason. */
  exemptions: readonly GateExemption[];
  /** Helpers and constants this gate's decision actually rests on. See GateDependency. */
  dependsOn?: readonly GateDependency[];
};

export const GATE_SOURCES: Record<GateSourceId, GateSource> = {
  // -------------------------------------------------------------------------
  // The hosted build: definer functions in supabase/migrations.
  // -------------------------------------------------------------------------
  admin_brand_id: {
    file: "supabase/migrations/009_admin_write_tier.sql",
    symbol: "admin_brand_id",
    kind: "sql",
    fingerprint: "4244b6ce54f51e7d",
    gates: ["edit", "comments", "send"],
    what:
      "Resolves the brand for every admin write on the hosted build, and refuses a caller who is " +
      "not an admin or is asking about a brand that is not there.",
    exemptions: [
      {
        id: "brand_not_authenticated",
        raises: "PORTAL:AUTH:not authenticated",
        why:
          "Identity, not the record. A signed out session has no page to render this control on, " +
          "so there is nothing for a clause to withhold.",
      },
      {
        id: "brand_unknown_to_admin",
        raises: "PORTAL:NOTFOUND:no such brand for this account",
        why:
          "The same answer for a brand out of scope and a brand that does not exist, deliberately, " +
          "so a clause predicting it would leak which of the two it was.",
      },
      {
        id: "brand_row_missing",
        raises: "PORTAL:NOTFOUND:no such brand for this account",
        why:
          "The second arm of the same refusal, for a slug with no clients row. Exempt for the " +
          "reason above, and unreachable from a page already rendering the brand's article.",
      },
    ],
  },
  // Migration 013 replaced 009's admin_done_topic wholesale to add the approved lock, so 013 is
  // the definition the database runs and 009's copy is dead text. The first version of this
  // contract pinned 009 and would have stayed green through any edit to the live one.
  admin_done_topic: {
    file: "supabase/migrations/013_approved_lock.sql",
    symbol: "admin_done_topic",
    kind: "sql",
    fingerprint: "25e031cf00f9ea20",
    gates: ["send"],
    what:
      "Resolves a topic for any admin write, raises PORTAL:NOTDONE unless topic_rollup.status is " +
      "exactly 'done', then PORTAL:LOCKED on an approved article. admin_save_blog_content, " +
      "admin_add_comment and the send all still route through it on the hosted build, but only " +
      "its APPROVED clause sits on a door now: the done-only half has no promotion in front of " +
      "it, so it would refuse the below-bar bench that exists on the local build alone, and " +
      "every hosted admin write route answers 501 before this function runs, so done-only here " +
      "is defense-in-depth rather than a refusal any mounted control can hit.",
    exemptions: [
      {
        id: "done_topic_not_found",
        raises: "PORTAL:NOTFOUND:no such blog for this account",
        why:
          "Resolution rather than a gate. The stage page is rendering this topic's article, so a " +
          "topic the record cannot find is not a condition any control on this page can be in.",
      },
    ],
  },
  admin_send_blog_to_client: {
    file: "supabase/migrations/009_admin_write_tier.sql",
    symbol: "admin_send_blog_to_client",
    kind: "sql",
    fingerprint: "93a1c241d5fe1044",
    gates: ["send"],
    what:
      "The hosted send. Its one refusal of its own is an open or applying client suggestion, and " +
      "it is asserted in the UPDATE's own WHERE rather than in a counted pre-check, so zero rows " +
      "updated IS the refusal.",
    exemptions: [],
  },
  // Migration 010 replaced 009's copy to fix the blank test and add the applying refusal.
  admin_save_blog_content: {
    file: "supabase/migrations/010_admin_write_tier_fixes.sql",
    symbol: "admin_save_blog_content",
    kind: "sql",
    fingerprint: "000ad5e45bb09a1f",
    gates: ["edit"],
    what:
      "The hosted save. Beyond the shared gate it refuses a blank or oversized body, an article " +
      "with a change mid-apply, and a base version that is no longer the latest.",
    exemptions: [
      {
        id: "save_blank_body",
        raises: "PORTAL:BLANK:an empty article cannot be saved",
        why:
          "About the PAYLOAD rather than the record. No state and no fact on the wire could " +
          "predict what the operator is about to type, and a control withheld on one would be " +
          "refusing the act of clearing the box.",
      },
      {
        id: "save_body_too_large",
        raises: "PORTAL:TOOLARGE:the article is over 1 MB",
        why: "The payload again, for the same reason as the blank body above.",
      },
      {
        id: "save_base_version_stale",
        raises: "PORTAL:STALE:this article changed while you were editing",
        why:
          "The base version the editor opened from is not on this page's wire: the blogs read " +
          "returns no version_no, so the comparison cannot be made here. A genuine gap rather " +
          "than a category error, and closing it needs a version on the wire.",
      },
    ],
  },
  admin_add_comment: {
    file: "supabase/migrations/010_admin_write_tier_fixes.sql",
    symbol: "admin_add_comment",
    kind: "sql",
    fingerprint: "12a85520b460b244",
    gates: ["comments"],
    what:
      "The hosted change request. It inserts 'open' rather than 'applying' because a definer " +
      "function cannot start the Claude session, and beyond the shared gate it refuses only an " +
      "empty selection or an empty instruction.",
    exemptions: [
      {
        id: "comment_blank_selection",
        raises: "PORTAL:BLANK:select the text this change applies to",
        why: "The payload, decided when the operator presses send and not before.",
      },
      {
        id: "comment_blank_instruction",
        raises: "PORTAL:BLANK:say what should change about the selected text",
        why: "The payload, as above.",
      },
    ],
  },
  // THE DISMISS HALF OF `comments`, MISSING FROM THIS TABLE ON BOTH BUILDS UNTIL NOW. The contract
  // enumerated filing a change request and nothing else, so the two functions that CLOSE one were
  // unlisted, unfingerprinted and unaccounted, and a refusal added to either would have shipped
  // green. blog-stage.tsx has always passed `canComment` to the rail as the flag that lets this
  // side "file, resolve, dismiss or reply", in its own words, so all three doors were riding on a
  // gate that had read exactly one of them.
  admin_dismiss_comment: {
    file: "supabase/migrations/010_admin_write_tier_fixes.sql",
    symbol: "admin_dismiss_comment",
    kind: "sql",
    fingerprint: "766a700b529030ae",
    gates: ["comments"],
    what:
      "The hosted dismiss: a comment is CLOSED rather than deleted, because the client can see " +
      "their own suggestion and a row that vanished reads as lost while a dismissed one reads as " +
      "reviewed. It refuses an applying comment, whose background task would otherwise land a " +
      "verdict on a row that already reads closed.",
    exemptions: [
      {
        id: "dismiss_topic_not_found",
        raises: "PORTAL:NOTFOUND:no such blog for this account",
        why:
          "Resolution rather than a gate, exactly as admin_done_topic's own NOTFOUND is. The " +
          "stage page is rendering this topic's article.",
      },
    ],
  },
  refuse_version_when_approved: {
    file: "supabase/migrations/013_approved_lock.sql",
    symbol: "refuse_version_when_approved",
    kind: "sql",
    fingerprint: "fd43951309748652",
    gates: ["edit", "comments"],
    what:
      "The trigger on blog_versions. Every path that commits a version passes it, in both " +
      "languages, which is why the lock lives here rather than in each writer.",
    exemptions: [],
  },
  refuse_comment_when_approved: {
    file: "supabase/migrations/013_approved_lock.sql",
    symbol: "refuse_comment_when_approved",
    kind: "sql",
    fingerprint: "fd5c2836cefaf6f6",
    gates: ["comments"],
    what:
      "The trigger on blog_comments, TOP-LEVEL ROWS ONLY. An operator comment is born 'applying' " +
      "and runs Claude at once, so it is an edit wearing a comment's clothes; a parent_id row " +
      "(a client's question answer, or a legacy reply) returns early and is untouched.",
    exemptions: [],
  },

  // -------------------------------------------------------------------------
  // The local engine: server/app.py, server/cms/gate.py, server/blog_edit.py.
  // -------------------------------------------------------------------------
  client_or_404: {
    file: "server/app.py",
    symbol: "_client_or_404",
    kind: "python",
    fingerprint: "4ea483dedc489e82",
    gates: ["answer", "edit", "comments", "send"],
    what: "The engine's twin of admin_brand_id: the brand must exist and be inside the caller's scope.",
    exemptions: [
      {
        id: "engine_client_unknown",
        raises: 'detail=f"unknown client {slug!r}"',
        why:
          "Identity and existence, not the record, and answered identically for out of scope and " +
          "not there so a clause predicting it would leak the difference.",
      },
    ],
  },
  topic_or_404: {
    file: "server/app.py",
    symbol: "_topic_or_404",
    kind: "python",
    fingerprint: "dfdabc791ae049bc",
    gates: ["answer", "edit", "comments", "send"],
    what:
      "The engine's topic resolver, and the traversal guard with it: an unknown slug and a " +
      "smuggled path get one answer.",
    exemptions: [
      {
        id: "engine_topic_unknown",
        raises: 'detail=f"no blog {topic_slug!r} for client {slug!r}"',
        why: "Resolution rather than a gate: this page is rendering the topic's article.",
      },
    ],
  },
  // THE TWIN THE FIRST CONTRACT MISSED. A reviewer changed `if status != "done":` here to admit
  // 'stopped' and 'failed' and the whole suite stayed green, because this function was in neither
  // GATE_SOURCES nor ALL_GATE_CLAUSES while its hosted counterpart was in both.
  require_done: {
    file: "server/app.py",
    symbol: "_require_done",
    kind: "python",
    fingerprint: "ea22e7feea82b739",
    gates: ["send"],
    what:
      "The local engine's admin_done_topic: a 409 unless the topic's terminal verdict is done. " +
      "Only api_send_blog_to_client calls it now: the three editing routes moved to " +
      "_require_reviewable when the admin-review bench gained the failed draft. IT STILL " +
      "DEMANDS THE LITERAL done AND IS NOT WIDENED: what changed is what reaches it, because " +
      "the send route promotes a failed topic first, exactly as the CMS route has always done " +
      "through blog_edit.promote_if_failed, so the status really is done when this compares it.",
    exemptions: [],
    dependsOn: [
      {
        file: "server/app.py",
        symbol: "_topic_status",
        why:
          "THE WHOLE OF WHAT `done` MEANS HERE. _require_done contributes one comparison and one " +
          "raise; the status it compares is folded by this helper out of the record. Forcing it " +
          "to return \"done\" leaves _require_done's own text byte identical, so its fingerprint " +
          "held and the DONE_TOPIC_ENGINE clause went on describing a gate that had stopped " +
          "gating. That mutation ran green against the whole suite.",
      },
    ],
  },
  require_reviewable: {
    file: "server/app.py",
    symbol: "_require_reviewable",
    kind: "python",
    // Recorded at the entry's creation, reconciled with the clause above it.
    fingerprint: "e6a0ac2987702f5d",
    gates: ["edit", "comments"],
    what:
      "The admin-review bench's own gate: a 409 unless the verdict is done OR failed. The " +
      "three editing routes (save, comment filing, comment resolve) call it, so an operator " +
      "can polish a sub-90 draft before releasing it, while needs_review, stopped and running " +
      "stay closed and _require_done keeps demanding the literal done on the send, which the " +
      "route's own promotion satisfies rather than widens.",
    exemptions: [],
    dependsOn: [
      {
        file: "server/app.py",
        symbol: "_topic_status",
        why:
          "The same dependency require_done records, for the same mutation: the status this " +
          "gate compares is folded by this helper, so a helper forced to answer \"done\" " +
          "leaves this gate's own text byte identical while it stops gating.",
      },
    ],
  },
  require_not_approved: {
    file: "server/app.py",
    symbol: "_require_not_approved",
    kind: "python",
    fingerprint: "6302d2452a9c26e4",
    gates: ["answer", "edit", "comments", "send"],
    what:
      "The HTTP half of the approved lock, and the widest gate in the engine: it stands in front " +
      "of the answer routes as well as the three write routes, because an answer dispatches a " +
      "revise that rewrites the draft and commits a version. On the send it also guards the " +
      "promotion behind it: a resurrected topics row keeps its old approval stamp, and shipping " +
      "over one would end in mark_sent's None with a sentence about suggestions that are not " +
      "the problem.",
    exemptions: [],
  },
  require_not_with_client: {
    file: "server/app.py",
    symbol: "_require_not_with_client",
    kind: "python",
    fingerprint: "ac5fcc04bd6f174e",
    gates: ["edit", "comments"],
    what:
      "409 while the article is out with the client and they have asked for nothing back. Writing " +
      "then commits a version that topics.sent_version_id does not point at, so the approval " +
      "landing next describes bytes nobody is reading.",
    exemptions: [],
    dependsOn: [
      {
        file: "server/app.py",
        symbol: "_with_client_since",
        why:
          "THE CONDITION ITSELF, and this function is only the raise on top of it. " +
          "_require_not_with_client asks for a date and refuses if it gets one, so inverting the " +
          "helper's `if sent_at is None or round_open:` to `if sent_at is not None and not " +
          "round_open:` swaps exactly which articles are refused while leaving every byte of the " +
          "caller alone. The helper is also the ONE definition of out-with-the-client that " +
          "api_generate reads, so a change here moves two doors at once.",
      },
    ],
  },
  api_answers: {
    file: "server/app.py",
    symbol: "api_answers",
    kind: "python",
    fingerprint: "fee3065ef64f50d5",
    gates: ["answer"],
    what:
      "The submit door behind the `answer` verb. It 404s when no form exists and 409s a stale " +
      "one, and it never once consults answeredness, which is what lets a held topic's form be " +
      "submitted again after a crashed revise.",
    exemptions: [
      {
        id: "answers_role",
        raises: 'detail="answering requires a commenter or admin role"',
        why:
          "Identity. This is the one write a non-admin may make, and the role is not a fact about " +
          "the article.",
      },
      {
        id: "answers_unanswered_questions",
        raises: '"unanswered": exc.ids,',
        why:
          "The payload. Which boxes the operator left empty is decided as they press submit, and " +
          "the panel reports it inline against the questions themselves.",
      },
      {
        id: "answers_form_vanished_at_write",
        raises: "status_code=404, detail=str(exc)) run_id = uuid",
        why:
          "The same NoQuestions as the clause above it, re-raised from write_answers after the " +
          "form was read. It is the TOCTOU remainder of a check the clause already makes, so a " +
          "second clause over the same fact would decide nothing new.",
      },
    ],
  },
  api_revise_answered: {
    file: "server/app.py",
    symbol: "api_revise_answered",
    kind: "python",
    fingerprint: "65a6dc9cf340cc9a",
    gates: ["answer"],
    what:
      "The rerun door behind the `answer` verb. It 404s when no form exists, 409s a stale one, " +
      "and 409s a form nobody has answered, because a rerun with nothing to apply is a wasted " +
      "session.",
    exemptions: [
      {
        id: "revise_claimed_elsewhere",
        raises: "another engine already claimed this rerun",
        why:
          "A fact about ANOTHER machine's engine, held in the record for seconds and released " +
          "when that dispatch settles. Nothing on this page's wire reports it, and a control " +
          "withheld on it would flicker rather than inform.",
      },
    ],
  },
  answers_refuse_topic_in_flight: {
    file: "server/app.py",
    symbol: "_refuse_if_topic_in_flight",
    kind: "python",
    fingerprint: "5e994182fdc98029",
    gates: ["answer"],
    what:
      "The shared refusal both answer-verb routes make: this TOPIC is already in a live run, so " +
      "a revise would open a second session against the draft that run is writing.",
    exemptions: [
      {
        id: "answers_topic_in_flight",
        raises: "is already in a live run for",
        why:
          "Subsumed: a topic in a live run derives `generating`, whose bench is empty, and `live` " +
          "is on the wire for exactly that reason. It is listed as ONE source rather than twice " +
          "because both routes now call the same helper, which is the point of the helper: the " +
          "two used to refuse on the BRAND having any live run, and each carried its own " +
          "sentence saying so.",
      },
    ],
  },
  api_save_blog_content: {
    file: "server/app.py",
    symbol: "api_save_blog_content",
    kind: "python",
    fingerprint: "ac909ca1173c8d7c",
    gates: ["edit"],
    what:
      "The engine's save route. Beyond the three shared helpers it refuses a live run and the " +
      "payload.",
    exemptions: [
      {
        id: "save_route_live_run",
        raises: "edit once it finishes so the engine's",
        why: "Subsumed by `generating`.",
      },
      {
        id: "save_route_blank",
        raises: 'detail="an empty article cannot be saved',
        why: "The payload, as the hosted function's own blank refusal is.",
      },
      {
        id: "save_route_too_large",
        raises: 'status_code=413, detail="the article is over 1 MB',
        why: "The payload.",
      },
    ],
  },
  api_add_blog_comment: {
    file: "server/app.py",
    symbol: "api_add_blog_comment",
    kind: "python",
    fingerprint: "424261b6030a40d0",
    gates: ["comments"],
    what:
      "The engine's change request route, which files the comment AND starts the Claude session, " +
      "so it carries an in-flight cap the hosted function has no need of.",
    exemptions: [
      {
        id: "comment_route_live_run",
        raises: "edit once it finishes so the engine's",
        why: "Subsumed by `generating`.",
      },
      {
        id: "comment_route_blank",
        raises: 'detail="a comment needs both the selected text and an instruction"',
        why: "The payload.",
      },
    ],
    dependsOn: [
      {
        file: "server/blog_edit.py",
        constant: "MAX_IN_FLIGHT",
        why:
          "THE NUMBER THE CAP IS, which this route names and does not contain. The comparison " +
          "reads `>= blog_edit.MAX_IN_FLIGHT`, so the route's body is identical whether the " +
          "constant is 1, 3 or 10, and COMMENT_CAP's ENGINE_MAX_IN_FLIGHT would go on refusing " +
          "at 3 regardless. Both directions were demonstrated green: 10 makes the page refuse " +
          "what the engine allows, and 1 makes it OFFER what the engine refuses, which is the " +
          "fail-open half and the one this whole file exists to stop.",
      },
    ],
  },
  // THE RESOLVE HALF OF `comments`, and it was the largest unlisted surface in the engine: seven
  // refusals, four of them the same shared helpers the filing route runs, and none of it
  // enumerated. The four shared arms are NOT restated here. They are calls to _require_done,
  // _require_not_approved and _require_not_with_client, which are sources of their own with
  // clauses of their own, and the extractor sees raises INSIDE a body rather than raises reachable
  // from it. Restating them would put the same rule in the table twice and let the two copies
  // drift, which is the defect this file was written to remove.
  api_resolve_blog_comment: {
    file: "server/app.py",
    symbol: "api_resolve_blog_comment",
    kind: "python",
    fingerprint: "704a5484d1a4c258",
    gates: ["comments"],
    what:
      "Spends a Claude session on ONE waiting comment. The client's suggestions arrive 'open' " +
      "with no apply behind them because the portal runs no engine, so this is the door that " +
      "starts one, and a committed version comes out of it. That is why it carries the same done, " +
      "approved and with-client gates as filing, plus the in-flight cap riding inside its flip.",
    exemptions: [
      {
        id: "resolve_route_live_run",
        raises: "resolve once it finishes so the engine's",
        why: "Subsumed by `generating`, whose bench is empty.",
      },
      {
        id: "resolve_route_comment_unknown",
        raises: 'detail=f"no comment {comment_id!r} on {topic!r}")',
        why:
          "A property of ONE comment rather than of the article, and this contract is keyed by " +
          "article. The rail cannot offer a resolve on a row it does not hold.",
      },
      {
        id: "resolve_route_comment_state",
        raises: "this change is {state}; only an open or failed one can",
        why:
          "The other arm of the same flip, and a property of one comment again: 'resolved', " +
          "'dismissed' and 'applying' each refuse here. The card carries its own state and " +
          "withholds its own button, so an article-level clause would decide nothing it does not.",
      },
    ],
  },
  // THE DISMISS HALF ON THE BUILD THAT DOES THE WRITING, twin of admin_dismiss_comment above.
  // Neither was listed, so the whole act was invisible to the fingerprint on both builds at once.
  api_delete_blog_comment: {
    file: "server/app.py",
    symbol: "api_delete_blog_comment",
    kind: "python",
    fingerprint: "255f25f6cdf3c773",
    gates: ["comments"],
    what:
      "The engine's dismiss: any author's comment closed without an edit, never deleted, for the " +
      "reason migration 010 gives at length. It carries NO done, approved or with-client gate, " +
      "because closing a suggestion commits no version and spends no session, and it refuses an " +
      "applying comment twice over, once as a pre-check and once inside the atomic close.",
    exemptions: [
      {
        id: "dismiss_route_comment_unknown",
        raises: 'detail=f"no comment {comment_id!r} on {topic!r}")',
        why: "A property of one comment rather than of the article, as the resolve route's is.",
      },
      {
        id: "dismiss_route_applying_at_write",
        raises: 'it can be dismissed once it lands", ) return Response(status_code=204)',
        why:
          "The SAME refusal as the clause below it, re-raised after the atomic close came back " +
          "empty because a resolve flipped the row between the read and the write. It is the " +
          "TOCTOU remainder of a check the clause already makes, so a second clause over the " +
          "same fact would decide nothing new. The fragment recorded here reaches past the " +
          "identical detail string to the line that follows it, because the two raises are " +
          "otherwise word for word the same and a shorter fragment would match both.",
      },
    ],
  },
  // THE ONE RELEASE DOOR, at every score, and the separate promote route it absorbed is DELETED
  // rather than parked here. It appends a `done` verdict to the status trail for a below-bar
  // draft (blog_edit.promote_to_done), ledgers the blog, and releases it through mark_sent, so
  // every other gate in this table keeps demanding the literal "done" untouched: a promoted blog
  // satisfies them because the fold genuinely reads done afterward, never because one of them
  // was widened. That is the shape blog_edit.promote_if_failed already had for the
  // CMS push, copied rather than invented.
  api_send_blog_to_client: {
    file: "server/app.py",
    symbol: "api_send_blog_to_client",
    kind: "python",
    fingerprint: "0948090b650d9e32",
    gates: ["send"],
    what:
      "The engine's send route, and the only one an operator's release ever reaches: it " +
      "refuses a topic mid-run, calls blog_edit.promote_if_failed so a below-bar draft BECOMES " +
      "done rather than the done gate being widened, then stamps the send and reports the " +
      "open-suggestion sentinel mark_sent answers None with. The done gate, the approved lock " +
      "and the scored-draft refusal are _require_done's, _require_not_approved's and " +
      "promote_if_failed's own clauses, called rather than restated.",
    exemptions: [
      {
        id: "send_route_record_behind",
        raises: "status_code=409, detail=str(exc))",
        why:
          "blog_edit.EditError arriving one frame up. Its DECIDABLE half is the scoreless " +
          "failure, and that is a clause (promotes_scored_draft) rather than part of this " +
          "exemption. What is left is blog_edit.promote_to_done's own pair: the status feed on " +
          "this machine sitting behind a record another engine wrote (the promotion line gets " +
          "swallowed by the ordinal conflict, verified after commit), and a draft the machine " +
          "MOVED after its last evaluator score (a retry's writer replaced blog.md and died " +
          "before an eval, so the score describes other bytes). Both are facts about the status " +
          "feed's line-level shape at one instant, not conditions the record on this page's " +
          "wire can express, so no clause could decide either; the 409 carries the fix in the " +
          "engine's own words. The publish route carries the identical exemption over the " +
          "identical call.",
      },
    ],
  },
  // THE ONLY DOOR THE PUBLISH ACT PASSES THROUGH ON THE LOCAL BUILD, and it was not listed while
  // the gate module it calls was. That is the wrong way round to leave a surface: assert_publishable
  // decides, but this route is what an operator's press actually reaches, and it adds five refusals
  // of its own on top of the one it delegates. None of them was fingerprinted.
  // THE PROMOTION BOTH SHIP DOORS PERFORM BEFORE THEIR OWN GATE, and the reason a failed blog
  // reaches the client or the CMS without _require_done or assert_publishable being widened by a
  // syllable. ONE HOME, TWO DOORS: it used to live in server/cms/routes.py, which
  // the send route would have had to copy, and a second copy is a second answer to "may this
  // blog be promoted" free to drift from the first.
  promote_if_failed: {
    file: "server/blog_edit.py",
    symbol: "promote_if_failed",
    kind: "python",
    // Recorded when the two ship doors were folded into one release button and this helper
    // became their shared home, reconciled against its one raise rather than bumped.
    fingerprint: "7571018c45da9f02",
    gates: ["send", "publish"],
    what:
      "Promotes a FAILED topic to done on the operator's authority before either ship door's " +
      "gate sees it, appending the operator-named `done` verdict and the score. A silent " +
      "no-op for every other status, so needs_review, stopped and running fall through to the " +
      "caller's own refusal untouched. It refuses a failed topic with no evaluator-scored " +
      "draft, which is the one thing a sub-90 ship cannot waive.",
    exemptions: [],
  },
  api_publish_blog: {
    file: "server/cms/routes.py",
    symbol: "api_publish_blog",
    kind: "python",
    // Moved a second time when publishing began stamping the send. A push to the client's own
    // CMS puts the article live on their site, so leaving sent_to_client null after it hid an
    // article the client could already read: blogState drops `published` when there is no send.
    // The stamp SATISFIES that guard rather than bypassing it, since published-without-a-send
    // becomes unreachable instead of merely tolerated. Best-effort and after record_publish, so
    // no bookkeeping failure can report a landed publish as a failed one.
    //
    // Moved a THIRD time when the route began writing the CMS metadata. NO REFUSAL CHANGED, and
    // that is the reconciliation rather than an excuse for the hash: the route now calls
    // gate.assert_publishable itself before spending a model session, which duplicates a 409 arm
    // it already had (publish_route_gate_refused_before_metadata records it), and appends the
    // brand's accepted tags to its vocabulary after the push lands. The gate is called twice and
    // waived nowhere. Nothing here decides who may publish that did not decide it before.
    fingerprint: "fed52687240227a1",
    gates: ["publish"],
    what:
      "Pushes one shipped blog to the CMS as a draft, synchronously, because the operator is " +
      "watching. It resolves the brand and the topic, delegates the real gate to " +
      "server/cms/gate.py, resolves the one shared write key, maps the CMS's own failure back " +
      "to a status that blames the right party, and then stamps the send so the client's portal " +
      "shows the article they can already read on their site.",
    exemptions: [
      {
        id: "publish_route_client_unknown",
        raises: "detail=f\"No client '{slug}'\"",
        why:
          "Existence and identity rather than the record, and answered the same way " +
          "_client_or_404's own 404 is. A page rendering this brand's article is not in this " +
          "condition.",
      },
      {
        id: "publish_route_topic_unknown",
        raises: "detail=f\"No blog '{topic_slug}'\"",
        why:
          "Resolution and the traversal guard together, exactly as _topic_or_404's is: a " +
          "topic_slug that does not survive slugify is a smuggled path, and it answers 404 " +
          "rather than naming what it found.",
      },
      {
        id: "publish_promote_did_not_land",
        raises: "status_code=409, detail=str(exc))",
        why:
          "blog_edit.EditError from promote_if_failed, arriving one frame up, and the identical " +
          "exemption the send route carries over the identical call. Its decidable half is the " +
          "scoreless failure, which is the promotes_scored_draft clause; what is left is " +
          "promote_to_done's pair, a status feed BEHIND the record and a draft the machine MOVED " +
          "after its last evaluator score. Both are facts about the status feed's line-level " +
          "shape at one instant, not conditions this page's wire can express.",
      },
      {
        id: "publish_route_gate_refused",
        raises: "status_code=409, detail=str(refused))",
        why:
          "The HTTP mapping of gate.PublishRefused, which is assert_publishable's refusal " +
          "arriving one frame up. PUBLISH_TOPIC_IS_DONE already carries the one arm of it that " +
          "is on this page's wire, and the other three are exempt against the gate module " +
          "itself. A clause here would restate that decision in a second place and let the two " +
          "drift, which is the shape of this whole defect.",
      },
      {
        id: "publish_route_gate_refused_before_metadata",
        raises: "status_code=409, detail=str(refused))",
        why:
          "THE SAME REFUSAL AS THE ENTRY ABOVE, raised one call earlier, and deliberately not " +
          "merged with it. The route gates BEFORE generating the CMS metadata so a blog the gate " +
          "will refuse never costs a model session; build_for_publish then gates AGAIN on its " +
          "own authority, because a caller allowed to skip that check is precisely the one `if` " +
          "between an unvetted draft and a client that gate.py's own docstring refuses to " +
          "permit. Two calls, two arms, one decision. The duplication is the price of never " +
          "letting the gate become the caller's option, and it is exempt for the same reason " +
          "the other arm is: PUBLISH_TOPIC_IS_DONE already carries the half of it that is on " +
          "this page's wire.",
      },
      {
        id: "publish_route_payload",
        raises: "status_code=422, detail=str(bad))",
        why:
          "The payload the gate built, rejected for its own shape. Decided from artifacts on " +
          "disk at the moment of pushing and not predictable from any fact this page holds.",
      },
      {
        id: "publish_route_no_cms_key",
        raises: "detail=cms_client.missing_key_detail()",
        why:
          "THE ENGINE'S CONFIGURATION, not the article. Whether the one shared CMS write key is " +
          "set is resolved from the process environment and server/.env at the moment of the " +
          "push, and no read this page makes reports it. A clause would answer `unknowable` for " +
          "every article on every brand and, failing closed, would remove the Publish control " +
          "from a correctly configured machine because the page cannot see a file it has no " +
          "business reading. The 503 names the file and the resolution order, which is the " +
          "sentence an operator can act on.",
      },
      {
        id: "publish_route_cms_upstream",
        raises: "status_code=_status_for(cause.status)",
        why:
          "The CMS's own failure, mapped rather than flattened: a revoked key answers 503 and an " +
          "unreachable host answers 502. It is a fact about another service at one instant and " +
          "not a condition the record can be in, so nothing here could withhold a control on it.",
      },
    ],
  },
  // WHAT ACTUALLY REFUSES A PUBLISH. The first contract declared `publish` to carry zero clauses,
  // reason given as "it changes nothing about the article". That is true of the article and false
  // of the act: this gate refuses any blog whose terminal status is not the literal string
  // "done", and it says at length why the refusal is server side rather than a disabled button.
  assert_publishable: {
    file: "server/cms/gate.py",
    symbol: "assert_publishable",
    kind: "python",
    fingerprint: "6c0e709494aba15e",
    gates: ["publish"],
    what:
      "The only-push-finished-blogs check, and the only thing standing between an unvetted draft " +
      "and a CMS post an editor can approve. It refuses a topic with no committed body, a topic " +
      "with no status feed, and any status that is not exactly 'done'.",
    exemptions: [
      {
        id: "publish_no_body",
        raises: "No blog on disk for",
        why:
          "Whether the record holds a committed version is not on this page's wire. It is also " +
          "not a condition a published or approved article can be in, and those two states are " +
          "the whole of the bench that grants `publish`.",
      },
      {
        id: "publish_no_status_feed",
        raises: "has no status feed, so the engine cannot confirm it finished",
        why:
          "A topic with no status feed folds to the `unknown` state, whose bench is empty, so the " +
          "control is already withheld by the layer above this one.",
      },
    ],
  },
  cms_record_blog: {
    file: "server/cms/gate.py",
    symbol: "_record_blog",
    kind: "python",
    fingerprint: "b7e089f910d5fe5f",
    gates: ["publish"],
    what:
      "Chooses WHICH committed bytes a push ships: the latest version normally, and the version " +
      "the client actually approved once there is an approval. It refuses rather than guesses " +
      "when the two have come apart.",
    exemptions: [
      {
        id: "publish_approved_version_unknown",
        raises: "the record does not say which",
        why:
          "An integrity fault inside the record, over columns this page's wire does not carry " +
          "(sent_version_id and the version list). A clause would answer `unknowable` for every " +
          "approved article and, failing closed, would remove the Publish control from the one " +
          "state whose entire purpose is to offer it. Publishing is also the one act that changes " +
          "nothing about the article, so an attempt that is refused costs the operator a sentence " +
          "rather than a mistake, and that sentence names both versions and asks for a decision. " +
          "The trade is made deliberately here rather than by omission.",
      },
      {
        id: "publish_approved_version_mismatch",
        raises: "is the latest in the record, so the approval and",
        why: "The other arm of the same integrity fault, exempt for the reason above.",
      },
    ],
  },
  edit_refuse_if_approved: {
    file: "server/blog_edit.py",
    symbol: "_refuse_if_approved",
    kind: "python",
    // Re-recorded when _COMMENT_COLS (inside this symbol's extraction window) gained the
    // added_to_instructions column. The refusals themselves are unchanged.
    fingerprint: "0cf2e733ba99a033",
    gates: ["edit", "comments"],
    what:
      "The engine module's own approved lock, in front of the trigger, so an operator reads a " +
      "sentence naming the approval instead of an unmapped database exception.",
    exemptions: [],
  },
  edit_refuse_live_run: {
    file: "server/blog_edit.py",
    symbol: "_refuse_live_run",
    kind: "python",
    fingerprint: "df36bf4671600ba8",
    gates: ["edit", "comments"],
    what:
      "Refuses an apply whose session started before a run took ownership of the same files, " +
      "checked after the session rather than before it.",
    exemptions: [
      {
        id: "apply_live_run",
        raises: "started before this change was",
        why:
          "Subsumed by `generating`, and checked AFTER the Claude session has already run, so no " +
          "control could have withheld itself on it in the first place.",
      },
    ],
  },
  edit_refuse_moved_record: {
    file: "server/blog_edit.py",
    symbol: "_refuse_moved_record",
    kind: "python",
    fingerprint: "514b6f80167032f4",
    gates: ["edit", "comments"],
    what:
      "Refuses a write whose base version is no longer the record's latest, which is how a " +
      "teammate's engine committing in the same window avoids being silently reverted.",
    exemptions: [
      {
        id: "apply_record_moved",
        raises: "raise EditError(CONFLICT_ERROR)",
        why:
          "The base version is not on this page's wire, the same gap admin_save_blog_content's " +
          "PORTAL:STALE leaves, and closing it needs a version_no in the blogs read.",
      },
    ],
  },
  edit_add_comment: {
    file: "server/blog_edit.py",
    symbol: "add_comment",
    kind: "python",
    fingerprint: "dcc9bef338eac73b",
    gates: ["comments"],
    what:
      "Inserts the operator's comment in state 'applying' by default, which is what makes filing " +
      "one through the auto-apply route an edit rather than a note, and calls the approved lock " +
      "before it does. The auto_apply=False path (docx import) inserts 'open' instead, a note the " +
      "operator resolves by hand from the rail, and the approved lock still precedes it.",
    exemptions: [
      {
        id: "add_comment_topic_unknown",
        raises: 'raise EditError(f"no topic {topic_slug!r} for client {client_slug!r}")',
        why: "Resolution rather than a gate, as _topic_or_404's own is.",
      },
    ],
  },
  edit_mark_sent: {
    file: "server/blog_edit.py",
    symbol: "mark_sent",
    kind: "python",
    fingerprint: "64246bfa6184c19b",
    gates: ["send"],
    what:
      "The engine's send. It raises nothing at all: both of its refusals answer None, and the " +
      "open-suggestion one lives in the UPDATE's own WHERE so a portal write cannot land between " +
      "a count and a stamp.",
    exemptions: [
      {
        id: "mark_sent_approved_sentinel",
        raises: null,
        why:
          "A sentinel return rather than a raise, over the same fact the approved clauses already " +
          "carry. It is the lock ITSELF for this act: sending inserts nothing, so neither trigger " +
          "in migration 013 fires on it, and the UPDATE would clear the very approval the lock " +
          "protects.",
      },
      {
        id: "mark_sent_open_suggestion_sentinel",
        raises: null,
        why:
          "The other sentinel: zero rows updated IS the refusal, and the send clause below carries " +
          "the same fact from the route that turns the None into a 409.",
      },
    ],
  },
};

export type GateClause = {
  /** Stable id, used in test names and in the refusal a control reports. */
  id: string;
  source: GateSourceId;
  /**
   * 1-indexed line in the source file where `condition` sits, as of the last reconciliation.
   *
   * DOCUMENTATION FIRST AND AN ASSERTION SECOND. The drift test checks it, and it reports a MOVED
   * line and a MISSING condition as two different failures with two different instructions,
   * because they mean opposite things: a moved line is an unrelated edit above and the fix is to
   * update the number, while a missing condition is the gate itself changing and the fix is to
   * reconcile this table. Folding them into one message is how a person learns to bump numbers
   * without reading them.
   */
  line: number;
  /** The refusal's condition, VERBATIM from the file. The drift test looks this up literally. */
  condition: string;
  /**
   * A distinctive VERBATIM fragment of the raise this condition guards, for the accounting test.
   * Null where the refusal is a sentinel return rather than a raise.
   */
  raises: string | null;
  /** What the layer raises when the condition holds, so a withheld control can say why. */
  refusal: string;
  /**
   * Whether this condition clears on its own while the operator watches.
   *
   * WHY THIS LIVES ON THE CLAUSE AND NOT IN THE COMPONENT. blog-stage.tsx has a stated rule that a
   * control refused by the STATE is gone rather than greyed, with a stated exception for
   * conditions to wait out: a Claude apply already in flight, the engine's one-session cap. That
   * distinction is a property of the REFUSAL, not of the control, and left in the component it
   * becomes a second private opinion about what the layers below do. The page would be keeping its
   * own list of which refusals are worth waiting for, and the moment a new one is added the list
   * is silently short, which is the shape of every round of this defect.
   */
  transient: boolean;
  /** This clause evaluated over the facts the caller actually has. */
  decide: (input: GateInput) => ClauseVerdict;
  /**
   * One input this clause must PASS and one it must REFUSE.
   *
   * WHAT THIS BUYS AND WHAT IT DOES NOT. The fingerprint pins the source text and the accounting
   * pins the set of refusals; neither can see whether the decide() beside a condition computes
   * that condition. A decide() edited into `() => "pass"` to clear a red build satisfies both, and
   * that is exactly how this table would rot. The witness makes that edit fail, because a constant
   * cannot produce two answers. It does NOT prove the comparison is the right one, which is the
   * known floor stated at the top of this file.
   */
  witness: { passes: GateInput; refuses: GateInput };
};

/**
 * One route into an act.
 *
 * `answer` HAS TWO AND EVERY OTHER VERB HAS ONE, which is the whole reason doors exist rather than
 * a flat clause list per action. blog-state.ts already documents `answer` as two acts behind one
 * verb: submit the answers, or dispatch the rerun for answers the client already filed. They are
 * separate routes with DIFFERENT and partly OPPOSITE conditions, because POST /revise requires
 * `answered` and POST /answers does not care. A flat AND over both would refuse every record, and
 * a flat OR over both would grant on a clause the other route refuses. An action is allowed when
 * SOME door passes every one of its own clauses, which is what "there is a way through" means.
 */
export type GateDoor = {
  id: string;
  /** What pressing this door does, for the person reading a withheld control's reason. */
  what: string;
  clauses: readonly GateClause[];
};

/** A record that passes everything, so a witness can vary one fact and mean exactly that fact. */
const CLEAN: GateInput = {
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

/** The same input with one record fact changed. Keeps every witness a one-variable statement. */
function withRecord(patch: Partial<GateRecord>): GateInput {
  return { ...CLEAN, record: { ...CLEAN.record, ...patch } };
}

const APPROVED_AT = "2026-07-19T10:00:00Z";

const DONE_TOPIC: GateClause = {
  id: "topic_is_done",
  source: "admin_done_topic",
  line: 136,
  condition: "if v_status is distinct from 'done'::topic_status then",
  raises: "PORTAL:NOTDONE:this blog is %, not done",
  refusal: "PORTAL:NOTDONE",
  transient: false,
  // The status IS on the wire, so this one is always decidable. It is also the clause rounds two
  // and three got wrong by granting acts in `answers_submitted`, a state derived from the client's
  // submit stamp rather than from the status, and therefore spanning both 'needs_review' before
  // the rerun and 'done' after it.
  decide: ({ record }) => (record.status === "done" ? "pass" : "refuse"),
  witness: { passes: CLEAN, refuses: withRecord({ status: "needs_review" }) },
};

// THE SAME RULE ON THE BUILD THAT DOES THE WRITING, and its absence was the reviewer's second
// demonstration. Recorded as its own clause rather than folded into DONE_TOPIC because it is a
// different function in a different language: either can change without the other, and a single
// clause would have to name one file and go quiet about the other.
const DONE_TOPIC_ENGINE: GateClause = {
  id: "topic_is_done_engine",
  source: "require_done",
  line: 1645,
  condition: 'if status != "done":',
  raises: "not done; {act} is for shipped blogs only",
  refusal: "409 this blog is not done, and the stage is for shipped blogs",
  transient: false,
  // THE GATE IS UNCHANGED AND STILL DEMANDS THE LITERAL "done", exactly as
  // PUBLISH_TOPIC_IS_DONE says of its own twin, and this clause is shaped from that one. What
  // changed is what reaches it: the send route promotes a failed topic with a scored draft
  // before calling this, appending the operator-named `done` verdict, so the status really is
  // done by the time the comparison runs. A SCORELESS FAILURE STILL REFUSES, through
  // PROMOTES_SCORED_DRAFT: the promotion cannot happen, so the status stays failed.
  decide: ({ record }) =>
    record.status === "done" || (record.status === "failed" && record.score != null)
      ? "pass"
      : "refuse",
  witness: { passes: CLEAN, refuses: withRecord({ status: "failed" }) },
};

// THE ADMIN-REVIEW BENCH NOW SEATS A FAILED DRAFT, and this clause is the widening, kept as
// its own function so DONE_TOPIC_ENGINE above stays a separate statement about a separate
// gate. The operator may polish a sub-90 draft with edits and Claude comments before sending
// it: the released artifact should be the draft they are satisfied with. needs_review stays
// out (a hold no edit clears), stopped and running have no settled draft, and the send is the
// one door that ships a failed draft, by promoting it on the way through.
const REVIEWABLE_TOPIC_ENGINE: GateClause = {
  id: "topic_is_reviewable_engine",
  source: "require_reviewable",
  line: 1876,
  condition: 'if status not in ("done", "failed"):',
  raises: "not done or failed; {act} is for settled",
  refusal: "409 this blog is neither done nor failed, so the admin-review bench is closed",
  transient: false,
  decide: ({ record }) =>
    record.status === "done" || record.status === "failed" ? "pass" : "refuse",
  witness: { passes: withRecord({ status: "failed" }), refuses: withRecord({ status: "needs_review" }) },
};

const NOT_APPROVED_SQL: GateClause = {
  id: "not_approved_sql",
  source: "admin_done_topic",
  line: 143,
  condition: "if v_approved is not null then",
  raises: "PORTAL:LOCKED:the client approved this article on %, so it is locked. %",
  refusal: "PORTAL:LOCKED",
  transient: false,
  decide: ({ record }) => (record.client_approved ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ client_approved: APPROVED_AT }) },
};

const NOT_APPROVED_VERSION_TRIGGER: GateClause = {
  id: "not_approved_version_trigger",
  source: "refuse_version_when_approved",
  line: 53,
  condition: "if v_approved is not null then",
  raises: "PORTAL:LOCKED:the client approved this article on %, so it is locked and cannot be",
  refusal: "PORTAL:LOCKED, from the trigger every version-committing path passes",
  transient: false,
  decide: ({ record }) => (record.client_approved ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ client_approved: APPROVED_AT }) },
};

const NOT_APPROVED_COMMENT_TRIGGER: GateClause = {
  id: "not_approved_comment_trigger",
  source: "refuse_comment_when_approved",
  line: 92,
  condition: "if v_approved is not null then",
  raises: "PORTAL:LOCKED:this article was approved on % and is locked",
  refusal: "PORTAL:LOCKED, from the trigger on top-level comments",
  transient: false,
  decide: ({ record }) => (record.client_approved ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ client_approved: APPROVED_AT }) },
};

const NOT_APPROVED_ENGINE: GateClause = {
  id: "not_approved_engine",
  source: "require_not_approved",
  line: 1669,
  condition: "if approved is not None:",
  raises: "detail=blog_edit.locked_detail(approved, act))",
  refusal: "409 the client approved this article, so it is locked",
  transient: false,
  decide: ({ record }) => (record.client_approved ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ client_approved: APPROVED_AT }) },
};

const NOT_APPROVED_EDIT_MODULE: GateClause = {
  id: "not_approved_edit_module",
  source: "edit_refuse_if_approved",
  line: 140,
  condition: "if approved is not None:",
  raises: "raise EditError(locked_detail(approved, act))",
  refusal: "EditError, the engine module's own lock in front of the trigger",
  transient: false,
  decide: ({ record }) => (record.client_approved ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ client_approved: APPROVED_AT }) },
};

/**
 * OUT WITH THE CLIENT, WHICH IS A SEND WITH NO ROUND OPEN.
 *
 * The condition recorded is the EARLY RETURN rather than the raise, because that is where the
 * decision is made: _require_not_with_client raises unconditionally once it gets past this line.
 * `_with_client_since` answers None both for an article that was never sent and for one whose
 * client has since asked for something, which is exactly blogState's split between `client_review`
 * and `changes_requested`, so the two facts this reads are the two the wire already carries.
 */
const NOT_WITH_CLIENT: GateClause = {
  id: "not_with_client",
  source: "require_not_with_client",
  line: 1746,
  condition: "if sent_at is None:",
  raises: "was sent to the client on",
  refusal: "409 the client is reading the exact version that was sent",
  transient: false,
  decide: ({ record }) => (record.sent_to_client && !record.change_round_open ? "refuse" : "pass"),
  witness: {
    passes: CLEAN,
    refuses: withRecord({ sent_to_client: APPROVED_AT, change_round_open: false }),
  },
};

/**
 * THE SEND'S ONE REFUSAL OF ITS OWN, on both builds, and it is a WHERE clause rather than a count.
 *
 * `changes_requested` on the wire counts top-level client comments in state 'open' or 'applying',
 * which is precisely the set the UPDATE's `not exists` subquery excludes. The clause is recorded
 * against the SQL, and its engine twin below against the route that reads mark_sent's None.
 */
const SEND_NO_OPEN_SUGGESTIONS_SQL: GateClause = {
  id: "send_no_open_suggestions_sql",
  source: "admin_send_blog_to_client",
  line: 201,
  condition: "if v_rows = 0 then",
  raises: "PORTAL:OPENSUGGESTIONS:the client",
  refusal: "PORTAL:OPENSUGGESTIONS",
  transient: false,
  decide: ({ record }) => ((record.changes_requested ?? 0) > 0 ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ changes_requested: 2 }) },
};

const SEND_NO_OPEN_SUGGESTIONS_ENGINE: GateClause = {
  id: "send_no_open_suggestions_engine",
  source: "api_send_blog_to_client",
  line: 2045,
  condition: "if state is None:",
  raises: "the client's suggestions are still open; resolve or dismiss each",
  refusal: "409 the client's suggestions are still open",
  transient: false,
  decide: ({ record }) => ((record.changes_requested ?? 0) > 0 ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ changes_requested: 1 }) },
};

// ---------------------------------------------------------------------------
// The two clauses the send door absorbed when the promote door was deleted.
// ---------------------------------------------------------------------------
// Both were written against a separate route that shipped a FAILED blog, and both survive
// because the refusals survive: the send route now performs the promotion itself, so a
// mid-run topic and a scoreless failure are refused by the door the operator actually
// presses. The two that did NOT survive were about scoping that separate door and nothing
// else: a status test admitting `failed` alone, which is exactly what DONE_TOPIC_ENGINE now
// spans from the other side, and a second copy of the open-suggestion sentinel, which
// SEND_NO_OPEN_SUGGESTIONS_ENGINE already reports from the same mark_sent.

const SEND_NOT_IN_FLIGHT: GateClause = {
  id: "send_not_in_flight",
  source: "api_send_blog_to_client",
  line: 2888,
  condition: "if topic in _live_run_slugs(slug):",
  raises: "is generating right now in a live run",
  refusal: "409 this topic is generating right now in a live run",
  transient: false,
  // THE REFUSAL A RETRY NEEDS. A retried topic keeps the PREVIOUS run's `failed` fold on the
  // wire while the new run is live, so without this a send would promote and release the
  // draft the operator just asked to be replaced. The registry excludes topics whose session
  // already settled (mark_topic_terminal), so a failed topic mid-batch reads live: false and
  // is sendable while its siblings still run, exactly as it is re-selectable on the roadmap.
  decide: ({ record }) => (record.live ? "refuse" : "pass"),
  witness: { passes: CLEAN, refuses: withRecord({ live: true }) },
};

/**
 * A SAVE WAITS FOR AN APPLY, AND THIS CLAUSE IS WHY THE EDIT CONTROL GREYS RATHER THAN VANISHES.
 *
 * The stage page always held this number and always disabled the Edit button on it with a hand
 * written `applying > 0`, one layer below a canEdit that knew nothing about the refusal. The
 * number now reaches the gate, and `transient` carries the shape of the control so the page no
 * longer decides for itself what migration 010 does.
 */
const NO_APPLY_IN_FLIGHT: GateClause = {
  id: "no_apply_in_flight",
  source: "admin_save_blog_content",
  line: 113,
  condition: "where topic_id = v_tid and parent_id is null and state = 'applying') then",
  raises: "PORTAL:APPLYING:a change is being applied to this article",
  refusal: "PORTAL:APPLYING, so the save waits for the apply to land",
  transient: true,
  decide: ({ applying }) => applyingCount(applying, (count) => count === 0),
  witness: { passes: CLEAN, refuses: { ...CLEAN, applying: 1 } },
};

/**
 * blog_edit.MAX_IN_FLIGHT, MIRRORED, and the mirroring is checked rather than trusted.
 *
 * THIS FILE CANNOT READ THE PYTHON AND MUST NOT TRY. It ships to the browser, where node:fs does
 * not exist and a bundle that reached for the repo working tree would be a build error at best. So
 * the value is carried here as an inert number, exactly as the fingerprints are inert strings, and
 * gate-extract.ts reads the real constant in the TEST process and holds this one against it.
 *
 * WHAT THAT BUYS OVER THE LITERAL 3 THAT USED TO SIT IN THE decide() BELOW. Nothing at runtime:
 * the number is the same number. The whole of the difference is that a bare 3 inside a lambda is
 * invisible to every mechanism in this file, and a named export with a test behind it is not.
 * Changing MAX_IN_FLIGHT to 10 or to 1 in server/blog_edit.py left the entire suite green, because
 * api_add_blog_comment names the constant rather than containing it, so no body moved and no
 * fingerprint noticed. TWO mechanisms close that now and they fail differently on purpose: the
 * `dependsOn` entry on api_add_blog_comment moves that source's fingerprint, which says "the cap
 * this gate rests on is not the cap it rested on", and the parity test on this constant says
 * "the engine caps at N and this page caps at 3", which is the sentence that names the fix.
 *
 * THE `= 1` DIRECTION IS THE ONE THAT MATTERS. Raising the engine's cap makes this page refuse
 * something the engine would take, which costs an operator a control they could have had. Lowering
 * it makes this page OFFER a comment the engine refuses outright, which is the offered-but-refused
 * defect this entire contract exists to make impossible, arriving through a number nobody hashed.
 */
export const ENGINE_MAX_IN_FLIGHT = 3;

/**
 * THREE APPLIES AT ONCE IS THE CAP, and the composer already renders the remainder beside itself.
 * The count is taken on the RECORD rather than in one machine's memory, because two engines share
 * it, and the ceiling comes from ENGINE_MAX_IN_FLIGHT above rather than from a literal written out
 * here, so this clause and server/blog_edit.py cannot quietly come to hold different numbers.
 */
const COMMENT_CAP: GateClause = {
  id: "comment_in_flight_cap",
  source: "api_add_blog_comment",
  line: 1803,
  condition:
    "if await asyncio.to_thread(blog_edit.in_flight_count, slug, topic) >= blog_edit.MAX_IN_FLIGHT:",
  raises: "changes are already in flight for",
  refusal: "409 the engine's three-apply cap is full; wait for one to land",
  transient: true,
  decide: ({ applying }) => applyingCount(applying, (count) => count < ENGINE_MAX_IN_FLIGHT),
  witness: { passes: CLEAN, refuses: { ...CLEAN, applying: ENGINE_MAX_IN_FLIGHT } },
};

/**
 * THE SAME CAP ON THE OTHER DOOR INTO A CLAUDE SESSION, and it is a separate clause for the reason
 * DONE_TOPIC and DONE_TOPIC_ENGINE are separate: it is a different function, and either can change
 * without the other. Folding the two into one clause would name one route and go quiet about the
 * second, which is how api_resolve_blog_comment came to be unlisted in the first place.
 *
 * THE CONDITION RECORDED IS THE RE-READ RATHER THAN A COUNT, because this route no longer runs a
 * count of its own. The cap moved INSIDE blog_edit.resolve_comment's flip statement, so the route
 * learns it was refused by getting nothing back, then re-reads the comment to say WHICH of the two
 * possible refusals it was: a row that still reads open or failed was refused by the cap, and
 * anything else was refused by its own state. That re-read is where the cap is distinguished, so
 * that is the line this clause pins.
 */
const RESOLVE_COMMENT_CAP: GateClause = {
  id: "resolve_in_flight_cap",
  source: "api_resolve_blog_comment",
  line: 1883,
  condition: 'if state in ("open", "failed"):',
  raises: "changes are already in flight for",
  refusal: "409 the engine's three-apply cap is full; wait for one to land before resolving",
  transient: true,
  decide: ({ applying }) => applyingCount(applying, (count) => count < ENGINE_MAX_IN_FLIGHT),
  witness: { passes: CLEAN, refuses: { ...CLEAN, applying: ENGINE_MAX_IN_FLIGHT } },
};

/**
 * A DISMISS WAITS FOR AN APPLY, ON BOTH BUILDS, and these two clauses are why the `comments` act
 * now answers about more than filing.
 *
 * WHAT THE LAYER REFUSES. Migration 010's UPDATE carries `and state <> 'applying'` in its own
 * WHERE and raises PORTAL:APPLYING when it matches nothing; server/app.py checks the same state
 * first and raises the same sentence. Both exist for one reason, stated in the engine route's own
 * docstring: an applying comment has a background task behind it that will land its verdict, and
 * closing the row underneath that task leaves the verdict written onto something already dismissed.
 *
 * WHY THE ARTICLE-LEVEL COUNT IS THE RIGHT FACT TO READ, given the refusal is about ONE comment.
 * `applying` is the number of top-level comments mid-apply on THIS article, which blog-stage.tsx
 * already computes off the rail it already fetches. At zero, no comment on the article is applying
 * and no dismiss can be refused for this reason. Above zero, at least one row would be, and the
 * contract fails closed rather than guessing which row the operator is about to press. That is the
 * same shape as NO_APPLY_IN_FLIGHT on the save door, over the identical fact.
 *
 * THE HONEST COST, WRITTEN DOWN RATHER THAN DISCOVERED. `comments` is ONE act covering a rail that
 * files, resolves and dismisses, so a clause true of dismissing now speaks for filing too, and
 * `adminGateAllows("comments", ...)` answers false with one apply in flight even though the
 * composer itself would be taken. TRANSIENT IS WHAT KEEPS THAT FROM COSTING ANYTHING VISIBLE:
 * `adminGateStanding` skips transient clauses when it computes `mount`, so the control stays on
 * the page and greys with the layer's own reason on it, which is exactly what an operator wants
 * while an apply lands. Splitting filing and dismissing apart properly means a seventh verb in
 * AdminAction, which is blog-state.ts's to give and not this file's to invent.
 */
const DISMISS_NOT_APPLYING_SQL: GateClause = {
  id: "dismiss_not_applying_sql",
  source: "admin_dismiss_comment",
  line: 51,
  condition: "and state <> 'applying'",
  raises: "PORTAL:APPLYING:this change is still being applied",
  refusal: "PORTAL:APPLYING, so the dismiss waits for the apply to land",
  transient: true,
  decide: ({ applying }) => applyingCount(applying, (count) => count === 0),
  witness: { passes: CLEAN, refuses: { ...CLEAN, applying: 1 } },
};

const DISMISS_NOT_APPLYING_ENGINE: GateClause = {
  id: "dismiss_not_applying_engine",
  source: "api_delete_blog_comment",
  line: 1946,
  condition: 'if found.get("state") == "applying":',
  raises: 'it can be dismissed once it lands", ) if await asyncio.to_thread(blog_edit.dismiss_comment',
  refusal: "409 this change is still being applied; it can be dismissed once it lands",
  transient: true,
  decide: ({ applying }) => applyingCount(applying, (count) => count === 0),
  witness: { passes: CLEAN, refuses: { ...CLEAN, applying: 1 } },
};

/**
 * PUBLISH IS NOT UNGATED, and the first version of this contract said it was.
 *
 * server/cms/gate.py refuses any blog whose terminal status is not the literal string "done", and
 * it argues at length that the refusal must be server side because a CMS draft is directly
 * approvable and the CMS cannot tell a blog that scored 96 from one that hit the iteration cap.
 * The bench grants `publish` in `approved` and `published`, both of which normally carry a done
 * status, so this clause is quiet on the happy path and withholds the control on exactly the
 * records where the push would come back a 409.
 */
const PUBLISH_TOPIC_IS_DONE: GateClause = {
  id: "publish_topic_is_done",
  source: "assert_publishable",
  line: 229,
  condition: 'if status != "done":',
  raises: "not done. Only a blog the engine shipped",
  refusal: "409 only a blog the engine shipped may reach the CMS",
  transient: false,
  // THE GATE IS UNCHANGED AND STILL DEMANDS THE LITERAL "done". What changed is what reaches
  // it: blog_edit.promote_if_failed runs FIRST and promotes a failed topic on the
  // operator's authority, appending the same `done` verdict the send door appends,
  // so by the time this check runs the status really is done. That is why `failed` passes here
  // rather than the gate having been widened, and it is why the promotion's own refusal is a
  // separate clause below rather than a condition folded into this one.
  //
  // A SCORELESS FAILURE STILL REFUSES, through PROMOTES_SCORED_DRAFT: the promotion
  // cannot happen, so the status stays failed and this check refuses it exactly as before.
  decide: ({ record }) =>
    record.status === "done" || (record.status === "failed" && record.score != null)
      ? "pass"
      : "refuse",
  witness: { passes: CLEAN, refuses: withRecord({ status: "needs_review" }) },
};

/**
 * THE PROMOTION EITHER SHIP DOOR PERFORMS ON A FAILED BLOG, and the one thing that can refuse it.
 *
 * The operator may release a sub-90 draft they have read to the client, or post it to the CMS,
 * and both doors express that authority the same way: an appended `done` verdict naming them and
 * the score. ONE CLAUSE FOR BOTH, because it is one function refusing once (blog_edit
 * promote_if_failed); a copy per door would be two statements of one rule, free to drift, which
 * is the defect this whole file exists to prevent. Gates and the link pass run BEFORE the eval,
 * so a scored committed draft is gate-clean and link-clean by construction, and the 90 bar is
 * the ONLY thing being waived. A failed topic with no scored version (a crash, a preflight
 * refusal) has nothing shippable in it at all.
 */
const PROMOTES_SCORED_DRAFT: GateClause = {
  id: "promotes_scored_draft",
  source: "promote_if_failed",
  line: 1078,
  condition: "if score is None:",
  raises: "has no evaluator-scored draft, so there is nothing to",
  refusal: "409 no evaluator-scored draft exists to ship",
  transient: false,
  // Only a FAILED record passes through the promotion at all; a done one skips it untouched.
  decide: ({ record }) =>
    record.status !== "failed" || record.score != null ? "pass" : "refuse",
  witness: {
    passes: withRecord({ status: "failed", score: 92 }),
    refuses: withRecord({ status: "failed" }),
  },
};

const FORM_EXISTS_FOR_ANSWERS: GateClause = {
  id: "answers_form_exists",
  source: "api_answers",
  line: 1454,
  condition: "except questions_mod.NoQuestions as exc:",
  raises: "status_code=404, detail=str(exc)) if state[",
  refusal: "404 no questions on this topic",
  transient: false,
  decide: ({ form }) => formPresence(form),
  witness: { passes: CLEAN, refuses: { ...CLEAN, form: "absent" } },
};

const FORM_NOT_STALE_FOR_ANSWERS: GateClause = {
  id: "answers_form_not_stale",
  source: "api_answers",
  line: 1457,
  condition: 'if state["stale"]:',
  raises: "these questions describe iteration",
  refusal: "409 these questions describe an earlier iteration",
  transient: false,
  decide: ({ form }) => formFlag(form, (f) => !f.stale),
  witness: { passes: CLEAN, refuses: { ...CLEAN, form: { stale: true, answered: true } } },
};

const FORM_EXISTS_FOR_REVISE: GateClause = {
  id: "revise_form_exists",
  source: "api_revise_answered",
  line: 1536,
  condition: "except questions_mod.NoQuestions as exc:",
  raises: "status_code=404, detail=str(exc)) if state[",
  refusal: "404 no questions on this topic",
  transient: false,
  decide: ({ form }) => formPresence(form),
  witness: { passes: CLEAN, refuses: { ...CLEAN, form: "absent" } },
};

const FORM_NOT_STALE_FOR_REVISE: GateClause = {
  id: "revise_form_not_stale",
  source: "api_revise_answered",
  line: 1538,
  condition: 'if state["stale"]:',
  raises: "these questions describe an earlier draft of",
  refusal: "409 a revise has already replaced the draft these questions ask about",
  transient: false,
  decide: ({ form }) => formFlag(form, (f) => !f.stale),
  witness: { passes: CLEAN, refuses: { ...CLEAN, form: { stale: true, answered: true } } },
};

const FORM_ANSWERED_FOR_REVISE: GateClause = {
  id: "revise_form_answered",
  source: "api_revise_answered",
  line: 1544,
  condition: 'if not state["answered"]:',
  raises: "have no answers yet, so a rerun has nothing",
  refusal: "409 the questions have no answers yet, so a rerun has nothing to apply",
  transient: false,
  decide: ({ form }) => formFlag(form, (f) => f.answered),
  witness: { passes: CLEAN, refuses: { ...CLEAN, form: { stale: false, answered: false } } },
};

/** Every clause this contract knows, so the drift test can walk them without walking the doors. */
export const ALL_GATE_CLAUSES: readonly GateClause[] = [
  DONE_TOPIC,
  DONE_TOPIC_ENGINE,
  NOT_APPROVED_SQL,
  NOT_APPROVED_VERSION_TRIGGER,
  NOT_APPROVED_COMMENT_TRIGGER,
  NOT_APPROVED_ENGINE,
  NOT_APPROVED_EDIT_MODULE,
  NOT_WITH_CLIENT,
  SEND_NO_OPEN_SUGGESTIONS_SQL,
  SEND_NO_OPEN_SUGGESTIONS_ENGINE,
  REVIEWABLE_TOPIC_ENGINE,
  SEND_NOT_IN_FLIGHT,
  PROMOTES_SCORED_DRAFT,
  NO_APPLY_IN_FLIGHT,
  COMMENT_CAP,
  RESOLVE_COMMENT_CAP,
  DISMISS_NOT_APPLYING_SQL,
  DISMISS_NOT_APPLYING_ENGINE,
  PUBLISH_TOPIC_IS_DONE,
  FORM_EXISTS_FOR_ANSWERS,
  FORM_NOT_STALE_FOR_ANSWERS,
  FORM_EXISTS_FOR_REVISE,
  FORM_NOT_STALE_FOR_REVISE,
  FORM_ANSWERED_FOR_REVISE,
];

/**
 * THE TABLE. Keyed by the same AdminAction the bench hands out, so the two compose rather than
 * compete: `adminCan` says whether the article's PLACE permits the act, and this says whether the
 * RECORD will take it. Both must hold, and neither is a restatement of the other.
 *
 * `publish` USED TO SIT IN THAT SENTENCE AND IT DID NOT BELONG THERE. The reason given was that a
 * push changes nothing about the article, which is true and is a claim about the ARTICLE rather
 * than about the act: server/cms/gate.py refuses a publish outright unless the terminal status is
 * exactly "done". It now carries that clause.
 */
export const ADMIN_GATE_DOORS: Record<AdminAction, readonly GateDoor[]> = {
  answer: [
    {
      id: "submit_answers",
      what: "file answers to the evaluator's questions, which dispatches the surgical revise",
      clauses: [NOT_APPROVED_ENGINE, FORM_EXISTS_FOR_ANSWERS, FORM_NOT_STALE_FOR_ANSWERS],
    },
    {
      id: "rerun_with_answers",
      what: "dispatch the rerun for answers the client already filed from their portal",
      clauses: [
        NOT_APPROVED_ENGINE,
        FORM_EXISTS_FOR_REVISE,
        FORM_NOT_STALE_FOR_REVISE,
        FORM_ANSWERED_FOR_REVISE,
      ],
    },
  ],
  edit: [
    {
      id: "save_blog_content",
      what: "save the article body",
      // REVIEWABLE rather than the DONE pair, and the SQL clause's absence is a decision:
      // admin_done_topic still demands the literal done on the hosted build, but every hosted
      // admin write route answers 501 hostedWriteRefused before any SQL runs, so the only
      // build that MOUNTS this control is the local one, whose engine gate is exactly the
      // clause below. Listing the SQL clause here would refuse the failed bench on the one
      // build that has it. If the hosted build ever performs admin writes, widen
      // admin_done_topic in a migration first and restore its clause here.
      clauses: [
        REVIEWABLE_TOPIC_ENGINE,
        NOT_APPROVED_SQL,
        NOT_APPROVED_ENGINE,
        NOT_APPROVED_EDIT_MODULE,
        NOT_APPROVED_VERSION_TRIGGER,
        NOT_WITH_CLIENT,
        NO_APPLY_IN_FLIGHT,
      ],
    },
  ],
  comments: [
    /**
     * ONE DOOR SPANNING THE RAIL'S WHOLE WRITE SIDE, which is what blog-stage.tsx has always meant
     * by this act: `canComment` is documented there as whether the state lets this side "file,
     * resolve, dismiss or reply to a change", and it is threaded to the rail as one flag. The
     * contract used to describe only the filing route, so the resolve and the dismiss rode on a
     * gate that had never read them.
     *
     * THE THREE ROUTES ARE ANDed RATHER THAN ORed, and the choice is deliberate even though doors
     * exist precisely to express OR. A door per route would make `comments` allowed whenever ANY
     * route passes, and the dismiss route carries no done gate, no approved gate and no
     * with-client gate at all: migration 013's triggers are `before insert` and a dismiss is an
     * UPDATE, and server/app.py's delete route calls only the two resolvers. So an OR would grant
     * `comments` on an approved article, which is true of dismissing and false of the act the
     * bench hands out. blog-state.ts gives `approved` a bench of publish alone, and this table
     * composes with that bench rather than arguing with it.
     *
     * THE ORDER IS THE MESSAGE ORDER. Permanent clauses first, then the cap, then the dismiss
     * pair, because `verdictOver` reports the FIRST refusing clause and the cap's sentence is the
     * one an operator at three applies needs. All three transient clauses leave `mount` true, so
     * none of them removes a control.
     */
    {
      id: "add_comment",
      what: "file, resolve or dismiss a change request",
      // REVIEWABLE rather than the DONE pair, for the reason the edit door states: the failed
      // bench exists only on the local build, and the hosted SQL gate sits behind routes that
      // 501 every admin write anyway.
      clauses: [
        REVIEWABLE_TOPIC_ENGINE,
        NOT_APPROVED_SQL,
        NOT_APPROVED_ENGINE,
        NOT_APPROVED_EDIT_MODULE,
        NOT_APPROVED_COMMENT_TRIGGER,
        NOT_WITH_CLIENT,
        COMMENT_CAP,
        RESOLVE_COMMENT_CAP,
        DISMISS_NOT_APPLYING_SQL,
        DISMISS_NOT_APPLYING_ENGINE,
      ],
    },
  ],
  send: [
    {
      id: "send_to_client",
      what: "release the article to the client, whatever it scored",
      // DONE_TOPIC IS ABSENT AND ITS ABSENCE IS A DECISION, the same one the edit door records:
      // migration 013's admin_done_topic still demands the literal done, and unlike the engine's
      // twin it has NO promotion in front of it, so listing it here would refuse the below-bar
      // release on the only build that offers one. Every hosted admin write route answers 501
      // before that SQL runs, and SendToClient returns null on that build. If the hosted build
      // ever performs admin writes, promote inside admin_send_blog_to_client in a migration
      // first and restore the clause here.
      clauses: [
        SEND_NOT_IN_FLIGHT,
        DONE_TOPIC_ENGINE,
        PROMOTES_SCORED_DRAFT,
        NOT_APPROVED_SQL,
        NOT_APPROVED_ENGINE,
        SEND_NO_OPEN_SUGGESTIONS_SQL,
        SEND_NO_OPEN_SUGGESTIONS_ENGINE,
      ],
    },
  ],
  publish: [
    {
      id: "publish_to_cms",
      what: "push the article to the CMS",
      clauses: [PROMOTES_SCORED_DRAFT, PUBLISH_TOPIC_IS_DONE],
    },
  ],
};

export type GateVerdict =
  /** Some door passes every one of its clauses. `door` is the one that does. */
  | { allowed: true; door: GateDoor }
  /**
   * No door passes. `blocking` is the clause to show a person: the first REFUSING clause of the
   * door that got furthest, or an unknowable one when nothing outright refused.
   *
   * `undecidable` separates "the record refuses this" from "nobody has told us yet", because they
   * want different words on screen and, more importantly, because only the first is stable. A
   * control withheld for an undecidable reason comes back on its own when the read lands.
   */
  | { allowed: false; undecidable: boolean; blocking: GateClause | null };

/**
 * Whether the layers under this UI will take the act, given what the caller actually knows.
 *
 * The search is over doors and it stops at the first that passes cleanly. Where none does, the
 * refusal reported is the first hard refusal encountered, in door order, because a hard refusal
 * names a real condition of the record and an unknowable names only a read in flight. Reporting
 * the unknowable in preference would tell an operator to wait for something that is never coming.
 */
export function adminGateVerdict(action: AdminAction, input: GateInput): GateVerdict {
  return verdictOver(action, input, () => true);
}

/**
 * The boolean a control is gated on.
 *
 * FAIL CLOSED, and the single expression below is the whole of that promise: anything other than a
 * passing door is false. Every previous round of this defect failed open by guessing a fact it did
 * not hold, so the guess is what had to go, not the row it was written into.
 */
export function adminGateAllows(action: AdminAction, input: GateInput): boolean {
  return adminGateVerdict(action, input).allowed;
}

/**
 * What a control should DO about this act, which is a finer question than whether it may proceed.
 *
 * `mount` ignores the transient clauses. A control refused only by a condition that clears on its
 * own belongs on the page, greyed, naming the wait: blog-stage.tsx has said so for a long time and
 * used to implement it with its own predicate over the comment rail. `waitingOn` is the transient
 * clause holding it shut, so the tooltip can carry the layer's own reason rather than a sentence
 * the page invented.
 *
 * `act` is `adminGateAllows` and stays the thing any request is gated on. A greyed control that
 * somehow fires still has to pass it.
 */
export type GateStanding = {
  mount: boolean;
  waitingOn: GateClause | null;
  act: boolean;
};

export function adminGateStanding(action: AdminAction, input: GateInput): GateStanding {
  const permanent = verdictOver(action, input, (clause) => !clause.transient);
  if (!permanent.allowed) {
    return { mount: false, waitingOn: null, act: false };
  }
  const full = adminGateVerdict(action, input);
  if (full.allowed) {
    return { mount: true, waitingOn: null, act: true };
  }
  // Every permanent clause passed, so whatever blocks the full verdict is transient or unknowable.
  return { mount: true, waitingOn: full.blocking, act: false };
}

/** The one search, run over whichever clauses the caller cares about. */
function verdictOver(
  action: AdminAction,
  input: GateInput,
  include: (clause: GateClause) => boolean,
): GateVerdict {
  const doors = ADMIN_GATE_DOORS[action];
  let firstRefusal: GateClause | null = null;
  let sawUnknowable = false;
  // A caller that supplied no moment is asking a record question, so the clauses that describe a
  // moment have nothing to say to it. See GateInput.applying for why this is a case and not a
  // loophole, and note that "unread" is NOT this case: it fails closed.
  const momentless = input.applying === undefined;

  for (const door of doors) {
    let doorOk = true;
    for (const clause of door.clauses) {
      if (!include(clause) || (momentless && clause.transient)) {
        continue;
      }
      const verdict = clause.decide(input);
      if (verdict === "pass") {
        continue;
      }
      doorOk = false;
      if (verdict === "refuse") {
        firstRefusal = firstRefusal ?? clause;
      } else {
        sawUnknowable = true;
      }
    }
    if (doorOk) {
      return { allowed: true, door };
    }
  }

  return {
    allowed: false,
    undecidable: firstRefusal === null && sawUnknowable,
    blocking: firstRefusal,
  };
}

/** A form the caller has not read is not a fact, so it decides nothing either way. */
function formPresence(form: GateForm): ClauseVerdict {
  if (form === "unread") {
    return "unknowable";
  }
  return form === "absent" ? "refuse" : "pass";
}

/**
 * The applying count, with an unsupplied or unread rail deciding nothing.
 *
 * The absent case is `undefined` rather than a sentinel string, because a caller that never passed
 * the field and a page whose read is in flight are the same thing to a clause: neither is a fact,
 * so neither may open a control.
 */
function applyingCount(
  applying: GateApplying | undefined,
  holds: (count: number) => boolean,
): ClauseVerdict {
  if (applying === undefined || applying === "unread") {
    return "unknowable";
  }
  return holds(applying) ? "pass" : "refuse";
}

/** Same rule one level in: an absent form fails a flag test because there is no flag to test. */
function formFlag(form: GateForm, holds: (facts: GateFormFacts) => boolean): ClauseVerdict {
  if (form === "unread") {
    return "unknowable";
  }
  if (form === "absent") {
    return "refuse";
  }
  return holds(form) ? "pass" : "refuse";
}
