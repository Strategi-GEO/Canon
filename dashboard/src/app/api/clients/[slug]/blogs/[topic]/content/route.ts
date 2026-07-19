import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";
import { adminRpcError } from "@/lib/server/admin-rpc";

/**
 * Save an operator's own edit of the article as a new committed version.
 *
 * All authority lives in admin_save_blog_content (supabase/migrations/009_admin_write_tier.sql):
 * it verifies the caller is an admin, resolves the brand and topic from these slugs, refuses a
 * demo fixture and a topic that is not `done`, refuses while a Claude apply is mid-flight,
 * locks the topic row, allocates the next version_no and repoints topics.shipped_version_id.
 * This handler only shapes HTTP.
 *
 * base_version IS REQUIRED AND IS THE WHOLE RACE GUARD. The local engine's save sends no
 * version, and blog_edit.save_content is honest about what that leaves open: it can prove the
 * record has not moved since IT read, and it cannot prove the browser's editor was opened
 * after the last commit, because no version travels on the wire. Hosted has strictly more
 * editors, no APPLY_LOCK, and no engine holding anything, so the version the editor was opened
 * on travels with the body and a mismatch is refused as PORTAL:STALE rather than silently
 * burying whoever saved first.
 *
 * A missing or non-numeric base_version is a 422 here rather than a coerced 0, because 0 is a
 * real answer (a topic with no versions yet) and coercing to it would turn "the browser forgot
 * to tell us" into "the browser believes this is the first version", which is exactly the
 * assertion the guard exists to check.
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

  let body: { body?: unknown; base_version?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with body and base_version is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with body and base_version is required");
  }
  if (typeof body.base_version !== "number" || !Number.isInteger(body.base_version)) {
    return detail(
      422,
      "base_version is required and must be the version number this edit started from",
    );
  }

  try {
    // Blank and over-size refusals belong to the function, not here: this handler coerces
    // shape and never judges content, exactly as the portal write routes do.
    const result = await rpc<{ version_no: number; word_count: number }>(
      user.token,
      "admin_save_blog_content",
      {
        p_brand: slug,
        p_topic: topic,
        p_body: String(body.body ?? ""),
        p_base_version_no: body.base_version,
      },
    );
    return json(result);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
