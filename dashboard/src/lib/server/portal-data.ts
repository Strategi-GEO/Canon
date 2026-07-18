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
 * STATE MODEL, the portal's whole vocabulary, derived and never stored:
 *   ready     -- the ledger records the blog as shipped AND an operator pressed Send to
 *                client (topics.sent_to_client_at) AND the client has not approved it yet.
 *                Shipped alone is not enough: a done blog sits in ADMIN REVIEW, editable
 *                on the dashboard's blog stage page, until the send releases it. This is
 *                the portal's acting state on a finished article: Approve and Suggest
 *                changes both live here. Open suggestions read "with the team" on the
 *                detail page, and the state STAYS ready with Approve still offered,
 *                because a suggestion is input to the team, never a lock on the client.
 *   approved  -- ready plus the client's approval stamp (topics.client_approved_at).
 *                Terminal until the team sends again: every send clears the stamp, so an
 *                approval always describes bytes the client actually reviewed, never an
 *                article that changed underneath their sign-off.
 *   action    -- the blog is held at needs_review and the CURRENT question form is
 *                unanswered and not stale: the client can and should answer.
 *   frozen    -- the blog is with the editorial team and the client cannot act:
 *                either the form was answered (answers recorded, revise owed/running),
 *                or the form went stale / the hold carries no answerable form.
 *   hidden    -- everything else (failed, stopped, unknown, first runs in flight, and a
 *                shipped blog nobody sent yet with nothing the client ever acted on).
 *                A client portal is not a run console; work the team has not finished
 *                and the client cannot act on simply is not shown.
 *
 * The old "delivered" state is GONE, split by the approval stamp into ready and approved.
 * Nothing a client used to see disappears: every topic that was delivered is sent, so it
 * folds to one of the two new states, and the article stays readable in both.
 *
 * A note on sent-with-open-questions: a handful of legacy topics shipped under the old
 * gate while carrying current unanswered questions. The send wins here, because the ledger
 * says the artifact went out; the portal never summons a client to act on an article they
 * already received. New holds never reach done, so the case is legacy-only.
 */

export type PortalState = "action" | "frozen" | "ready" | "approved";

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
  state: PortalState;
  /** The state's own date: approved date, sent date, asked date, or answered date. UTC ISO. */
  date: string;
  question_count: number | null;
  word_count: number | null;
  /** frozen only: true when answers are recorded (vs a generic with-the-team hold). */
  answered: boolean;
  /** ready and approved only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved only: when the client approved. UTC ISO. */
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
  state: PortalState;
  date: string;
  word_count: number | null;
  /** ready/approved: the article as sent. action: the current draft under review. frozen: absent. */
  body: string | null;
  /** action only: the form to answer. */
  questions: PortalQuestion[] | null;
  asked: string | null;
  /** frozen-with-answers only: what was answered, read-only. */
  answers: PortalAnswerView[] | null;
  answered_at: string | null;
  /** ready and approved only: the client's own suggestions, oldest first. */
  comments: PortalComment[] | null;
  /** ready and approved only: when the team sent the article for review. UTC ISO. */
  sent: string | null;
  /** approved only: when the client approved. UTC ISO. */
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
  state: PortalState | null;
  title: string;
  askedAt: string | null;
  answeredAt: string | null;
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
      `topics?select=id,slug,title,shipped_version_id,sent_version_id,sent_to_client_at,client_approved_at` +
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
    pg<ChildRow[]>(
      token,
      `review_notes?select=parent_id,body,created_at&client_id=eq.${clientId}&parent_id=not.is.null`,
    ),
    pgPaged<EventRow>(
      token,
      `status_events?select=topic_id,iter,line_no,status&client_id=eq.${clientId}&order=line_no.asc`,
    ),
    // The client's OWN suggestions only (author=client), safe columns only. The author's
    // email column is never selected on this surface, and neither are error or edits:
    // an apply failure and its diff are the team's material, and selecting a column the
    // portal never shows is exactly the regression tests/portal_check.py exists to catch.
    pg<CommentRow[]>(
      token,
      `blog_comments?select=id,topic_id,selected_text,instruction,state,created_at` +
        `&client_id=eq.${clientId}&author=eq.client&order=created_at.asc`,
    ),
  ]);
  return { topics, versions, ledger, notes, children, events, comments };
}

