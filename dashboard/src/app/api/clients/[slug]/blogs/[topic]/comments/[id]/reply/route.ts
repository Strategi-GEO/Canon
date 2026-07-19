import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";
import { adminRpcError } from "@/lib/server/admin-rpc";

/**
 * The operator's reply: answer one change request in its own thread.
 *
 * All authority lives in admin_reply_comment (supabase/migrations/011_admin_reply_comment.sql).
 * It verifies the caller is an admin, scopes the parent to this brand and topic, refuses a
 * reply to a reply, and inserts with the caller's own identity.
 *
 * REPLYING IS NOT RESOLVING. The parent's state is untouched, nothing is applied, and no count
 * moves, exactly as the engine's own reply route behaves. An operator answering "we cut that
 * line, it was a duplicate" is telling the client something, and turning that sentence into a
 * Claude session or a dismissal would decide the request on their behalf.
 *
 * This route exists because the stage page has always rendered a Reply control while the
 * hosted build had no route behind it: the operator typed an answer to a client and got a 404.
 * Its guards are narrower than the sibling comment routes on purpose, matching the engine: no
 * demo refusal and no done gate, because those exist to protect real API spend and a reply
 * spends none.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; topic: string; id: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, topic, id } = await params;

  let body: { body?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with the reply text is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with the reply text is required");
  }

  try {
    const replyId = await rpc<string>(user.token, "admin_reply_comment", {
      p_brand: slug,
      p_topic: topic,
      p_comment: id,
      p_body: String(body.body ?? ""),
    });
    return json({ id: replyId }, 201);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
