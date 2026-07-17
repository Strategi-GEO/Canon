import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { byteCompare, groupOrgs, listClients } from "@/lib/server/clients";
import { failure, json } from "@/lib/server/http";
import { pg } from "@/lib/server/postgrest";

/**
 * Who this token is to the app, mirroring the engine's GET /api/me.
 *
 * Every read below runs AS THE USER, so RLS answers the questions the engine answers from
 * its identity tables: is_admin is whether the caller can see their own app_admins row, and
 * a non-admin's orgs and clients come from their org_members grants fanned out through the
 * org_membership view. An admin gets the full org and client lists, exactly as the engine's
 * unfiltered answer, because RLS shows an admin every row.
 */
export async function GET(request: Request) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }

  try {
    const adminRows = await pg<{ user_id: string }[]>(
      user.token,
      `app_admins?select=user_id&user_id=eq.${user.userId}`,
    );
    const isAdmin = adminRows.length > 0;

    let orgs: { slug: string; name: string }[];
    let clients: string[];

    if (isAdmin) {
      // Everything, exactly as the pre-auth app answered: the org and client lists ARE the
      // admin's scope. list_orgs skips fixtures; the client slugs include them.
      const listed = await listClients(user.token);
      orgs = groupOrgs(listed.map((entry) => entry.shape)).map((org) => ({
        slug: org.slug,
        name: org.name,
      }));
      clients = listed.map((entry) => entry.shape.slug);
    } else {
      // The org grant fans out to every live brand in the org through org_membership, so a
      // brand moving between orgs moves the user's access with it, for free. RLS already
      // filters org_membership to the brands this caller can read.
      const [grants, membership] = await Promise.all([
        pg<{ org_slug: string }[]>(
          user.token,
          `org_members?select=org_slug&user_id=eq.${user.userId}`,
        ),
        pg<{ org_slug: string; org_name: string; client_slug: string }[]>(
          user.token,
          "org_membership?select=org_slug,org_name,client_slug",
        ),
      ]);
      const granted = new Set(grants.map((grant) => grant.org_slug));
      const orgNames = new Map<string, string>();
      const slugs = new Set<string>();
      for (const row of membership) {
        if (!granted.has(row.org_slug)) {
          continue;
        }
        orgNames.set(row.org_slug, row.org_name);
        slugs.add(row.client_slug);
      }
      orgs = [...orgNames.entries()]
        .sort((a, b) => byteCompare(a[0], b[0]))
        .map(([slug, name]) => ({ slug, name }));
      clients = [...slugs].sort(byteCompare);
    }

    return json({
      user_id: user.userId,
      email: user.email,
      is_admin: isAdmin,
      orgs,
      clients,
    });
  } catch (cause) {
    return failure(cause);
  }
}
