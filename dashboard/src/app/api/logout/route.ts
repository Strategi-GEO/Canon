import { logout } from "@/lib/server/auth";
import { noContent } from "@/lib/server/http";

/**
 * Best-effort revoke, always 204, mirroring the engine: a logout must always succeed from
 * the browser's side, because the client is discarding its tokens either way and an error
 * here would leave it holding a session it already decided to end.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { refresh_token?: unknown };
    if (typeof body.refresh_token === "string") {
      await logout(body.refresh_token);
    }
  } catch {
    // Best effort by contract.
  }
  return noContent();
}
