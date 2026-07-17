import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId } from "@/lib/server/clients";
import { parseCsv } from "@/lib/server/csv";
import { detail, failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

type SheetRow = {
  filename: string;
  raw_csv: string;
  modified: string | null;
  created_at: string;
};

/**
 * The engine's GET /api/clients/{slug}/roadmap/sheet: the raw CSV as a rectangle for the
 * preview, every column intact, header and rows padded to the sheet's width, exactly as
 * roadmap.read_sheet builds it.
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
      `roadmap_sheets?select=filename,raw_csv,modified,created_at&client_id=eq.${cid}`,
    );
    const sheet = sheets[0];
    if (sheet === undefined) {
      return detail(404, `no roadmap sheet for client '${slug}' in roadmap_sheets`);
    }

    const rawRows = parseCsv(sheet.raw_csv);
    const width = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
    const padded = rawRows.map((row) => [...row, ...Array(width - row.length).fill("")]);

    return json({
      filename: sheet.filename,
      // coalesce(modified, created_at), as the engine's _fetch_sheet reads it.
      modified: new Date(sheet.modified ?? sheet.created_at).toISOString(),
      bytes: Buffer.byteLength(sheet.raw_csv, "utf-8"),
      columns: padded[0] ?? [],
      rows: padded.slice(1),
    });
  } catch (cause) {
    return failure(cause);
  }
}
