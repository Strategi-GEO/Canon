import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { groupOrgs, listClients } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";

/**
 * One org, resolved against the RLS-scoped grouping, so an org outside a non-admin's grants
 * answers the same 404 as one that does not exist, exactly as the engine's api_org.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ org: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { org } = await params;
  try {
    const listed = await listClients(user.token);
    const found = groupOrgs(listed.map((entry) => entry.shape)).find(
      (candidate) => candidate.slug === org,
    );
    if (found === undefined) {
      return detail(404, `unknown organisation '${org}'`);
    }
    return json(found);
  } catch (cause) {
    return failure(cause);
  }
}
