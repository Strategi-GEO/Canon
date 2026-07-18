import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { buildDetail } from "@/lib/server/portal-data";

/**
 * One blog, in its client-visible shape for its current state. Out-of-scope and
 * nonexistent answer the same 404: a 404 that differed by scope would be an existence
 * oracle for other orgs' work.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand, topic } = await params;
  try {
    const blog = await buildDetail(user.token, brand, topic);
    if (blog === null) {
      return detail(404, `no blog '${topic}' for '${brand}'`);
    }
    return json(blog);
  } catch (cause) {
    return failure(cause);
  }
}
