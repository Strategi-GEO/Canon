/**
 * THE ONE ANSWER TO "WHAT STATE IS THIS BLOG IN".
 *
 * Before this file the answer was assembled per surface, and there were a lot of assemblers:
 * four independent folds of the status feed, three computations of the question hold, two of
 * the delivery state, and three separate vocabularies for what a human is shown. None of them
 * shared code. What kept them agreeing was comments in each one asserting that it matched the
 * others, which is a claim rather than a mechanism, and the claim had already come apart in
 * places: the blogs table coloured a score green on ledger membership while the stage page
 * recomputed `score >= 95` locally, so the same blog could read as shipped on one screen and
 * not on the other.
 *
 * ONE STATE, TWO VOCABULARIES. The admin and the client are looking at the same article at the
 * same moment, so they must never disagree about where it is. What differs is what each is
 * told and what each may do, so the state is computed once here and rendered through two label
 * maps and two action maps below. A client is never shown "Internal review" because a client
 * cannot see the article then at all, and that is a VISIBILITY rule over one state rather than
 * a second state machine that could drift from the first.
 *
 * WHY needs_review IS has_questions, AND THE EXACT LIMIT OF WHAT THAT BUYS. The engine contract
 * defines needs_review as one thing: this blog has questions that are current, on disk and
 * answerable. server/runner.py _enforce_terminal_status corrects a claimed needs_review with no
 * current form back to done or failed by its score, so the status is a good enough signal to
 * LABEL the article with, which is all this state is used for here.
 *
 * IT IS NOT GOOD ENOUGH TO OPEN A DOOR WITH, and reading it as though it were is what shipped the
 * fifth round of one defect. The correction runs in _enforce_terminal_status, and revise_topic's
 * three restore arms do not go through it: each appends a terminal line carrying
 * `prev_terminal["status"]`, which on an article held for answers is `needs_review`, so a SPENT or
 * STALE form can sit beside that status with nothing having re-derived it. The biconditional
 * "needs_review exactly when a current answerable form exists" is therefore FALSE in the direction
 * that matters, and no predicate over the status can stand in for reading the form. Anything that
 * decides whether a WRITE will be accepted belongs in gate-contract.ts, which carries the source
 * lines that perform the refusals and is checked against them on every test run.
 *
 * THE FACTS THIS TAKES ARE ALREADY ON THE WIRE from both backends. server/app.py _blog_history
 * and the hosted app/api/clients/[slug]/blogs/route.ts return the same five fields, so this is
 * one implementation over two sources rather than a third source of truth. There is
 * deliberately no Python twin: a second copy in another language is the exact failure this
 * file exists to end.
 */

export type BlogState =
  /** A run is live. No terminal line yet, which is not a verdict and not a failure. */
  | "generating"
  /** Held. The evaluator asked something only a person can answer, at any score. */
  | "has_questions"
  /**
   * The client answered the current form and the rerun has not landed yet. Nobody owes an
   * answer any more, and nothing has been decided either, so this is neither has_questions nor
   * a verdict. It exists because the gap between a submit and the rerun's terminal line is real
   * time, and without a state of its own the article reads as still asking a question the
   * client has already answered.
   */
  | "answers_submitted"
  /** Passed and with the team. The admin refines it and decides when the client sees it. */
  | "internal_review"
  /** Released. The client is reading it and owes an approval or a change request. */
  | "client_review"
  /** The client asked for something. Back with the admin, and the send is refused until clear. */
  | "changes_requested"
  /** The client accepted these exact bytes. LOCKED: see adminActions and clientActions. */
  | "approved"
  /** In the CMS. Terminal. */
  | "published"
  /** The loop exhausted itself with nothing to ask. A machine's answer, not a human's task. */
  | "failed"
  /** The operator ended the run before it reached a verdict. Not a failure. */
  | "stopped"
  /** No readable status line. Real on the wire, so it is handled rather than assumed away. */
  | "unknown";

