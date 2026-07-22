import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { buildReports } from "@/lib/server/portal-data";

/**
 * The brand's monthly reports, as a client reads them: the SHARED snapshots only. Read-only, like
 * every portal surface. Out-of-scope and nonexistent answer the same 404; a brand with nothing
 * shared yet is a 200 whose `months` array is empty, which the view renders as "not available".
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand } = await params;
  try {
    const reports = await buildReports(user.token, brand);
    if (reports === null) {
      return detail(404, `unknown brand '${brand}'`);
    }
    return json(reports);
  } catch (cause) {
    return failure(cause);
  }
}
