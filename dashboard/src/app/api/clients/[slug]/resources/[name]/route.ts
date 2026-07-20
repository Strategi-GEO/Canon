import { adminRpcError } from "@/lib/server/admin-rpc";
import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId } from "@/lib/server/clients";
import { supabaseAnonKey, supabaseUrl } from "@/lib/server/env";
import { detail, failure, json, noContent } from "@/lib/server/http";
import { pg, rpc } from "@/lib/server/postgrest";

/**
 * The hosted half of GET /api/clients/{slug}/resources/{name}, and it deliberately does NOT
 * answer the same thing the engine answers.
 *
 * The engine streams the bytes (server/app.py api_resource_file). This route CANNOT, and the
 * reason is the same platform limit that forced migration 015: Vercel caps a serverless
 * request and response body at 4.5 MB on every plan, MAX_RESOURCE_BYTES is 25 MiB, and the
 * live corpus already holds a 12.8 MB brochure. Proxying is not slow here, it is impossible,
 * so bytes go browser <-> Storage directly and this route's whole job is to hand the browser
 * what it needs to make that trip. It answers JSON, never a file.
 *
 * ============================================================================
 * THE CHOICE: a signed URL, not the object path
 * ============================================================================
 * The two candidates were (a) return object_path and let the browser fetch
 * `${SUPABASE_URL}/storage/v1/object/resources/<path>` with its own JWT, and (b) mint a signed
 * URL here and return that. Both are free of the service-role key, which is the constraint
 * that mattered most: Storage signs on the CALLER's authority, so POST /object/sign is
 * governed by resources_read_scoped (migration 015) exactly as a direct read would be, and a
 * caller with no membership in the brand cannot sign a URL they could not have fetched. So
 * "signing needs the secret key" is false, and the old comment on the listing route saying so
 * has been corrected.
 *
 * (b) wins on two grounds the constraint did not settle:
 *
 * 1. THE BROWSER DOES NOT KNOW WHERE SUPABASE IS. SUPABASE_URL and SUPABASE_ANON_KEY are
 *    server-only by deliberate design (see lib/server/env.ts: nothing there is NEXT_PUBLIC_).
 *    Option (a) works only if this route also hands back the project URL and the anon key, so
 *    the "just return the path" option is really "publish the project's Storage endpoint and
 *    key to every browser". That is a larger change to this app's posture than the feature
 *    warrants, and it is not reversible once shipped: the key is in the bundle.
 * 2. A HEADER CANNOT BE ATTACHED TO AN <img> OR AN <embed>. The product rule is that pdf,
 *    image and text preview inline. An authenticated fetch can only be done from script, so
 *    option (a) means downloading up to 25 MiB into JS memory and creating a blob: URL for
 *    every preview, holding the whole brochure in the tab. A signed URL is an ordinary URL
 *    that src= accepts, so the browser streams and renders it with no copy in our hands.
 *
 * The cost of (b) is honest and worth naming: a signed URL is a bearer token in a query
 * string, so anyone it is forwarded to can read the file for as long as it lives. That is why
 * the TTL below is 60 seconds rather than an hour. It is long enough to start a fetch or point
 * an <embed> at it and far too short to be a link anybody shares.
 */

/** Seconds a minted URL stays valid. See the TTL reasoning above; keep it short. */
const SIGNED_URL_TTL = 60;

/**
 * A resource name is an arbitrary filename: the schema preserves it verbatim because
 * canonical-facts.md refers to the brochure by exact filename, so it contains spaces and can
 * contain commas, dots and parentheses, all of which are PostgREST filter syntax. Wrapping the
 * value in double quotes makes PostgREST read it literally; backslash and the quote itself are
 * escaped first so a name containing a quote cannot close the string early. This is the same
 * defence inList() applies for the same reason.
 */
function eqFilter(value: string): string {
  const quoted = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return encodeURIComponent(quoted);
}

/**
 * Storage returns signedURL as a path relative to /storage/v1 ("/object/sign/resources/..."),
 * so it is joined here rather than handed to the browser as-is. Absolute is what the caller
 * needs anyway, since the browser does not hold SUPABASE_URL.
 */
