import { adminRpcError } from "@/lib/server/admin-rpc";
import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { byteCompare, clientId } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { pg, rpc } from "@/lib/server/postgrest";
import type { PortalResource } from "@/portal/types";

/**
 * The engine's GET /api/clients/{slug}/resources: the knowledge-base INDEX from
 * client_resources.
 *
 * This used to say "list only", on the ground that a per-file download needs a Storage signed
 * URL and a signed URL needs the secret key. The second half of that was wrong. Storage signs
 * on the CALLER's authority: POST /storage/v1/object/sign is governed by the same
 * resources_read_scoped policy (migration 015) as any other read, so the user's own JWT mints
 * the URL and no secret key is involved. The sibling [name]/route.ts does exactly that, and
 * this route now carries the field that route's consumers need to decide what to do with the
 * bytes once they have them.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    const rows = await pg<
      {
        name: string;
        size_bytes: number;
        uploaded_at: string | null;
        content_type: string | null;
      }[]
    >(
      user.token,
      `client_resources?select=name,size_bytes,uploaded_at,content_type&client_id=eq.${cid}`,
    );
    // The engine orders by lower(name) collate "C"; sorting the lowercased names by byte
    // order here reproduces it, underscores before letters included.
    const resources = rows
      .slice()
      .sort((a, b) => byteCompare(a.name.toLowerCase(), b.name.toLowerCase()))
      .map((row) => ({
        name: row.name,
        size: row.size_bytes,
        modified: row.uploaded_at ?? "",
        // The engine falls back to mimetypes.guess_type(name) for rows written before the
        // column existed; this route deliberately does NOT reproduce that guess. Node has no
        // mimetypes table, so reproducing it means a hand-written extension map that drifts
        // from Python's, and the drift would be invisible: the two servers would label one
        // file two ways. The fallback is not lost, it has just moved to where it already
        // lived: resource-type.ts reads the extension whenever content_type is empty, for
        // both the badge and the preview decision. So a NULL column reaches the UI as "" and
        // the UI answers from the filename, one guess in one place.
        content_type: row.content_type ?? "",
      }));
    return json({ resources });
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * The index half of a client upload: record the row for bytes the browser has already put
 * into Storage through upload-url/route.ts.
 *
 * THE ORDER IS DELIBERATE AND IT IS THE ORDER THE CLIENT USES. The bytes land first and this
 * row second, so a failed upload costs nothing: an object with no row is invisible to every
 * reader, and a retry of the same file computes the same content address and lands on it
 * again. Writing the row first would list a file the brand cannot open, and its name would
 * then refuse the very retry that would have fixed it.
 *
 * All authority lives in portal_resource_add (supabase/migrations/016_resource_client_write.sql).
 * It gates on auth_can_write_client_slug (admins plus a brand's own writing members, since
 * migration 022 made resources common to both), resolves the brand from this slug so no caller can name
 * another org's row, BUILDS the object path itself from the brand it authorised rather than
 * accepting one, refuses a blank or over-long filename, refuses a malformed digest or size,
 * refuses anything over the 25 MiB limit, and refuses BOTH duplicate shapes: a filename the
 * brand already uses and bytes the brand already stores under another name. Nothing in that
 * path upserts, so no call this handler can make overwrites a file the client already has.
 *
 * This handler only shapes HTTP. It coerces the body's SHAPE and never judges its content, it
 * forwards the caller's own JWT, and it hands the function's PORTAL:<CODE>:<detail> refusals to
 * the shared admin map. It does NOT resolve the brand first: the function answers that question
 * itself and answers it in one sentence for all four ways it can fail, and a second lookup here
 * would be a second answer to the same question with no scope check the function does not
 * already make.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;

  let body: { name?: unknown; sha256?: unknown; size?: unknown; content_type?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with name, sha256, size and content_type is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with name, sha256, size and content_type is required");
  }

  // A size that is not a finite number travels as null, which the function refuses as BADBODY
  // with a sentence. Truncating a fractional one is shape work rather than judgement: bigint
  // has no room for a fraction, so 1.5 would otherwise come back as a Postgres cast error the
  // browser reads as a broken server instead of a bad field.
  const size = Number(body.size);
  const sizeBytes = Number.isFinite(size) ? Math.trunc(size) : null;

  try {
    const resource = await rpc<PortalResource>(user.token, "portal_resource_add", {
      p_client_slug: slug,
      p_name: String(body.name ?? ""),
      p_sha256: String(body.sha256 ?? ""),
      p_size_bytes: sizeBytes,
      // "" where the browser could not tell what the file was. The function stores NULL for it
      // and the listing above renders NULL back as "", so the filename decides the type in the
      // one place resource-type.ts already decides it.
      p_content_type: String(body.content_type ?? ""),
    });
    // 201 for the same reason the engine's api_resource_upload answers 201: a row now exists
    // that did not before. The ENVELOPE is this route's own and does not copy the engine's
    // bare row, because the two POSTs are not the same endpoint wearing two coats: the
    // engine's takes multipart bytes from an admin and this one takes an index record from
    // the brand's own member. `{resource}` is what the client half is typed against.
    return json({ resource }, 201);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