/**
 * Read EVERY row of a query, page by page. status_events grows a few dozen rows per run
 * forever, so a busy brand walks past PostgREST's max-rows cap (Supabase defaults to 1000),
 * and because the query orders line_no.asc a silent cap drops the NEWEST lines, which are
 * exactly the ones the state fold reads (max iter, last terminal status). Paging until a
 * short page is the whole fix; the other fetchBrand reads are bounded by editorial volume.
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

    const entry = ledger.get(topic.slug) ?? null;
    const shipped = entry !== null;
    const shippedVersion =
      topic.shipped_version_id !== null
        ? (versionById.get(topic.shipped_version_id) ?? null)
        : null;
    const sentVersion =
      topic.sent_version_id !== null
        ? (versionById.get(topic.sent_version_id) ?? null)
        : null;

    let state: PortalState | null = null;
    if (shipped && topic.sent_to_client_at !== null) {
      // Shipped AND released: the send stamp is the admin-review exit, pressed by an
      // operator on the blog stage page. Without it a shipped blog is still the team's,
      // so it falls through to the branches below exactly as it did before shipping: a
      // client who answered a form keeps their with-the-team row (a blog must never
      // vanish on them), and a blog they never acted on stays out of sight until it is
      // sent. Legacy delivered blogs were backfilled as sent by migration 004, so
      // nothing a client already received disappears. The approval stamp then splits the
      // released article in two: approved once the client signed off, ready until then.
      // The stamp alone decides it; open suggestions do NOT move a blog off ready,
      // because the client keeps the right to approve past their own suggestions.
      state = topic.client_approved_at !== null ? "approved" : "ready";
    } else if (form.length > 0 && !stale && !answered && status === "needs_review") {
      state = "action";
    } else if (form.length > 0 && answered) {
      // The CLIENT answered this form, so it is with the team until it ships, WHATEVER the
      // run status now reads: revise still running, or interrupted, or landed failed/stopped
      // before delivering. The status is deliberately not part of this test. A client who
      // answered must never watch their blog VANISH: dropping it (state null) would erase
      // the one action they took with no trace and no explanation. It stays a calm
      // with-the-team row until delivery replaces it.
      state = "frozen";
    } else if (status === "needs_review") {
      // Held, but with nothing the client can answer (stale form, or a hold that never
      // filed one): with the team, not with the client.
      state = "frozen";
    }

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
      title: entry?.topic || latestVersion.h1_title || topic.title || topic.slug,
      askedAt,
      answeredAt,
    });
  }
  return folds;
}

function cardOf(
  fold: TopicFold,
  brand: { slug: string; name: string },
  org: string,
): PortalBlogCard | null {
  if (fold.state === null) {
    return null;
  }
  const released = fold.state === "ready" || fold.state === "approved";
  const shippedDate =
    fold.ledger?.generated_at ||
    fold.shippedVersion?.committed_at ||
    fold.latest.committed_at;
  // ready and approved carry the stamp that created them, so a re-send or an approval is
  // new activity and floats the card in the newest-first sort exactly when the client
  // last needed to look at it. The shipped-date fallbacks are for legacy stamps only.
  const date =
    fold.state === "approved"
      ? (fold.topic.client_approved_at ?? shippedDate)
      : fold.state === "ready"
        ? (fold.topic.sent_to_client_at ?? shippedDate)
        : fold.state === "action"
          ? (fold.askedAt ?? fold.latest.committed_at)
          : (fold.answeredAt ?? fold.askedAt ?? fold.latest.committed_at);
  return {
    org,
    brand: brand.slug,
    brand_name: brand.name,
    topic_slug: fold.topic.slug,
    title: fold.title,
    state: fold.state,
    date,
    question_count: fold.state === "action" ? fold.form.length : null,
    word_count: released
      ? ((fold.sentVersion ?? fold.shippedVersion ?? fold.latest).word_count ?? null)
      : null,
    answered: fold.state === "frozen" && fold.answered,
    sent: released ? fold.topic.sent_to_client_at : null,
    approved: fold.state === "approved" ? fold.topic.client_approved_at : null,
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
  if (fold === undefined || fold.state === null) {
    return null;
  }

  // Bodies are fetched per detail, never in the list: an org's whole corpus in one
  // overview response would be most of a megabyte for no screen that shows it.
  const released = fold.state === "ready" || fold.state === "approved";
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
  } else if (fold.state === "action") {
    const rows = await pg<{ body: string }[]>(
      token,
      `blog_versions?select=body&id=eq.${fold.latest.id}`,
    );
    body = rows[0]?.body ?? null;
  }
  // frozen: no body on purpose. The draft is mid-revision; showing yesterday's bytes as
  // though they were the article would be showing something nobody will publish.

  const card = cardOf(fold, { slug: brand.client_slug, name: brand.client_name }, brand.org_slug);
  return {
    brand: brand.client_slug,
    brand_name: brand.client_name,
    topic_slug: fold.topic.slug,
    title: fold.title,
    state: fold.state,
    date: card?.date ?? fold.latest.committed_at,
    word_count: released
      ? ((fold.sentVersion ?? fold.shippedVersion ?? fold.latest).word_count ?? null)
      : null,
    body,
    questions:
      fold.state === "action"
        ? fold.form.map((row) => ({
            id: row.ref ?? "",
            area: row.area,
            question: row.body,
            why: row.why ?? "",
          }))
        : null,
    asked: fold.state === "action" ? fold.askedAt : null,
    answers:
      fold.state === "frozen" && fold.answered
        ? fold.form.map((row) => ({
            id: row.ref ?? "",
            area: row.area,
            question: row.body,
            answer: fold.childByParent.get(row.id)?.body ?? "",
          }))
        : null,
    answered_at: fold.state === "frozen" ? fold.answeredAt : null,
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
    approved: fold.state === "approved" ? fold.topic.client_approved_at : null,
  };
}
