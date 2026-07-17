import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { readClient } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";

/**
 * One client, mirroring the engine's GET /api/clients/{slug}: the client shape without the
 * preflight decoration (which only the list carries). Out of scope answers the SAME 404 as
 * does-not-exist, which RLS gives us for free: no row either way.
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
    const client = await readClient(user.token, slug);
    if (client === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    return json(client);
  } catch (cause) {
    return failure(cause);
  }
}
