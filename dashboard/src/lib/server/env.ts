/**
 * Server-side configuration for the hosted-mode Route Handlers. SERVER ONLY: nothing here is
 * NEXT_PUBLIC_, and nothing here may ever hold the Supabase SECRET key. The handlers speak
 * GoTrue and PostgREST with the ANON key plus the caller's own JWT, so RLS answers every
 * scoping question and a leaked deployment env cannot mutate anything.
 *
 * Read lazily, at request time, never at module scope: the LOCAL build runs with none of
 * these set (the browser talks to the FastAPI engine and these handlers are dead code), and
 * a module-scope read would make `next build` depend on deployment env.
 */

export class MissingEnv extends Error {}

export function supabaseUrl(): string {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  if (url === "") {
    throw new MissingEnv("SUPABASE_URL is not set");
  }
  return url;
}

export function supabaseAnonKey(): string {
  const key = process.env.SUPABASE_ANON_KEY ?? "";
  if (key === "") {
    throw new MissingEnv("SUPABASE_ANON_KEY is not set");
  }
  return key;
}
