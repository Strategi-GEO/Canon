import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { byteCompare, clientId } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

/**
 * The engine's GET /api/clients/{slug}/resources: the knowledge-base INDEX from
 * client_resources. List only: the per-file download needs a Storage signed URL, which needs
 * the secret key, and the secret key is not in this app, so hosted mode renders names and
 * sizes and nothing more.
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
    const rows = await pg<{ name: string; size_bytes: number; uploaded_at: string | null }[]>(
      user.token,
      `client_resources?select=name,size_bytes,uploaded_at&client_id=eq.${cid}`,
    );
    // The engine orders by lower(name) collate "C"; sorting the lowercased names by byte
    // order here reproduces it, underscores before letters included.
    const resources = rows
      .slice()
      .sort((a, b) => byteCompare(a.name.toLowerCase(), b.name.toLowerCase()))
      .map((row) => ({
        name: row.name,
        size: row.size_bytes,
        modified: row.uploaded_at ?? "",
      }));
    return json({ resources });
  } catch (cause) {
    return failure(cause);
  }
}
