import { detail, failure } from "@/lib/server/http";
import { PostgrestError } from "@/lib/server/postgrest";

/**
 * The hosted admin write tier's shared error mapping.
 *
 * Every admin_* function in migration 009 raises the same PORTAL:<CODE>:<detail> protocol the
 * portal_* functions use. The prefix is kept rather than renamed to ADMIN: because rpc()'s
 * parser and all four existing portal maps key on it, and a second prefix is a second thing to
 * drift for no gain: the prefix marks "this is a deliberate refusal carrying a sentence for a
 * human", which is as true of an operator action as a client one.
 *
 * ONE MAP, not one per route, and that is deliberate. The portal routes each carry their own
 * copy with only the codes that route's function raises, on the stated ground that a code
 * listed but never raised reads as a refusal the route handles when it handles nothing. That
 * reasoning holds for four routes written once; it stops holding across seven routes over
 * seven functions that share three helper functions and therefore share most of their codes.
 * The failure this prevents is the other one that comment names: a code a function raises but
 * the map lacks lands as a bare 400, and the operator sees "Bad Request" where the database
 * wrote them a sentence.
 *
 * So the map is the union of every code the admin_* functions raise, and it is maintained
 * against them. If a function gains a code, it goes here.
 *
 * THE UNION NOW REACHES PAST THE admin_* FUNCTIONS, and that is deliberate rather than a
 * slip. The client resource writes go through portal_resource_add and portal_resource_remove
 * (migration 016), which raise the same PORTAL:<CODE>:<detail> protocol, so their routes hand
 * their refusals here rather than growing a fourth private copy of the same mapping. The
 * reasoning above is unchanged by that: these functions share auth_can_write_client_slug with
 * everything else in the resource path, so they share most of their codes too, and a code
 * raised but unmapped is the same bare 400 the header already calls the failure to prevent.
 */
const STATUS_FOR: Record<string, number> = {
  // Raised by admin_brand_id when auth.uid() is null. In practice unreachable through these
  // routes, because verifyRequest already answered 401 before the RPC was called; it exists
  // so a direct PostgREST call gets the same answer.
  AUTH: 401,
  // The ONE refusal for "not an admin", "no such brand" and "no such topic". Never split
  // these: telling the caller which of the three it was is the enumeration oracle migration
  // 003 removed from portal_submit_answers.
  NOTFOUND: 404,
  // Business refusals. Each names a state the caller can act on.
  DEMO: 409,
  NOTDONE: 409,
  OPENSUGGESTIONS: 409,
  APPLYING: 409,
  STALE: 409,
  EXISTS: 409,
  HELD: 409,
  RUNNING: 409,
  NOSHEET: 409,
  // The client approved this article, so migration 013 locks it. 409 rather than 403: the
  // caller is permitted to do this in general, just not to an article in this state, which is
  // exactly what every other code in this block means. 403 would read as "your account cannot
  // do this" and send an admin looking for a permission they already have.
  LOCKED: 409,
  // The same bytes are already stored for this brand under a different filename, raised by
  // portal_resource_add (migration 016:147 and :171). It belongs in this block and not with
  // the body problems: nothing about the request is malformed, it conflicts with what the
  // brand already holds, which is what every other 409 above means.
  //
  // THIS ENTRY IS LOAD-BEARING RATHER THAN COMPLETING A SET. The resources upload path keys the
  // entire duplicate story off status 409: at that status it renders the database's own
  // sentence, which names the file the bytes are already stored as, followed by the promise
  // that nothing was overwritten. Without the entry the refusal arrives as a bare 400 and the
  // uploader is told it failed with no sentence telling them the file is already stored, which
  // is the one thing that would let them act on it. (Resources are admin-only since migration
  // 024; this is the admin console's upload path.)
  DUPLICATEBYTES: 409,
  // Body problems. The function judges content; the route only judged shape.
  BLANK: 422,
  // A sha256 that is not 64 lowercase hex characters, or a size that is null or negative,
  // raised by portal_resource_add (migration 016:108 and :111). 422 rather than 400 for the
  // reason BLANK is: the request parsed and its shape was right, so what failed is a value
  // inside it. The upload route validates the same sha before it builds a storage path, so a
  // BADBODY reaching a caller means the two halves of one upload disagreed about the digest.
  BADBODY: 422,
  TOOLARGE: 413,
};

/**
 * Turns a thrown RPC error into the response the operator should see.
 *
 * A PORTAL: message is a refusal the database wrote deliberately, so its sentence is handed
 * through untouched: those sentences are written for the person reading them and are the
 * whole reason the protocol exists. Anything else is a genuine fault and goes to failure(),
 * which maps a missing env to 500 and an upstream problem to 502.
 */
export function adminRpcError(cause: unknown): Response {
  if (cause instanceof PostgrestError && cause.body?.message?.startsWith("PORTAL:")) {
    const [, code, ...rest] = cause.body.message.split(":");
    return detail(STATUS_FOR[code] ?? 400, rest.join(":"));
  }
  return failure(cause);
}
