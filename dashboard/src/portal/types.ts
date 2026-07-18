/**
 * The portal's wire types, mirroring what the Route Handlers actually answer. Deliberately
 * SMALL: no score, no iterations, no stage, no run timing, no eval or dossier artifacts
 * anywhere on this wire. That absence is the client-safe boundary, and
 * tests/portal_check.py enforces it by grepping this app for the forbidden fields.
 */

export type PortalState = "action" | "frozen" | "delivered";

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

export type PortalBlogDetail = {
  brand: string;
  brand_name: string;
  topic_slug: string;
  title: string;
  state: PortalState;
  date: string;
  word_count: number | null;
  body: string | null;
  questions: PortalQuestion[] | null;
  asked: string | null;
  answers: PortalAnswerView[] | null;
  answered_at: string | null;
};

export type AnswersBody = {
  answers: { id: string; answer: string }[];
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
