import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The client's sign-off on a channel post: stamp it approved. Authority lives in
 * portal_approve_channel_post (migration 032): role and brand scope, that the post was sent, and
 * that it is not already approved. There is no version to name (channel posts have no versions),
 * so there is no STALE race and the body is empty.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  NOTSENT: 409,
  APPROVED: 409,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ brand: string; channel: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand, channel, topic } = await params;

  try {
    await rpc<unknown>(user.token, "portal_approve_channel_post", {
      p_client_slug: brand,
      p_channel: channel,
      p_topic: topic,
    });
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      return detail(STATUS_FOR[code] ?? 400, rest.join(":"));
    }
    if (cause instanceof SyntaxError) {
      // portal_approve_channel_post returns void; PostgREST answers a void RPC with 204 and an
      // empty body, which the JSON parse trips over AFTER the write landed. That is success.
      return json({ approved: true });
    }
    return failure(cause);
  }
  return json({ approved: true });
}
