/**
 * The portal's wire types, mirroring what the Route Handlers actually answer. Deliberately
 * SMALL: no score, no iterations, no stage, no run timing, no eval or dossier artifacts
 * anywhere on this wire. That absence is the client-safe boundary, and
 * tests/portal_check.py enforces it by grepping this app for the forbidden fields.
 */

/**
 * The portal's whole vocabulary for a blog, derived server-side (portal-data.ts) and never
 * stored: action (the client owes answers), frozen (with the editorial team), ready (sent
 * for the client's review: approve it or suggest changes), approved (the client signed it
 * off and the team takes it live). "ready" and "approved" together replace the old
 * terminal "delivered": delivery is no longer the end of the conversation, approval is.
 */
export type PortalState = "action" | "frozen" | "ready" | "approved";

export type PortalOrg = {
  slug: string;
  name: string;
  brands: { slug: string; name: string }[];
};

export type Me = {
  user_id: string;
  email: string;
  /**
   * Whether this login is a Strategi operator. The portal UI has no admin switch of its
   * own, but the ONE common login reads this to decide where a just-verified account goes:
   * an admin to /admin, a client to their /{org}.
   */
  is_admin: boolean;
  orgs: PortalOrg[];
};

export type PortalBlogCard = {
  /** The org the brand belongs to, so a card can link to /{org}/{brand}/... on its own. */
  org: string;
  brand: string;
  brand_name: string;
  topic_slug: string;
  title: string;
  state: PortalState;
  date: string;
  question_count: number | null;
  word_count: number | null;
  answered: boolean;
  /** ready and approved only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved only: when the client approved. UTC ISO. */
  approved: string | null;
};

export type Overview = {
  orgs: PortalOrg[];
  blogs: PortalBlogCard[];
};

export type PortalQuestion = {
  id: string;
  area: string | null;
  question: string;
  why: string;
};

export type PortalAnswerView = {
  id: string;
  area: string | null;
  question: string;
  answer: string;
};

/**
 * One suggestion the client filed against a sent article, in the record's own states. The
 * UI folds them to plain language (with the team / addressed / reviewed) because how a
 * change gets applied is the team's machinery, never the client's concern. Deliberately no
 * error field: a failed apply is the team's problem, and the wire not carrying the error
 * is what guarantees no view can ever show it.
 */
export type PortalCommentState = "open" | "applying" | "resolved" | "failed" | "dismissed";

export type PortalComment = {
  id: string;
  selected_text: string;
  instruction: string;
  state: PortalCommentState;
  created: string;
};

export type PortalBlogDetail = {
  brand: string;
  brand_name: string;
  topic_slug: string;
  title: string;
  state: PortalState;
  date: string;
  word_count: number | null;
  /** ready/approved: the sent article. action: the current draft under review. frozen: absent. */
  body: string | null;
  questions: PortalQuestion[] | null;
  asked: string | null;
  answers: PortalAnswerView[] | null;
  answered_at: string | null;
  /** ready and approved only: the client's own suggestions, oldest first. */
  comments: PortalComment[] | null;
  /** ready and approved only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved only: when the client approved. UTC ISO. */
  approved: string | null;
};

export type AnswersBody = {
  answers: { id: string; answer: string }[];
};

/** What one suggestion carries to the server: the rendered selection, enough surrounding
 *  text to place it even when the passage repeats, and the client's note. */
export type SuggestBody = {
  selected_text: string;
  context_before: string;
  context_after: string;
  instruction: string;
};

export type PortalRoadmapRow = {
  index: number;
  topic: string;
  covers: string;
  prompts: string[];
  extras: Record<string, string>;
  delivered: boolean;
  delivered_at: string | null;
  topic_slug: string | null;
};

export type PortalRoadmap = {
  brand: string;
  brand_name: string;
  rows: PortalRoadmapRow[];
};
