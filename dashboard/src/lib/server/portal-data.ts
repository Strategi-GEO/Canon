import { blogState, clientCanSee, type BlogState } from "@/lib/blog-state";
import { inList, pg } from "@/lib/server/postgrest";

/**
 * The portal's data shapes, built server-side so the CLIENT-SAFE boundary is one place.
 *
 * WHAT A CLIENT NEVER SEES, enforced here by never selecting it: scores (blog_versions.score,
 * asked_score, topic_rollup), iterations and stages, run durations, eval bodies, dossiers,
 * status notes, gates, and the CMS surface. The portal's payloads carry titles, dates, states,
 * questions, answers, and article bodies, and nothing else. tests/portal_check.py greps this
 * app for the forbidden column names, so a future select that reaches for one fails the build,
 * not a review.
 *
 * Reads run as the caller via PostgREST, so RLS scopes every row: an org login only ever
 * receives its own org's brands, and an out-of-scope brand folds to "not found".
 *
 * THE STATE IS NOT DECIDED HERE. lib/blog-state.ts decides it, for both surfaces at once, and
 * this file's only job is to hand it honest facts and to render the answer. The portal used to
 * own a private four-value vocabulary (action / frozen / ready / approved) computed from a
 * ledger row, two stamps and a form read; the admin dashboard computed its own from the same
 * record, and what kept the two agreeing was a comment in each one asserting that it did. That
 * is a claim rather than a mechanism. `blogState()` is the mechanism, `clientCanSee()` decides
 * what a client is shown of it, and `clientCan()` decides what a client may do to it.
 *
 * THE FACTS, and where each comes from:
 *   status            the run feed's last terminal line, folded below, with ONE correction
 *   answers_submitted the newest reply on the CURRENT form, so a submit is a state and not a flag
 *   sent_to_client    topics.sent_to_client_at, the admin-review exit
 *   client_approved   topics.client_approved_at, the client's sign-off on exactly these bytes
 *   changes_requested top-level client suggestions still open or mid-apply
 *   published         topics.published_at, granted to authenticated by migration 012
 *
 * THE SUBMIT IS A FACT NOW, AND IT USED TO BE TWO FAKES. This file previously simulated the
 * window between a client pressing Submit and the rerun's terminal line by rewriting the status
 * to `running` for EVERY spent hold and then widening visibility to catch what that rewrite hid.
 * Both devices are gone from the answered case, because `answers_submitted` is a real state in
 * lib/blog-state.ts and the machine decides it from the same fact both backends already send.
 * A simulation that lands on `generating` cannot be told apart from an actual run, so no view
 * could render the client's own answers beside the draft they answered against; the state can,
 * and the whole of PART 1 of this change is handing it the fact instead of faking the answer.
 *
 * THE ONE CORRECTION THAT SURVIVES, AND WHY IT IS NOT REDUNDANT. The engine defines needs_review
 * as "questions that are current, on disk and answerable", and runner.py corrects a hold whose
 * form is absent or stale back to done or failed. What this file reads is a MIRROR of the run
 * feed, and the mirror carries that correction only once the revise writes its own terminal
 * line. An ANSWERED spent hold is now `answers_submitted` and needs no repair. An UNANSWERED one
 * (no form on disk at all, a form the anchor or the iteration has moved past, or a form the
 * OPERATOR already answered) is still a mirror claiming a question the client cannot answer, and
 * reporting it as `has_questions` would put a client in front of an empty, stale or spent form:
 * an aside reading "0 questions before this can be finalised", or a box whose submit
 * portal_submit_answers refuses as stale or as already answered. So the repair is
 * NARROWED to `unansweredSpentHold` rather than deleted, and the narrowing is the whole of what
 * lets `answers_submitted` outrank it, because `generating` sits above it in blogState's ladder
 * and would have swallowed the new state entirely.
 *
 * VISIBILITY IS clientCanSee, PLUS TWO ARMS THIS FILE STILL OWNS, both narrower than before.
 * clientCanSee now admits `answers_submitted` itself, so the ordinary answered window needs no
 * addition here at all. What the arms cover is the two slivers the state genuinely cannot reach:
 *   answered              a rerun that is LIVE outranks the submit in blogState (deliberately:
 *                         the rerun is the thing the state waits for), so the record reads
 *                         `generating` while it runs and clientCanSee refuses it.
 *   unansweredSpentHold   the repaired mirror above, which reads `generating` by construction.
 * Refusing either would make the article vanish out from under the person who just acted on it,
 * and worse than vanish: portal_submit_answers freezes the blog on submit, so the detail page
 * they are standing on would 404 the instant they answered.
 *
 * That is a VISIBILITY rule over one state and never a second state machine, which is the same
 * distinction lib/blog-state.ts draws for the labels. Note what the two arms do NOT do: they
 * grant no act (clientCan still answers no in `generating`), they reveal no article (no body is
 * fetched for them), and they admit no row the client never touched. What they DO cost is one
 * narrowing at the wire, because a widened rule can hand a client's JSON a state word their
 * vocabulary was never meant to carry. See clientWireState below.
 */

/**
 * The states whose payload carries the SENT article, so the client reads and annotates exactly
 * the bytes the send stamped. Exported because the blog route needs the same answer for its
 * thread read, and two copies of this list would drift the moment one state was added.
 *
 * `answers_submitted` IS DELIBERATELY ABSENT, and the omission is the load-bearing half of this
 * function rather than an oversight. Every state listed here is at or past a SEND, and three
 * separate things key off that and nothing else: the body served is topics.sent_version_id's
 * bytes, the word count describes the released article, and app/api/blog/[brand]/[topic] reads
 * the suggestion threads and the approve-time version stamp for exactly this set. An article
 * whose client has just answered a question form has never been sent, so it has no sent version
 * to serve, no released length to report, and no thread to read: admitting it here would hand it
 * the LATEST bytes under a name that promises the sent ones, which is the precise failure the
 * anchored-body rule below exists to prevent.
 *
 * The client DOES read an article in `answers_submitted`, and clientReadsDraft is where that
 * lives. Two predicates because there are two articles: the one a send released, and the one a
 * question form is anchored to.
 */
export function clientReadsArticle(state: BlogState): boolean {
  return (
    state === "client_review" ||
    state === "changes_requested" ||
    state === "approved" ||
    state === "published"
  );
}

