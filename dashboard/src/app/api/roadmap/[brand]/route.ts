import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { buildRoadmap } from "@/lib/server/portal-data";

/**
 * The brand's content roadmap, read-only. The portal has no roadmap mutation of any kind:
 * no upload, no generate, no delete. Out-of-scope and nonexistent answer the same 404.
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
    const roadmap = await buildRoadmap(user.token, brand);
    if (roadmap === null) {
      return detail(404, `unknown brand '${brand}'`);
    }
    return json(roadmap);
  } catch (cause) {
    return failure(cause);
  }
}