/** Exactly the fields both backends already return for a blog. Nothing derived, nothing extra. */
export type BlogStateFacts = {
  status: string;
  /**
   * Whether a run owns this topic RIGHT NOW, from the run registry rather than from the status
   * feed. Absent means "this backend does not report it", which falls back to the status test.
   *
   * THE STATUS FEED CANNOT ANSWER THIS AND THAT WAS A REAL BUG. `status` comes from a fold that
   * scans an append-only status.jsonl in reverse for the last TERMINAL line, and that file
   * outlives the run that wrote it. So a second run on the same topic reports the PREVIOUS run's
   * terminal status for its entire duration: an answer-driven revise rendered as "Has questions"
   * with the answer form still mounted, at the very top of the operator's queue, while a session
   * already owned the article. The `generating` state was reachable only on a topic's first ever
   * run, which is precisely the case the state matters least.
   */
  live?: boolean;
  /**
   * ISO stamp or null: when the client submitted answers to the CURRENT question form, the one
   * anchored to the version they were shown. Null means this form is still unanswered.
   *
   * A STAMP RATHER THAN A BOOLEAN, matching every other field here that records a human act. A
   * boolean would answer "did they" and nothing else, while a stamp answers "when", which is
   * what a card renders under "Questions answered" without asking a second question of the
   * backend. Absent reads as false, so an engine too old to report it degrades to the old
   * behaviour of showing the form's own state rather than inventing a state it cannot support.
   */
  answers_submitted?: string | null;
  /** ISO stamp or null. Null means the client has never seen this article. */
  sent_to_client?: string | null;
  /** ISO stamp or null. Null means the client has not accepted these bytes. */
  client_approved?: string | null;
  /**
   * Top-level client suggestions still open or mid-apply. Replies are not counted.
   *
   * NOT WHAT DECIDES THE STATE, and that distinction was a shipped bug. See
   * `change_round_open` below. This count is still the right input for "how many are
   * outstanding right now", which is what the send control renders.
   */
  changes_requested?: number;
  /**
   * Whether the client has filed a change request SINCE THE LAST SEND. The round, not the queue.
   *
   * THE STATE USED TO KEY OFF THE LIVE COUNT AND THAT DEAD-ENDED THE LOOP. Resolving the last
   * suggestion took the count to zero, which dropped the article back to `client_review`, whose
   * admin action list is empty. So the admin resolved the client's request, produced a new
   * version, and had no button left to send it: the client stayed pinned to the pre-fix bytes by
   * sent_version_id, was told the article was ready to review, and could approve a version that
   * never received the change they asked for. A failed apply did the same thing by a different
   * road, because a `failed` comment is neither open nor applying either.
   *
   * A ROUND IS STICKY AND ONLY A RE-SEND CLOSES IT. That is what makes the state survive the
   * work done inside it: resolve, dismiss, retry a failed apply, edit by hand, all of it happens
   * while the round stays open, and mark_sent moving sent_to_client_at forward is the single act
   * that ends it. It also needs no comment-state list, so it cannot rot the next time one is
   * added.
   *
   * Absent means false, which is the honest reading for a backend too old to send it: an engine
   * that does not report rounds reports no round, and the article reads as `client_review`. That
   * is the pre-existing behaviour rather than a new failure.
   */
  change_round_open?: boolean;
  /** ISO stamp or null. NULL IS "NO RECORD OF A PUSH", never "not published" (migration 012). */
  published?: string | null;
};

/**
 * The state, from the record and nothing else.
 *
 * ORDER IS THE WHOLE SPECIFICATION and every position in it is load-bearing:
 *
 * `generating` is FIRST because a live run outranks every stamp under it. A blog can be sent,
 * come back with change requests, and be re-run to resolve them; while that run is live the
 * true answer is that the engine is working, not that the client is waiting.
 *
 * The delivery ladder runs newest act first (published, approved, changes_requested, sent)
 * because those stamps are monotonic human acts and the most recent one is the state. Reading
 * it in the other order would report `client_review` for an article the client already
 * approved.
 *
 * `has_questions` sits BELOW the delivery ladder and can never actually be reached from it: a
 * send is refused while the status is needs_review, so no article carries both a send stamp and
 * a live form. The order is written this way anyway, so that if that guard is ever loosened the
 * fallout is a stale label rather than an article the client can no longer act on.
 *
 * `failed` and `stopped` sit last for the same reason: neither can carry a delivery stamp, so
 * their position costs nothing and defends against the case where one somehow does.
 */