/**
 * The states whose payload carries the ANCHORED DRAFT: the exact version the current question
 * form is about, never the newest committed row.
 *
 * BOTH MEMBERS ARE THE SAME RULE AT TWO MOMENTS. In `has_questions` the client is answering
 * about that draft; in `answers_submitted` they have answered about that same draft and are
 * owed the right to keep reading what they answered against, plus their own answers beside it.
 * The anchor does not move between the two, because the anchor is review_notes.blog_version_id
 * on the form itself and answering a form does not re-anchor it.
 *
 * THIS IS WHAT KEEPS A NEWER DRAFT AWAY FROM THE CLIENT. A rerun that lands clean at a passing
 * score with nothing to ask commits a NEW version and goes to internal review, which is not
 * theirs to see. Serving `fold.latest` in this window would show them that draft anyway, silently
 * and with no send behind it. Serving `fold.formVersion` shows them the article the conversation
 * is actually about, which is the same article on both sides of their Submit.
 *
 * Not exported, and that is on purpose: portal/views.tsx is a client component and importing
 * anything from this module would drag the PostgREST client into the browser bundle.
 */
function clientReadsDraft(state: BlogState): boolean {
  return state === "has_questions" || state === "answers_submitted";
}

/**
 * The state as a CLIENT may RECEIVE it, applied where a payload is built and nowhere else.
 *
 * VISIBILITY IS WIDER THAN clientCanSee, SO THE WIRE NEEDS A NARROWING. The two arms documented
 * at the top of this file keep an article the client answered on their screen while a rerun is
 * genuinely in flight, and that window reads `generating`, `internal_review`, `failed`,
 * `stopped` or `unknown` depending on where the answer-driven revise got to. The rendered UI
 * is already right about all five, because clientTag folds every one of them to a busy "In
 * progress". The JSON was not, and the JSON is the half a client can read in devtools: it
 * shipped the team's own words about the client's article, and it contradicted
 * portal/types.ts, which states that internal_review, failed and stopped never reach here.
 *
 * IT NARROWS STRICTLY LESS THAN IT USED TO, and that is `answers_submitted` working rather than
 * this function weakening. clientCanSee admits the new state, so the ordinary window between a
 * Submit and a send now travels under its own name and reaches the views intact: that is what
 * lets the detail page render the client's answers beside the draft they answered against, which
 * is impossible under a word that also means "a run is live".
 *
 * THE ANSWER IS AN EXISTING STATE, NEVER A PORTAL DIALECT. portal/types.ts records why the
 * old private four-value vocabulary was deleted: every view speaks BlogState, so a dialect on
 * the wire only means each view mapping back on arrival, forever. `generating` needs no such
 * mapping. It is a state the client vocabulary genuinely describes, it is ALREADY on this
 * wire (a spent hold folds to it through the status correction above), and it answers every
 * question the portal asks of a state identically to the four it replaces: clientCanSee no,
 * clientCan no to every act, clientReadsArticle no, clientTag "In progress". The payload
 * narrows and not one view changes.
 *
 * This GRANTS NOTHING and REVEALS NOTHING. It is applied to the payload's state field alone,
 * after `visible` has already decided the row belongs on the wire and after every branch that
 * chooses a body, an answer list or a date has read the real state. A client receives one
 * honest word for "with the team" instead of five, four of which were never theirs to read.
 */
function clientWireState(state: BlogState): BlogState {
  return clientCanSee(state) ? state : "generating";
}

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
 * One of the client's own suggestions, shown back to them on the detail page. The raw
 * state travels and the UI maps it to plain language: open and applying read "with the
 * team", resolved reads "addressed", dismissed reads "reviewed". failed deliberately reads
 * "with the team" as well, and no error text is selected or carried here: a failed apply
 * is the team's problem to retry, never the client's to debug. The author's email column
 * is never selected anywhere on this surface.
 */
export type PortalComment = {
  id: string;
  selected_text: string;
  instruction: string;
  state: "open" | "applying" | "resolved" | "failed" | "dismissed";
  created: string;
};

export type PortalBlogCard = {
  /** The org the brand belongs to, so a card can link to /{org}/{brand}/... on its own. */
  org: string;
  brand: string;
  brand_name: string;
  topic_slug: string;
  title: string;
  state: BlogState;
  /** The state's own date: published, approved, suggested, sent, asked or answered. UTC ISO. */
  date: string;
  /** has_questions only: the size of the OPEN form. Null once it is answered. */
  question_count: number | null;
  word_count: number | null;
  /** Before a send only: true when the client's answers to the current form are recorded. */
  answered: boolean;
  /** Released states only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved and published only: when the client approved. UTC ISO. */
  approved: string | null;
};

export type PortalOrg = {
  slug: string;
  name: string;
  brands: { slug: string; name: string }[];
};

export type PortalBlogDetail = {
  brand: string;
  brand_name: string;
  topic_slug: string;
  title: string;
  state: BlogState;
  date: string;
  word_count: number | null;
  /**
   * Released: the article as sent. has_questions and answers_submitted: the ANCHORED draft, the
   * one the question form is about. The two `generating` slivers: absent.
   */
  body: string | null;
  /** has_questions only: the form to answer. Null once it is answered, because it is spent. */
  questions: PortalQuestion[] | null;
  asked: string | null;
  /** Before a send, once answered: what was answered, read-only. Chiefly answers_submitted. */
  answers: PortalAnswerView[] | null;
  answered_at: string | null;
  /** Released states only: the client's own suggestions, oldest first. */
  comments: PortalComment[] | null;
  /** Released states only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved and published only: when the client approved. UTC ISO. */
  approved: string | null;
};

// ---------------------------------------------------------------------------
// Row shapes (exactly the columns selected, nothing more)
// ---------------------------------------------------------------------------

type MembershipRow = {
  org_slug: string;
  org_name: string;
  client_id: string;
  client_slug: string;
  client_name: string;
};
type TopicRow = {
  id: string;
  slug: string;
  title: string | null;
  shipped_version_id: string | null;
  sent_version_id: string | null;
  sent_to_client_at: string | null;
  client_approved_at: string | null;
  /** NULL IS "NO RECORD OF A PUSH", never "not published" (migration 012 has no backfill). */
  published_at: string | null;
};
type VersionRow = {
  id: string;
  topic_id: string;
  h1_title: string | null;
  committed_at: string;
  version_no: number;
  word_count: number | null;
};
type LedgerRow = { topic: string | null; topic_slug: string | null; generated_at: string | null };
type NoteRow = {
  id: string;
  topic_id: string;
  blog_version_id: string;
  ref: string | null;
  area: string | null;
  body: string;
  why: string | null;
  asked_iter: number | null;
  created_at: string;
};
type ChildRow = { parent_id: string; body: string; created_at: string };
/**
 * A reply by ANY author, reduced to the only column that question needs. It deliberately carries
 * no body and no author: this row type answers "has somebody already replied to this question",
 * and a shape that could carry an operator's words onto the client surface is a shape a later
 * edit can leak through. ChildRow above is the client's own reply, text and all.
 */
