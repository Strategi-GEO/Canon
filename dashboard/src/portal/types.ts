import type { BlogState } from "@/lib/blog-state";

/**
 * The portal's wire types, mirroring what the Route Handlers actually answer. Deliberately
 * SMALL: no score, no iterations, no stage, no run timing, no eval or dossier artifacts
 * anywhere on this wire. That absence is the client-safe boundary, and
 * tests/portal_check.py enforces it by grepping this app for the forbidden fields.
 *
 * THE STATE ON THIS WIRE IS THE CANONICAL BlogState, not a portal dialect. The old private
 * four-value vocabulary (action / frozen / ready / approved) is GONE, and the reason it went
 * is that translating at the wire boundary would have put a second decider back: every view
 * that asks `clientCan(state, "approve")` or renders `<BlogStateTag>` speaks BlogState, so a
 * dialect on the wire only means mapping back on arrival, in each view, forever.
 *
 * Carrying the canonical state is NOT carrying the admin's information. A client is shown a
 * different LABEL for the same state (clientTag), is offered different ACTS (clientActions),
 * and is shown only the states a client surface can legitimately describe: internal_review,
 * failed and stopped never reach this wire.
 *
 * THEY ARE NARROWED, NOT DROPPED, and the difference is worth stating because the earlier
 * version of this comment claimed the wrong mechanism and the wrong mechanism was reassuring.
 * portal-data.ts does NOT drop those rows: the visibility rule deliberately keeps an article
 * the client just answered, so it stays on the page instead of vanishing under the person who
 * acted on it, and the revise that follows lands on internal_review or failed while it runs.
 * What happens at the payload boundary is a NARROWING to a state the client vocabulary covers.
 * Believing the drop story would have made the next reader treat this wire as safe by
 * construction, when what makes it safe is one explicit mapping that has to keep being applied.
 */
export type { BlogState };

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
  state: BlogState;
  date: string;
  question_count: number | null;
  word_count: number | null;
  /** Spent holds only: true when the client's answers are recorded and being applied. */
  answered: boolean;
  /** Released states only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved and published only: when the client approved. UTC ISO. */
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
 * UI folds them to plain language (with the team / resolved / reviewed) because how a
 * change gets applied is the team's machinery, never the client's concern. Deliberately no
 * error field: a failed apply is the team's problem, and the wire not carrying the error
 * is what guarantees no view can ever show it.
 */
export type PortalCommentState = "open" | "applying" | "resolved" | "failed" | "dismissed";

/**
 * Who wrote a line in a thread, already translated. The record says 'client' or 'operator';
 * the client reads "you" or "the team", so the translation happens at the wire boundary
 * (app/api/blog/[brand]/[topic]/route.ts) and the operator's vocabulary never arrives in a
 * client browser at all. There is no third value: a thread has exactly two sides.
 */
export type PortalReplyAuthor = "you" | "team";

/** One line of the conversation under a suggestion. Replies are flat by construction: the
 *  record refuses a reply to a reply, so nothing here nests. */
export type PortalReply = {
  id: string;
  author: PortalReplyAuthor;
  body: string;
  created: string;
};

export type PortalComment = {
  id: string;
  selected_text: string;
  instruction: string;
  state: PortalCommentState;
  created: string;
  /** Oldest first, both sides' lines in one list. Empty until somebody answers. */
  replies: PortalReply[];
};

export type PortalBlogDetail = {
  brand: string;
  brand_name: string;
  topic_slug: string;
  title: string;
  state: BlogState;
  date: string;
  word_count: number | null;
  /** Released: the sent article. has_questions: the draft under review. Held: absent. */
  body: string | null;
  questions: PortalQuestion[] | null;
  asked: string | null;
  answers: PortalAnswerView[] | null;
  answered_at: string | null;
  /** Released states only: the client's own suggestions, oldest first, with their threads. */
  comments: PortalComment[] | null;
  /**
   * Released states only: the id of the version these bytes came from, carried back on
   * approve. It is what closes the race where the team re-sends while an approval is in
   * flight: without it the stamp lands on an article the client never read, and the record
   * would say they signed off on bytes that appeared after they pressed the button. Null on
   * a legacy send that predates the stamp, which the record accepts as the matching value.
   */
  version: string | null;
  /** Released states only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved and published only: when the client approved. UTC ISO. */
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

/** What one reply carries: which suggestion it answers, and the line itself. */
export type ReplyBody = {
  parent_id: string;
  body: string;
};

/** What an approval carries: the version the client actually read. */
export type ApproveBody = {
  version: string | null;
};

/**
 * One file in the brand's own fact base, exactly as GET /api/clients/{slug}/resources
 * answers it. Same four fields the admin surface reads, and deliberately the same four: this
 * is the ONE payload on the portal wire that is not a narrowing of something the team owns,
 * because the client uploaded these files and there is no internal half to withhold.
 *
 * `content_type` is a required string here where src/types marks it optional, because the
 * hosted route already resolved the absence: a NULL column arrives as "". The empty string is
 * not a missing value to guard against, it is the documented signal that nothing was recorded
 * at upload and the filename decides. resource-type.ts reads it that way for both the badge
 * and the preview choice, so it is the one guess in the one place.
 */
export type PortalResource = {
  name: string;
  size: number;
  /** When the file was uploaded. UTC ISO, or "" on a row that never recorded one. */
  modified: string;
  content_type: string;
};

export type PortalResourceList = {
  resources: PortalResource[];
};

/**
 * A short-lived, header-free URL for one file's bytes, from
 * GET /api/clients/{slug}/resources/{name}. NEVER the bytes themselves: Vercel caps a
 * serverless body at 4.5 MB and a resource runs to 25 MiB, so the bytes travel between the
 * browser and Storage directly and this is the ticket for that trip.
 *
 * Being header-free is the whole point of the shape: an <img> or an <iframe> cannot carry an
 * Authorization header, so a preview that needed one would mean pulling the entire file into
 * JS memory as a blob first. `expires_in` is seconds and it is short, so a dialog that can
 * stay open longer than that asks for a fresh one rather than discovering the expiry
 * mid-render.
 */
export type PortalResourceLink = {
  name: string;
  url: string;
  content_type: string;
  size: number;
  expires_in: number;
};

/**
 * Where the browser PUTs the bytes of ONE new file, from
 * POST /api/clients/{slug}/resources/upload-url.
 *
 * The same 4.5 MB wall forces this, and it forces it in the harder direction: an upload
 * cannot be proxied through a Route Handler at all, so the browser has to reach Storage
 * itself. It does that on a URL minted for one object key on the caller's own authority
 * (migration 015's resources_insert_scoped governs the minting), which is why `headers`
 * arrives from the server rather than being assembled here: the browser is told what to send
 * and never holds a project credential of its own.
 */
export type PortalUploadTarget = {
  url: string;
  /** PUT today. Carried on the wire so a Storage API change is a server-side change. */
  method: string;
  headers: Record<string, string>;
};

/**
 * What indexing one uploaded file carries to POST /api/clients/{slug}/resources.
 *
 * `sha256` is the object's whole address: the bytes live at `<brand>/<sha256>` and the server
 * builds that path from the brand it authorised the call for, so this body can never name
 * another brand's object. The index row is written AFTER the bytes land, which is the order
 * that makes a failed upload cost nothing: an unindexed object is invisible and a retry of
 * the same file simply lands on the same address again.
 */
export type IndexResourceBody = {
  name: string;
  sha256: string;
  size: number;
  content_type: string;
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
