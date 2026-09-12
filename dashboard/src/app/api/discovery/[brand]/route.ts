import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { failure, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";

/**
 * The discovery questions a brand has been SENT, with whatever the client already saved.
 *
 * All authority is in portal_discovery_questions (supabase/migrations/040_client_discovery.sql):
 * it scopes to the caller's own orgs and filters on sent_at, so a draft the operator has not
 * released cannot reach a client through this route however it is called.
 *
 * A brand with no sent questions is a 200 with an empty array, not a 404, the same way the
 * reports route answers a brand with nothing shared. There is a real difference between "this
 * brand is not yours" (the RPC returns nothing because the membership check failed) and "nobody
 * has sent you questions yet", and only the second is an ordinary state worth a page.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ brand: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { brand } = await params;
  try {
    const questions = await rpc<unknown>(user.token, "portal_discovery_questions", {
      p_brand: brand,
    });
    return json({ questions: Array.isArray(questions) ? questions : [] });
  } catch (cause) {
    return failure(cause);
  }
}