type ReplyParentRow = { parent_id: string };
type EventRow = { topic_id: string; iter: number; line_no: number; status: string };
type CommentRow = {
  id: string;
  topic_id: string;
  selected_text: string;
  instruction: string;
  state: PortalComment["state"];
  created_at: string;
};

function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** roadmap.slugify, verbatim, for ledger rows whose topic_slug cell is empty. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const TOPIC_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CLIENT_SLUG_RE = /^_?[a-z0-9]+(-[a-z0-9]+)*$/;

export function validTopicSlug(slug: string): boolean {
  return TOPIC_SLUG_RE.test(slug);
}
export function validClientSlug(slug: string): boolean {
  return CLIENT_SLUG_RE.test(slug);
}

// ---------------------------------------------------------------------------
// Orgs and brands for this login
// ---------------------------------------------------------------------------

/**
 * The caller's org list. An admin sees every org (RLS shows an admin every membership
 * row); an org login sees exactly the orgs its org_members grants name. Either way the
 * org_membership view is the authority, so a brand moving between orgs moves with it.
 */
export async function orgsForUser(token: string, userId: string): Promise<PortalOrg[]> {
  const [adminRows, grants, membership] = await Promise.all([
    pg<{ user_id: string }[]>(token, `app_admins?select=user_id&user_id=eq.${userId}`),
    pg<{ org_slug: string }[]>(token, `org_members?select=org_slug&user_id=eq.${userId}`),
    pg<MembershipRow[]>(
      token,
      "org_membership?select=org_slug,org_name,client_id,client_slug,client_name",
    ),
  ]);
  const isAdmin = adminRows.length > 0;
  const granted = new Set(grants.map((grant) => grant.org_slug));

  const orgs = new Map<string, PortalOrg>();
  for (const row of membership) {
    if (!isAdmin && !granted.has(row.org_slug)) {
      continue;
    }
    const org = orgs.get(row.org_slug) ?? { slug: row.org_slug, name: row.org_name, brands: [] };
    org.brands.push({ slug: row.client_slug, name: row.client_name });
    orgs.set(row.org_slug, org);
  }
  const list = [...orgs.values()].sort((a, b) =>
    byteCompare(a.name.toLowerCase(), b.name.toLowerCase()),
  );
  for (const org of list) {
    org.brands.sort((a, b) => byteCompare(a.name.toLowerCase(), b.name.toLowerCase()));
  }
  return list;
}

