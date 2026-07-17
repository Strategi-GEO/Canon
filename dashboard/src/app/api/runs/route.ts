import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { json } from "@/lib/server/http";

/**
 * Hosted stub. Runs are ephemeral engine state (an in-process dict of asyncio handles in
 * server/runner.py), so the hosted deployment, which has no engine, honestly has none. The
 * empty list keeps every poller (topbar indicator, session cards, run notifier) quiet.
 */
export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  return json({ runs: [] });
}
