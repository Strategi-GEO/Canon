-- 022_admin_manage_resources.sql
-- Resources become common to admins and clients, not client-only.
--
-- 015 built auth_can_write_client_slug with NO admin bypass, so a Strategi operator could read
-- a brand's knowledge base but never add or remove a file: only client members could. The
-- product rule changed. Admins manage resources from the console and clients manage them from
-- the portal, both able to view, download and delete, so this predicate now mirrors
-- auth_can_read_client_slug: admin OR a brand's own writing member.
--
-- ONE function, redefined. Every resource write door already routes through it, so this one
-- change reaches all of them at once: the storage INSERT/DELETE policies (resources_insert_scoped,
-- resources_delete_scoped), portal_resource_add and portal_resource_remove. A member still needs
-- the writing role; the bypass only adds admins, it does not drop the role gate.
--
-- SAFE ON A LIVE DB: create or replace on one function, no table or policy touched. The engine
-- connects with the secret key and bypasses RLS, so nothing changes for it. Keep in sync with
-- schema.sql, the authority for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/022_admin_manage_resources.sql

begin;

create or replace function auth_can_write_client_slug(cslug text) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
      or exists (
    select 1 from org_membership m
    join org_members om on om.org_slug = m.org_slug
    where m.client_slug = cslug
      and om.user_id = auth.uid()
      and om.role in ('admin', 'commenter')
  )
$$;

commit;
