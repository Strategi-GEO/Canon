import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { clientId, readLedger } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";

/** The engine's GET /api/clients/{slug}/ledger: every shipped-blog row, oldest first. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;
  try {
    const cid = await clientId(user.token, slug);
    if (cid === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    return json({ rows: await readLedger(user.token, cid) });
  } catch (cause) {
    return failure(cause);
  }
}
