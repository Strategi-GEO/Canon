import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The client's reply: one more line in an existing suggestion's thread.
 *
 * All authority lives in the database function portal_reply_comment
 * (supabase/migrations/005_client_review.sql): it verifies the caller's role and brand
 * scope, that the article was sent, that the parent is a top-level comment on THIS topic
 * rather than a reply to a reply, and the per-thread cap, then inserts the line with the
 * caller's identity. This handler only shapes HTTP: it validates the body's SHAPE (never
 * its content), forwards the caller's own JWT, and maps the function's PORTAL:<CODE>:<detail>
 * error protocol onto statuses.
 *
 * REPLYING IS NOT RESOLVING AND IS NOT WITHDRAWING. The row lands with parent_id set and
 * every count and apply path filters those out, so a client answering "thanks, that reads
 * right now" adds nothing the team has to clear before sending again. A reply that counted
 * as a change request would leave a polite thank-you blocking the next send forever.
 *
 * An unknown parent, another topic's parent, and a parent that is itself a reply all answer
 * 404 with the same words the function chose. Telling them apart would hand a caller a probe
 * for which comment ids exist and which of them are replies.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  NOTSENT: 409,
  BLANK: 422,
  LIMIT: 429,
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

  let body: { parent_id?: unknown; body?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with parent_id and body is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with parent_id and body is required");
  }
  const parent = String(body.parent_id ?? "");
  if (parent === "") {
    // The one refusal that cannot reach the function: a blank id would arrive as a null
    // uuid and come back as "no comment to reply to", which reads to a client as though
    // their own suggestion had disappeared.
    return detail(422, "a JSON body with parent_id and body is required");
  }

  try {
    const id = await rpc<string>(user.token, "portal_reply_comment", {
      p_brand: brand,
      p_topic: topic,
      p_parent: parent,
      p_body: String(body.body ?? ""),
    });
    return json({ id }, 201);
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      return detail(STATUS_FOR[code] ?? 400, rest.join(":"));
    }
    if (cause instanceof PostgrestError && cause.body?.code === "22P02") {
      // An id that is not a uuid at all never reaches the function's own gates: PostgREST
      // fails to cast the argument first. Without this arm a malformed id 502s as an
      // upstream failure, which says the portal broke when the request was simply wrong.
      return detail(404, "no comment to reply to on this article");
    }
    return failure(cause);
  }
}
