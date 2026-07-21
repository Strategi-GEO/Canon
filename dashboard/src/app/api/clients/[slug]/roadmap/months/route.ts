import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

type SheetRow = {
  id: string;
  month: number;
  filename: string;
  modified: string | null;
  created_at: string;
};

/**
 * The engine's GET /api/clients/{slug}/roadmap/months: one entry per month, oldest first, for
 * the roadmap tab's month list. Mirrors roadmap.list_months. An empty list is the normal empty
 * state (a brand with no roadmap yet), never a 404: the tab renders "Add New Month Roadmap" over
 * it.
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
    const [sheets, rows] = await Promise.all([
      pg<SheetRow[]>(
        user.token,
        `roadmap_sheets?select=id,month,filename,modified,created_at&client_id=eq.${cid}&order=month.asc`,
      ),
      // row_count comes from roadmap_rows so it agrees with the brief reader, not the raw preview
      // (which may hold a blank trailing row), exactly as list_months counts it. No PostgREST
      // embed count is used elsewhere in this app; tally in JS, the totals are tiny.
      pg<{ sheet_id: string }[]>(user.token, `roadmap_rows?select=sheet_id&client_id=eq.${cid}`),
    ]);
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.sheet_id, (counts.get(row.sheet_id) ?? 0) + 1);
    }
    const months = sheets.map((sheet) => ({
      month: sheet.month,
      label: `Month ${sheet.month} Roadmap`,
      filename: sheet.filename,
      // coalesce(modified, created_at), as list_months / _fetch_sheet reads it.
      modified: new Date(sheet.modified ?? sheet.created_at).toISOString(),
      row_count: counts.get(sheet.id) ?? 0,
    }));
    return json({ months });
  } catch (cause) {
    return failure(cause);
  }
}
