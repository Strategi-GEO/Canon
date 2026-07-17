-- 001_auth_identity.sql
-- Incremental, additive migration: authentication / authorization identity.
--
-- Adds app_admins + org_members, the auth predicate functions, RLS read policies
-- scoped by membership, the view security_invoker flags, and SELECT grants to the
-- `authenticated` role. SAFE ON A LIVE DB: every object is additive and every
-- policy/grant targets `authenticated` only. The engine connects as the table
-- owner and BYPASSES RLS, so nothing about current behavior changes.
--
-- Idempotent: re-running replaces rather than duplicates. Keep in sync with
-- schema.sql, which is the authority for fresh builds. This file exists so the
-- LIVE database can be upgraded WITHOUT a drop/rebuild of the content schema.
--
--   psql "$DATABASE_URL" -f supabase/migrations/001_auth_identity.sql
--
-- After applying, seed the first admin:
--   python -m server.seed_admin --email you@strategi.is

begin;

-- security_invoker on views requires PostgreSQL 15+. Without it the four views
-- below run as owner (BYPASSRLS) and leak every row past RLS the moment an
-- authenticated token reaches Postgres directly. Fail loudly, never silently.
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception
      'geo-factory auth migration needs PostgreSQL 15+ (security_invoker views); found %',
      current_setting('server_version');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Identity tables
-- ---------------------------------------------------------------------------
-- A row in app_admins IS the admin grant (sees all orgs and brands). org_members
-- scopes a client login at the ORG, keyed on the DERIVED org slug
-- (coalesce(orgs.slug, clients.slug)) that org_membership exposes, NOT on
-- orgs.id: only explicit multi-brand orgs have an orgs row, so a uuid FK would
-- cover acme-group alone and strand every single-brand client. Both slugs are
-- immutable, so the key never rewrites; a brand moving between orgs re-derives
-- its org_slug through the view at read time, so access follows the move for
-- free. user_id is a bare uuid (auth.users(id)) with no FK, exactly like
-- client_members: this schema must not couple to Supabase's auth schema.
create table if not exists app_admins (
  user_id    uuid primary key,              -- auth.users(id)
  email      text not null,                 -- denormalised for display; auth.users is not ours to join
  added_by   uuid,                          -- auth.users(id) who granted it; null for the seed admin
  created_at timestamptz not null default now()
);

create table if not exists org_members (
  org_slug   client_slug not null,          -- coalesce(orgs.slug, clients.slug); see org_membership
  user_id    uuid not null,                 -- auth.users(id)
  role       text not null check (role in ('admin','viewer','commenter')),
  created_at timestamptz not null default now(),
  primary key (org_slug, user_id)
);
create index if not exists org_members_user on org_members (user_id);

alter table app_admins  enable row level security;
alter table org_members enable row level security;
revoke all on app_admins  from anon;
revoke all on org_members from anon;

-- ---------------------------------------------------------------------------
-- Auth predicate functions
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the predicate can read the membership tables regardless of
-- the caller's own RLS, using Supabase's auth.uid() (request.jwt.claims.sub).
create or replace function auth_is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_admins a where a.user_id = auth.uid())
$$;

create or replace function auth_org_slugs() returns setof client_slug
  language sql stable security definer set search_path = public as $$
  select om.org_slug from org_members om where om.user_id = auth.uid()
$$;

-- The one predicate every client_id-bearing table reuses.
create or replace function auth_can_read_client(cid uuid) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
      or exists (
        select 1 from org_membership m
        where m.client_id = cid
          and m.org_slug in (select auth_org_slugs())
      )
$$;

revoke all on function auth_is_admin(), auth_org_slugs(), auth_can_read_client(uuid) from anon;
grant execute on function auth_can_read_client(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Views must run as invoker or they leak (a view runs as its owner by default)
-- ---------------------------------------------------------------------------
alter view org_membership set (security_invoker = true);
alter view topic_rollup   set (security_invoker = true);
alter view topics_live    set (security_invoker = true);
alter view v_review_notes set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- RLS read policies, scoped by membership. authenticated + SELECT only; every
-- write stays on the service path. drop-then-create keeps this idempotent.
-- ---------------------------------------------------------------------------

-- Tables whose row scope IS their client_id:
drop policy if exists read_scoped on client_resources;
create policy read_scoped on client_resources for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on roadmap_uploads;
create policy read_scoped on roadmap_uploads  for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on roadmap_sheets;
create policy read_scoped on roadmap_sheets    for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on roadmap_rows;
create policy read_scoped on roadmap_rows      for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on topics;
create policy read_scoped on topics            for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on blog_versions;
create policy read_scoped on blog_versions     for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on status_events;
create policy read_scoped on status_events     for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on ledger_entries;
create policy read_scoped on ledger_entries    for select to authenticated
  using (auth_can_read_client(client_id));
drop policy if exists read_scoped on review_notes;
create policy read_scoped on review_notes      for select to authenticated
  using (auth_can_read_client(client_id));

-- clients: the scope key is the row's own id
drop policy if exists read_scoped on clients;
create policy read_scoped on clients for select to authenticated
  using (auth_can_read_client(id));

-- orgs: admins see all; a member sees the explicit orgs they belong to
drop policy if exists read_scoped on orgs;
create policy read_scoped on orgs for select to authenticated
  using (auth_is_admin() or slug in (select auth_org_slugs()));

-- identity tables: admins see all; a user sees their own memberships
drop policy if exists self_or_admin on app_admins;
create policy self_or_admin on app_admins  for select to authenticated
  using (auth_is_admin() or user_id = auth.uid());
drop policy if exists self_or_admin on org_members;
create policy self_or_admin on org_members for select to authenticated
  using (auth_is_admin() or user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Grants. RLS filters rows but the role still needs table privilege. SELECT
-- only, so even a stolen token cannot mutate; every write stays on the service
-- connection. client_members is intentionally NOT granted: its per-brand overlay
-- is resolved in Python (server/auth.py), never over the browser-direct path.
-- ---------------------------------------------------------------------------
grant select on clients, orgs, client_resources, roadmap_uploads, roadmap_sheets,
  roadmap_rows, topics, blog_versions, status_events, ledger_entries, review_notes,
  org_membership, topic_rollup, topics_live, v_review_notes,
  app_admins, org_members
  to authenticated;

commit;
