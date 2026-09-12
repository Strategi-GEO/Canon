/**
 * Server-side configuration for the hosted-mode Route Handlers. SERVER ONLY: nothing here is
 * NEXT_PUBLIC_, and nothing here may ever hold the Supabase SECRET key. The handlers speak
 * GoTrue and PostgREST with the ANON key plus the caller's own JWT, so RLS answers every
 * scoping question and a leaked deployment env cannot mutate anything.
 *
 * Read lazily, at request time, never at module scope: a module-scope read would make
 * `next build` depend on deployment env.
 *
 * THESE HANDLERS ARE NOT DEAD CODE LOCALLY, and an earlier version of this comment said they
 * were. Only the ADMIN surface talks to the FastAPI engine; the CLIENT PORTAL calls these
 * handlers same-origin in every mode, so a local dashboard with no SUPABASE_ANON_KEY has a
 * working admin side and a portal that answers 401 to everything. That failure used to be
 * indistinguishable from a wrong password: login succeeded against the engine, the redirect to
 * `/` asked THESE handlers who the caller was, they could not answer, and the app bounced back
 * to `/login` with no error. `unauthenticated()` now separates the two. Local portal work needs
 * dashboard/.env.local; see dashboard/.env.example.
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
