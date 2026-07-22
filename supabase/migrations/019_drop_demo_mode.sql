-- 019_drop_demo_mode.sql
-- Removes the per-client demo_mode feature. Demo brands (precoded/"mock" fixtures) are gone: the
-- app no longer flags, badges, or refuses them, so the `clients.demo_mode` column and every DB
-- object that reads it come out here. (GEO_MOCK, the old global mock env switch, had no DB
-- object of its own, so nothing about it belongs in this migration.)
--
-- WHAT READS THE COLUMN, and the order that clears it for a clean DROP:
--   1. portal_submit_answers reads clients.demo_mode into v_demo and raises PORTAL:DEMO. Recreated
--      below without that read or guard. A real client never triggered it, and a demo brand can no
--      longer exist to trigger it, so its behaviour for every surviving caller is identical.
--   2. admin_refuse_demo(uuid) exists ONLY to raise on a demo brand, and ~7 admin write functions
--      `perform admin_refuse_demo(v_cid)`. Rather than recreate all seven just to drop one call, it
--      becomes a no-op: the callers keep calling a harmless function and nothing references the
--      column any more. ponytail: no-op stub, excise the dead calls in a later pass if wanted.
--   3. admin_clients is `select *` over clients (migration 003), which froze demo_mode into its
--      column list at creation, so ALTER TABLE ... DROP COLUMN fails against it. Postgres will not
--      let CREATE OR REPLACE VIEW drop a middle column either, so the view is DROPPED, the column
--      is dropped, then the view is recreated (picking up the new column list), re-granted to
--      authenticated, and set back to security_invoker=false to match migration 006.
--
-- Idempotent throughout (create or replace / if exists), and schema.sql folds the same final state
-- in for fresh local builds, so this is safe to apply whether or not the column is still present.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/019_drop_demo_mode.sql

begin;

-- 1: portal_submit_answers, byte-for-byte the migration 014 definition minus the v_demo
-- declaration, the demo_mode read, and the `if v_demo then raise PORTAL:DEMO` guard.
create or replace function portal_submit_answers(
  p_client_slug text,
  p_topic_slug  text,
  p_answers     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid             uuid := auth.uid();
  v_is_admin        boolean;
  v_is_member       boolean;
  v_cid             uuid;
  v_tid             uuid;
  v_form_version    uuid;
  v_current_version uuid;
  v_form_iter       int;
  v_current_iter    int;
  v_row             record;
  v_answer          text;
  v_missing         text[] := '{}';
  v_out             jsonb  := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'PORTAL:BADBODY:answers must be a JSON array of {id, answer}';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_client_slug and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  -- A NON-MEMBER learns nothing: a brand that does not exist and a brand in someone else's
  -- org answer identically. This is the parity the read path already has (RLS folds both to
  -- an empty result), matched on the write path so the two cannot be told apart. 003 added
  -- this and it is carried forward here unchanged.
  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to answer for this account';
  end if;

  -- A member who lacks the answering role is told so plainly: they can already see the brand,
  -- so this reveals nothing, and role vocabulary stays out of the message.
  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to answer for this brand';
  end if;

  select t.id into v_tid
  from topics t
  where t.client_id = v_cid and t.slug = p_topic_slug and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to answer for this account';
  end if;

  -- The current form: the latest asking round, exactly _db_form_rows' definition in
  -- server/questions.py. Older rounds are history, not the form.
  select n.blog_version_id into v_form_version
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
  order by n.created_at desc
  limit 1;
  if v_form_version is null then
    raise exception 'PORTAL:NOTFOUND:the evaluator asked nothing here';
  end if;

  -- Serialize concurrent submits on the form's parent rows: the loser of this lock
  -- re-reads after the winner commits and refuses below as already answered.
  perform 1
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
    and n.blog_version_id = v_form_version
  for update;

  -- The topic's current version, by version_no and not by committed_at: version_no carries
  -- unique (topic_id, version_no), so this ordering is total, while two rows can share a
  -- timestamp and leave "the current version" decided by whichever the planner returned.
  -- Every other reader of "the current draft" in this codebase selects it exactly this way.
  select v.id into v_current_version
  from blog_versions v
  where v.topic_id = v_tid
  order by v.version_no desc
  limit 1;

  select n.asked_iter into v_form_iter
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
    and n.blog_version_id = v_form_version and n.asked_iter is not null
  order by n.created_at, n.ref
  limit 1;

  select coalesce(max(s.iter), 0) into v_current_iter
  from status_events s
  where s.topic_id = v_tid;

  -- VERSION OR ITERATION, the header's rule, in the order the header argues it. The version
  -- arm fires only where a current version was actually found: v_current_version is null only
  -- if the topic has no blog_versions row at all, which the NOT NULL FK on the form's own
  -- anchor makes unreachable while a form exists, and refusing on a failed lookup would turn
  -- a missing row into a client who cannot answer anything.
  --
  -- `is distinct from` on the iteration arm is deliberate and pre-existing: a form carrying no
  -- asked_iter at all is stale, which is what the app twins compute too (a null form iter
  -- never equals the high-water integer).
  if (v_current_version is not null and v_form_version <> v_current_version)
     or (v_form_iter is distinct from v_current_iter) then
    raise exception 'PORTAL:STALE:these questions describe an earlier draft; the editorial team has since moved the article on';
  end if;

  if exists (
      select 1
      from review_notes n
      where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
        and n.blog_version_id = v_form_version
        and exists (select 1 from review_notes r where r.parent_id = n.id)) then
    raise exception 'PORTAL:ANSWERED:this form has already been answered';
  end if;

  for v_row in
    select n.id, n.client_id, n.blog_version_id, n.ref, n.body
    from review_notes n
    where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
      and n.blog_version_id = v_form_version
    order by n.created_at, n.ref
  loop
    select btrim(coalesce(a.elem ->> 'answer', '')) into v_answer
    from jsonb_array_elements(p_answers) a(elem)
    where a.elem ->> 'id' = v_row.ref
    limit 1;

    if v_answer is null or v_answer = '' then
      v_missing := v_missing || coalesce(v_row.ref, '?');
    else
      insert into review_notes
        (topic_id, client_id, blog_version_id, parent_id, author, author_id, body)
      values
        (v_tid, v_row.client_id, v_row.blog_version_id, v_row.id, 'client', v_uid, v_answer);
      v_out := v_out || jsonb_build_object(
        'id', v_row.ref, 'question', v_row.body, 'answer', v_answer);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'PORTAL:INCOMPLETE:%', array_to_string(v_missing, ',');
  end if;

  return jsonb_build_object(
    'slug', p_topic_slug,
    'answered_at', now(),
    'answers', v_out);
end
$$;

-- 2: admin_refuse_demo neutralised to a no-op so its ~7 callers need no recreation and nothing
-- reads the column. The whole reason the function existed is gone; it stays only as a harmless
-- call target. The 009 revoke from public/anon persists across CREATE OR REPLACE.
create or replace function admin_refuse_demo(p_cid uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- demo_mode is removed: there is no demo brand to refuse. No-op on purpose.
  return;
end
$$;

-- 3: drop the frozen-column-list view, drop the column, recreate the view. CREATE OR REPLACE VIEW
-- cannot drop a middle column, so this must be a real DROP + recreate, then the 003 grant and the
-- 006 security_invoker=false are restored.
drop view if exists admin_clients;
alter table clients drop column if exists demo_mode;
create or replace view admin_clients as
  select * from clients where auth_is_admin();
grant select on admin_clients to authenticated;
alter view admin_clients set (security_invoker = false);

commit;