/** One brand's membership row, or null when RLS yields nothing (unknown OR out of scope). */
export async function brandRow(token: string, brandSlug: string): Promise<MembershipRow | null> {
  if (!validClientSlug(brandSlug)) {
    return null;
  }
  const rows = await pg<MembershipRow[]>(
    token,
    `org_membership?select=org_slug,org_name,client_id,client_slug,client_name&client_slug=eq.${brandSlug}`,
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The per-topic fold
// ---------------------------------------------------------------------------

type TopicFold = {
  topic: TopicRow;
  latest: VersionRow;
  shippedVersion: VersionRow | null;
  sentVersion: VersionRow | null;
  ledger: LedgerRow | null;
  comments: CommentRow[];
  form: NoteRow[];
  /**
   * THE VERSION THE CURRENT FORM IS ANCHORED TO, which is the draft a client answering these
   * questions is answering ABOUT. review_notes.blog_version_id is NOT NULL and carries a
   * composite foreign key to blog_versions(id, topic_id), so the anchor is a fact the database
   * already keeps rather than something this fold infers; the fold's only job is to carry it
   * out where the body read can reach it. Null only where the topic has no form at all, or,
   * defensively, where the anchored row fell outside this brand's version read.
   */
  formVersion: VersionRow | null;
  childByParent: Map<string, ChildRow>;
  formIter: number | null;
  maxIter: number;
  status: string;
  stale: boolean;
  answered: boolean;
  state: BlogState;
  /** clientCanSee, plus the two `generating` arms documented at the top of this file. */
  visible: boolean;
  title: string;
  askedAt: string | null;
  answeredAt: string | null;
  /** The newest open or mid-apply suggestion, so a change request floats its own card. */
  suggestedAt: string | null;
};

type BrandData = {
  topics: TopicRow[];
  versions: VersionRow[];
  ledger: LedgerRow[];
  notes: NoteRow[];
  children: ChildRow[];
  replies: ReplyParentRow[];
  events: EventRow[];
  comments: CommentRow[];
};

async function fetchBrand(token: string, clientId: string): Promise<BrandData> {
  const [topics, versions, ledger, notes, children, replies, events, comments] = await Promise.all([
    pg<TopicRow[]>(
      token,
      // published_at joins the select because it is the TOP of blogState's delivery ladder: a
      // live article must not keep reading as merely approved. Migration 012 grants exactly
      // this column to authenticated, and an ungranted column would refuse the whole request.
      `topics?select=id,slug,title,shipped_version_id,sent_version_id,sent_to_client_at,client_approved_at,published_at` +
        `&client_id=eq.${clientId}&deleted_at=is.null`,
    ),
    pg<VersionRow[]>(
      token,
      `blog_versions?select=id,topic_id,h1_title,committed_at,version_no,word_count` +
        `&client_id=eq.${clientId}&order=topic_id.asc,version_no.desc`,
    ),
    pg<LedgerRow[]>(
      token,
      `ledger_entries?select=topic,topic_slug,generated_at&client_id=eq.${clientId}`,
    ),
    pg<NoteRow[]>(
      token,
      `review_notes?select=id,topic_id,blog_version_id,ref,area,body,why,asked_iter,created_at` +
        `&client_id=eq.${clientId}&author=eq.evaluator&parent_id=is.null&order=created_at.desc`,
    ),
    // THE CLIENT'S OWN ANSWERS ONLY. `author=eq.client` is load-bearing and its absence was a
    // client-facing leak, not a tidiness problem: this read decides `answered`, `answered`
    // widens portal visibility, and an OPERATOR answering the same form satisfies an unfiltered
    // read identically. An internal_review article the client must never see then appeared in
    // their portal, captioned as their own answers, rendering the evaluator's questions and the
    // operator's internal replies. The genuine window, where a CLIENT has answered and the
    // revise has not yet landed, is `answers_submitted`, and this read is what decides it. It is
    // also the read whose bodies are handed back to the client as their own words, which is the
    // second reason the filter can never come off it.
    //
    // IT IS NOT THE READ THAT DECIDES WHETHER THE FORM IS STILL OPEN, and it used to be. That
    // question is the read below, and separating the two is the whole of this fix.
    pg<ChildRow[]>(
      token,
      `review_notes?select=parent_id,body,created_at&client_id=eq.${clientId}` +
        `&parent_id=not.is.null&author=eq.client`,
    ),
    // WHETHER ANY AUTHOR HAS ALREADY SPENT THE FORM, which is a different question from the one
    // above and was being answered with the above read's filter. Every other computation of this
    // fact in the repo is author agnostic: portal_submit_answers refuses a submit as
    // PORTAL:ANSWERED on `exists (select 1 from review_notes r where r.parent_id = n.id)`
    // (migration 003, carried forward whole by 014), server/questions.py _db_form_rows computes
    // the engine's own `answered` with that same exists, client_answers._PENDING_SQL asks it of
    // the dispatch a form owes, and blogs/[topic]/questions/route.ts folds the admin panel's
    // `answered` over an unfiltered children read. This fold was the one scoped to the client, so
    // an OPERATOR answering the form left the portal rating it answerable while the RPC refused
    // it: the client saw an open form, typed into it, and got an error on every submit. Migration
    // 014's header names that outcome as the unsafe direction by construction, "a client in front
    // of a box that accepts their typing and then always errors, with no way for them to tell
    // why", so the portal is the side that moves and the RPC is left alone.
    //
    // AN OPERATOR ANSWER REALLY DOES SATISFY THE FORM, which is why matching the RPC is right
    // here rather than merely convenient. server/questions.py write_answers matches its child row
    // by parent_id ALONE so an operator answer OVERWRITES a client reply, because two replies to
    // one question is a state describe_questions reads as two answers to one; the RPC's own
    // insert carries no such update arm, so author-scoping the RPC instead would manufacture
    // exactly that duplicate from the client surface with nobody watching. The operator's submit
    // has also already dispatched its surgical revise, synchronously, on POST /answers, so the
    // form is not merely replied to, it is spent: the rerun it summoned is running.
    //
    // PARENT_ID ONLY, NEVER A BODY AND NEVER AN AUTHOR. This read exists to count replies, and an
    // operator's reply text is internal material that must not reach a client payload at all. The
    // client's own answers still come from the read above, so nothing this returns is rendered.
    // PAGED, for the same reason the events read below is. This is the widest read in
    // fetchBrand: every reply ever filed for the brand, by any author, with no limit. Above
    // PostgREST's row cap the response truncates SILENTLY, repliedParents under-counts, and a
    // spent form reads open again, which is the exact defect this read was added to close. A
    // truncation here does not fail, it regresses, so the cap is the thing to remove rather
    // than the thing to stay under.
    pgPaged<ReplyParentRow>(
      token,
      `review_notes?select=parent_id&client_id=eq.${clientId}&parent_id=not.is.null`,
    ),
    // ORDERED BY THE UNIQUE KEY, never by line_no alone. `line_no` is the ordinal WITHIN one
    // topic (schema.sql declares `unique (topic_id, line_no)`), so across a brand it repeats
    // once per topic and an ordering on it is thousands of ties deep. Offset paging over a
    // tied sort is free to break those ties differently on each page, which drops or
    // duplicates rows at a page boundary, and the row a drop costs here is a terminal line:
    // the fold below would read a stale status, and a topic the admin is waiting on the
    // client to approve would vanish from that client's portal instead. `(topic_id, line_no)`
    // is the unique constraint itself, so the order is total by construction, and it is the
    // order the fold already assumes within a topic. The status_events_topic_line index backs
    // it exactly, so the total order costs nothing.
    pgPaged<EventRow>(
      token,
      `status_events?select=topic_id,iter,line_no,status&client_id=eq.${clientId}` +
        `&order=topic_id.asc,line_no.asc`,
    ),
    // The client's OWN suggestions only (author=client), safe columns only. The author's
    // email column is never selected on this surface, and neither are error or edits:
    // an apply failure and its diff are the team's material, and selecting a column the
    // portal never shows is exactly the regression tests/portal_check.py exists to catch.
    //
    // parent_id=is.null IS LOAD-BEARING NOW. A reply carries its text in `instruction` and
    // nothing in selected_text, so an unfiltered read counts every line a client ever wrote
    // in a thread as a fresh change request, and the state fold below would hold an article
    // at changes_requested on the strength of "thanks, that reads well". The blog route's
    // thread read has always applied this filter for the same reason.
    pg<CommentRow[]>(
      token,
      `blog_comments?select=id,topic_id,selected_text,instruction,state,created_at` +
        `&client_id=eq.${clientId}&author=eq.client&parent_id=is.null&order=created_at.asc`,
    ),
  ]);
  return { topics, versions, ledger, notes, children, replies, events, comments };
}

/**
 * Read EVERY row of a query, page by page. status_events grows a few dozen rows per run
 * forever, so a busy brand walks past PostgREST's max-rows cap (Supabase defaults to 1000),
 * and because the query orders ascending a silent cap drops the NEWEST lines, which are
 * exactly the ones the state fold reads (max iter, last terminal status). Paging until a
 * short page is the whole fix; the other fetchBrand reads are bounded by editorial volume.
 *
 * EVERY PATH HANDED TO THIS FUNCTION MUST ORDER BY A GENUINELY UNIQUE KEY, and that is a
 * precondition rather than a preference. Offset paging asks the database for the same sort
 * once per page and trusts the two to agree; where the sort has ties, nothing obliges it to
 * order them the same way twice, so a row can be skipped at one page boundary and repeated
 * at the next. A per-parent ordinal reads as unique and is not: status_events.line_no is
 * unique only per topic, which is exactly how this went wrong.
 */
const PG_PAGE = 1000;

async function pgPaged<T>(token: string, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += PG_PAGE) {
    const page = await pg<T[]>(token, `${path}&limit=${PG_PAGE}&offset=${offset}`);
    all.push(...page);
    if (page.length < PG_PAGE) {
      return all;
    }
  }
}

function foldTopics(data: BrandData): TopicFold[] {
  // Latest committed version per topic: rows arrive version_no.desc within each topic.
  const latest = new Map<string, VersionRow>();
  const versionById = new Map<string, VersionRow>();
  for (const version of data.versions) {
    versionById.set(version.id, version);
    if (!latest.has(version.topic_id)) {
      latest.set(version.topic_id, version);
    }
  }

  // ledger._keyed: slug -> row, last write wins, empty slugs dropped.
  const ledger = new Map<string, LedgerRow>();
  for (const row of data.ledger) {
    const slug = (row.topic_slug || slugify(row.topic ?? "")).trim();
    if (slug !== "") {
      ledger.set(slug, row);
    }
  }

  const notesByTopic = new Map<string, NoteRow[]>();
  for (const note of data.notes) {
    const list = notesByTopic.get(note.topic_id) ?? [];
    list.push(note);
    notesByTopic.set(note.topic_id, list);
  }

  const childByParent = new Map<string, ChildRow>();
  for (const child of data.children) {
    // One reply per question by construction; keep the newest defensively.
    const seen = childByParent.get(child.parent_id);
    if (seen === undefined || child.created_at > seen.created_at) {
      childByParent.set(child.parent_id, child);
    }
  }

  // The parents somebody, anybody, has already replied to. A Set and not a Map, because the
  // author-agnostic read carries nothing to hold: membership IS the whole fact, and it is the
  // same membership `exists (select 1 from review_notes r where r.parent_id = n.id)` computes
  // inside portal_submit_answers before it accepts a word of what the client typed.
  const repliedParents = new Set<string>();
  for (const reply of data.replies) {
    repliedParents.add(reply.parent_id);
  }

  // The client's own suggestions per topic, already oldest-first from the query's order.
  const commentsByTopic = new Map<string, CommentRow[]>();
  for (const comment of data.comments) {
    const list = commentsByTopic.get(comment.topic_id) ?? [];
    list.push(comment);
    commentsByTopic.set(comment.topic_id, list);
  }

  // topic_rollup's fold, minus the score it also computes: last non-running status by
  // ordinal wins; no terminal line means 'running'; zero events mean 'unknown'.
  const maxIter = new Map<string, number>();
  const lastTerminal = new Map<string, string>();
  const eventCount = new Map<string, number>();
  for (const event of data.events) {
    eventCount.set(event.topic_id, (eventCount.get(event.topic_id) ?? 0) + 1);
    maxIter.set(event.topic_id, Math.max(maxIter.get(event.topic_id) ?? 0, event.iter));
    if (event.status !== "running") {
      lastTerminal.set(event.topic_id, event.status);
    }
  }

  const folds: TopicFold[] = [];
  for (const topic of data.topics) {
    const latestVersion = latest.get(topic.id);
    if (latestVersion === undefined) {
      // No committed version: nothing a client could read. Same rule as the engine's
      // blogs list, which only reports topics carrying a blog.
      continue;
    }

    // The current form: every evaluator question sharing the NEWEST note's
    // blog_version_id (notes arrive created_at.desc). Older rounds are history.
    const topicNotes = notesByTopic.get(topic.id) ?? [];
    const formVersionId = topicNotes[0]?.blog_version_id ?? null;
    const form = topicNotes
      .filter((note) => note.blog_version_id === formVersionId)
      .sort(
        (a, b) =>
          a.created_at.localeCompare(b.created_at) || (a.ref ?? "").localeCompare(b.ref ?? ""),
      );

    // The anchor, resolved to the row itself here and not at the body read, so the one place
    // that knows how the form was assembled is also the place that says which draft it is
    // about. `versionById` is built from this brand's own version read, so a miss can only
    // mean the anchored row is out of RLS scope, and the body read falls back rather than
    // inventing a version.
    const formVersion =
      formVersionId !== null ? (versionById.get(formVersionId) ?? null) : null;

    const formIter = form.find((row) => row.asked_iter !== null)?.asked_iter ?? null;
    const iterHigh = maxIter.get(topic.id) ?? 0;
    const status =
      (eventCount.get(topic.id) ?? 0) > 0
        ? (lastTerminal.get(topic.id) ?? "running")
        : "unknown";
    // stale is VERSION **OR** ITERATION, the same rule the other three twins compute: the engine's
    // questions.describe_questions, the sweep's _PENDING_SQL, and portal_submit_answers (migration
    // 014). Drift between them is not a tidiness problem, it is a deadlock: a form this fold rates
    // answerable while the RPC refuses it as stale is a client typing into a box that always
    // errors, and a form this fold rates stale while the sweep still rates it pending keeps
    // dispatching reruns nobody asked for.
    //
    // The anchor leads because it is the stronger signal. review_notes.blog_version_id is NOT NULL
    // with a composite FK to blog_versions(id, topic_id), so it names the exact draft the questions
    // are about, where an iteration is a per-topic counter that only resembles an identity.
    //
    // THE ITERATION ARM STAYS BECAUSE A RESTORE COMMITS NO NEW VERSION: the stop-mid-revise path
    // puts the artifact set back byte for byte, adding no blog_versions row, so the anchor still
    // matches while the iteration has moved past it. Version-only would offer that form.
    //
    // `latestVersion` is this topic's newest committed row (versions arrive version_no.desc), the
    // same "current version" the SQL twins select with `order by version_no desc limit 1`.
    const versionMoved = formVersionId !== null && formVersionId !== latestVersion.id;
    const stale = form.length > 0 && (versionMoved || formIter !== iterHigh);
    const answered =
      form.length > 0 && form.every((row) => childByParent.has(row.id));
    // SPENT BY ANY AUTHOR, which is the test portal_submit_answers will actually apply the
    // instant the client presses Submit, so it is the test the offer has to be made on.
    // `answered` above stays the narrower client-only fact and feeds what it always fed: the
    // submit receipt, portal visibility, and the answers rendered back as the client's own. This
    // one feeds `liveForm` alone. Two facts from one form, and conflating them is what put a
    // client in front of a box that always errored.
    // SOME, NEVER EVERY, and the word is the whole of this fact's correctness. portal_submit_answers
    // raises PORTAL:ANSWERED from `exists (select 1 from review_notes r where r.parent_id = n.id)`
    // nested inside an EXISTS over the form's questions (014:173-180), so ONE reply to ONE question
    // spends the whole form as far as the RPC is concerned. An `every` here asked a different
    // question, whether the form was FULLY answered, and the two disagree on exactly the partly
    // replied form.
    //
    // THAT FORM IS NOT HYPOTHETICAL, WHICH IS WHY THIS IS A BUG AND NOT A STYLE CHOICE. commit_topic
    // re-asks on the SAME blog_version_id with `on conflict ... do update ... where not exists
    // (select 1 from review_notes r where r.parent_id = review_notes.id)` (sync.py:606-618), so an
    // evaluator's re-ask deliberately leaves already-answered refs untouched and adds new ones
    // beside them. The engine PRODUCES partly replied current forms by design. Under `every` the
    // portal read one as open, rendered the box, and the RPC refused every submit into it.
    const formSpent = form.length > 0 && form.some((row) => repliedParents.has(row.id));

    // The ledger row still supplies the title and the shipped date. It no longer gates the
    // released states: mark_sent refuses a topic that is not done, so a send stamp already
    // implies the ledger entry the old test read, and where the two disagree the stamp is the
    // act an operator actually performed while the row is bookkeeping about it.
    const entry = ledger.get(topic.slug) ?? null;
    const shippedVersion =
      topic.shipped_version_id !== null
        ? (versionById.get(topic.shipped_version_id) ?? null)
        : null;
    const sentVersion =
      topic.sent_version_id !== null
        ? (versionById.get(topic.sent_version_id) ?? null)
        : null;

    // A live form is the only thing that makes a needs_review hold answerable: current (matching
    // the newest iteration and the newest version), on disk, and NOBODY has replied to it yet,
    // client or operator. That is the engine's own definition of the status, restated against the
    // mirror, and the author-agnostic half of it is exactly what the RPC enforces on the submit
    // this offer leads to. Reading `answered` here instead offered the form to a client whose
    // operator had already answered it, and every submit came back PORTAL:ANSWERED.
    const liveForm = form.length > 0 && !stale && !formSpent;
    const spentHold = status === "needs_review" && !liveForm;
    // THE SPENT HOLD SPLITS IN TWO, and only one half is still a fake. `answered` is a real
    // state, so it goes to blogState as a fact and the status is left alone. What is left here
    // is a mirror asserting a question that does not exist for the CLIENT to answer, and it now
    // covers three cases rather than two: no form on disk, a form the anchor or the iteration has
    // moved past, and a form the OPERATOR has already answered. Repairing all three to `running`
    // is the same repair this file has always made, and it must survive, because the alternative
    // is `has_questions` and `has_questions` is a promise that the aside beside the article can
    // be answered.
    //
    // THE OPERATOR CASE IS THE MOST HONEST OF THE THREE, not the most strained. An operator
    // answering the form dispatched a surgical revise at submit time, so a run genuinely is what
    // this blog is waiting on and `generating` is the true word for it. Note what this arm does
    // NOT do here: it widens visibility by nothing at all, because before this fix that same row
    // was visible anyway, as `has_questions`, with a form under it that could not be submitted.
    const unansweredSpentHold = spentHold && !answered;

    // Open suggestions the team still owes an answer on. `failed` is deliberately not counted:
    // an apply that broke is the team's retry, never a request the client is still waiting on,
    // and the client is never told it happened at all.
    const openSuggestions = (commentsByTopic.get(topic.id) ?? []).filter(
      (comment) => comment.state === "open" || comment.state === "applying",
    );

    const askedAt = form.reduce<string | null>(
      (min, row) => (min === null || row.created_at < min ? row.created_at : min),
      null,
    );
    // COMPUTED ABOVE THE STATE NOW, because it is an INPUT to it rather than a decoration on it.
    // `answered` is still the derive input, and this is that same boolean carrying its date: the
    // reduce cannot return null while `answered` is true, since `answered` is exactly "every row
    // of the form has a reply" and every reply carries a created_at. blogState reads the field
    // truthily, so the two can never disagree about whether a submit happened.
    const answeredAt = answered
      ? form.reduce<string | null>((max, row) => {
          const child = childByParent.get(row.id);
          if (child === undefined) {
            return max;
          }
          return max === null || child.created_at > max ? child.created_at : max;
        }, null)
      : null;

    // THE ONE PLACE A STATE IS DECIDED. Everything above this line is a fact; everything
    // below reads the answer. The submit is now one of those facts rather than a rewrite of a
    // different one, and the status repair that remains is narrowed to the case the new state
    // does not reach, for the reason set out at the top of this file.
    const state = blogState({
      status: unansweredSpentHold ? "running" : status,
      answers_submitted: answeredAt,
      sent_to_client: topic.sent_to_client_at,
      client_approved: topic.client_approved_at,
      changes_requested: openSuggestions.length,
      published: topic.published_at,
    });

    // clientCanSee decides this, with the TWO arms documented at the top of the file.
    //
    // NEITHER ARM IS THE OLD ANSWERED WINDOW ANY MORE: clientCanSee admits `answers_submitted`
    // itself, so the ordinary case between a Submit and a send is covered by the machine. What
    // is left is the pair of slivers where the record honestly reads `generating` and the client
    // still acted. `answered` catches a rerun that is LIVE, which blogState deliberately ranks
    // above the submit because the rerun is the thing the submit waits for. `unansweredSpentHold`
    // catches the repaired mirror above. Removing either would drop a row the client is standing
    // on, and portal_submit_answers freezes the blog on submit, so the page they are on 404s.
    const visible = clientCanSee(state) || unansweredSpentHold || answered;

    folds.push({
      topic,
      latest: latestVersion,
      shippedVersion,
      sentVersion,
      ledger: entry,
      comments: commentsByTopic.get(topic.id) ?? [],
      form,
      formVersion,
      childByParent,
      formIter,
      maxIter: iterHigh,
      status,
      stale,
      answered,
      state,
      visible,
      title: entry?.topic || latestVersion.h1_title || topic.title || topic.slug,
      askedAt,
      answeredAt,
      suggestedAt: openSuggestions.reduce<string | null>(
        (max, comment) => (max === null || comment.created_at > max ? comment.created_at : max),
        null,
      ),
    });
  }
  return folds;
}

function cardOf(
  fold: TopicFold,
  brand: { slug: string; name: string },
  org: string,
): PortalBlogCard | null {
  if (!fold.visible) {
    return null;
  }
  const released = clientReadsArticle(fold.state);
  const shippedDate =
    fold.ledger?.generated_at ||
    fold.shippedVersion?.committed_at ||
    fold.latest.committed_at;
  // Every state carries the stamp of the act that created it, so a push, an approval, a
  // suggestion or a re-send is new activity and floats the card in the newest-first sort
  // exactly when the client last needed to look at it. The shipped-date fallbacks are for
  // legacy stamps only, and published_at falls back through the ladder beneath it because
  // migration 012 has no backfill: a legacy push left no stamp to read.
  //
  // `answers_submitted` GETS NO ARM OF ITS OWN, and that is a decision rather than a gap: the
  // act that created it is the submit, and the trailing arm already reads `answeredAt` first.
  // Writing the arm out would be the same expression one indent higher, so the ladder would
  // gain a branch that can only ever agree with the one below it. The trailing arm still has to
  // stand for the two `generating` slivers as well, where answeredAt is null for a spent hold
  // nobody answered and askedAt is the honest date.
  const date =
    fold.state === "published"
      ? (fold.topic.published_at ?? fold.topic.client_approved_at ?? shippedDate)
      : fold.state === "approved"
        ? (fold.topic.client_approved_at ?? shippedDate)
        : fold.state === "changes_requested"
          ? (fold.suggestedAt ?? fold.topic.sent_to_client_at ?? shippedDate)
          : fold.state === "client_review"
            ? (fold.topic.sent_to_client_at ?? shippedDate)
            : fold.state === "has_questions"
              ? (fold.askedAt ?? fold.latest.committed_at)
              : (fold.answeredAt ?? fold.askedAt ?? fold.latest.committed_at);
  return {
    org,
    brand: brand.slug,
    brand_name: brand.name,
    topic_slug: fold.topic.slug,
    title: fold.title,
    // The narrowed state, because this object IS the wire. Every field around it is computed
    // from `fold.state`, the real one, and only what leaves gets the client's vocabulary.
    state: clientWireState(fold.state),
    date,
    // THE OPEN FORM'S SIZE, so it stays null once the form is answered. ActionCard is the only
    // card that renders it and its sentence is "N questions from our editorial review", which is
    // a demand; an answered form makes no demand, and its card is a FrozenRow that reads the
    // `answered` flag below instead.
    question_count: fold.state === "has_questions" ? fold.form.length : null,
    word_count: released
      ? ((fold.sentVersion ?? fold.shippedVersion ?? fold.latest).word_count ?? null)
      : null,
    // KEYED OFF clientReadsArticle, NOT clientCanSee, and the swap is a correctness fix rather
    // than a tidy. This flag means "the client's answers are recorded", and it used to be able to
    // say so only in the states a client could not see, because those were the only states a
    // submit could produce. `answers_submitted` is a state a client CAN see, so the old test
    // silently answered false in the one place the flag exists to be true: FrozenRow would have
    // dropped its tick and its "answers received" sentence exactly when the answers had just
    // arrived. clientReadsArticle is the honest line, because it is a send that ends this
    // window: before one, an answered form is news; after one, the article itself is the news.
    answered: !clientReadsArticle(fold.state) && fold.answered,
    sent: released ? fold.topic.sent_to_client_at : null,
    approved:
      fold.state === "approved" || fold.state === "published"
        ? fold.topic.client_approved_at
        : null,
  };
}

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

export type Overview = {
  orgs: PortalOrg[];
  blogs: PortalBlogCard[];
};

export async function buildOverview(token: string, userId: string): Promise<Overview> {
  const orgs = await orgsForUser(token, userId);
  // Keep each brand's org slug alongside it: the flat list loses the org otherwise, and a
  // card needs its org to link to /{org}/{brand}/... without a second lookup.
  const brands = orgs.flatMap((org) => org.brands.map((brand) => ({ ...brand, org: org.slug })));

  // client ids come from the membership view the org list was built from; re-read keyed
  // by slug so the two cannot disagree mid-request.
  const idRows =
    brands.length > 0
      ? await pg<{ client_id: string; client_slug: string }[]>(
          token,
          `org_membership?select=client_id,client_slug&client_slug=${inList(brands.map((brand) => brand.slug))}`,
        )
      : [];
  const idBySlug = new Map(idRows.map((row) => [row.client_slug, row.client_id]));

  const perBrand = await Promise.all(
    brands.map(async (brand) => {
      const clientId = idBySlug.get(brand.slug);
      if (clientId === undefined) {
        return [];
      }
      const folds = foldTopics(await fetchBrand(token, clientId));
      return folds
        .map((fold) => cardOf(fold, brand, brand.org))
        .filter((card): card is PortalBlogCard => card !== null);
    }),
  );

  const blogs = perBrand.flat();
  // One stable order the home page re-buckets from: newest activity first.
  blogs.sort((a, b) => byteCompare(b.date, a.date));
  return { orgs, blogs };
}

// ---------------------------------------------------------------------------
// Roadmap: the content plan, read-only
// ---------------------------------------------------------------------------

export type PortalRoadmapRow = {
  index: number;
  topic: string;
  covers: string;
  prompts: string[];
  /** Extra planning columns under their own sheet headers (Format, Search Intent, ...). */
  extras: Record<string, string>;
  /** Delivered rows link into the library; planned rows are just the plan. */
  delivered: boolean;
  delivered_at: string | null;
  topic_slug: string | null;
};

export type PortalRoadmap = {
  brand: string;
  brand_name: string;
  rows: PortalRoadmapRow[];
};

/**
 * The brand's roadmap as a CLIENT reads it: the plan itself (topic, coverage, target
 * prompts, the sheet's own extra columns) plus which rows are already delivered. Nothing
 * operational crosses this wire: no generation report, no upload identity, no
 * completeness diagnostics, and, as everywhere on this surface, no scores. The portal has
 * no write affordance against the roadmap at all; the sheet is the team's to manage.
 */
export async function buildRoadmap(
  token: string,
  brandSlug: string,
): Promise<PortalRoadmap | null> {
  const brand = await brandRow(token, brandSlug);
  if (brand === null) {
    return null;
  }
  const [rows, ledger, sentRows] = await Promise.all([
    pg<{
      row_index: number;
      topic: string | null;
      covers: string | null;
      prompts: string[] | null;
      extras: Record<string, unknown> | null;
      topic_slug: string | null;
    }[]>(
      token,
      `roadmap_rows?select=row_index,topic,covers,prompts,extras,topic_slug` +
        `&client_id=eq.${brand.client_id}&order=row_index.asc`,
    ),
    pg<LedgerRow[]>(
      token,
      `ledger_entries?select=topic,topic_slug,generated_at&client_id=eq.${brand.client_id}`,
    ),
    // Delivered here must agree with the blog cards: shipped AND sent, never the ledger
    // alone, or the plan would announce an article the library refuses to show.
    pg<{ slug: string; sent_to_client_at: string | null }[]>(
      token,
      `topics?select=slug,sent_to_client_at&client_id=eq.${brand.client_id}&deleted_at=is.null`,
    ),
  ]);

  const sentBySlug = new Map(sentRows.map((row) => [row.slug, row.sent_to_client_at]));
  const shipped = new Map<string, LedgerRow>();
  for (const entry of ledger) {
    const slug = (entry.topic_slug || slugify(entry.topic ?? "")).trim();
    if (slug !== "" && (sentBySlug.get(slug) ?? null) !== null) {
      shipped.set(slug, entry);
    }
  }

  return {
    brand: brand.client_slug,
    brand_name: brand.client_name,
    rows: rows.map((row) => {
      const slug = row.topic_slug ?? null;
      const entry = slug !== null ? (shipped.get(slug) ?? null) : null;
      const extras: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.extras ?? {})) {
        if (value !== null && value !== undefined && String(value).trim() !== "") {
          extras[key] = String(value);
        }
      }
      return {
        index: row.row_index,
        topic: row.topic ?? "",
        covers: row.covers ?? "",
        prompts: row.prompts ?? [],
        extras,
        delivered: entry !== null,
        delivered_at: entry?.generated_at ?? null,
        topic_slug: slug,
      };
    }),
  };
}

