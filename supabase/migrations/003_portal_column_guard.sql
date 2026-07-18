-- 003_portal_column_guard.sql
-- The client-safe boundary, moved from application code into the DATABASE, plus two
-- portal hardening fixes an adversarial review confirmed.
--
-- THE HOLE THIS CLOSES (critical): migration 001 grants the `authenticated` role SELECT on
-- WHOLE TABLES, and RLS scopes ROWS to the caller's org but never COLUMNS. Before the client
-- portal there were no non-admin authenticated users, so this was latent. seed_org_users.py
-- now mints one authenticated login per client org, and that JWT lives in the client's own
-- browser: a client could take it straight to `${SUPABASE_URL}/rest/v1/blog_versions?select=
-- score,eval_body` (or topics.dossier, clients.canonical_facts, status_events.score/note,
-- ledger_entries.score, review_notes.asked_score) and read every score, hostile-audit eval
-- body, research dossier, do-not-claim fact base and status internal for their own brands.
-- The portal's SELECT lists never ask for those columns, but the SELECT list is not a
-- security control: a direct PostgREST call ignores it. The product contract says client
-- payloads must NEVER carry scores, iterations, stages, eval bodies, dossiers, or status
-- internals, so the enforcement belongs where a hand-crafted request cannot route around it.
--
-- THE FIX: revoke table-wide SELECT from `authenticated` on every table that carries a
-- sensitive column, then re-grant SELECT on the SAFE columns only. PostgreSQL column
-- privileges make a `select=score` by an authenticated JWT fail outright. The portal already
-- selects only safe columns, so it keeps working with no code change (verified against
-- portal-data.ts). Views that expose sensitive columns (topic_rollup, topics_live,
-- v_review_notes) are revoked from `authenticated` outright; the portal reads none of them.
--
-- WHO IS UNAFFECTED: the LOCAL engine and the LOCAL admin dashboard reach Postgres as the
-- table OWNER over the service connection, which bypasses RLS and column grants entirely
-- (schema.sql says so), so nothing about a running Canon install changes. The one consumer
-- that loses direct access to the sensitive columns is the HOSTED (Vercel) admin dashboard,
-- which reads PostgREST as the user: its eval.md / dossier.md / score reads now need an
-- admin-only path. Admin-only full-column views gated on auth_is_admin() are provided at the
-- end for that surface to adopt; the local admin needs none of them.
--
-- Idempotent, additive, safe on a live DB. Apply after 001 and 002:
--   psql "$DATABASE_URL" -f supabase/migrations/003_portal_column_guard.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. Column-scoped SELECT for `authenticated`. Revoke the table, grant safe columns.
-- ---------------------------------------------------------------------------
-- clients: the fact base (canonical_facts), the internal brief (client_md), the gate config
-- (gates), and never_claim are operator material. A client sees only identity + flags.
revoke select on clients from authenticated;
grant select (id, org_id, slug, name, domain, industry, description,
              demo_mode, created_at, deleted_at, preflight_ok, is_fixture, canonical_facts_at)
  on clients to authenticated;

-- topics: the dossier, the links-verified working log, and the NEEDS_REVIEW marker text are
-- internal. Identity, title, ship pointer and timestamps are safe.
revoke select on topics from authenticated;
grant select (id, client_id, slug, title, shipped_version_id, created_at, deleted_at)
  on topics to authenticated;

-- blog_versions: score and eval_body are the whole hostile-audit surface; iteration and
-- superseded_reason are pipeline internals. The article body and its metadata are the
-- client's own content and stay readable.
revoke select on blog_versions from authenticated;
grant select (id, topic_id, client_id, version_no, body, h1_title, word_count,
              shipped, committed_at)
  on blog_versions to authenticated;

-- status_events: score, note, stage, event, ts (run timing) are internals the contract
-- forbids. The portal folds client state from status + iter + line_no only, so those three
-- (plus the keys) are all it may read.
revoke select on status_events from authenticated;
grant select (id, topic_id, client_id, line_no, iter, status)
  on status_events to authenticated;

-- ledger_entries: the score column is the one internal; everything else is the ship record
-- the client's delivered library is built from.
revoke select on ledger_entries from authenticated;
grant select (id, client_id, topic_slug, topic, covers, prompts, generated_at, run_id)
  on ledger_entries to authenticated;

-- review_notes: asked_score is the score at asking time, an internal. The question text,
-- area, why, iteration and the reply rows are what the portal shows and records.
revoke select on review_notes from authenticated;
grant select (id, topic_id, client_id, blog_version_id, parent_id, author, author_id,
              ref, area, body, why, anchor, created_at, asked_iter)
  on review_notes to authenticated;

-- roadmap_sheets: raw_csv (the uploaded bytes) and report (the generation account) are
-- operator material. The portal reads roadmap_rows, not sheets, so grant only the harmless
-- identity columns for any incidental read.
revoke select on roadmap_sheets from authenticated;
grant select (id, client_id, filename, columns, modified, created_at)
  on roadmap_sheets to authenticated;