export function blogState(facts: BlogStateFacts): BlogState {
  // `live` FIRST and the status test only as a fallback. The registry knows a run is in flight;
  // the status fold can only know that no terminal line has ever been written, which is true
  // exactly once per topic. A backend that does not report `live` keeps the old behaviour rather
  // than losing the state altogether.
  if (facts.live ?? facts.status === "running") {
    return "generating";
  }
  // A SEND STAMP IS REQUIRED, and its absence used to be a client-facing exposure. `published`
  // sat above every delivery check and clientCanSee grants it unconditionally, so a record with
  // published_at set and sent_to_client_at null jumped straight from a state the client must
  // never see to one where the portal renders the full body, captioned as live on their site.
  // The publish gate itself required only that the status was done, with no send or approval
  // test, so one CMS push on an internal draft was the whole exploit.
  //
  // The gate is being fixed to require a send as well, and this stays regardless: a state
  // machine that depends on every caller upstream getting it right is not a guard. An article
  // published without ever being sent now reads as whatever it actually is to the team, and the
  // admin still sees the push itself through the PublishedChip, which reads published_at
  // directly rather than through the state.
  if (facts.published && facts.sent_to_client) {
    return "published";
  }
  if (facts.client_approved) {
    return "approved";
  }
  if (facts.sent_to_client) {
    // THE ROUND, not the queue. `change_round_open` stays true from the client's first request
    // until a re-send, so resolving the last one does not strip the admin of the Send button
    // they need to deliver the fix. The live count falls back in only when a backend does not
    // report rounds, which keeps an older engine behaving exactly as it did.
    const round = facts.change_round_open ?? (facts.changes_requested ?? 0) > 0;
    return round ? "changes_requested" : "client_review";
  }
  // EVERY NEIGHBOUR OF THIS LINE IS DELIBERATE.
  //
  // BELOW `generating`, because a live rerun outranks every stamp exactly as it does above, and
  // here it is sharper than that: the rerun is the very thing this state waits for, so reporting
  // "answers submitted" while it runs would name the wait instead of the work.
  //
  // BELOW the delivery ladder, because a send is a newer human act than the submit and is what
  // ends this state. An article that was answered and then sent is with the client, not waiting
  // on a rerun that already landed.
  //
  // ABOVE `has_questions`, and that is the whole reason the state exists. The mirror keeps
  // reporting `needs_review` from the submit until the rerun writes its terminal line, because
  // the form is still on disk and still iteration-matched, so without this line the client is
  // told we need their answer on points they just answered.
  //
  // ABOVE `failed` and `stopped` for the reason those two sit last generally, and above
  // `internal_review` for a stronger one: the rerun lands on one of those three, and refusing
  // this state there is precisely what makes the article vanish out from under the person who
  // just acted. A rerun that passes clean goes to internal_review, which clientCanSee denies, so
  // a client who answered would watch their article disappear the moment their answers worked.
  if (facts.answers_submitted) {
    return "answers_submitted";
  }
  if (facts.status === "needs_review") {
    return "has_questions";
  }
  if (facts.status === "done") {
    return "internal_review";
  }
  if (facts.status === "failed") {
    return "failed";
  }
  if (facts.status === "stopped") {
    return "stopped";
  }
  return "unknown";
}

/**
 * What the ADMIN may do. The absence of a verb here is a refusal, and the refusal is enforced
 * again in the database: these flags decide what renders, and migration 013 plus the engine's
 * own guards decide what is permitted. A UI-only lock is a suggestion.
 *
 * THE APPROVED AND PUBLISHED ROWS ARE THE POINT OF THIS TABLE. Once the client has accepted an
 * article, nobody edits it, the admin included. The alternative was letting the admin polish
 * after approval, and it fails on the only question that matters: the approval stamp records
 * that the client accepted THESE bytes, so any edit after it makes the record assert something
 * the client never did. Posting to the CMS is the one act left, because it changes nothing
 * about the article.
 */
