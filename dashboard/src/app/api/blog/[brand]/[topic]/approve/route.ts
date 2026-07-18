import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The client's sign-off: stamp the article they read approved.
 *
 * All authority lives in the database function portal_approve_blog
 * (supabase/migrations/005_client_review.sql): it verifies the caller's role and brand
 * scope, that the article was actually sent, that it is not already approved, and that the
 * version named in the body is still the one on offer, then stamps the approval with the
 * caller's identity atomically. This handler only shapes HTTP: forward the caller's own
 * JWT and map the function's PORTAL:<CODE>:<detail> error protocol onto statuses. A re-send
 * clears the stamp server-side, so approving again after one is a fresh, valid act.
 *
 * THE BODY CARRIES THE VERSION THE CLIENT READ, and it is the whole of the race guard: the
 * team can re-send while somebody is halfway down the article, and an approval that named
 * no version would stamp bytes that arrived after the button was pressed. A mismatch comes
 * back as PORTAL:STALE, which is the ONE 409 this route marks for the caller (see below).
 * A legacy send that predates the version stamp carries null on both sides and matches.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  NOTSENT: 409,
  APPROVED: 409,
  STALE: 409,
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

  // A body is expected but not required to be complete: an approval with no version names
  // no version, which is exactly what a legacy send holds, and the function compares the
  // two either way.
  let body: { version?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const version =
    typeof body?.version === "string" && body.version !== "" ? body.version : null;

  try {
    await rpc<unknown>(user.token, "portal_approve_blog", {
      p_brand: brand,
      p_topic: topic,
      p_version: version,
    });
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      const message = rest.join(":");
      if (code === "STALE") {
        // Flagged as a field, not as words, because every refusal here is a 409 and the
        // portal has to tell exactly this one apart. The others mean the record already
        // moved past the button, so re-reading the page answers them silently; this one
        // means the approval did NOT land and the article on screen is not the article the
        // client was reading. That has to be said out loud, and a branch on copy text
        // would be one edit away from going quiet.
        return detail(409, { detail: message, stale: true });
      }
      return detail(STATUS_FOR[code] ?? 400, message);
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
