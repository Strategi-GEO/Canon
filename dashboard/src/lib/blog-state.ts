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
 * WHY needs_review IS has_questions AND NEEDS NO EXTRA INPUT. The engine contract defines
 * needs_review as exactly one thing: this blog has questions that are current, on disk and
 * answerable. server/runner.py _enforce_terminal_status corrects a claimed needs_review with
 * no current form back to done or failed by its score, so the status cannot be held while the
 * form is absent, stale, unreadable or already answered. That makes the status itself the
 * question signal, and this function needs no separate questions read to know one is owed.
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
   */
  | "answer"
  /** Edit the markdown directly, and select a passage to have Claude change it. */
  | "edit"
  /** Resolve, dismiss or reply to a client's change request. */
  | "comments"
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
  // GRANTING FOUR IS NOT A FUDGE, BECAUSE EVERY ONE OF THEM HAS A LAYER THAT DISCRIMINATES ON THE
  // SAME FACT THIS TABLE CANNOT SEE. A GRANT HERE IS A PERMISSION, NEVER A RENDERING.
  // `answer` renders AnswerQuestions, which reads the question form: in (a) it finds a
  // client-answered form and draws the Rerun button, and in (b) it finds no form at all, because
  // clearing it is the revise's own finally-arm, and draws nothing.
  // `send` renders SendToClient, whose blockedReason reads the status: in (b) it sends, and in (a)
  // it greys the control and names the rerun as the act that comes first.
  // `edit` and `comments` pass through adminWriteTierReady below, which reads the same status
  // migration 009's admin_done_topic reads: in (b) it is 'done' and both controls render and
  // work, and in (a) it is not and blog-stage.tsx withholds them. THEY HAD NO SUCH LAYER UNTIL
  // NOW AND THAT IS THE WHOLE OF WHAT WAS BROKEN HERE: they were granted alongside two acts that
  // discriminate, which made the row read as though all four did.
  // Each situation gets the controls its record can take, and the rest are either absent or say
  // what to do instead.
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
  // A LIVE RERUN NEVER REACHES THIS BRANCH, which is a separate reassurance and not the one that
  // makes `edit` safe. `generating` is derived above every stamp including this one, so while a
  // run owns the artifact the state is `generating` and this list is never consulted. The old fear
  // of an edit racing the pass about to rewrite the same bytes describes a moment this table
  // cannot be asked about. What makes `edit` safe in (a) is adminWriteTierReady withholding it.
  answers_submitted: ["answer", "edit", "comments", "send"],
  // The refining bench. This is the one state where the admin shapes the article freely.
  internal_review: ["edit", "comments", "send"],
  // WAITING, and the empty list is the feature. The client is reading the exact bytes pinned by
  // sent_version_id, so an edit here changes the article underneath someone mid-review.
  client_review: [],
  // The client asked for something, so the admin answers it and sends again. `send` is listed
  // and is still refused by the record while any suggestion is open: the button appears once
  // the last one is resolved or dismissed, which is what makes it a queue rather than a trap.
  changes_requested: ["edit", "comments", "send"],
  // LOCKED. One door, and it is the only act that does not alter what the client approved.
  approved: ["publish"],
  // Still one door: pushing again updates the same CMS post rather than creating a second one,
  // so a re-push is how a failed or partial push is retried. Nothing else reopens.
  published: ["publish"],
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
 * WHETHER THE RECORD ITSELF WILL TAKE AN ADMIN WRITE, which is a question the table above cannot
 * be asked and must stop pretending to answer.
 *
 * THE STRUCTURAL DEFECT THIS CLOSES, because it has now shipped three times in a row and every
 * previous fix was an edit to one row. ADMIN_ACTIONS is keyed by STATE. Every layer beneath it
 * gates on STATUS: migration 009's admin_done_topic (:143) raises PORTAL:NOTDONE unless
 * topic_rollup.status is exactly 'done', and admin_save_blog_content (:352) and admin_add_comment
 * (:299) both resolve through it. Those two keys are not the same key, and `answers_submitted`
 * is exactly where they come apart: it is derived from the client's submit stamp rather than from
 * the status, so it spans 'needs_review' before the rerun and 'done' after it. NO STATIC ROW CAN
 * BE CORRECT FOR BOTH, so any fix that only changes the row moves the defect rather than removing
 * it. It read `[]` and stranded the article, then ["edit", "comments", "send"] and handed the
 * pre-rerun operator three controls the database refuses, then gained `answer` and left `edit` and
 * `comments` refused in that same window.
 *
 * SO THE DISCRIMINATION MOVES TO A SECOND LAYER, WHICH IS THE ARCHITECTURE THIS FILE ALREADY HAS
 * RATHER THAN A NEW ONE. `answer` and `send` were never broken by the state fold, and the reason
 * is that each already has a layer between the grant and the button: AnswerQuestions reads the
 * question form and draws its Rerun strip only while one is live, and SendToClient's blockedReason
 * reads the status and greys the control with a sentence naming the rerun. `edit` and `comments`
 * were the two acts granted with nothing in front of them. This is that missing layer, and
 * blog-stage.tsx composes it with the bench exactly as it composes HOSTED_READONLY.
 *
 * WHY NOT SPLIT THE STATE INSTEAD, which is the other honest shape. A split would put the
 * difference where a reader sees it without a comment, and it would put it on the CLIENT wire,
 * where there is no difference at all. portal-data.ts's clientReadsDraft tests `state ===
 * "has_questions" || state === "answers_submitted"` to decide whether the client is served the
 * anchored draft, and nothing outside this file holds a Record<BlogState, ...>, so TypeScript
 * would not flag the omission: a split would silently stop serving the draft to the client who
 * had just answered, taking their own answers off their screen moments after they filed them.
 *
 * IT NAMES THE MIGRATION'S RULE AND NOT A STATE, deliberately, so it stays correct for every
 * state rather than for the one that exposed it. Any future bench granting `edit` or `comments`
 * in a state that can carry a not-done status inherits the discrimination instead of rediscovering
 * this bug.
 */
export function adminWriteTierReady(facts: BlogStateFacts): boolean {
  return facts.status === "done";
}

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
