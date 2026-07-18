import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The client's sign-off: stamp the sent article approved.
 *
 * All authority lives in the database function portal_approve_blog
 * (supabase/migrations/005_client_review.sql): it verifies the caller's role and brand
 * scope, that the article was actually sent, and that it is not already approved, then
 * stamps the approval with the caller's identity atomically. This handler only shapes
 * HTTP: no body to validate (the URL names everything), forward the caller's own JWT,
 * and map the function's PORTAL:<CODE>:<detail> error protocol onto statuses. A re-send
 * clears the stamp server-side, so approving again after one is a fresh, valid act.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  DEMO: 409,
  NOTSENT: 409,
  APPROVED: 409,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ brand: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand, topic } = await params;

  try {
    await rpc<unknown>(user.token, "portal_approve_blog", {
      p_brand: brand,
      p_topic: topic,
    });
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      return detail(STATUS_FOR[code] ?? 400, rest.join(":"));
    }
    if (cause instanceof SyntaxError) {
      // portal_approve_blog returns void, and PostgREST answers a void RPC with 204 and
      // an EMPTY body, which rpc()'s JSON parse trips over AFTER the write already
      // landed. The parse failure is therefore this route's success signal, not an
      // error; letting it fall to failure() would 500 an approval that succeeded.
      return json({ approved: true });
    }
    return failure(cause);
  }
  return json({ approved: true });
}
