import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail } from "@/lib/server/http";

/**
 * Hosted stub. Fact-base builds live in the engine process, and there is no engine here: the
 * engine's own "never built one" 404 is the answer the UI already reads as the empty state.
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
  return detail(404, `no facts generation job for '${slug}'`);
}
