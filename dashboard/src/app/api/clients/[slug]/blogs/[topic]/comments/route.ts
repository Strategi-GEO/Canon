import { HOSTED_READONLY } from "@/lib/hosted";
import { adminRpcError } from "@/lib/server/admin-rpc";
import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, hostedWriteRefused, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";

/**
 * The operator's comment: record one selection-anchored change request on a finished article.
 *
 * All authority lives in the database function admin_add_comment
 * (supabase/migrations/009_admin_write_tier.sql). It gates on auth_is_admin() and nothing
 * else, resolves the brand and the topic from these two text slugs so no caller can name
 * another org's row by id, refuses a demo fixture, refuses any topic whose rollup is not
 * 'done', and refuses a blank selection or a blank instruction. It stamps the caller's email
 * from the JWT and inserts the row itself. This handler only shapes HTTP: it validates the
 * body's SHAPE and never its content, forwards the caller's own JWT, and hands the function's
 * PORTAL:<CODE>:<detail> refusals to the shared admin map.
 *
 * THIS IS NOT THE LOCAL ADD-COMMENT ACTION, AND THE DIFFERENCE IS REAL RATHER THAN COSMETIC.
 * The local engine's route inserts an operator comment in state 'applying' and immediately
 * starts a Claude session that rewrites the selected text, so pressing the button there IS the
 * edit. NO CLAUDE EDIT RUNS FROM THE HOSTED BUILD. A SECURITY DEFINER function can insert a
 * row and cannot start an Agent SDK session, so the comment lands in state 'open': a QUEUED
 * REQUEST, waiting for an operator to resolve it from a machine that has an engine, exactly as
 * a client's suggestion already waits.
 *
 * Inserting 'applying' here to match the local shape would file a comment that applies
 * forever: it would hold one of the three in-flight slots permanently, it could not be
 * dismissed because dismissal refuses 'applying', and it would disable the stage page's
 * editor. A later local engine's reconcile_stranded would then fail it with "the engine
 * restarted while this change was being applied", which would be a lie, because no engine ever
 * had it.
 *
 * THE UI MUST SAY SO. A caller that renders this 201 as "your edit was applied" is describing
 * work nobody did. The honest sentence is that the request is queued for a run.
 */

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; topic: string }> },
) {
  // The hosted site performs no admin write, and hostedWriteRefused carries the whole reasoning.
  // HOSTED_READONLY is false in the local app, so the insert below is unchanged there. The
  // docstring above already concedes that a comment filed here only ever queues, because no Agent
  // SDK session can start on this surface: an operator with the app open files the request and
  // resolves it in one move.
  if (HOSTED_READONLY) {
    return hostedWriteRefused("file a change request on this article");
  }

  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, topic } = await params;

  let body: {
    selected_text?: unknown;
    instruction?: unknown;
    context_before?: unknown;
    context_after?: unknown;
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
    // Returns the new comment's id. Blank-field refusal is the function's, not ours: this
    // handler coerces shape and never judges content.
    const id = await rpc<string>(user.token, "admin_add_comment", {
      p_brand: slug,
      p_topic: topic,
      p_selected_text: String(body.selected_text ?? ""),
      p_instruction: String(body.instruction ?? ""),
      p_context_before: String(body.context_before ?? ""),
      p_context_after: String(body.context_after ?? ""),
    });
    return json({ id }, 201);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
