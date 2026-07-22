import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

function intOrNull(value: string | undefined): number | null {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The engine's GET /api/clients/{slug}/roadmap/report: the saved account of how this brand's
 * roadmap was generated, from roadmap_sheets.report, front matter parsed exactly as
 * roadmap_gen.read_report parses it. A 404 here is ordinary: uploaded roadmaps have no
 * report, because nothing generated them.
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
  // ?month=N reads one specific month's report; absent means the current (latest) month.
  // Malformed is a 400.
  const monthRaw = new URL(request.url).searchParams.get("month");
  if (monthRaw !== null && !/^[1-9]\d*$/.test(monthRaw)) {
    return detail(400, `month must be a positive integer, got '${monthRaw}'`);
  }
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    const sheets = await pg<{ report: string | null }[]>(
      user.token,
      // admin_roadmap_sheets: `report` is not granted to `authenticated`. See migration 008.
      `admin_roadmap_sheets?select=report&client_id=eq.${cid}&` +
        (monthRaw === null ? "order=month.desc&limit=1" : `month=eq.${monthRaw}`),
    );
    const text = sheets[0]?.report ?? null;
    if (text === null) {
      return detail(404, `no roadmap generation report for '${slug}'`);
    }

    const meta: Record<string, string> = {};
    let body = text;
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---\n", 4);
      if (end !== -1) {
        for (const line of text.slice(4, end).split("\n")) {
          const cut = line.indexOf(":");
          if (cut !== -1) {
            meta[line.slice(0, cut).trim()] = line.slice(cut + 1).trim();
          }
        }
        body = text.slice(end + 5);
      }
    }

    return json({
      content: body.trim(),
      generated: meta.generated ?? null,
      brand_url: meta.brand_url ?? null,
      piece_count: intOrNull(meta.piece_count),
      rows: intOrNull(meta.rows),
      notes: meta.notes ?? null,
    });
  } catch (cause) {
    return failure(cause);
  }
}
