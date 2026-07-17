import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail } from "@/lib/server/http";

/**
 * Hosted stub. Describe jobs live in the engine process, and there is no engine here, so the
 * honest answer is the engine's own "no draft job" 404, which every caller already treats as
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
  return detail(404, `no draft job for '${slug}'`);
}
