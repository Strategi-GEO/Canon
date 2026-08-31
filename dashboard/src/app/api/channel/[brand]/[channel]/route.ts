import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { buildChannelPosts } from "@/lib/server/portal-data";

/**
 * A brand's channel posts (any of LinkedIn, Medium, Bluesky, X), grouped ready-to-post vs
 * posted. Out-of-scope
 * and nonexistent answer the same 404, so it cannot be an existence oracle for another org.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string; channel: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand, channel } = await params;
  try {
    const list = await buildChannelPosts(user.token, brand, channel);
    if (list === null) {
      return detail(404, `no ${channel} posts for '${brand}'`);
    }
    return json(list);
  } catch (cause) {
    return failure(cause);
  }
}