export type AdminAction =
  /**
   * Open the question form. TWO ACTS BEHIND ONE VERB, because they are two moments of one
   * panel reading one file: answer what the evaluator asked, or dispatch the rerun that applies
   * answers the client already filed from their portal. AnswerQuestions decides which of them it
   * is looking at from the form's own state, so a second verb here would be a second name for a
   * control that does not split.
   *
   * THE GRANT IS NOT ENOUGH ON ITS OWN, and believing it was is what shipped the fourth round of
   * this bug, and then the fifth. Both doors behind this verb gate on the question form's OWN
   * `stale` and `answered` flags, which the state cannot see and which no predicate over the
   * status can stand in for. gate-contract.ts holds those two doors as clauses carrying the
   * verbatim source lines that perform the refusals, and blog-stage.tsx composes this grant with
   * `adminGateAllows("answer", ...)` over the form the page has actually read.
   */
  | "answer"
  /** Edit the markdown directly, and select a passage to have Claude change it. */
  | "edit"
  /** File a change request, resolve one with Claude, dismiss one, or reply in its thread. */
  | "comments"
  /**
   * Reply in an existing thread, and nothing else: no filing, no resolving, no dismissing.
   *
   * A SECOND VERB RATHER THAN A WIDER `comments`, because the acts behind `comments` all change
   * the article and a reply changes nothing. It carries parent_id, commits no version and
   * resolves no request, which is why migration 013 exempts it from the approved lock by name
   * (013:18, and the `new.parent_id is not null` early return at 013:88), why migration 011's
   * admin_reply_comment carries no done gate and no approved gate at all, and why
   * server/app.py's reply route (:1898) states the same two absences in its own docstring.
   *
   * IT EXISTS BECAUSE THE TWO BENCHES DISAGREED AND THE CLIENT'S WAS RIGHT. CLIENT_ACTIONS grants
   * `reply` in client_review and approved, so a client can ask a question about an article the
   * operator may no longer edit. The admin bench carried nothing there, so the rail rendered
   * read-only, ReplyBox was withheld, and the operator could not answer a person who was waiting
   * on them, over an act every layer underneath accepts. Withdrawing the client's grant was the
   * other way to make the two agree and it is the wrong one: it buys agreement by taking away
   * the cheapest, least destructive act in the loop and leaving the client with silence.
   *
   * GRANTED WHERE THE RAIL IS READ AND `comments` IS NOT, which is exactly client_review,
   * approved and published. In every state that grants `comments` the reply door already rides
   * on that grant, so the two never both appear and blog-stage.tsx ORs them into one flag.
   */
  | "reply"
  /** Release it, or release it again after resolving change requests. */
  | "send"
  /** Push it to the CMS. */
  | "publish";

