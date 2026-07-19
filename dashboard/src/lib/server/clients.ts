import { pg } from "@/lib/server/postgrest";

/**
 * The client and org shapes, mirrored from server/clients.py so the hosted handlers answer
 * byte-compatible JSON. Every rule here names the engine function it copies; when the engine
 * changes, this file is the whole surface to re-check.
 */

// Mirrors _CLIENT_SLUG_RE in server/app.py (the client_slug domain, underscore fixtures
// included). A guard in front of every lookup, so a smuggled path segment 404s before any
// query is built.
const CLIENT_SLUG_RE = /^_?[a-z0-9]+(-[a-z0-9]+)*$/;

// Mirrors roadmap.slugify's fixed point: a valid topic slug is one slugify leaves unchanged.
const TOPIC_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The engine's ONE preflight refusal, verbatim from server/app.py _PREFLIGHT_PLACEHOLDER_REASON. */
export const PREFLIGHT_PLACEHOLDER_REASON =
  "canonical-facts.md still contains the token PLACEHOLDER and has not been reviewed";

export function validClientSlug(slug: string): boolean {
  return CLIENT_SLUG_RE.test(slug);
}

export function validTopicSlug(slug: string): boolean {
  return TOPIC_SLUG_RE.test(slug);
}

/** roadmap.slugify, verbatim: lowercase, runs of non-alphanumerics to one hyphen, trimmed. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Byte-order string sort, reproducing Postgres collate "C" for the ASCII slugs this app has. */
export function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type Organisation = { slug: string; name: string };

export type ClientShape = {
  slug: string;
  name: string;
  organisation: Organisation;
  domain: string;
  industry: string;
  description: string;
  demo_mode: boolean;
  has_roadmap: boolean;
  has_canonical_facts: boolean;
  resource_count: number;
  blog_count: number;
  created: string;
};

export type OrgShape = { slug: string; name: string; brands: ClientShape[] };

type ClientRow = {
  id: string;
  slug: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  description: string | null;
  demo_mode: boolean;
  created_at: string | null;
  preflight_ok: boolean;
  org: { slug: string; name: string } | null;
};

const CLIENT_SELECT =
  "id,slug,name,domain,industry,description,demo_mode,created_at,preflight_ok,org:orgs(slug,name)";

/** server/clients.py _client_from_row, translated field for field. */
function shapeClient(
  row: ClientRow,
  flags: { hasRoadmap: boolean; hasFacts: boolean; resources: number; blogs: number },
): ClientShape {
  const name = row.name || row.slug;
  return {
    slug: row.slug,
    name,
    // An explicit org comes from the orgs join; a client with org_id null is its own
    // single-brand org, synthesised on read and never stored, exactly as the engine does it.
    organisation: row.org ? { slug: row.org.slug, name: row.org.name } : { slug: row.slug, name },
    domain: row.domain || "",
    industry: row.industry || "",
    description: row.description || "",
    demo_mode: Boolean(row.demo_mode),
    has_roadmap: flags.hasRoadmap,
    has_canonical_facts: flags.hasFacts,
    resource_count: flags.resources,
    blog_count: flags.blogs,
    created: row.created_at ?? "",
  };
}

function countBy(rows: { client_id: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.client_id, (counts.get(row.client_id) ?? 0) + 1);
  }
  return counts;
}

export type ListedClient = { shape: ClientShape; preflightOk: boolean };

/**
 * Every live client the CALLER can read, RLS-scoped, in the exact shape and slug byte order
 * clients.list_clients returns. The derived flags come from four cheap side reads instead of
 * the engine's correlated subqueries, because PostgREST cannot express those in one select.
 */
