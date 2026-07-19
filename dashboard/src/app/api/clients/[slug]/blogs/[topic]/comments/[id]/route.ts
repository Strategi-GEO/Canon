import { adminRpcError } from "@/lib/server/admin-rpc";
import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { noContent } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";

/**
 * The operator's withdrawal: take one change request off an article.
 *
 * All authority lives in the database function admin_dismiss_comment
 * (supabase/migrations/009_admin_write_tier.sql). It gates on auth_is_admin() and nothing
 * else, resolves the brand and the topic from these text slugs, and scopes the delete by
 * topic_id, which is what stops a guessed comment uuid from reaching across tenants: an id
 * belonging to another brand matches no row.
 *
 * THE NARROW GUARD IS DELIBERATE AND IS NOT AN OVERSIGHT. Dismissal carries no demo refusal,
 * no done gate and no live-run gate, because the local engine's DELETE carries none either: a
 * comment can be withdrawn whatever state the blog is in. Copying the add-comment guard stack
 * onto this route would refuse dismissals the local build allows, and the two surfaces would
 * disagree about the same button.
 *
 * The one refusal it does carry is atomic and belongs in SQL rather than here: state <>
 * 'applying' sits in the function's WHERE, so a comment whose Claude apply is mid-flight
 * cannot be pulled out from under the running session. Zero rows means the comment was already
 * gone, was a reply rather than a top-level request, or is applying, and the caller gets one
 * refusal for all three, because a dismissed comment and a never-existed comment are the same
 * thing to the person pressing the button.
 *
 * This handler only shapes HTTP. There is no body, it forwards the caller's own JWT, and the
 * returned id is discarded: the answer is a bare 204, matching the engine's own DELETE so
 * src/lib/api.ts cannot tell the two servers apart.
 */

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; topic: string; id: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, topic, id } = await params;

  try {
    await rpc<string>(user.token, "admin_dismiss_comment", {
      p_brand: slug,
      p_topic: topic,
      p_comment: id,
    });
    return noContent();
  } catch (cause) {
    return adminRpcError(cause);
  }
}