const ADMIN_ACTIONS: Record<BlogState, readonly AdminAction[]> = {
  // A run owns the artifact while it is live. Every door is shut, including the ones a stopped
  // or finished blog would open, because two writers on one draft is how a revise loses bytes.
  generating: [],
  // Answering is the ONLY door, and it is a demand rather than an offer: there is no dismiss
  // and no proceed-anyway at any score, including 96. The engine contract is explicit that a
  // draft the evaluator could not verify does not ship because it scored well.
  has_questions: ["answer"],
  // TWO SITUATIONS WEAR THIS ONE STATE, AND THE BENCH CARRIES A DOOR FOR EACH. The state is
  // reached the INSTANT the client submits from the portal, which is long before anything has
  // been done with what they wrote, so `answers_submitted` spans both of these:
  //
  //   (a) The answers are in and the rerun that applies them has NOT run. The portal has no
  //       engine behind it, so a client's submit dispatches nothing, and server/app.py ships the
  //       auto-pickup sweep DISABLED (it returns unless GEO_ANSWERS_PICKUP=1, for the billing
  //       reason written out there). Nothing moves this article on its own. It wants a RERUN.
  //   (b) The rerun landed clean at >= 95 with nothing new to ask, so the status is now `done`
  //       and the article is a finished draft nobody has delivered. It wants a SEND.
  //
  // THE DISCRIMINATOR IS THE UNDERLYING STATUS, WHICH THIS STATE DELIBERATELY FOLDS AWAY. In (a)
  // the mirror still reports `needs_review`, because the form is on disk and iteration-matched
  // until the rerun writes its terminal line. In (b) it reports `done`. Folding that difference
  // away is the whole point of the state, because the client must read one steady thing across
  // their own Submit, so the fold is right and the BENCH is where the difference has to come back.
  //
  // GRANTING FOUR IS NOT A FUDGE, BECAUSE EVERY ONE OF THEM NOW PASSES THROUGH A GATE CLAUSE
  // CARRYING THE SOURCE LINE THAT WOULD REFUSE IT. A GRANT HERE IS A PERMISSION, NEVER A
  // RENDERING, and the discrimination lives in gate-contract.ts rather than in a sentence here.
  // `answer` passes through the two doors that verb actually has, gated on the FORM's `stale` and
  // `answered` flags, which are the fields POST /answers and POST /revise read: in (a) the form is
  // current and unanswered or current and answered, and one of the two doors takes it; in (b) the
  // form is gone or spent and both refuse, so blog-stage.tsx withholds the strip.
  // `edit`, `comments` and `send` pass through the DONE_TOPIC clause, which carries migration
  // 009's own `if v_status is distinct from 'done'::topic_status then`: in (b) the status is
  // 'done' and all three render and work, and in (a) it is not and blog-stage.tsx withholds them.
  // SendToClient's blockedReason still names the rerun, because a greyed control with a real next
  // act is better than an absent one where the condition clears on its own.
  // Each situation gets the controls its record can take, and the rest are either absent or say
  // what to do instead.
  //
  // `answer` LOOKED LIKE IT ALREADY HAD ONE AND IT DID NOT, WHICH IS ROUND FOUR OF THIS DEFECT.
  // The claim written here was that AnswerQuestions finds no form in (b), because clearing it is
  // the revise's own finally-arm. That is true of the DISK and the panel reads the RECORD:
  // questions.describe_questions with no root reads review_notes (server/questions.py:329), and
  // server/sync.py:546 to :551 spares ANSWERED evaluator rows from its post-revise delete. So the
  // answered form survives the rerun, questions-state.ts modeOf (:60) tests `answered` before
  // `stale`, and answer-questions.tsx:208 drew "Rerun with their answers" over a form
  // server/app.py:1538 refuses as stale. The control rendered and 409'd. A discriminating layer
  // that was asserted in a comment rather than composed in code is the same as no layer at all,
  // which is the lesson of every round of this bug.
  //
  // WHY THE STATE IS NOT SPLIT IN TWO INSTEAD. A split would put the difference where a reader
  // sees it without this comment, and it would also put it on the CLIENT wire, where there is no
  // difference at all: the client reads the anchored draft and can do nothing to it in both
  // situations, so clientCanSee, the client tag and portal-data's clientReadsDraft would each
  // have to answer the same thing twice and stay in step forever. One state with two doors keeps
  // the client half honest, and this comment is what it costs.
  //
  // THIS ROW HAS BEEN WRONG TWICE, so neither mistake gets repeated by accident. It read `[]`
  // first, and the sticky submit stamp turned that into an article nobody could ever deliver:
  // server/app.py applies no staleness and no expiry to the stamp, deliberately and with its
  // reasoning written out there, so (b) is the HAPPY PATH rather than an edge case, and an empty
  // bench made the one act that clears the pin the one act the admin could not reach. It then
  // read ["edit", "comments", "send"], which fixed (b) and left (a) worse than the original:
  // migration 009's admin_done_topic gates editing, commenting AND sending on topic_rollup.status
  // being exactly 'done', so in (a) the database refuses all three, and the operator was handed
  // three controls, one of them greyed with a sentence pointing at answering, and no rerun
  // anywhere on the page. A missing button is a dead end; three refused ones are a dead end that
  // argues with the record. Adding `answer` fixed (a)'s dead end and left `edit` and `comments`
  // refused there, which is the SAME defect a third time: a row keyed by state cannot answer a
  // question keyed by status, so the third fix is the second layer rather than a fourth row value.
  //
  // WHAT (a) LOOKS LIKE WHEN THE RERUN HAS ALREADY BEEN AND GONE BADLY, because the state also
  // holds records neither situation describes. A rerun that crashes lands on `failed` and one the
  // operator stops lands on `stopped`, and both keep the submit stamp, so both derive this state.
  // The status is not `done`, so `edit`, `comments` and `send` are all refused; the form is no
  // longer current, so `answer` is refused too. THAT IS NOT A DEAD END WITH BUTTONS ON IT: every
  // one of those four is either withheld by its tier layer or greyed by SendToClient with the
  // sentence that names the act which does move the article, which is generating this topic
  // again. The exit is a fresh run rather than a bench act, exactly as it is for `failed` and
  // `stopped` proper, and the page says so instead of offering a control that argues.
  //
  // A LIVE RERUN NEVER REACHES THIS BRANCH, which is a separate reassurance and not the one that
  // makes `edit` safe. `generating` is derived above every stamp including this one, so while a
  // run owns the artifact the state is `generating` and this list is never consulted. The old fear
  // of an edit racing the pass about to rewrite the same bytes describes a moment this table
  // cannot be asked about. What makes `edit` safe in (a) is the DONE_TOPIC clause withholding it.
  answers_submitted: ["answer", "edit", "comments", "send"],
  // The refining bench. This is the one state where the admin shapes the article freely.
  internal_review: ["edit", "comments", "send"],
  // WAITING, and the emptiness of the WRITE bench is still the feature. The client is reading the
  // exact bytes pinned by sent_version_id, so an edit here changes the article underneath someone
  // mid-review. `reply` is not an edit: CLIENT_ACTIONS grants the client `reply` in this same
  // state, and an operator who cannot answer a question the client asked while reading is the
  // asymmetry the verb was added to close. See `reply` above.
  client_review: ["reply"],
  // The client asked for something, so the admin answers it and sends again. `send` is listed
  // and is still refused by the record while any suggestion is open: the button appears once
  // the last one is resolved or dismissed, which is what makes it a queue rather than a trap.
  changes_requested: ["edit", "comments", "send"],
  // LOCKED for every act that changes the article, which is what the lock is for and all it is
  // for. `publish` is the one act that alters nothing the client approved. `reply` is the other,
  // and its absence here was a defect rather than part of the lock: CLIENT_ACTIONS grants the
  // client `reply` on an approved article, migration 013 exempts replies from the approved lock
  // in so many words, and the bench carried nothing, so the client could speak and the operator
  // could not answer.
  approved: ["publish", "reply"],
  // Still the same two doors: pushing again updates the same CMS post rather than creating a
  // second one, so a re-push is how a failed or partial push is retried. `reply` survives the
  // publish for the same reason it survives the approval, and it matters here for one specific
  // road: a client replies while the article is approved, the operator publishes, and without
  // this grant the thread they left open becomes unanswerable at the moment it is least
  // excusable. The client's own bench is empty here, so no NEW question can arrive.
  published: ["publish", "reply"],
  // Today's handling, unchanged: these never reach a client and carry no review loop.
  failed: [],
  stopped: [],
  unknown: [],
};

