import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId, ledgerStamp, liveSlugs } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

type SheetRow = { id: string; columns: string[] };

type StoredRow = {
  row_index: number;
  topic: string;
  covers: string;
  prompts: string[];
  extras: { label: string; value: string }[];
  topic_slug: string | null;
  complete: boolean;
  missing: string[];
};

/**
 * The engine's GET /api/clients/{slug}/roadmap: load_roadmap + annotate_generated, answered
 * from the record. roadmap_rows already stores exactly what roadmap._build_rows parsed
 * (indices with gaps, extras keyed by header, generated completeness), so no CSV is re-read
 * here and the two servers cannot parse one sheet differently.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    const sheets = await pg<SheetRow[]>(
      user.token,
      `roadmap_sheets?select=id,columns&client_id=eq.${cid}`,
    );
    const sheet = sheets[0];
    if (sheet === undefined) {
      return detail(404, `no roadmap sheet for client '${slug}' in roadmap_sheets`);
    }
    const [stored, shipped] = await Promise.all([
      pg<StoredRow[]>(
        user.token,
        `roadmap_rows?select=row_index,topic,covers,prompts,extras,topic_slug,complete,missing` +
          `&sheet_id=eq.${sheet.id}&order=row_index.asc`,
      ),
      // live_slugs, not the raw ledger: a blog deleted from the record is gone, so its row
      // must not come back red and unselectable. Same rule as roadmap.annotate_generated.
      liveSlugs(user.token, cid),
    ]);
    const rows = stored.map((row) => {
      const entry = row.topic_slug !== null ? shipped.get(row.topic_slug) : undefined;
      return {
        index: row.row_index,
        topic: row.topic,
        covers: row.covers,
        prompts: row.prompts,
        topic_slug: row.topic_slug ?? "",
        complete: row.complete,
        missing: row.missing,
        extras: row.extras,
        already_generated: entry !== undefined,
        ledger: entry === undefined ? null : ledgerStamp(entry),
      };
    });
    return json({ columns: sheet.columns, rows, warnings: [] });
  } catch (cause) {
    return failure(cause);
  }
}
