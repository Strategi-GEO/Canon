import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId } from "@/lib/server/clients";
import { supabaseAnonKey, supabaseUrl } from "@/lib/server/env";
import { detail, failure, json } from "@/lib/server/http";

/**
 * POST /api/clients/{slug}/resources/upload-url: where the browser PUTs the bytes of one new
 * file. It answers a ticket and never touches the bytes themselves.
 *
 * The sibling [name]/route.ts explains the wall this route is built around, and it applies
 * here in the harder direction. Vercel caps a serverless request body at 4.5 MB on every plan
 * and MAX_RESOURCE_BYTES is 25 MiB, so an upload cannot be proxied through a Route Handler at
 * all: the browser has to reach Storage itself. What this route does is mint the one URL that
 * lets it, scoped to a single object key.
 *
 * NO SECRET KEY IS INVOLVED, which is the whole design and not an optimisation. Storage signs
 * on the CALLER's authority, so this POST is governed by resources_insert_scoped (migration
 * 015) exactly as a direct upload would be: a caller with no write seat in the brand cannot
 * mint a URL for an object they could not have written. Reaching for the service-role key here
 * would bypass RLS entirely and make this handler the only thing standing between one brand's
 * private documents and another's, which is precisely the job 015 took away from application
 * code.
 *
 * THE OBJECT KEY IS BUILT HERE AND NEVER ACCEPTED. Migration 016 states the rule this obeys
 * for the index half: a caller-supplied path is the pointer to the bytes themselves, so
 * `resources/<other-brand>/<sha>` would be another brand's document. The slug comes from the
 * route, checked against the brand the caller can actually see, and the sha256 is validated to
 * 64 hex characters BEFORE it is interpolated, so neither half of this path is a string the
 * caller chose freely.
 */

/** The one bucket, matching client_resources.object_path's prefix and migration 015's policies. */
const BUCKET = "resources";

/**
 * The address a resource is stored at, content-addressed exactly as db.resource_add writes it.
 * Anything outside 64 lowercase hex is refused rather than escaped: this value becomes a path
 * segment, and a validator that accepts and sanitises is a validator someone later reads as
 * permission to pass a filename through.
 */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Storage returns the token as a path relative to /storage/v1, so it is joined here rather
 * than handed to the browser as-is. Absolute is what the caller needs anyway, since the
 * browser does not hold SUPABASE_URL: env.ts keeps it server-only and nothing there is
 * NEXT_PUBLIC_. This mirrors absoluteSignedUrl in the sibling [name]/route.ts deliberately.
 * The two are not shared because every helper in this app lives under lib/server and a signed
 * URL join is not the reason to open a second home for one.
 */
function absoluteSignedUrl(base: string, signed: string): string {
  return `${base}/storage/v1/${signed.replace(/^\/+/, "")}`;
}

/**
 * Whether a refusal from the sign call is the caller's permissions rather than a broken hop.
 *
 * storage-api reports an RLS refusal two ways depending on its version: as a plain 401 or 403,
 * or as a 400 whose JSON body carries the intended status in `statusCode`. Both are read, and
 * a bare 400 is read as a refusal too, because this route leaves it nothing else to be: the
 * bucket and the key are built here from a validated sha and a slug the caller demonstrably
 * reads, and the body is an empty object. Anything with a different status is a genuine fault
 * (a missing bucket answers 404, an unreachable project answers nothing at all) and keeps the
 * 502 the sibling route gives, so an operator is never sent hunting for a permission that was
 * never the problem.
 */
function isPermissionRefusal(status: number, body: string): boolean {
  if (status === 400 || status === 401 || status === 403) {
    return true;
  }
  try {
    const parsed = JSON.parse(body) as { statusCode?: unknown };
    const declared = Number(parsed.statusCode);
    return declared === 401 || declared === 403;
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;

  let body: { sha256?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with the file's sha256 is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with the file's sha256 is required");
  }
  const sha256 = String(body.sha256 ?? "");
  if (!SHA256_RE.test(sha256)) {
    return detail(422, "sha256 must be 64 lowercase hex characters");
  }

  try {
    // Also the slug's own guard: clientId refuses anything outside the client_slug domain
    // before it builds a query, so a smuggled path segment 404s here rather than reaching the
    // key below. RLS scopes the lookup, so a brand outside the caller's grants is the same 404
    // as a brand that does not exist, and the engine's wording is reproduced exactly.
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }

    // The caller's own JWT, exactly as postgrest.ts forwards it: the apikey selects the role
    // and the bearer decides what that role may reach. An empty JSON body is what storage-js
    // sends for an upload with no upsert, and upsert is deliberately absent: migration 015
    // grants no UPDATE policy on storage.objects, so nothing in this path can overwrite an
    // object that already exists.
    const res = await fetch(
      `${supabaseUrl()}/storage/v1/object/upload/sign/${BUCKET}/${slug}/${sha256}`,
      {
        method: "POST",
        headers: {
          apikey: supabaseAnonKey(),
          Authorization: `Bearer ${user.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
        cache: "no-store",
      },
    );
    if (!res.ok) {
      const text = await res.text();
      // The key already holds an object, which for a content-addressed bucket means these
      // exact bytes are already stored for this brand. Whether the refusal lands here or on
      // portal_resource_add's DUPLICATEBYTES depends on which storage-api version is running,
      // because the existence check has moved between the sign step and the upload step, so
      // both answers exist and either one can be the one that fires. Both are a 409 carrying a
      // sentence, which is what resources.tsx renders followed by its promise that nothing was
      // overwritten. The sentence does not claim the file is in their list: an object can
      // outlive the row that named it, so "stored" is the most this route can honestly say.
      if (res.status === 409) {
        return detail(
          409,
          `these exact bytes are already stored for client '${slug}'; upload the file once under the name you want`,
        );
      }
      if (isPermissionRefusal(res.status, text)) {
        // The sentence the client reads for a viewer seat. resources.tsx turns a 403 on a
        // write into "this account can read the files here but cannot add or remove them",
        // which is the true story: they reached this page from their own brand list, so what
        // they lack is the seat and not the brand.
        return detail(403, `this account cannot add files to client '${slug}'`);
      }
      return detail(502, `storage refused to sign an upload for '${slug}': HTTP ${res.status} ${text}`);
    }

    // This endpoint names the field `url` where /object/sign names it `signedURL`, so both are
    // read. The sibling route already accepts both spellings for its own endpoint, and the
    // cost of accepting a name Storage does not currently send is nothing next to the cost of
    // a rename landing as "storage answered 200 without a URL".
    const signed = (await res.json()) as { url?: string; signedURL?: string; signedUrl?: string };
    const relative = signed.url ?? signed.signedURL ?? signed.signedUrl;
    if (typeof relative !== "string" || relative === "") {
      return detail(502, "storage answered 200 without an upload URL");
    }

    return json({
      url: absoluteSignedUrl(supabaseUrl(), relative),
      // PUT today, carried on the wire so a Storage API change stays a server-side change.
      method: "PUT",
      // Empty, and that is the point of the whole shape: the token rides in the query string,
      // so the browser sends no credential of ours to a third-party host. The Content-Type is
      // left to fetch, which stamps it from the File itself; dictating one here would override
      // what the browser knows about its own bytes.
      headers: {},
    });
  } catch (cause) {
    return failure(cause);
  }
}