export function adminActions(state: BlogState): readonly AdminAction[] {
  return ADMIN_ACTIONS[state];
}

export function adminCan(state: BlogState, action: AdminAction): boolean {
  return ADMIN_ACTIONS[state].includes(action);
}

/**
 * WHETHER THE RECORD ITSELF WILL TAKE AN ADMIN WRITE LIVES IN gate-contract.ts, NOT HERE.
 *
 * Two predicates used to sit at this spot, `adminWriteTierReady` and `adminAnswerTierReady`, and
 * they are gone rather than moved. Each was a second statement, in TypeScript, of a rule that
 * lives in SQL or in Python, and a second statement of a rule is the defect this whole area kept
 * reproducing. `adminWriteTierReady` restated migration 009. `adminAnswerTierReady` restated
 * server/app.py, and it restated it WRONG: it derived the question form from the status, off a
 * biconditional between `needs_review` and a current answerable form that the engine does not
 * hold, because revise_topic's three restore arms append a terminal line carrying
 * `prev_terminal["status"]` without ever passing it through `_enforce_terminal_status`. A status
 * copied forward from an earlier verdict is not a function of the form at all.
 *
 * WHY THE REPLACEMENT IS NOT A THIRD PREDICATE. The problem was never which row or which condition
 * was written; it was that nothing made the TypeScript and the layer below agree, so a
 * disagreement was silent and five rounds of patching each found a new place to be silent in. The
 * gate contract records, for every refusal, the verbatim source line that performs it and a
 * fingerprint of the enclosing function, and dashboard/tests/gate-contract.test.ts re-derives both
 * from the real files on every run. Change admin_done_topic in SQL and touch no TypeScript and the
 * suite goes red naming the clauses that rested on it. That is a mechanism; a predicate here would
 * have been another claim.
 *
 * THIS FILE STILL OWNS THE OTHER HALF, and the two compose rather than compete. ADMIN_ACTIONS says
 * whether the article's PLACE permits an act. The gate contract says whether the RECORD will take
 * it. Both must hold, neither restates the other, and neither is allowed to answer the other's
 * question. That is why the state is not split in two to make the fold go away: portal-data.ts's
 * clientReadsDraft tests `has_questions || answers_submitted` to decide whether the client is
 * served the anchored draft, and nothing outside this file holds a Record<BlogState, ...>, so
 * TypeScript would not flag the omission. A split would silently stop serving the draft to the
 * client who had just answered, taking their own answers off their screen moments after they
 * filed them.
 *
 * See dashboard/src/lib/gate-contract.ts.
 */

/**
 * What the CLIENT may do, and separately whether they can see the article at all.
 *
 * `suggest` is absent from `approved` DELIBERATELY and this is a change in behaviour: the
 * portal used to allow a client to keep suggesting after approving, on the reasoning that an
 * approval is not the end of the conversation. It is now the end of the conversation, because
 * the article is locked for everyone at that point and a suggestion nobody is permitted to
 * apply is a request that can only be disappointed.
 */
export type ClientAction =
  /** Answer the evaluator's questions. */
  | "answer"
  /** Accept the article as sent. */
  | "approve"
  /** Select a passage and ask for a change. */
  | "suggest"
  /** Reply inside an existing thread. Never resolves and never withdraws anything. */
  | "reply";

