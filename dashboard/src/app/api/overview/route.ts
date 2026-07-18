import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { failure, json } from "@/lib/server/http";
import { buildOverview } from "@/lib/server/portal-data";

/**
 * The home page's one read: every org and brand this login can see, plus every blog in a
 * client-visible state (delivered, action, frozen). The client-safe boundary lives in
 * portal-data.ts; this handler adds nothing to it and subtracts nothing from it.
 */
export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  try {
    return json(await buildOverview(user.token, user.userId));
  } catch (cause) {
    return failure(cause);
  }
}
