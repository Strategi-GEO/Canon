import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { groupOrgs, listClients } from "@/lib/server/clients";
import { failure, json } from "@/lib/server/http";

/**
 * The engine's GET /api/orgs: the grouping over brands, derived exactly as
 * server/clients.py list_orgs derives it (explicit org from the join, self-org fallback,
 * fixtures skipped). RLS scopes the underlying client list, so orgs with no visible brand
 * vanish whole, which is what the engine's _scoped_orgs does.
 */
export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  try {
    const listed = await listClients(user.token);
    return json({ geo_mock: false, orgs: groupOrgs(listed.map((entry) => entry.shape)) });
  } catch (cause) {
    return failure(cause);
  }
}