const CLIENT_ACTIONS: Record<BlogState, readonly ClientAction[]> = {
  generating: [],
  // The client sees the current draft for context and answers. They cannot approve something
  // that has not been sent, and there is nothing to suggest against yet.
  has_questions: ["answer"],
  // Visible but read-only, and the emptiness is the point. The client has done the one thing
  // that was theirs to do, so they keep the draft and their own answers on screen while the
  // rerun runs. Answering again would file a second reply against a form already submitted, and
  // approving or suggesting needs a send that has not happened.
  answers_submitted: [],
  // Not visible. The article is with the team.
  internal_review: [],
  client_review: ["approve", "suggest", "reply"],
  // Their request is with the team. Replying keeps the thread usable; suggesting again would
  // queue a second request against bytes the first one is already changing.
  changes_requested: ["reply"],
  // Locked for the client exactly as it is for the admin: no new change requests, from either
  // side. Replying survives, and migration 013 permits it for the reason 011 gave about the
  // operator's side: a reply carries parent_id, changes no bytes and resolves nothing, so
  // "thanks, this reads well" is not an edit and refusing it only buys silence.
  approved: ["reply"],
  // Live on their site. The conversation about getting it there is over.
  published: [],
  failed: [],
  stopped: [],
  unknown: [],
};

export function clientActions(state: BlogState): readonly ClientAction[] {
  return CLIENT_ACTIONS[state];
}

export function clientCan(state: BlogState, action: ClientAction): boolean {
  return CLIENT_ACTIONS[state].includes(action);
}

/**
 * Whether the client can see the article AT ALL.
 *
 * This is not "has any action": a client sees an approved or published article and can do
 * nothing to it, which is correct, because it is theirs to read. What they must never see is an
 * article still with the team, or one that failed.
 */
export function clientCanSee(state: BlogState): boolean {
  return (
    state === "has_questions" ||
    // NON-NEGOTIABLE. The client answered a form seconds ago, so hiding the article here takes
    // it away from the one person on the record who just acted on it, and takes their answers
    // with it. They keep reading the version their form was anchored to until a send moves them
    // on or a new form asks something else.
    state === "answers_submitted" ||
    state === "client_review" ||
    state === "changes_requested" ||
    state === "approved" ||
    state === "published"
  );
}

/** The tone a tag is drawn in. Named by meaning rather than by colour so the theme owns the hex. */
export type StateTone =
  /** Work is happening. */
  | "busy"
  /** A person owes an action. */
  | "owed"
  /** Waiting on someone else. Nothing to do. */
  | "waiting"
  /** Good, finished, out the door. */
  | "ship"
  /** Something went wrong or was cut short. */
  | "trouble";

export type StateTag = {
  /** The tag text. Short enough for a table cell. */
  label: string;
  tone: StateTone;
  /** One sentence naming who owes what. Rendered in the tag's tooltip. */
  detail: string;
};

/**
 * ADMIN vocabulary. Every label names WHERE the article is, and every detail names WHO owes the
 * next act, because an operator scanning twenty rows is asking exactly one question: which of
 * these is mine to move.
 */
const ADMIN_TAGS: Record<BlogState, StateTag> = {
  generating: {
    label: "Generating",
    tone: "busy",
    detail: "A run is live on this article. Nothing to do until it finishes.",
  },
  has_questions: {
    label: "Has questions",
    tone: "owed",
    detail:
      "The evaluator asked something only a person can answer, so this article is held until " +
      "someone answers it. You or the client can, and answering reruns the article.",
  },
  // NAMES BOTH ACTS, IN THE ORDER THEY HAPPEN, because one state covers two situations here and
  // a tag cannot ask which. The old detail said nobody edits it in the meantime, which described
  // a rerun already in flight: a rerun in flight is `generating`, and by the time this state is
  // derived either the rerun is owed or it has already landed.
  answers_submitted: {
    label: "Answers submitted",
    tone: "owed",
    detail:
      "The client answered the evaluator's questions, so this article is yours to move. Rerun to " +
      "apply their answers where that has not happened yet, then send the clarified article.",
  },
  internal_review: {
    label: "Internal review",
    tone: "owed",
    detail:
      "Passed and with your team. Refine it here, then send it to the client when you are happy.",
  },
  client_review: {
    label: "With client",
    tone: "waiting",
    detail:
      "Sent for review. The client owes an approval or a change request, so there is nothing " +
      "to do here until they act.",
  },
  changes_requested: {
    label: "Changes requested",
    tone: "owed",
    detail:
      "The client asked for changes. Resolve or dismiss each one, then send the article again.",
  },
  approved: {
    label: "Approved",
    tone: "ship",
    detail:
      "The client accepted these exact bytes, so the article is locked and nobody edits it. " +
      "Posting it to the CMS is all that is left.",
  },
  published: {
    label: "Published",
    tone: "ship",
    detail: "In the CMS. Posting again updates the same post rather than creating a second one.",
  },
  failed: {
    label: "Failed",
    tone: "trouble",
    detail: "The run finished without reaching a shippable draft and had nothing to ask.",
  },
  stopped: {
    label: "Stopped",
    tone: "trouble",
    detail: "Someone ended the run before it reached a verdict. Generate again to resume.",
  },
  unknown: {
    label: "Unknown",
    tone: "trouble",
    detail: "No readable status line for this article.",
  },
};

