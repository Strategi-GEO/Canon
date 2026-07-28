import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { buildChannelPost } from "@/lib/server/portal-data";

/**
 * One channel post in its client-visible shape: the body plus the client's own suggestions.
 * Keyed by the source blog's slug, the same URL key the admin surface uses. A post never sent to
 * this client, or a brand out of scope, answers 404.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string; channel: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand, channel, topic } = await params;
  try {
    const post = await buildChannelPost(user.token, brand, channel, topic);
    if (post === null) {
      return detail(404, `no ${channel} post '${topic}' for '${brand}'`);
    }
    return json(post);
  } catch (cause) {
    return failure(cause);
  }
}
