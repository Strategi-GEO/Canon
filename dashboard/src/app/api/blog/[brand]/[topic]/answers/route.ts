import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The portal's ONE write: submit the client's answers to the current question form.
 *
 * All authority lives in the database function portal_submit_answers
 * (supabase/migrations/002_client_portal.sql): it verifies the caller's role, the form's
 * currency, and the submission's completeness, then records 'client'-authored replies
 * atomically. This handler only shapes HTTP: it validates the body's SHAPE (never its
 * content), forwards the caller's own JWT, and maps the function's PORTAL:<CODE>:<detail>
 * error protocol onto the statuses the engine uses for the same refusals.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  DEMO: 409,
  STALE: 409,
  ANSWERED: 409,
  INCOMPLETE: 422,
  BADBODY: 422,
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

  let body: { answers?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with an answers array is required");
  }
  if (!Array.isArray(body.answers)) {
    return detail(422, "a JSON body with an answers array is required");
  }
  const answers = body.answers
    .filter(
      (item): item is { id: unknown; answer: unknown } =>
        typeof item === "object" && item !== null,
    )
    .map((item) => ({ id: String(item.id ?? ""), answer: String(item.answer ?? "") }));

  try {
    const result = await rpc<unknown>(user.token, "portal_submit_answers", {
      p_client_slug: brand,
      p_topic_slug: topic,
      p_answers: answers,
    });
    return json(result, 202);
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      const message = rest.join(":");
      if (code === "INCOMPLETE") {
        // The same 422 shape the engine's answers route gives: the blank ids, named.
        return detail(422, {
          detail: "every question needs an answer",
          unanswered: message.split(",").filter((id) => id !== ""),
        });
      }
      return detail(STATUS_FOR[code] ?? 400, message);
    }
    return failure(cause);
  }
}
