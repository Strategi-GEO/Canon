// RELATIVE, with the extension, and not the "@/" alias. These are VALUE imports, so node --test
// resolves them at runtime, and it does not read tsconfig paths: blog-score.ts imports its
// neighbour the same way for the same reason. A type-only import may use the alias, because node
// strips those before anything tries to resolve them.
import { blogState, clientCanSee, type BlogState, type BlogStateFacts } from "./blog-state.ts";

/**
 * WHICH SUBTAB OF THE MERGED BLOGS PAGE A TOPIC BELONGS TO.
 *
 * The Create tab and the Blogs tab are one page now, and the four tabs partition every topic a
 * brand has. Each rule is ONE predicate over facts the wire already carries, and each topic lands
 * in EXACTLY ONE tab: the four are mutually exclusive by construction below, and blogTabs.test.ts
 * pins that over every BlogState there is, so a state added later cannot quietly land in two
 * places or in none.
 *
 *   NEW              nothing has been written yet, so the roadmap ROW shows and Generate acts.
 *   INTERNAL REVIEW  a draft exists and it is on the team's bench.
 *   CLIENT REVIEW    the client can see it, and it stays here until it is live.
 *   PUBLISHED        it is in the CMS.
 *
 * CLIENT REVIEW IS `clientCanSee` AND NOT A LIST OF STATES. That predicate already answers
 * exactly this question for the portal, so reading it here means the tab an operator sees and the
 * article a client sees can never disagree: if it is in Client review, they have it. Writing the
 * states out by hand would be a second copy of a rule that already exists, and the copy is what
 * drifts. It is why a held blog lands here rather than on the team's bench, which is not a special
 * case but a consequence: clientCanSee("has_questions") is true, because the portal serves the
 * question form to the client to answer.
 */
export type BlogTab = "new" | "internal" | "client" | "published";

export const BLOG_TABS: readonly BlogTab[] = ["new", "internal", "client", "published"];

export const BLOG_TAB_LABELS: Record<BlogTab, string> = {
  new: "New",
  internal: "Internal review",
  client: "Client review",
  published: "Published",
};

/** The facts a tab is decided from: the state facts, plus the evaluator's number. */
export type TabFacts = BlogStateFacts & {
  score?: number | null;
  /** Written by hand rather than by the engine. Such a blog has no score BY DESIGN. */
  uploaded?: boolean | null;
};

/**
 * Whether a real article exists for this topic.
 *
 * AN EVALUATOR'S SCORE IS THE TEST, not a file on disk, and that is the operator's own answer to
 * "what counts as a draft": one full loop iteration finished, so a number and a fix list exist and
 * there is something to judge. A run stopped mid-write leaves bytes nobody scored, which is not a
 * draft anyone can act on, and its topic goes back to New where a rerun is the only sensible act.
 *
 * AN UPLOADED BLOG COUNTS WITHOUT ONE. It was written by a person and never evaluated, so its score
 * is null by design; testing the number alone would file every hand-written article under "nothing
 * has been written yet", which is the exact opposite of true.
 */
export function hasDraft(facts: TabFacts): boolean {
  return typeof facts.score === "number" || facts.uploaded === true;
}

/**
 * The tab this topic's row belongs in.
 *
 * ORDER IS THE RULE. Published is terminal and outranks everything. Client review is next because
 * possession beats progress: once the client has the article, where the engine got to is no longer
 * the useful sentence. Only then does the draft test split the team's bench from the roadmap.
 */
export function blogTab(facts: TabFacts): BlogTab {
  const state = blogState(facts);
  if (state === "published") {
    return "published";
  }
  if (clientCanSee(state)) {
    return "client";
  }
  return hasDraft(facts) ? "internal" : "new";
}

/**
 * The same partition over a STATE alone, for callers that hold no record: the tab tests, and any
 * caller reasoning about a state rather than about a row.
 *
 * A state carries no score, so `internal` and `new` are indistinguishable from it. It answers with
 * null there rather than guessing, because a guess is how a hand-written blog gets filed as
 * unwritten.
 */
export function tabOfState(state: BlogState): BlogTab | null {
  if (state === "published") {
    return "published";
  }
  if (clientCanSee(state)) {
    return "client";
  }
  // The one state that decides itself: a roadmap row with no blog behind it cannot be anywhere
  // but New, and unlike the two below it there is no score that could move it.
  if (state === "not_generated") {
    return "new";
  }
  return null;
}
