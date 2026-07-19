import { adminRpcError } from "@/lib/server/admin-rpc";
import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";

/**
 * The operator's release: hand a finished article to the client for review.
 *
 * All authority lives in the database function admin_send_blog_to_client
 * (supabase/migrations/009_admin_write_tier.sql). It gates on auth_is_admin() and nothing
 * else, resolves the brand and the topic from these two text slugs so no caller can name
 * another org's row by id, refuses a demo fixture, and refuses any topic whose rollup is not
 * 'done', which is the record-visible stand-in for the engine's in-memory live-run guard. It
 * then stamps sent_to_client_at, pins sent_version_id from a correlated subselect on the
 * LATEST version rather than from anything the browser sent, and clears the prior approval so
 * a re-send asks for a fresh sign-off.
 *
 * THE OPEN-SUGGESTION REFUSAL IS THE FUNCTION'S WHERE CLAUSE, NOT A PRE-CHECK HERE. Counting
 * open suggestions in this handler and then calling the RPC is exactly the check-then-act
 * window a portal write lands in: the count returns zero, the client files a suggestion, and
 * the article goes out over a request nobody has read. Zero rows updated is the refusal, and
 * it reaches the operator as OPENSUGGESTIONS through the shared map.
 *
 * This handler only shapes HTTP. There is no body to validate, it forwards the caller's own
 * JWT so RLS and the definer's own gate both see the real identity, and it returns the
 * function's answer untouched: that object is read back inside the writing transaction, so it
 * describes the state this send produced and not one some other session moved to afterwards.
 * Re-deriving those fields from a second query would reintroduce the staleness the function
 * exists to avoid.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; topic: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, topic } = await params;

  try {
    // The full review-state object: sent_to_client, sent_to_client_by, client_approved,
    // client_approved_by, changes_requested. Passed through as-is.
    const result = await rpc<Record<string, unknown>>(user.token, "admin_send_blog_to_client", {
      p_brand: slug,
      p_topic: topic,
    });
    return json(result);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
