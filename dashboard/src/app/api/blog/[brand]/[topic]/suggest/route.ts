import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The client's suggestion: record one selection-anchored change request on the sent
 * article.
 *
 * All authority lives in the database function portal_suggest_change
 * (supabase/migrations/005_client_review.sql): it verifies the caller's role and brand
 * scope, that the article was sent, that the suggestion carries real text, and the
 * per-topic open-suggestion cap, then inserts the comment anchored to the SENT version
 * with the caller's identity. No Claude runs from here: the row lands state 'open' and
 * waits for the team's Resolve on the admin stage page. This handler only shapes HTTP: it
 * validates the body's SHAPE (never its content), forwards the caller's own JWT, and maps
 * the function's PORTAL:<CODE>:<detail> error protocol onto statuses.
 *
 * AN APPROVED ARTICLE IS LOCKED AND TAKES NO SUGGESTION, which reverses what this comment
 * said before migration 013 and is why LOCKED now sits in the map below. The old reasoning
 * was that a client who signed off and then spots a wrong figure must be able to say so, and
 * the team decides what that means. The team no longer can: an approval locks the article for
 * everyone, the admin included, so a suggestion filed against one is a request nobody is
 * permitted to apply, and offering it could only end in disappointing the person who made it.
 * A client who spots a real problem after approving raises it with the team, who re-open the
 * article deliberately rather than by silently editing what was signed off.
 *
 * The refusal comes from 013's blog_comments trigger rather than from portal_suggest_change
 * itself, because five write paths in two languages reach that table. The map carries exactly
 * the codes that reach this route, whoever raises them,
 * because a code listed here that nothing raises reads as a refusal this route handles when
 * it handles nothing, and one the function raises but the map lacks lands as a bare 400.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  NOTSENT: 409,
  // Raised by migration 013's blog_comments trigger, not by portal_suggest_change itself: the
  // article was approved, so it is locked and takes no new change requests from either side.
  // Listed here and NOT on the reply route, because the trigger exempts replies and the map's
  // rule above is that a code nothing raises must not appear.
  LOCKED: 409,
  BADBODY: 422,
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

  let body: {
    selected_text?: unknown;
    context_before?: unknown;
    context_after?: unknown;
    instruction?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with selected_text and instruction is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with selected_text and instruction is required");
  }

  try {
    // Returns the new comment's id. Blank-field refusal is the function's, not ours:
    // this handler coerces shape and never judges content, exactly like its sibling
    // answers route.
    const id = await rpc<string>(user.token, "portal_suggest_change", {
      p_brand: brand,
      p_topic: topic,
      p_selected: String(body.selected_text ?? ""),
      p_before: String(body.context_before ?? ""),
      p_after: String(body.context_after ?? ""),
      p_instruction: String(body.instruction ?? ""),
    });
    return json({ id }, 201);
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      return detail(STATUS_FOR[code] ?? 400, rest.join(":"));
    }
    return failure(cause);
  }
}