-- roadmap_uploads: the raw upload bytes. The portal never reads this table; revoke outright.
revoke select on roadmap_uploads from authenticated;

-- roadmap_rows carries no sensitive column (topic, covers, prompts, extras are the plan the
-- client is meant to see), so its table-wide grant stays.

-- Views that re-expose sensitive base columns. The portal reads none of them (it reads base
-- tables with safe selects); the hosted admin reads them and must move to the admin views
-- below. Revoke so an authenticated JWT cannot reach score/eval_body/dossier/asked_score
-- through a view either.
revoke select on topic_rollup  from authenticated;   -- score, iterations
revoke select on topics_live   from authenticated;   -- topics.* incl dossier/review_note
revoke select on v_review_notes from authenticated;  -- review_notes.* incl asked_score

-- ---------------------------------------------------------------------------
-- 2. portal_submit_answers: close the existence oracle.
-- ---------------------------------------------------------------------------
-- The old order looked the client up, raised NOTFOUND (404) when absent, THEN checked
-- membership and raised ROLE (403) for an out-of-scope brand that exists. Probing the RPC
-- with guessed slugs therefore distinguished "exists in another org" (403) from "does not
-- exist" (404): an enumeration oracle over the whole client list, and exactly what the
-- function's own comment claimed it prevented. Fix: a caller who is NOT a member of the
-- brand's org gets the SAME not-found answer whether or not the brand exists. Only a member
-- lacking the answering role gets the distinct ROLE refusal, which tells them nothing they
-- do not already know (they can see the brand).
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
  v_uid          uuid := auth.uid();
  v_is_admin     boolean;
  v_is_member    boolean;
  v_cid          uuid;
  v_demo         boolean;
  v_tid          uuid;
  v_form_version uuid;
  v_form_iter    int;
  v_current_iter int;
  v_row          record;
  v_answer       text;
  v_missing      text[] := '{}';
  v_out          jsonb  := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception 'PORTAL:BADBODY:answers must be a JSON array of {id, answer}';
  end if;

  select c.id, c.demo_mode into v_cid, v_demo
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
  -- an empty result), now matched on the write path so the two cannot be told apart.
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

  if v_demo then
    raise exception 'PORTAL:DEMO:demo brands never run a real revise, so answers are not accepted';
  end if;

  select t.id into v_tid
  from topics t
  where t.client_id = v_cid and t.slug = p_topic_slug and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to answer for this account';
  end if;

  select n.blog_version_id into v_form_version
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
  order by n.created_at desc
  limit 1;
  if v_form_version is null then
    raise exception 'PORTAL:NOTFOUND:the evaluator asked nothing here';
  end if;

  perform 1
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
    and n.blog_version_id = v_form_version
  for update;

  select n.asked_iter into v_form_iter
  from review_notes n
  where n.topic_id = v_tid and n.author = 'evaluator' and n.parent_id is null
    and n.blog_version_id = v_form_version and n.asked_iter is not null
  order by n.created_at, n.ref
  limit 1;

  select coalesce(max(s.iter), 0) into v_current_iter
  from status_events s
  where s.topic_id = v_tid;

  if v_form_iter is distinct from v_current_iter then
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

revoke all on function portal_submit_answers(text, text, jsonb) from public, anon;
grant execute on function portal_submit_answers(text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. portal_revise_claims: an attempts counter, so a persistently failing pickup revise
--    is capped instead of re-dispatched every sweep forever (real quota on each attempt).
-- ---------------------------------------------------------------------------
alter table portal_revise_claims add column if not exists attempts int not null default 0;

-- ---------------------------------------------------------------------------
-- 4. Admin-only full-column views for the HOSTED admin dashboard to adopt. Gated on
--    auth_is_admin(): a non-admin authenticated JWT selecting from these gets zero rows,
--    so they leak nothing even though they carry the sensitive columns. The local admin
--    (engine, owner connection) does not need them; they exist so the hosted read path has
--    a route to eval_body / dossier / score without the base-table grants that leaked.
-- ---------------------------------------------------------------------------
create or replace view admin_blog_versions as
  select * from blog_versions where auth_is_admin();
create or replace view admin_topics as
  select * from topics where auth_is_admin();
create or replace view admin_status_events as
  select * from status_events where auth_is_admin();
create or replace view admin_review_notes as
  select * from review_notes where auth_is_admin();
create or replace view admin_ledger_entries as
  select * from ledger_entries where auth_is_admin();
create or replace view admin_clients as
  select * from clients where auth_is_admin();

alter view admin_blog_versions  set (security_invoker = true);
alter view admin_topics         set (security_invoker = true);
alter view admin_status_events  set (security_invoker = true);
alter view admin_review_notes   set (security_invoker = true);
alter view admin_ledger_entries set (security_invoker = true);
alter view admin_clients        set (security_invoker = true);

grant select on admin_blog_versions, admin_topics, admin_status_events,
  admin_review_notes, admin_ledger_entries, admin_clients to authenticated;

commit;
