import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";
import { adminRpcError } from "@/lib/server/admin-rpc";
import type { UploadBlogResult } from "@/types";

/**
 * Ingest an article the operator already has, in place of generating one.
 *
 * All authority lives in admin_upload_blog (supabase/migrations/009_admin_write_tier.sql):
 * it verifies the caller is an admin, refuses a demo fixture, reads the topic's title, scope
 * and prompts from roadmap_rows so the browser cannot name a topic the roadmap does not plan,
 * refuses a held or mid-run topic, refuses an existing blog without an explicit replace,
 * refuses a replace over open client suggestions, then commits the version, writes the
 * terminal status line at the record's own line_no high-water mark, and inserts the ledger
 * row that stops a research run rewriting the article later.
 *
 * THE GATES DO NOT RUN HERE AND THE RESULT SAYS SO. gates.py is a subprocess and there is no
 * process on Vercel to run it in, so the function returns `gates: {ran: false, reason}` and
 * can never return `passed: true`. That distinction is the whole point: "we did not check" and
 * "we checked and it was clean" must not look the same to whoever presses Send afterwards.
 * An article uploaded here is held to the same standard by a human rather than by the script.
 *
 * The local engine's route runs the gates and reports them, so the two builds differ in what
 * they can tell you about the same file. They do not differ in what they store.
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

  let body: { body?: unknown; replace?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with the article markdown is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with the article markdown is required");
  }

  try {
    const result = await rpc<UploadBlogResult>(user.token, "admin_upload_blog", {
      p_brand: slug,
      p_topic: topic,
      p_body: String(body.body ?? ""),
      // Anything other than an explicit true is a refusal to replace. A truthy coercion here
      // would turn a stray string into consent to overwrite a finished article.
      p_replace: body.replace === true,
    });
    return json(result);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
