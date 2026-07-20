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
  /** ISO stamp or null. Null means the client has never seen this article. */
  sent_to_client?: string | null;
  /** ISO stamp or null. Null means the client has not accepted these bytes. */
  client_approved?: string | null;
  /** Top-level client suggestions still open or mid-apply. Replies are not counted. */
  changes_requested?: number;
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
  if (facts.status === "running") {
    return "generating";
  }
  if (facts.published) {
    return "published";
  }
  if (facts.client_approved) {
    return "approved";
  }
  if (facts.sent_to_client) {
    return (facts.changes_requested ?? 0) > 0 ? "changes_requested" : "client_review";
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
  /** Answer the evaluator's questions and rerun. */
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
  failed: 2,
  unknown: 3,
  stopped: 4,
  internal_review: 5,
  generating: 6,
  client_review: 7,
  approved: 8,
  published: 9,
};

export function adminUrgency(state: BlogState): number {
  return ADMIN_URGENCY[state];
}