export async function listClients(token: string): Promise<ListedClient[]> {
  const [rows, factRows, sheetRows, resourceRows, liveTopics, versionRows] = await Promise.all([
    pg<ClientRow[]>(token, `clients?select=${CLIENT_SELECT}&deleted_at=is.null`),
    // has_canonical_facts without pulling every fact base over the wire: just the slugs whose
    // canonical_facts is non-null. This is the same "is not null" the engine computes.
    //
    // admin_clients, NOT clients, and the difference is the whole reason this route used to
    // 502. Postgres requires SELECT on any column a query FILTERS by, migration 003 revoked
    // canonical_facts from `authenticated` because it is the do-not-claim fact base, so this
    // probe against the base table is refused for every caller who is not the table owner.
    // The admin view carries the full column set behind auth_is_admin(); listClients is only
    // ever called on the is_admin branch of /api/me, so an admin gets the real answer and
    // nobody else can reach the view at all.
    pg<{ slug: string }[]>(
      token,
      "admin_clients?select=slug&deleted_at=is.null&canonical_facts=not.is.null",
    ),
    pg<{ client_id: string }[]>(token, "roadmap_sheets?select=client_id"),
    pg<{ client_id: string }[]>(token, "client_resources?select=client_id"),
    // blog_count counts LIVE topics carrying at least one committed version, which is what
    // topics_live.has_blog derives. That view is revoked from `authenticated` outright (it
    // re-exposes topics.dossier and topics.review_note), so the count is assembled from the
    // two reads it was doing internally: live topics, and the topics that have a version.
    // Both columns used here are granted, so this half needs no admin view.
    pg<{ id: string; client_id: string }[]>(token, "topics?select=id,client_id&deleted_at=is.null"),
    pg<{ topic_id: string }[]>(token, "blog_versions?select=topic_id"),
  ]);

  const hasFacts = new Set(factRows.map((row) => row.slug));
  const hasSheet = new Set(sheetRows.map((row) => row.client_id));
  const resources = countBy(resourceRows);
  const withVersion = new Set(versionRows.map((row) => row.topic_id));
  const blogs = countBy(liveTopics.filter((topic) => withVersion.has(topic.id)));

  return rows
    .slice()
    .sort((a, b) => byteCompare(a.slug, b.slug))
    .map((row) => ({
      shape: shapeClient(row, {
        hasRoadmap: hasSheet.has(row.id),
        hasFacts: hasFacts.has(row.slug),
        resources: resources.get(row.id) ?? 0,
        blogs: blogs.get(row.id) ?? 0,
      }),
      preflightOk: Boolean(row.preflight_ok),
    }));
}

