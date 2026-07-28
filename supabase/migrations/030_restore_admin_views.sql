-- 030_restore_admin_views.sql
-- Restore the nine admin_* read views the HOSTED admin dashboard depends on.
--
-- THE DRIFT: 003 created six admin_* views, 006 fixed their security_invoker flag, 007 added
-- admin_topic_rollup + admin_topics_live, and 008 added admin_roadmap_sheets. Every one of them
-- was later dropped from the live database, almost certainly by schema.sql's teardown (it
-- `drop ... cascade`s the base views and rebuilds them, and the consolidation that folded 003's
-- revokes into schema.sql never folded the admin views back in). The base tables, the 003
-- column revokes, and every admin_* RPC function are all present; only these nine views are
-- gone, so the hosted /api/me admin branch (listClients -> admin_clients) answers PostgREST 404
-- and the site root renders "Could not open your workspace." The LOCAL engine reads as the table
-- owner and never touches these views, which is why the desktop app is unaffected.
--
-- SAME SHAPE, SAME GATE as 003/006/007/008: definer views (security_invoker = false, so they run
-- as the owner and bypass the base-table column grants that 003 correctly revoked), filtered by
-- auth_is_admin(), granted to authenticated. A non-admin JWT gets `where false` and zero rows;
-- anon is never granted them. No base-table grant is touched, so the client column boundary is
-- exactly as strict as before. The `select *` views auto-carry every column later migrations
-- added (clients.market, roadmap_sheets.month, ...), which is why they are reproduced verbatim.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/030_restore_admin_views.sql

begin;

-- The six full-column base-table views (003 bodies, 006 flag).
create or replace view admin_blog_versions  as select * from blog_versions  where auth_is_admin();
create or replace view admin_topics         as select * from topics         where auth_is_admin();
create or replace view admin_status_events  as select * from status_events  where auth_is_admin();
create or replace view admin_review_notes   as select * from review_notes   where auth_is_admin();
create or replace view admin_ledger_entries as select * from ledger_entries where auth_is_admin();
create or replace view admin_clients        as select * from clients        where auth_is_admin();

-- The status fold (007). Mirrors topic_rollup: last non-running status wins, score is the last
-- eval-end line that carried one, iterations is the high-water mark.
create or replace view admin_topic_rollup as
  select
    t.id as topic_id,
    coalesce(
      (select s.status from status_events s
        where s.topic_id = t.id and s.status <> 'running'::topic_status
        order by s.line_no desc limit 1),
      'running'::topic_status) as status,
    (select s.score from status_events s
      where s.topic_id = t.id and s.stage = 'eval'::run_stage
        and s.event = 'end'::stage_event and s.score is not null
      order by s.line_no desc limit 1) as score,
    coalesce((select max(s.iter) from status_events s where s.topic_id = t.id), 0) as iterations,
    (select count(*) from status_events s where s.topic_id = t.id) as event_count
  from topics t
  where auth_is_admin();

-- Live topics plus has_blog (007). Mirrors topics_live, including its deleted_at is null filter.
create or replace view admin_topics_live as
  select
    t.id, t.client_id, t.slug, t.title, t.dossier, t.dossier_at, t.links_verified,
    t.review_note, t.shipped_version_id, t.created_at, t.deleted_at,
    exists (select 1 from blog_versions v where v.topic_id = t.id) as has_blog
  from topics t
  where t.deleted_at is null and auth_is_admin();

-- The roadmap sheet (008).
create or replace view admin_roadmap_sheets as select * from roadmap_sheets where auth_is_admin();

-- Definer, explicitly: the whole point is to run as owner and reach the revoked columns behind
-- auth_is_admin(). A create-or-replace on an existing invoker view keeps its old flag, so set it.
alter view admin_blog_versions  set (security_invoker = false);
alter view admin_topics         set (security_invoker = false);
alter view admin_status_events  set (security_invoker = false);
alter view admin_review_notes   set (security_invoker = false);
alter view admin_ledger_entries set (security_invoker = false);
alter view admin_clients        set (security_invoker = false);
alter view admin_topic_rollup   set (security_invoker = false);
alter view admin_topics_live    set (security_invoker = false);
alter view admin_roadmap_sheets set (security_invoker = false);

grant select on
  admin_blog_versions, admin_topics, admin_status_events, admin_review_notes,
  admin_ledger_entries, admin_clients, admin_topic_rollup, admin_topics_live,
  admin_roadmap_sheets
  to authenticated;

commit;
