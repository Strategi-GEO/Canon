import { unauthenticated, verifyRequest } from "@/lib/server/auth";
import { readClient } from "@/lib/server/clients";
import { detail, failure, json } from "@/lib/server/http";
import { rpc } from "@/lib/server/postgrest";
import { adminRpcError } from "@/lib/server/admin-rpc";

/**
 * One client, mirroring the engine's GET /api/clients/{slug}: the client shape without the
 * preflight decoration (which only the list carries). Out of scope answers the SAME 404 as
 * does-not-exist, which RLS gives us for free: no row either way.
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
    const client = await readClient(user.token, slug);
    if (client === null) {
      return detail(404, `unknown client '${slug}'`);
    }
    return json(client);
  } catch (cause) {
    return failure(cause);
  }
}

/**
 * Edit one brand's settings: its name, description, domain and industry.
 *
 * All authority lives in admin_update_client (supabase/migrations/009_admin_write_tier.sql).
 * A null field means "not sent" and is left alone, so a PATCH carrying one key cannot blank
 * the others, matching the engine's update_client exactly.
 *
 * FOUR FIELDS, AND THE SIGNATURE IS THE SECURITY BOUNDARY. gates, client_md, canonical_facts,
 * demo_mode and org_id are not writable from here. That is not an oversight of scope: 003
 * spent a whole migration revoking READ access to gates, client_md and canonical_facts from
 * `authenticated`, and a write path into a column the caller may not read would be strictly
 * more powerful than the read path that was deliberately closed.
 *
 * organisation_name is excluded for a different reason and it is worth stating, because the
 * local engine accepts it here. _upsert_org does `on conflict (slug) do update set name =
 * excluded.name`, which renames the org for EVERY brand under it. No per-brand check can scope
 * that, because orgs carries no client_id, so it is a cross-tenant write wearing a
 * brand-scoped costume and it stays on the engine where one operator owns the machine.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await verifyRequest(request);
  if (user === null) {
    return unauthenticated();
  }
  const { slug } = await params;

  let body: {
    name?: unknown;
    description?: unknown;
    domain?: unknown;
    industry?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return detail(422, "a JSON body with the fields to change is required");
  }
  if (body === null || typeof body !== "object") {
    return detail(422, "a JSON body with the fields to change is required");
  }

  // An ABSENT key and a null both mean "leave this alone", so each field is forwarded as null
  // unless a string actually arrived. A String() coercion here would turn an absent key into
  // the literal "undefined" and write it into the brand.
  const asText = (v: unknown) => (typeof v === "string" ? v : null);

  try {
    const updated = await rpc<Record<string, unknown>>(user.token, "admin_update_client", {
      p_brand: slug,
      p_name: asText(body.name),
      p_description: asText(body.description),
      p_domain: asText(body.domain),
      p_industry: asText(body.industry),
    });
    return json(updated);
  } catch (cause) {
    return adminRpcError(cause);
  }
}