/** One client in the same shape, or null when RLS yields no row (unknown OR out of scope). */
export async function readClient(token: string, slug: string): Promise<ClientShape | null> {
  if (!validClientSlug(slug)) {
    return null;
  }
  const rows = await pg<ClientRow[]>(
    token,
    `clients?select=${CLIENT_SELECT}&slug=eq.${slug}&deleted_at=is.null`,
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const [factRows, sheetRows, resourceRows, blogRows] = await Promise.all([
    pg<{ slug: string }[]>(
      token,
      // admin_clients, for the reason listClients gives: canonical_facts is revoked, and a
      // query is refused for FILTERING on a column it may not read, not only for selecting it.
      `admin_clients?select=slug&slug=eq.${slug}&deleted_at=is.null&canonical_facts=not.is.null`,
    ),
    pg<{ client_id: string }[]>(token, `roadmap_sheets?select=client_id&client_id=eq.${row.id}`),
    pg<{ client_id: string }[]>(token, `client_resources?select=client_id&client_id=eq.${row.id}`),
    pg<{ client_id: string }[]>(
      token,
      `admin_topics_live?select=client_id&client_id=eq.${row.id}&has_blog=is.true`,
    ),
  ]);
  return shapeClient(row, {
    hasRoadmap: sheetRows.length > 0,
    hasFacts: factRows.length > 0,
    resources: resourceRows.length,
    blogs: blogRows.length,
  });
}

/** The client's row id, or null. The record-backed twin of db.client_id for these handlers. */
export async function clientId(token: string, slug: string): Promise<string | null> {
  if (!validClientSlug(slug)) {
    return null;
  }
  const rows = await pg<{ id: string }[]>(
    token,
    `clients?select=id&slug=eq.${slug}&deleted_at=is.null`,
  );
  return rows[0]?.id ?? null;
}

/**
 * clients.list_orgs, verbatim: explicit orgs from the join, a self-org for every other brand,
 * the underscore fixtures skipped, orgs sorted by lowercased name and brands likewise.
 */
export function groupOrgs(clients: ClientShape[]): OrgShape[] {
  const grouped = new Map<string, OrgShape>();
  for (const client of clients) {
    if (client.slug.startsWith("_")) {
      continue;
    }
    const org = client.organisation;
    const entry = grouped.get(org.slug) ?? { slug: org.slug, name: org.name, brands: [] };
    entry.brands.push(client);
    grouped.set(org.slug, entry);
  }
  const orgs = [...grouped.values()].sort((a, b) =>
    byteCompare(a.name.toLowerCase(), b.name.toLowerCase()),
  );
  for (const org of orgs) {
    org.brands.sort((a, b) => byteCompare(a.name.toLowerCase(), b.name.toLowerCase()));
  }
  return orgs;
}

// ---------------------------------------------------------------------------
// Ledger reads, mirroring server/ledger.py: every field a STRING, exactly as the CSV-era
// ledger produced, because the callers' int(score) try/excepts rely on it.
// ---------------------------------------------------------------------------

export type LedgerRow = {
  topic: string;
  topic_slug: string;
  covers: string;
  prompts: string;
  score: string;
  generated_at: string;
  run_id: string;
};

type LedgerRecord = {
  topic: string | null;
  topic_slug: string | null;
  covers: string | null;
  prompts: string[] | null;
  score: number | null;
  generated_at: string | null;
  run_id: string | null;
};

function shapeLedger(record: LedgerRecord): LedgerRow {
  return {
    topic: record.topic ?? "",
    topic_slug: record.topic_slug ?? "",
    covers: record.covers ?? "",
    // The DB column is text[]; the CSV stored one newline-joined cell. Join on read.
    prompts: (record.prompts ?? []).join("\n"),
    score: record.score === null ? "" : String(record.score),
    generated_at: record.generated_at ?? "",
    run_id: record.run_id ?? "",
  };
}

/** ledger.read_ledger: every row, oldest first. */
export async function readLedger(token: string, cid: string): Promise<LedgerRow[]> {
  const records = await pg<LedgerRecord[]>(
    token,
    // admin_ledger_entries: the ledger's score column is revoked from `authenticated`.
    `admin_ledger_entries?select=topic,topic_slug,covers,prompts,score,generated_at,run_id` +
      `&client_id=eq.${cid}&order=generated_at.asc`,
  );
  return records.map(shapeLedger);
}

/** ledger._keyed: slug -> row, last write wins, empty slugs dropped. */
function keyed(rows: LedgerRow[]): Map<string, LedgerRow> {
  const entries = new Map<string, LedgerRow>();
  for (const row of rows) {
    const slug = (row.topic_slug || slugify(row.topic)).trim();
    if (slug !== "") {
      entries.set(slug, row);
    }
  }
  return entries;
}

/** ledger.ledger_slugs: the raw ledger keyed by slug, deleted blogs included. */
export async function ledgerSlugs(token: string, cid: string): Promise<Map<string, LedgerRow>> {
  return keyed(await readLedger(token, cid));
}

/**
 * ledger.live_slugs: only entries whose topic still exists in the record with at least one
 * blog version, which is what unblocks a roadmap row for regeneration.
 */
export async function liveSlugs(token: string, cid: string): Promise<Map<string, LedgerRow>> {
  const [rows, liveTopics] = await Promise.all([
    readLedger(token, cid),
    pg<{ slug: string }[]>(token, `admin_topics_live?select=slug&client_id=eq.${cid}&has_blog=is.true`),
  ]);
  const live = new Set(liveTopics.map((topic) => topic.slug));
  return keyed(rows.filter((row) => live.has(row.topic_slug)));
}

/** roadmap.annotate_generated's per-row ledger stamp: score int or null, generated_at string. */
export function ledgerStamp(entry: LedgerRow): { score: number | null; generated_at: string } {
  const parsed = Number.parseInt(entry.score, 10);
  return {
    score: Number.isNaN(parsed) ? null : parsed,
    generated_at: entry.generated_at ?? "",
  };
}