/**
 * CLIENT vocabulary. Different words for the same states, for two reasons: the client's question
 * is "is this mine right now", and the team's internal machinery is not theirs to read. No label
 * here mentions a score, an evaluator or an iteration.
 *
 * The states a client cannot see still carry an entry, because a tag with no entry is a crash
 * waiting for the first record that reaches a state the map forgot.
 */
const CLIENT_TAGS: Record<BlogState, StateTag> = {
  generating: {
    label: "In progress",
    tone: "busy",
    detail: "Our team is working on this article.",
  },
  has_questions: {
    label: "Waiting on you",
    tone: "owed",
    detail: "We need your answer on a couple of points before this article can go further.",
  },
  // "Questions answered" rather than "In progress", because this client DID something and a
  // label that forgets it reads as though the answers went nowhere. It is a receipt as much as a
  // state, and it says nothing about what our side is doing with them, which is not theirs to
  // read.
  answers_submitted: {
    label: "Questions answered",
    tone: "waiting",
    detail: "Thanks, we have your answers. Our team is working them into this article now.",
  },
  internal_review: {
    label: "In progress",
    tone: "busy",
    detail: "Our team is working on this article.",
  },
  client_review: {
    label: "Ready to review",
    tone: "owed",
    detail: "This article is with you. Approve it, or select any passage to ask for a change.",
  },
  changes_requested: {
    label: "With our team",
    tone: "waiting",
    detail: "We are working through the changes you asked for.",
  },
  approved: {
    label: "Approved",
    tone: "ship",
    detail: "You approved this article. It is locked now and on its way to your site.",
  },
  published: {
    label: "Published",
    tone: "ship",
    detail: "This article is live on your site.",
  },
  // Never rendered: clientCanSee is false for all three. Present so the map is total.
  failed: { label: "In progress", tone: "busy", detail: "Our team is working on this article." },
  stopped: { label: "In progress", tone: "busy", detail: "Our team is working on this article." },
  unknown: { label: "In progress", tone: "busy", detail: "Our team is working on this article." },
};

export function adminTag(state: BlogState): StateTag {
  return ADMIN_TAGS[state];
}

export function clientTag(state: BlogState): StateTag {
  return CLIENT_TAGS[state];
}

/**
 * The admin's scanning order: HOW MUCH THIS ROW WANTS A HUMAN.
 *
 * Sorting a state column alphabetically would be arbitrary, so it sorts by need. This ordering
 * inherits the reasoning of the STATUS_ORDER it replaced in blogs-filter.ts, and two of those
 * judgements are worth restating because they are not obvious:
 *
 * A BLOG THE ENGINE CANNOT DESCRIBE WANTS A HUMAN EARLY. `unknown` and `failed` sit near the
 * top, not near the bottom. An operator opens this list to find out what went wrong at least as
 * often as to move work along, and burying the two states that cannot explain themselves under
 * every finished article answers the wrong question. They are not "finished", they are mute.
 *
 * A STOPPED BLOG RANKS BELOW THE ONES THAT WANT AN EXPLANATION. It is the only state here the
 * operator already knows about, because they caused it, so it never earns the top of a list
 * opened to discover something. It still ranks above the in-flight and finished ones, because
 * it is a decision left open: generating the topic again is the way to resume it, and nothing
 * else on this list is waiting on that call.
 *
 * The two states blocking someone OUTSIDE the team come first. has_questions holds the whole
 * pipeline on one person's answer, and changes_requested has a client waiting on a reply.
 */
const ADMIN_URGENCY: Record<BlogState, number> = {
  has_questions: 0,
  changes_requested: 1,
  // Third, under the two states blocking someone outside the team and above everything the
  // operator can only watch. A client has already spent their attention on this row and is
  // waiting on our rerun to make it count, which is nearer to "yours to move" than anything
  // below it, and the rerun is cheap to dispatch once it is seen.
  answers_submitted: 2,
  failed: 3,
  unknown: 4,
  stopped: 5,
  internal_review: 6,
  generating: 7,
  client_review: 8,
  approved: 9,
  published: 10,
};

export function adminUrgency(state: BlogState): number {
  return ADMIN_URGENCY[state];
}
