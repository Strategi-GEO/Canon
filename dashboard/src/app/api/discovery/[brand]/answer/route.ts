import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, failure, json } from "@/lib/server/http";
import { PostgrestError, rpc } from "@/lib/server/postgrest";

/**
 * Save ONE discovery answer.
 *
 * One question per call, because the form saves as the client types. A whole-form submit would
 * make a 40-question form all-or-nothing, which is the shape the evaluator's question form has
 * and the shape the engine contract says gets closed rather than answered. Nothing here is
 * required and nothing is held: a client who answers six of forty has still made the fact base
 * six facts better, and no blog is waiting on the other thirty-four.
 *
 * A BLANK answer clears the row. That is how a client withdraws something they are no longer sure
 * of, and a withdrawn uncertain answer is strictly better for the fact base than one left
 * standing.
 *
 * All authority is in portal_answer_discovery: role gate, tenancy through client_id, and the
 * sent_at filter that keeps a draft unanswerable. This handler shapes HTTP and nothing else.
 */

const STATUS_FOR: Record<string, number> = {
  AUTH: 401,
  ROLE: 403,
  NOTFOUND: 404,
  BADBODY: 422,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ brand: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand } = await params;

  let body: { id?: unknown; answer?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with an id and an answer is required");
  }
  const id = String(body.id ?? "");
  if (id === "") {
    return detail(422, "a JSON body with an id and an answer is required");
  }
  // Never validated for CONTENT, only shape. What counts as a usable answer is the fact base
  // build's judgement, not this handler's, and a client writing "not sure, ask our ops lead" is
  // a genuinely useful answer that any content rule here would have thrown away.
  const answer = String(body.answer ?? "");

  try {
    const result = await rpc<unknown>(user.token, "portal_answer_discovery", {
      p_brand: brand,
      p_question: id,
      p_answer: answer,
    });
    return json(result);
  } catch (cause) {
    if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
      const [, code, ...rest] = cause.body.message.split(":");
      return detail(STATUS_FOR[code] ?? 400, rest.join(":"));
    }
    return failure(cause);
  }
}
