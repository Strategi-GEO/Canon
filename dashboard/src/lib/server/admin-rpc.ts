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
  // Body problems. The function judges content; the route only judged shape.
  BLANK: 422,
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
