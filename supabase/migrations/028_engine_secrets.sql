-- 028_engine_secrets.sql
-- The engine's secrets, fetched by the desktop app AFTER an operator logs in, so nobody is
-- handed a server/.env file any more.
--
-- WHY THIS EXISTS. Until now every operator got a server/.env with the database URL, the
-- Supabase service key, and the research-tool keys, forwarded by an admin. A forwarded file
-- lives forever and cannot be revoked: disabling the person in Supabase does nothing to the
-- copy on their disk. This moves those same secrets behind a login. The app ships only the
-- PUBLIC half (the project URL and the anon/publishable key, exactly what the Vercel site
-- already ships to every browser), the operator signs in with their own Canon account, and
-- this function hands back the engine secrets ONLY IF they are an admin.
--
-- WHAT THIS IS NOT. It is not a smaller blast radius than the file for a machine that already
-- fetched once: the secrets are cached to that machine's private data folder exactly as the
-- file was, so a compromised laptop is no better and no worse than before. What it buys is
-- REVOCATION AT THE SOURCE and PER-PERSON PROVISIONING: turn the account off and that person
-- can never fetch again from a new machine, and rotating the keys here re-locks every machine
-- at once on its next launch.
--
-- THE SERVICE KEY IS RETURNED, and that is deliberate and unchanged from the file. The engine
-- writes through the service role (server/db.py), so the bootstrap returns the same credential
-- the file always carried. That is why the gate is auth_is_admin() and not merely authenticated:
-- a viewer or a commenter must never receive god-mode DB access, and only operators run the
-- desktop engine at all.
--
-- SAFE ON A LIVE DB: creates one table and one function, grants nothing to anon, and adds no
-- policy that widens any existing read. Seeding is a separate admin step below.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/028_engine_secrets.sql
--
-- THEN SEED ONCE (as the project owner, in the SQL editor), with your real values:
--   insert into engine_secrets (key, value) values
--     ('DATABASE_URL',        '<the same DATABASE_URL your server/.env has>'),
--     ('SUPABASE_URL',        '<your project URL>'),
--     ('SUPABASE_SECRET_KEY', '<your service role / secret key>'),
--     ('FIRECRAWL_API_KEY',   '<...>'),
--     ('DATAFORSEO_USERNAME', '<...>'),
--     ('DATAFORSEO_PASSWORD', '<...>')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
-- Add ANTHROPIC_API_KEY too only if runs should bill an API key instead of each device's
-- own Claude login. Omit any key you do not use; the app writes exactly what it receives.

begin;

-- key/value so a new secret is a row, never a schema change: the app writes whatever keys it
-- receives into server/.env verbatim, so adding one here needs no app release.
create table if not exists engine_secrets (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- RLS ON WITH NO POLICY DENIES ALL DIRECT ACCESS, which is the point: the only read path is the
-- SECURITY DEFINER function below, so no JWT, anon or authenticated, can select the raw table.
alter table engine_secrets enable row level security;
revoke all on engine_secrets from anon, authenticated;

-- The one read path. SECURITY DEFINER so it sees past the table's RLS; admin-gated so only an
-- operator receives the secrets; STABLE because it only reads. Returns a flat json object of
-- key -> value, which the app writes straight into server/.env.
create or replace function get_engine_secrets()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not auth_is_admin() then
    raise exception 'not authorized: engine secrets are available to admins only';
  end if;
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into result from engine_secrets;
  return result;
end
$$;

-- anon (a logged-out caller) must never reach it; a logged-in caller may, and the body still
-- refuses a non-admin. Both halves are needed: the grant lets the RPC be called, the auth_is_admin
-- check inside decides whether it answers.
revoke all on function get_engine_secrets() from anon;
grant execute on function get_engine_secrets() to authenticated;

commit;
