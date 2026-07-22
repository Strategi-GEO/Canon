-- 024_resources_admin_only.sql
-- Resources become ADMIN-ONLY. A client gets no access at all: no list, no download, no
-- upload, no delete, on any brand.
--
-- 022 made resources common to admins and clients. The product rule changed again: the
-- resources tab is the operator's alone. This reaches every door resources have.
--
--   WRITES (upload + delete). auth_can_write_client_slug is the ONE function every resource
--   write routes through: the storage resources_insert_scoped and resources_delete_scoped
--   policies, portal_resource_add and portal_resource_remove, exactly as 022 documented.
--   Redefining it to admin-only closes all four at once. Its cslug argument is now vestigial:
--   an admin may write any brand's resources and a non-admin may write none, so the slug no
--   longer decides. The signature is kept because those four callers pass it.
--
--   READS (list + download). Two policies, swapped in place rather than the function beneath
--   them, because that function is SHARED. auth_can_read_client backs every membership read in
--   the app (blogs, roadmap, status), and auth_can_read_client_slug backs client REPORTS too
--   (020), so touching either would pull client access off things clients must keep. Only the
--   two resource-specific policies move to auth_is_admin().
--
-- SAFE ON A LIVE DB: create-or-replace on one function, drop-then-create on two policies, no
-- table touched. The engine connects with the secret key and bypasses RLS, so nothing changes
-- for it. Keep in sync with schema.sql, the authority for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/024_resources_admin_only.sql

begin;

-- WRITES: the one choke point, now admin-only. cslug is ignored (see header).
create or replace function auth_can_write_client_slug(cslug text) returns boolean
  language sql stable security definer set search_path = public as $$
  select auth_is_admin()
$$;

-- READS: the two resource-specific policies, admin-only. The shared functions beneath the
-- other read policies are deliberately untouched (see header).
drop policy if exists read_scoped on client_resources;
create policy read_scoped on client_resources for select to authenticated
  using (auth_is_admin());

drop policy if exists resources_read_scoped on storage.objects;
create policy resources_read_scoped on storage.objects for select to authenticated
  using (
    bucket_id = 'resources'
    and auth_is_admin()
  );

commit;
