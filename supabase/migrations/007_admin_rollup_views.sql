-- 007_admin_rollup_views.sql
-- The two admin views migration 003 forgot, so the HOSTED dashboard can be deployed.
--
-- 003 revoked three views from `authenticated` outright, because each re-exposes sensitive
-- base columns through a select *:
--
--   topic_rollup    score, iterations
--   topics_live     topics.* including dossier and review_note
--   v_review_notes  review_notes.* including asked_score
--
-- That was right: a client's JWT must not read scores or dossiers by any route, and a view is
-- a route. 003 then built admin_* counterparts for the BASE TABLES it had column-scoped
-- (blog_versions, topics, status_events, review_notes, ledger_entries, clients) so the hosted
-- admin surface had somewhere to go. It built none for the two rollup views it had revoked, so
-- the hosted dashboard's status fold and its per-client blog counts had no admin path at all
-- and answered 502 on Vercel. 006 made the existing admin views work; this adds the missing
-- pair so the whole hosted read surface is reachable.
--
-- SAME SHAPE, SAME GATE as every view 006 fixed: definer (security_invoker unset, so false),
-- owned by the migration role, and filtered by auth_is_admin(). A non-admin authenticated JWT
-- gets `where false` and therefore zero rows; `anon` is not granted them at all. No base-table
-- grant changes, so the column guard 003 installed is untouched and a client still cannot read
-- score, dossier or asked_score anywhere.
--
-- v_review_notes gets no counterpart here deliberately: admin_review_notes already exposes the
-- same rows with the full column set, and the hosted questions route reads that instead. A
-- second view over the same rows is a second thing to keep in step for no gain.
--
-- The bodies below are copied from the revoked views rather than selecting from them, because
-- selecting from a revoked view inside a definer view would work but would hide WHICH relation
-- the rows come from behind two hops. One hop, one definition, greppable.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/007_admin_rollup_views.sql

begin;

-- The status fold: last non-running status wins, the score is the last eval-end line that
-- carried one, iterations is the high-water mark. Mirrors topic_rollup exactly.
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

-- Live topics plus has_blog. Mirrors topics_live, including its deleted_at is null filter.
create or replace view admin_topics_live as
  select
    t.id, t.client_id, t.slug, t.title, t.dossier, t.dossier_at, t.links_verified,
    t.review_note, t.shipped_version_id, t.created_at, t.deleted_at,
    exists (select 1 from blog_versions v where v.topic_id = t.id) as has_blog
  from topics t
  where t.deleted_at is null and auth_is_admin();

grant select on admin_topic_rollup, admin_topics_live to authenticated;

commit;