export async function buildDetail(
  token: string,
  brandSlug: string,
  topicSlug: string,
): Promise<PortalBlogDetail | null> {
  if (!validTopicSlug(topicSlug)) {
    return null;
  }
  const brand = await brandRow(token, brandSlug);
  if (brand === null) {
    return null;
  }
  const folds = foldTopics(await fetchBrand(token, brand.client_id));
  const fold = folds.find((entry) => entry.topic.slug === topicSlug);
  if (fold === undefined || !fold.visible) {
    return null;
  }

  // Bodies are fetched per detail, never in the list: an org's whole corpus in one
  // overview response would be most of a megabyte for no screen that shows it.
  const released = clientReadsArticle(fold.state);
  let body: string | null = null;
  if (released) {
    // The SENT version's bytes, never the latest: a sent blog stays editable on the admin
    // stage page, so the latest row can be a mid-edit draft nobody released. The client
    // reviews, suggests against, and approves exactly what the send stamped
    // (topics.sent_version_id); anything else would let an approval describe an article
    // the client never saw. The fallbacks cover pre-005 sends the backfill stamped from
    // the shipped version.
    const versionId = (fold.sentVersion ?? fold.shippedVersion ?? fold.latest).id;
    const rows = await pg<{ body: string }[]>(token, `blog_versions?select=body&id=eq.${versionId}`);
    body = rows[0]?.body ?? null;
  } else if (clientReadsDraft(fold.state)) {
    // THE ANCHORED VERSION'S BYTES, NEVER THE LATEST, and this is the same rule the released
    // branch above states, applied before the send instead of after it. A client is shown the
    // draft the QUESTIONS ARE ABOUT, because that is the only draft their answers can be
    // answers to: the form quotes it, the aside tells them it is "the current draft, shown so
    // you can answer in context", and an answer written against other bytes is an answer to a
    // question nobody asked. Nothing guarantees the newest committed version is that draft. A
    // topic keeps generating while a hold stands, so a stopped or crashed revise, an engine
    // rerun, or an admin edit on the stage page can all land a newer row behind the form the
    // client is still looking at, and `fold.latest` would hand them that row silently. The
    // anchor is review_notes.blog_version_id, folded above, so the answer and the article it
    // describes stay the same article. The fallback is for an anchor RLS did not return, where
    // the latest draft is a worse answer than no answer only if it is also wrong, and here it
    // is the best remaining guess.
    //
    // IT NOW COVERS `answers_submitted` TOO, and that is the product rule this file previously
    // had to decline. The old comment below this branch said the rule needed a rendering branch
    // this file could not reach, and it was right at the time: the answered window folded to
    // `generating`, a body on `generating` is indistinguishable from the SENT article to the
    // view, and handing one over would have rendered the approve banner and the suggestion rail
    // over an article nobody released. `answers_submitted` is a state of its own, so the view
    // can branch on it, and the anchor is unchanged by the act of answering. The client keeps
    // reading the draft they answered against, and a rerun that lands a newer passing draft in
    // internal review changes nothing they see, because nothing here reads `fold.latest`.
    const versionId = (fold.formVersion ?? fold.latest).id;
    const rows = await pg<{ body: string }[]>(token, `blog_versions?select=body&id=eq.${versionId}`);
    body = rows[0]?.body ?? null;
  }
  // The two `generating` slivers still get NO body, and the reason is the one the paragraph
  // above retired for `answers_submitted`: a state the client vocabulary renders as "in
  // progress" has no rendering branch that could tell an anchored draft from a released one,
  // and portal/views.tsx reads any non-null body outside the draft states as the SENT article.
  // A live rerun is also the one moment the anchored bytes are genuinely being rewritten, so
  // the article is briefly absent from a page that keeps the client's own answers. See the
  // notes on this change.

  const card = cardOf(fold, { slug: brand.client_slug, name: brand.client_name }, brand.org_slug);
  return {
    brand: brand.client_slug,
    brand_name: brand.client_name,
    topic_slug: fold.topic.slug,
    title: fold.title,
    // Narrowed exactly as the card is, and for the same reason: the detail payload is the
    // other half of what a client can read. The blog route asks clientReadsArticle of this
    // field, and it answers no for the real state and no for `generating` alike, so the
    // narrowing cannot open a body the send never released.
    state: clientWireState(fold.state),
    date: card?.date ?? fold.latest.committed_at,
    word_count: released
      ? ((fold.sentVersion ?? fold.shippedVersion ?? fold.latest).word_count ?? null)
      : null,
    body,
    questions:
      fold.state === "has_questions"
        ? fold.form.map((row) => ({
            id: row.ref ?? "",
            area: row.area,
            question: row.body,
            why: row.why ?? "",
          }))
        : null,
    asked: fold.state === "has_questions" ? fold.askedAt : null,
    // THE SAME clientCanSee-to-clientReadsArticle SWAP the card's `answered` flag makes, and it
    // matters more here: this IS the client's own answers, and `answers_submitted` is the state
    // whose entire purpose is showing them back. Testing clientCanSee would have withheld a
    // client's answers from the client precisely because the machine had finally granted them
    // sight of the article. A send is the honest end of the window: after one, the article is
    // what the page is about and the answers that shaped it are history.
    answers:
      !clientReadsArticle(fold.state) && fold.answered
        ? fold.form.map((row) => ({
            id: row.ref ?? "",
            area: row.area,
            question: row.body,
            answer: fold.childByParent.get(row.id)?.body ?? "",
          }))
        : null,
    answered_at: !clientReadsArticle(fold.state) ? fold.answeredAt : null,
    comments: released
      ? fold.comments.map((row) => ({
          id: row.id,
          selected_text: row.selected_text,
          instruction: row.instruction,
          state: row.state,
          created: row.created_at,
        }))
      : null,
    sent: released ? fold.topic.sent_to_client_at : null,
    approved:
      fold.state === "approved" || fold.state === "published"
        ? fold.topic.client_approved_at
        : null,
  };
}
