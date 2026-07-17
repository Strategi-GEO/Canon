import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail } from "@/lib/server/http";

/**
 * Hosted stub. Roadmap generation jobs live in the engine process, and there is no engine
 * here: the engine's own "never had a generation" 404 is the answer the UI already reads as
 * the empty state.
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
  return detail(404, `no roadmap generation job for '${slug}'`);
}
