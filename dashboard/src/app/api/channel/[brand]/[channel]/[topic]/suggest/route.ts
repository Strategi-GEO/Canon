import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * The client's request for a change on a channel post: record one selection-anchored suggestion.
 * All authority lives in portal_suggest_channel_change (migration 032): it verifies role and brand
 * scope, that the post was sent, that the suggestion carries real text, and the per-post open cap,
 * then inserts the comment with the caller's identity. No Claude runs from here: the row lands
 * 'open' and waits for the team's Resolve. This handler shapes HTTP only.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  NOTSENT: 409,
  BADBODY: 422,
  LIMIT: 429,
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
    const id = await rpc<string>(user.token, "portal_suggest_channel_change", {
      p_client_slug: brand,
      p_channel: channel,
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