function absoluteSignedUrl(base: string, signed: string): string {
  return `${base}/storage/v1/${signed.replace(/^\/+/, "")}`;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; name: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, name } = await params;

  // ?download=1 mirrors the engine's own flag. Storage honours a `download` query parameter on
  // a signed URL by answering Content-Disposition: attachment with that filename, which is the
  // same inline-by-default, attachment-on-request behaviour api_resource_file implements with
  // its own header. Passing the ORIGINAL name means a save-as writes the operator's filename
  // and not the sha256 the object is stored under.
  const wantsDownload = new URL(request.url).searchParams.get("download") === "1";

  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }

    // RLS scopes this read to brands the caller can see, so a name under someone else's brand
    // yields no row and lands on the same 404 as a name that does not exist. The engine's
    // wording is reproduced exactly, because api.ts renders the server's own sentence.
    const rows = await pg<{ object_path: string; content_type: string | null; size_bytes: number }[]>(
      user.token,
      `client_resources?select=object_path,content_type,size_bytes` +
        `&client_id=eq.${cid}&name=eq.${eqFilter(name)}`,
    );
    const row = rows[0];
    if (row === undefined) {
      return detail(404, `no resource ${JSON.stringify(name)} for client ${JSON.stringify(slug)}`);
    }

    // object_path carries the bucket prefix ("resources/<slug>/<sha256>") while the sign
    // endpoint wants the bucket and the key separately, so the first segment is split off
    // exactly as server/app.py and sync.materialize_client split it. Splitting on the FIRST
    // slash only: a key contains slashes of its own and must survive intact.
    const split = row.object_path.indexOf("/");
    const bucket = split < 0 ? "" : row.object_path.slice(0, split);
    const key = split < 0 ? "" : row.object_path.slice(split + 1);
    if (bucket === "" || key === "") {
      return detail(502, `resource ${JSON.stringify(name)} has an unusable object path`);
    }

    // The caller's own JWT, exactly as postgrest.ts forwards it: the apikey selects the role
    // and the bearer decides what that role may reach. Storage refuses to sign an object the
    // caller could not read, so this call is the authorisation check and not a step after one.
    const res = await fetch(`${supabaseUrl()}/storage/v1/object/sign/${bucket}/${key}`, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey(),
        Authorization: `Bearer ${user.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text();
      // A 400 or 404 here is an index row whose object is gone from the bucket, which is a
      // real inconsistency and not a caller error, so it does not become a 404 the UI would
      // render as "no such file". Naming the hop matches failure()'s posture.
      return detail(502, `storage refused to sign ${JSON.stringify(name)}: HTTP ${res.status} ${body}`);
    }
    const signed = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const relative = signed.signedURL ?? signed.signedUrl;
    if (typeof relative !== "string" || relative === "") {
      return detail(502, "storage answered 200 without a signed URL");
    }

    const url = absoluteSignedUrl(supabaseUrl(), relative);
    return json({
      name,
      // Absolute, single-use-ish and header-free: the browser fetches or embeds it directly.
      url: wantsDownload ? `${url}&download=${encodeURIComponent(name)}` : url,
      // Same fallback rule as the listing route: NULL reaches the UI as "" and resource-type.ts
      // answers from the filename. One guess, in one place.
      content_type: row.content_type ?? "",
      size: row.size_bytes,
      // So a caller can decide whether to re-request rather than discovering expiry mid-render.
      expires_in: SIGNED_URL_TTL,
    });
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Remove one file from the brand's knowledge base, the index row and the stored object
 * together.
 *
 * BOTH HALVES OR NEITHER, and that is why this is one RPC rather than a delete here and a
 * Storage call beside it. The two are a single act: an index row whose object is gone is a
 * file whose download answers 502 with no way for the brand to tell why, and an object with no
 * row is storage nobody can see or remove. Doing them from two hops in this handler means a
 * crash between them leaves exactly one of those states behind, so the ordering is handed to
 * portal_resource_remove, which owns both sides of it inside one transaction. What "the stored
 * object" means there is stated precisely in migration 016's own closing note: the function
 * removes the storage.objects row every reader resolves, which is a complete delete as far as
 * this product can observe, and it leaves the backing blob to be unreachable rather than
 * erased.
 *
 * All authority lives in that function, as it does for the POST beside the listing. It gates
 * on auth_can_write_client_slug with no admin bypass, resolves the brand from this slug so no
 * caller can name another org's row, and raises NOTFOUND for a name the brand does not hold.
 * That refusal reaches the client as the role sentence rather than a broken-link sentence, and
 * it is the right one either way: the file was listed to them a moment ago, so a 404 on the
 * delete means their seat cannot remove it far more often than it means the name vanished.
 *
 * 204 with no body, matching the engine's own api_resource_delete (server/app.py), so the two
 * servers answer a delete identically for the same URL. `object_removed` STAYS OFF THE WIRE, and
 * that half of the old reasoning holds: the client asked for a file to be gone, the index row is
 * gone, so from their side the delete succeeded completely and the listing they see next proves
 * it. A false in their response would dress a successful delete as a failure, and the only act it
 * could prompt is a retry, which now matches no row and answers 404. The row is gone either way,
 * which is the whole of what was asked for.
 *
 * WHAT CHANGED IS THAT THE FLAG IS NO LONGER DISCARDED. Reading the RPC's answer into `unknown`
 * and dropping it threw away the one signal migration 016 built to make index and object
 * divergence observable. That migration is explicit about it: where the definer cannot reach
 * storage.objects the index row still goes, the bytes are orphaned, and "object_removed = false is
 * what makes it visible instead of silent". A route that receives that false and drops it restores
 * exactly the silence the flag exists to break, leaving a divergence discoverable from a storage
 * bill and nowhere else.
 *
 * SO IT LEAVES AS A LOG LINE, which is the channel this codebase already uses for an anomaly that
 * must not stop the caller, rather than a new one invented for it. server/app.py keeps a
 * `geo-factory` logger and warns on exactly this shape of event, the ledger append that failed
 * after the blog was already on disk, and its comment states the rule this follows: the artifact
 * is there either way, log and carry on. There is no per-file storage-health surface anywhere in
 * this app, and building one for a state nobody has yet observed would be turning a warning into a
 * feature, so the line carries the brand and the filename and lands in the deployment's function
 * logs where an operator investigating storage will be looking anyway.
 *
 * ONLY AN EXPLICIT false WARNS, and absence is not evidence. A function that answered without the
 * field is one this route cannot interrogate, so treating a missing field as an orphan would
 * report a divergence from a fact never established. That is the same positive-disagreement rule
 * the staleness readers apply to a version anchor they could not resolve.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string; name: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug, name } = await params;

  try {
    // The name travels verbatim, exactly as the GET above reads it: the schema preserves the
    // operator's filename with its spaces and punctuation intact, and an RPC argument is a
    // JSON value rather than a filter expression, so nothing needs quoting on the way in.
    const removal = await rpc<{ name?: string; object_removed?: boolean } | null>(
      user.token,
      "portal_resource_remove",
      {
        p_client_slug: slug,
        p_name: name,
      },
    );
    if (removal?.object_removed === false) {
      // The brand and the filename, and deliberately not the object path: the path is derivable
      // from those two and this line is a pointer for whoever goes looking, not a second record
      // of the delete. It names the state it leaves behind rather than the call that produced it,
      // because "rpc returned false" is not something an operator can act on.
      console.warn(
        `portal_resource_remove removed the index row for ${JSON.stringify(name)} under client ` +
          `${JSON.stringify(slug)} but deleted no storage object, so the stored bytes are ` +
          `orphaned in the bucket. The client's delete succeeded and nothing is wrong on their ` +
          `side; this is storage the index no longer points at.`,
      );
    }
    return noContent();
  } catch (cause) {
    return adminRpcError(cause);
  }
}
