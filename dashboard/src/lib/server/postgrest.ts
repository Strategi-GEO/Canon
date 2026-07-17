import { supabaseAnonKey, supabaseUrl } from "@/lib/server/env";

/**
 * The one PostgREST client for the hosted-mode Route Handlers.
 *
 * Every query runs AS THE CALLER: apikey is the anon key (role selection only) and the
 * Authorization header is the user's own JWT, so Row Level Security scopes every row and
 * these handlers never re-implement the engine's scope checks. A brand outside the caller's
 * grants simply yields no rows, which the handlers render as the same 404 the engine gives
 * for a brand that does not exist.
 *
 * SELECT only by construction: `authenticated` holds SELECT grants and nothing else
 * (supabase/migrations/001_auth_identity.sql), so even a bug here could not mutate.
 */

export class PostgrestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PostgrestError";
    this.status = status;
  }
}

/** One GET against /rest/v1. `path` starts with the table or view name, query string included. */
export async function pg<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    headers: {
      apikey: supabaseAnonKey(),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new PostgrestError(res.status, `postgrest ${res.status} on ${path.split("?")[0]}: ${body}`);
  }
  return (await res.json()) as T;
}

/** PostgREST `in.(...)` needs each value quoted; uuids and slugs are safe but quote anyway. */
export function inList(values: string[]): string {
  return `in.(${values.map((value) => `"${value}"`).join(",")})`;
}
