import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { json } from "@/lib/server/http";

/** Hosted stub: draft jobs live in the engine process, and there is no engine here. */
export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  return json({ jobs: [] });
}
