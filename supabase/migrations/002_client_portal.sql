-- 002_client_portal.sql
-- Incremental, additive migration: the client portal's ONE write, and the engine's
-- cross-machine claim table for picking that write up.
--
-- The portal (portal/) is a thin Supabase-direct app: every read runs as the user via
-- PostgREST under the 001 RLS policies, and the SECRET key exists nowhere in it. That
-- leaves exactly one thing a client must be able to DO: answer the evaluator's questions.
-- This migration adds that as a SECURITY DEFINER function rather than an INSERT policy,
-- because the submission is a transaction with rules (whole form or nothing, current form
-- only, one answer round ever), and RLS policies are row-at-a-time predicates that cannot
-- express "every question in this round got a non-blank answer atomically".
--
-- SAFE ON A LIVE DB: every object is additive. authenticated keeps SELECT-only on every
-- table; the one new write path is the function below, which validates caller, role, form
-- currency and completeness before inserting 'client'-authored reply rows into
-- review_notes, the exact shape server/questions.py write_answers inserts for an operator.
--
-- Idempotent: re-running replaces rather than duplicates. Keep in sync with schema.sql,
-- the authority for fresh builds (NOT yet folded in there: schema.sql carries another
-- session's uncommitted work right now, so this file is deliberately self-contained;
-- fold these objects into schema.sql with the next schema commit).
--
--   psql "$DATABASE_URL" -f supabase/migrations/002_client_portal.sql
--
-- After applying, provision org logins:
--   python -m server.seed_org_users --all

begin;

-- ---------------------------------------------------------------------------
-- portal_revise_claims: cross-machine mutual exclusion for the answers pickup
-- ---------------------------------------------------------------------------
-- The engine runs on EVERY teammate's machine (one local engine each, per the product's
-- architecture), and server/client_answers.py sweeps the record for client-answered forms
-- to dispatch the mandatory answer-driven revise. Two engines up at once would both find
-- the same pending form inside one sweep interval and both spend real quota revising the
-- same topic. A claim row is the tiebreak: the engine that inserts it dispatches, the one
-- that conflicts skips. claimed_at lets a claim whose engine died be re-claimed after two
-- hours, so a crash never strands a topic behind a dead claim forever.
--
-- SERVICE PATH ONLY. No browser and no portal handler ever touches this table: the engine
-- connects as the table owner and bypasses RLS; everyone else is revoked outright.
create table if not exists portal_revise_claims (
  topic_id   uuid primary key references topics(id) on delete cascade,
  claimed_by text not null,               -- hostname, informational: who is revising
  claimed_at timestamptz not null default now()
);

alter table portal_revise_claims enable row level security;
revoke all on portal_revise_claims from anon, authenticated;

-- ---------------------------------------------------------------------------
-- portal_submit_answers: the client's one write
-- ---------------------------------------------------------------------------
-- Mirrors the engine's POST /api/clients/{slug}/blogs/{topic}/answers refusal-for-refusal
-- (role -> demo -> not found -> stale -> already answered -> incomplete), because the two
-- are the same act performed from two surfaces and a rule enforced on one but not the
-- other is not a rule. Differences, both deliberate:
--   * author is 'client' (the note_author enum value reserved for exactly this),
--     author_id is auth.uid(), so the record shows WHO answered from WHERE.
--   * a form any of whose questions already has a reply is refused whole. The engine lets
--     an operator overwrite their own answers before the revise consumes them; a client
--     submission is final the moment it lands (the portal freezes the blog on submit), and
--     letting a second submit overwrite the first would falsify what the freeze promised.
--
-- SECURITY DEFINER so the inserts run as the table owner: authenticated deliberately holds
-- zero INSERT grants, and this function is the one gate through which a client write may
-- pass. Every error leaves as 'PORTAL:<CODE>:<detail>' so the portal's route handler can
-- map codes to HTTP statuses without parsing prose.
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
  if v_cid is null then
    -- Out of scope and nonexistent answer identically, the same rule the engine's
    -- _client_or_404 states: a 404 that differs by scope is an existence oracle.
    raise exception 'PORTAL:NOTFOUND:unknown client';
  end if;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  if not v_is_admin then
    if not exists (
        select 1
        from org_membership m
        join org_members om on om.org_slug = m.org_slug
        where m.client_id = v_cid
          and om.user_id = v_uid
          and om.role in ('admin', 'commenter')) then
      -- Covers both the outsider (no grant at all) and a grant without the answering
      -- role. One message, in words a person can read: role vocabulary is an internal
      -- storage detail and never reaches a client, and distinguishing outsider from
      -- under-privileged would tell an outsider the brand exists.
      raise exception 'PORTAL:ROLE:this account is not allowed to answer for this brand';
    end if;
  end if;

  if v_demo then
    raise exception 'PORTAL:DEMO:demo brands never run a real revise, so answers are not accepted';
  end if;

  select t.id into v_tid
  from topics t
  where t.client_id = v_cid and t.slug = p_topic_slug and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:unknown blog';
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

  -- stale mirrors describe_questions: the form's iter against the status_events
  -- high-water iter, not the version anchor (a restore moves the iteration while
  -- keeping the anchor, and the iteration is what the engine reads).
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

  -- Whole form or nothing: the raise aborts this function's transaction, so the inserts
  -- the loop already made roll back with it. A half-answered form never lands.
  if array_length(v_missing, 1) is not null then
    raise exception 'PORTAL:INCOMPLETE:%', array_to_string(v_missing, ',');
  end if;

  return jsonb_build_object(
    'slug', p_topic_slug,
    'answered_at', now(),
    'answers', v_out);
end
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default, and the 001 default-
-- privilege revokes cover only anon. Strip it explicitly, then grant the one caller.
revoke all on function portal_submit_answers(text, text, jsonb) from public, anon;
grant execute on function portal_submit_answers(text, text, jsonb) to authenticated;

commit;
