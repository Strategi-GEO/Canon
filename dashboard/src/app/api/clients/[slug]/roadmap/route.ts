import { HOSTED_READONLY } from "@/lib/hosted";
import { adminRpcError } from "@/lib/server/admin-rpc";
import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId, ledgerStamp, liveSlugs } from "@/lib/server/clients";
import { detail, failure, hostedWriteRefused, json } from "@/lib/server/http";
import { pg, rpc } from "@/lib/server/postgrest";

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
  // ?month=N selects one month's sheet; absent means the CURRENT roadmap, the latest month
  // (max), which is what every reader means by "the roadmap". A malformed month is a 400, never
  // a silent fall-through to the latest.
  const monthRaw = new URL(request.url).searchParams.get("month");
  if (monthRaw !== null && !/^[1-9]\d*$/.test(monthRaw)) {
    return detail(400, `month must be a positive integer, got '${monthRaw}'`);
  }
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    const sheets = await pg<SheetRow[]>(
      user.token,
      `roadmap_sheets?select=id,columns&client_id=eq.${cid}&` +
        (monthRaw === null ? "order=month.desc&limit=1" : `month=eq.${monthRaw}`),
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

/**
 * Delete ONE month's roadmap. `?month=N` is required: a brand now holds many monthly roadmaps
 * (migration 018), so client_id alone no longer names one to remove.
 *
 * All authority lives in the database function admin_delete_roadmap
 * (redefined as (p_brand, p_month) in supabase/migrations/018_monthly_roadmaps.sql). It gates on
 * auth_is_admin() and nothing else, resolves the brand from this text slug, archives that month's
 * raw CSV and its parse report into roadmap_uploads under a timestamped name, then deletes the
 * sheet at (client_id, month) and lets the cascade take its roadmap_rows. That pair is unique, so
 * the whole thing is one atomic statement and the engine's check-then-act is closed for free: a
 * brand with no such month is the function's own NOSHEET refusal, never a silent success.
 *
 * THE DISK HALF OF THIS ACTION CANNOT CROSS, AND IT IS HANDLED IN THE ENGINE. The local
 * delete also unlinks clients/<slug>/roadmap.csv, because a stale copy left on disk gets
 * picked up by the next generation's validate step as though that session had written it,
 * resurrecting the sheet the operator just deleted. A hosted delete cannot unlink a file on
 * somebody's laptop, so the engine drops a roadmap.csv whose sheet is gone from the record and
 * the record stays authoritative.
 *
 * This handler only shapes HTTP. There is no body, it forwards the caller's own JWT, and the
 * answer is the flat acknowledgement the engine's own DELETE gives.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  // The hosted site performs no admin write, and hostedWriteRefused carries the whole reasoning.
  // HOSTED_READONLY is false in the local app, so the delete below is unchanged there. Dropping a
  // roadmap is the most destructive act on this surface and the one with the largest gap between
  // the two builds: the local engine also unlinks clients/<slug>/roadmap.csv, and nothing hosted
  // can reach that file at all.
  if (HOSTED_READONLY) {
    return hostedWriteRefused("delete this brand's roadmap");
  }

  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;
  // month is REQUIRED: a brand holds many roadmaps, so client_id alone no longer names one to
  // delete. admin_delete_roadmap takes (p_brand, p_month) since migration 018.
  const monthRaw = new URL(request.url).searchParams.get("month");
  if (monthRaw === null || !/^[1-9]\d*$/.test(monthRaw)) {
    return detail(400, "month is required to delete a roadmap");
  }

  try {
    await rpc(user.token, "admin_delete_roadmap", {
      p_brand: slug,
      p_month: Number.parseInt(monthRaw, 10),
    });
    return json({ deleted: true });
  } catch (cause) {
    return adminRpcError(cause);
  }
}
