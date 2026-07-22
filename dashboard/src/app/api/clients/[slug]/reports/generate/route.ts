import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { detail, hostedWriteRefused } from "@/lib/server/http";

/**
 * Hosted stub. Report generation is an SDK session that lives in the engine, and there is no
 * engine here. GET answers the same 404 the engine gives for "never had a generation", which the
 * poll hook already reads as the empty state; POST and DELETE refuse, because generating and
 * clearing a report both happen in the Canon app.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) return unauthenticated();
  const { slug } = await params;
  return detail(404, `no report generation job for '${slug}'`);
}

export async function POST() {
  return hostedWriteRefused("generate a monthly report");
}

export async function DELETE() {
  return hostedWriteRefused("clear a report generation");
}
