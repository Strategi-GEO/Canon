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
 * THE FIVE FACTS, and where each comes from:
 *   status            the run feed's last terminal line, folded below, with ONE correction
 *   sent_to_client    topics.sent_to_client_at, the admin-review exit
 *   client_approved   topics.client_approved_at, the client's sign-off on exactly these bytes
 *   changes_requested top-level client suggestions still open or mid-apply
 *   published         topics.published_at, granted to authenticated by migration 012
 *
 * THE ONE CORRECTION, AND WHY IT IS A FACT RATHER THAN A STATE. The engine defines
 * needs_review as "questions that are current, on disk and answerable", and runner.py corrects
 * a hold whose form is absent, stale or already answered back to done or failed. blogState is
 * therefore right that the status IS the question signal and needs no second questions read.
 * What this file reads is a MIRROR of the run feed, and the mirror carries that correction only
 * once the answer-driven revise writes its own terminal line: between a client pressing Submit
 * and that line landing, the feed still says needs_review while the form is spent. So the
 * portal repairs the SIGNAL, reporting a spent hold as `running`, which is what the record is
 * actually doing. It does not invent a state beside blogState's, because a second state is
 * exactly what this refactor deleted.
 *
 * VISIBILITY IS clientCanSee, PLUS ONE ADDITION THIS FILE OWNS: AN ARTICLE THE CLIENT ANSWERED
 * STAYS VISIBLE WHILE THE TEAM WORKS. A spent hold folds to `generating` and the revise that
 * follows it lands on `internal_review`, `failed` or nothing readable, and clientCanSee refuses
 * all four. Refusing them here would make the article vanish out from under the person who just
 * acted on it, and worse than vanish: portal_submit_answers is explicit that the portal freezes
 * the blog on submit, so the detail page they are standing on would 404 the instant they
 * answered. Such a row is shown as a calm with-the-team row until the team sends it.
 *
 * That is a VISIBILITY rule over one state and never a second state machine, which is the same
 * distinction lib/blog-state.ts draws for the labels. Note what it does NOT do: it grants no
 * act (clientCan still answers no to everything in those states), it reveals no article (no body
 * is fetched for them), and it admits no row the client never touched. What it DOES cost is one
 * narrowing at the wire, because the widened rule can hand a client's JSON a state word their
 * vocabulary was never meant to carry. See clientWireState below.
 */

/**
 * The states whose payload carries the SENT article, so the client reads and annotates exactly
 * the bytes the send stamped. Exported because the blog route needs the same answer for its
 * thread read, and two copies of this list would drift the moment one state was added.
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
 * The state as a CLIENT may RECEIVE it, applied where a payload is built and nowhere else.
 *
 * VISIBILITY IS WIDER THAN clientCanSee, SO THE WIRE NEEDS A NARROWING. The addition
 * documented at the top of this file keeps an article the client answered on their screen
 * while the team works, and that window reads `generating`, `internal_review`, `failed`,
 * `stopped` or `unknown` depending on where the answer-driven revise got to. The rendered UI
 * is already right about all five, because clientTag folds every one of them to a busy "In
 * progress". The JSON was not, and the JSON is the half a client can read in devtools: it
 * shipped the team's own words about the client's article, and it contradicted
 * portal/types.ts, which states that internal_review, failed and stopped never reach here.
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
  question_count: number | null;
  word_count: number | null;
  /** Spent holds only: true when answers are recorded (vs a generic with-the-team hold). */
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
  /** Released: the article as sent. has_questions: the draft under review. Held: absent. */
  body: string | null;
  /** has_questions only: the form to answer. */
  questions: PortalQuestion[] | null;
  asked: string | null;
  /** Spent-hold-with-answers only: what was answered, read-only. */
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
  childByParent: Map<string, ChildRow>;
  formIter: number | null;
  maxIter: number;
  status: string;
  stale: boolean;
  answered: boolean;
  state: BlogState;
  /** clientCanSee, plus the spent-hold addition documented at the top of this file. */
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
  events: EventRow[];
  comments: CommentRow[];
};

