import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { validClientSlug } from "@/lib/server/clients";
import { detail, failure, text } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

/**
 * The engine's GET /api/clients/{slug}/facts: the brand's canonical-facts.md as text/plain,
 * from the same canonical_facts column the engine reads. 404 is the EMPTY STATE, not an
 * error: a brand whose fact base has never been built.
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
  try {
    if (!validClientSlug(slug)) {
      return detail(404, `unknown client '${slug}'`);
    }
    const rows = await pg<{ canonical_facts: string | null }[]>(
      user.token,
      // admin_clients: canonical_facts is the do-not-claim fact base, revoked from `authenticated`.
      `admin_clients?select=canonical_facts&slug=eq.${slug}&deleted_at=is.null`,
    );
    const row = rows[0];
    if (row === undefined) {
      return detail(404, `unknown client '${slug}'`);
    }
    if (row.canonical_facts === null) {
      return detail(404, `no canonical-facts.md for '${slug}'`);
    }
    return text(row.canonical_facts);
  } catch (cause) {
    return failure(cause);
  }
}
