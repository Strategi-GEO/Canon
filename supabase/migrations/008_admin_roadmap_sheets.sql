-- 008_admin_roadmap_sheets.sql
-- The last admin view the hosted dashboard needs: the roadmap sheet itself.
--
-- 003 column-scoped roadmap_sheets to (id, client_id, filename, columns, modified, created_at)
-- and left raw_csv and report ungranted. That was a judgement call rather than an obvious leak,
-- and it holds: raw_csv is the operator's whole uploaded sheet, and report is the generation
-- report describing how it was built, neither of which a client has any business reading off
-- PostgREST. But 003 built no admin_* counterpart for this table, so the hosted sheet preview
-- and the generation report had nowhere to read from and answered 502 on Vercel, exactly like
-- the rollup views 007 restored.
--
-- Same shape and same gate as 006 and 007: definer (security_invoker unset), filtered by
-- auth_is_admin(), granted to authenticated, and no base-table grant is touched. A non-admin
-- gets zero rows; `anon` cannot reach it at all.
--
-- roadmap_uploads is deliberately NOT given a view. 003 revoked it outright as "the raw upload
-- bytes, the portal never reads this table", no hosted route reads it either, and inventing an
-- admin path for a table nothing asks for is new surface bought for nothing. Add one when a
-- reader actually exists.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/008_admin_roadmap_sheets.sql

begin;

create or replace view admin_roadmap_sheets as
  select * from roadmap_sheets where auth_is_admin();

grant select on admin_roadmap_sheets to authenticated;

commit;