async function fetchBrand(token: string, clientId: string): Promise<BrandData> {
  const [topics, versions, ledger, notes, children, events, comments] = await Promise.all([
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
    // operator's internal replies. The spentHold arm still covers the genuine window where a
    // client has answered and the revise has not yet run.
    pg<ChildRow[]>(
      token,
      `review_notes?select=parent_id,body,created_at&client_id=eq.${clientId}` +
        `&parent_id=not.is.null&author=eq.client`,
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
  return { topics, versions, ledger, notes, children, events, comments };
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

    const formIter = form.find((row) => row.asked_iter !== null)?.asked_iter ?? null;
    const iterHigh = maxIter.get(topic.id) ?? 0;
    const status =
      (eventCount.get(topic.id) ?? 0) > 0
        ? (lastTerminal.get(topic.id) ?? "running")
        : "unknown";
    const stale = form.length > 0 && formIter !== iterHigh;
    const answered =
      form.length > 0 && form.every((row) => childByParent.has(row.id));

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

    // A live form is the only thing that makes a needs_review hold answerable: current
    // (matching the newest iteration), on disk, and nobody has replied to it yet. That is the
    // engine's own definition of the status, restated against the mirror.
    const liveForm = form.length > 0 && !stale && !answered;
    const spentHold = status === "needs_review" && !liveForm;

    // Open suggestions the team still owes an answer on. `failed` is deliberately not counted:
    // an apply that broke is the team's retry, never a request the client is still waiting on,
    // and the client is never told it happened at all.
    const openSuggestions = (commentsByTopic.get(topic.id) ?? []).filter(
      (comment) => comment.state === "open" || comment.state === "applying",
    );

    // THE ONE PLACE A STATE IS DECIDED. Everything above this line is a fact; everything
    // below reads the answer. `spentHold` corrects the status rather than branching around it,
    // for the reason set out at the top of this file.
    const state = blogState({
      status: spentHold ? "running" : status,
      sent_to_client: topic.sent_to_client_at,
      client_approved: topic.client_approved_at,
      changes_requested: openSuggestions.length,
      published: topic.published_at,
    });

    // clientCanSee decides this, with the ONE addition documented at the top of the file.
    //
    // The addition has two arms and they cover the same window from both ends. `spentHold` is
    // the mirror still reading needs_review while the answer-driven revise runs. `answered` is
    // that same form once the revise has landed, whatever it landed as: the run status is then
    // done, or failed, or nothing readable, and none of those is a state a client may see. In
    // both arms the client ANSWERED, and an article they acted on must not disappear out from
    // under them. It stays a calm with-the-team row until the team sends it.
    const visible = clientCanSee(state) || spentHold || answered;

    const askedAt = form.reduce<string | null>(
      (min, row) => (min === null || row.created_at < min ? row.created_at : min),
      null,
    );
    const answeredAt = answered
      ? form.reduce<string | null>((max, row) => {
          const child = childByParent.get(row.id);
          if (child === undefined) {
            return max;
          }
          return max === null || child.created_at > max ? child.created_at : max;
        }, null)
      : null;

    folds.push({
      topic,
      latest: latestVersion,
      shippedVersion,
      sentVersion,
      ledger: entry,
      comments: commentsByTopic.get(topic.id) ?? [],
      form,
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
    question_count: fold.state === "has_questions" ? fold.form.length : null,
    word_count: released
      ? ((fold.sentVersion ?? fold.shippedVersion ?? fold.latest).word_count ?? null)
      : null,
    // !clientCanSee is exactly "on this wire only because the client acted on it", since every
    // other such row was dropped above. The flag then splits the two with-the-team rows: one
    // where the client's answers are recorded and being applied, and one where the hold simply
    // carries nothing they can act on.
    answered: !clientCanSee(fold.state) && fold.answered,
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
  } else if (fold.state === "has_questions") {
    const rows = await pg<{ body: string }[]>(
      token,
      `blog_versions?select=body&id=eq.${fold.latest.id}`,
    );
    body = rows[0]?.body ?? null;
  }
  // A spent hold gets no body on purpose. The draft is mid-revision; showing yesterday's bytes
  // as though they were the article would be showing something nobody will publish.

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
    answers:
      !clientCanSee(fold.state) && fold.answered
        ? fold.form.map((row) => ({
            id: row.ref ?? "",
            area: row.area,
            question: row.body,
            answer: fold.childByParent.get(row.id)?.body ?? "",
          }))
        : null,
    answered_at: !clientCanSee(fold.state) ? fold.answeredAt : null,
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
