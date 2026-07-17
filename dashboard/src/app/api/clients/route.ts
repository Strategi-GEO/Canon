import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { listClients, PREFLIGHT_PLACEHOLDER_REASON } from "@/lib/server/clients";
import { failure, json } from "@/lib/server/http";

/**
 * The engine's GET /api/clients, answered from Supabase as the caller: RLS scopes the list,
 * so a non-admin sees only the brands their grants name and nothing in the response betrays
 * how many others exist. geo_mock is the wire-compat literal false the engine sends.
 */
export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  try {
    const listed = await listClients(user.token);
    const clients = listed.map((entry) => ({
      ...entry.shape,
      // The generated preflight_ok column encodes exactly the engine's _preflight rule
      // (facts absent passes, PLACEHOLDER refuses), so this cannot disagree with the engine.
      preflight: {
        ok: entry.preflightOk,
        reason: entry.preflightOk ? null : PREFLIGHT_PLACEHOLDER_REASON,
      },
    }));
    return json({ geo_mock: false, clients });
  } catch (cause) {
    return failure(cause);
  }
}
