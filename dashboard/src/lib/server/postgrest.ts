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
 * Reads are SELECT only by construction: `authenticated` holds SELECT grants and nothing
 * else (supabase/migrations/001_auth_identity.sql). The ONE write is rpc() below calling
 * portal_submit_answers, a SECURITY DEFINER function that authorizes its caller itself; no
 * other RPC exists, and no service key exists anywhere in this app.
 */

export class PostgrestError extends Error {
  readonly status: number;
  /** PostgREST's own error body, parsed when it was JSON: {code, message, details, hint}. */
  readonly body: { code?: string; message?: string } | null;

  constructor(status: number, message: string, body: { code?: string; message?: string } | null = null) {
    super(message);
    this.name = "PostgrestError";
    this.status = status;
    this.body = body;
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

/**
 * One RPC against /rest/v1/rpc/{fn}, as the caller. A plpgsql `raise exception` comes back
 * as a 400 whose JSON body carries the message; it is parsed here so the answers handler
 * can map the function's PORTAL:<CODE>:<detail> protocol onto HTTP statuses.
 */
export async function rpc<T>(token: string, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${supabaseUrl()}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey(),
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: { code?: string; message?: string } | null = null;
    try {
      parsed = JSON.parse(text) as { code?: string; message?: string };
    } catch {
      // Not JSON: the raw text still travels in the error message.
    }
    throw new PostgrestError(res.status, parsed?.message ?? `rpc ${fn} failed: ${text}`, parsed);
  }
  return (await res.json()) as T;
}

/** PostgREST `in.(...)` needs each value quoted; uuids and slugs are safe but quote anyway. */
export function inList(values: string[]): string {
  return `in.(${values.map((value) => `"${value}"`).join(",")})`;
}
