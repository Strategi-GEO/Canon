-- 009_admin_write_tier.sql
-- The admin write tier for the HOSTED dashboard.
--
-- WHY: the hosted app could read everything after 006-008 and write almost nothing. The
-- `authenticated` role has no INSERT/UPDATE/DELETE grant on any table and every RLS policy is
-- SELECT-only, so the only writes reaching Postgres from a browser are the four portal_*
-- definer functions, all of them client-side actions. An operator on Vercel could watch the
-- review loop and not move it: they could not release a blog, resolve a request, fix a typo,
-- or correct a brand name. This adds the operator half.
--
-- ============================================================================
-- THE AUTHORISATION RULE, STATED ONCE. Every function here obeys it.
-- ============================================================================
-- Gate on auth_is_admin() and NOTHING ELSE, then resolve the brand and the topic from the
-- TEXT SLUGS the caller passed, and raise ONE indistinguishable refusal when the caller is
-- not an admin OR either lookup came back empty.
--
-- It deliberately does NOT copy portal_approve_blog's shape. That function carries
--     v_is_admin or exists (select 1 from org_membership ... where om.user_id = v_uid)
-- because it is a CLIENT action a client must be able to perform. Reusing it here would be a
-- privilege widening wearing a hardening's clothes: seed_org_users.py mints one authenticated
-- login per client org and that JWT lives in the client's own browser, so the membership arm
-- would hand every client operator-level writes over their own brand. The concrete failure is
-- not hypothetical: a client could dismiss the very suggestion that blocks a re-send, and
-- mark_sent's open-suggestion guard is the thing standing between them and an article
-- released over a request nobody answered.
--
-- An admin is GLOBAL. app_admins has no org_slug or client_id column, server/auth.py returns
-- Identity(is_admin=True) before it ever queries membership, and every RLS policy reads
-- `auth_is_admin() or <scoped>`. So auth_is_admin() alone is complete authorisation, and a
-- per-brand check would be a check against a table an admin has no rows in.
--
-- NEVER ACCEPT AN ID. Every function takes text slugs and derives ids internally. A
-- p_topic_id or p_version uuid parameter would let any logged-in caller name another org's
-- row, and the WHERE would key on the id while the brand check looked at something unrelated.
--
-- NO ENUMERATION ORACLE. Non-admin, unknown brand and unknown topic all raise the same
-- NOTFOUND sentence. 003 fixed exactly this oracle in portal_submit_answers by moving the
-- membership test in front of the existence test; for an admin-only function that collapses
-- to admin-before-existence, and the refusal must not name which lookup failed.
--
-- ============================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ============================================================================
-- * ADDING A BRAND. create_client builds a 55-line client.md from a Python template and
--   assembles the gates blob in Python. A row inserted here would have no client_md and no
--   gates, so materialize_client would lay down no client.md and an empty gates.json, and
--   .claude/gates.py exits 2 on a missing config. The result is a brand that cannot be run.
--   Reproducing the template in plpgsql is a second copy of a thing that will drift.
-- * RESOLVING A COMMENT WITH CLAUDE. That is an Agent SDK session, not a row.
-- * THE GATE RUN on upload. gates.py is a subprocess. admin_upload_blog therefore reports the
--   gates as NOT RUN, and never as passed.
--
-- ============================================================================
-- GUARDS THAT CANNOT CROSS, AND WHAT REPLACES THEM
-- ============================================================================
-- The engine refuses a write while a run is live for the brand (_client_has_live_run reads
-- runner.RUNS, an in-memory dict). There is no liveness table in this schema, so that guard
-- cannot be reproduced. Its DB-visible stand-in is the topic's own fold: topic_rollup.status.
-- A topic mid-run has no terminal line and folds to 'running', so requiring 'done' refuses
-- exactly the topics a live run could be touching. It is NARROWER than the engine's brand-wide
-- refusal, and narrower is correct here: commit_topic writes one topic's directory, so a run
-- on topic A cannot race a write to topic B.
--
-- topic_rollup is READ, never re-implemented. Its header records that it was verified against
-- the engine's own summariser across 1,339 status lines and 50 topics with zero mismatches. A
-- second fold written by hand here would drift, and the drift would be silent: ordering by
-- created_at instead of line_no, or dropping the terminal filter, admits needs_review (a blog
-- held for an unanswered question) and stopped (half-written artifacts) into actions that must
-- see only shipped work.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/009_admin_write_tier.sql

begin;

-- ---------------------------------------------------------------------------
-- Shared resolver. Every function starts here.
-- ---------------------------------------------------------------------------
-- Returns the live client id for a slug, or raises the ONE refusal. Being a separate function
-- keeps the rule in a single place, so a later function cannot quietly implement a weaker
-- version of it. SECURITY DEFINER because it reads clients, which `authenticated` may only
-- read column-scoped, and it must answer for a brand the caller may not be able to see.
create or replace function admin_brand_id(p_brand text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid uuid;
begin
  if auth.uid() is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  -- Admin FIRST, and the same refusal as a missing brand, so a non-admin probing slugs
  -- learns nothing about which brands exist.
  if not auth_is_admin() then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;
  select c.id into v_cid from clients c
   where c.slug = p_brand and c.deleted_at is null;
  if v_cid is null then
    raise exception 'PORTAL:NOTFOUND:no such brand for this account';
  end if;
  return v_cid;
end
$$;

-- Refuses a demo fixture, reproducing runner.is_demo_client from the RECORD rather than from
-- clients/<slug>/gates.json. The two cannot disagree: clients.py writes demo_mode into the
-- gates blob from this same column, so the file is a copy of this and not the other way round.
create or replace function admin_refuse_demo(p_cid uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (select 1 from clients where id = p_cid and demo_mode) then
    raise exception 'PORTAL:DEMO:this brand is a demo fixture, so its blogs are placeholder text and are never delivered';
  end if;
end
$$;

-- The topic, scoped to the brand, plus the fold. Raises the same NOTFOUND, and refuses any
-- topic that is not `done` with a distinct code so the UI can say which of the two it was.
create or replace function admin_done_topic(p_cid uuid, p_topic text, p_act text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tid    uuid;
  v_status topic_status;
begin
  select t.id into v_tid from topics t
   where t.client_id = p_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no such blog for this account';
  end if;
  -- READ the fold, never re-derive it. See the header.
  select r.status into v_status from topic_rollup r where r.topic_id = v_tid;
  if v_status is distinct from 'done'::topic_status then
    raise exception 'PORTAL:NOTDONE:this blog is %, not done; % is for shipped blogs only',
      coalesce(v_status::text, 'unknown'), p_act;
  end if;
  return v_tid;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Send to client
-- ---------------------------------------------------------------------------
-- Mirrors blog_edit.mark_sent exactly, including the two things that make it correct:
--
-- sent_version_id is a CORRELATED SUBSELECT inside the SET list, never a parameter. A
-- caller-supplied version would let someone pin the client to a pre-edit draft and have them
-- approve that instead of the current article.
--
-- THE OPEN-SUGGESTION REFUSAL IS A WHERE CLAUSE, NOT A COUNTED PRE-CHECK. mark_sent's own
-- comment explains why: check-then-act across two statements is exactly wide enough for a
-- portal write to land in between, so the count returns zero, the client files a suggestion,
-- and the send goes out over a request nobody has seen. Zero rows updated IS the refusal.
-- `for update` on the topic row first, closing the READ COMMITTED residue the engine names.
create or replace function admin_send_blog_to_client(p_brand text, p_topic text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid  uuid := admin_brand_id(p_brand);
  v_tid  uuid;
  v_mail text := coalesce(auth.jwt() ->> 'email', '');
  v_rows int;
  v_out  jsonb;
begin
  perform admin_refuse_demo(v_cid);
  v_tid := admin_done_topic(v_cid, p_topic, 'sending to the client');

  perform 1 from topics where id = v_tid for update;

  update topics
     set sent_to_client_at = now(),
         sent_to_client_by = nullif(v_mail, ''),
         sent_version_id = (
           select v.id from blog_versions v
            where v.topic_id = topics.id
            order by v.version_no desc limit 1),
         client_approved_at = null,
         client_approved_by = null
   where id = v_tid
     and not exists (
       select 1 from blog_comments c
        where c.topic_id = topics.id and c.author = 'client'
          and c.parent_id is null
          and c.state in ('open', 'applying'));
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'PORTAL:OPENSUGGESTIONS:the client''s suggestions are still open; resolve or dismiss each one before sending again';
  end if;

  -- Read back in the SAME transaction the write happened in, so the answer cannot describe a
  -- state some other session moved to in between. The engine reads this in a second
  -- transaction and can report a changes_requested that was already stale on arrival.
  select jsonb_build_object(
           'sent_to_client',     t.sent_to_client_at,
           'sent_to_client_by',  t.sent_to_client_by,
           'client_approved',    t.client_approved_at,
           'client_approved_by', t.client_approved_by,
           'changes_requested',  (select count(*) from blog_comments c
                                   where c.topic_id = t.id and c.author = 'client'
                                     and c.parent_id is null
                                     and c.state in ('open', 'applying')))
    into v_out
  from topics t where t.id = v_tid;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Dismiss a comment
-- ---------------------------------------------------------------------------
-- The engine's DELETE route carries NO demo refusal, NO done gate and NO live-run gate
-- (app.py's dismiss handler), and that absence is deliberate: a comment can be withdrawn
-- whatever state the blog is in. Copying the add-comment guard stack onto dismiss would
-- refuse dismissals the local build allows, so this reproduces the narrow guard only.
--
-- The refusal is atomic, exactly as the engine's is: `state <> 'applying'` sits in the WHERE
-- so a comment whose Claude apply is mid-flight cannot be pulled out from under the session.
-- Zero rows means it was already gone, was a reply, or is applying, and the caller gets one
-- refusal for all three because a dismissed comment and a never-existed comment are the same
-- to the person pressing the button.
create or replace function admin_dismiss_comment(p_brand text, p_topic text, p_comment uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid uuid := admin_brand_id(p_brand);
  v_tid uuid;
  v_id  uuid;
begin
  select t.id into v_tid from topics t
   where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no such blog for this account';
  end if;

  -- topic_id in the WHERE is the scope check: a comment id from another brand matches
  -- nothing, so a guessed uuid cannot reach across tenants.
  delete from blog_comments
   where id = p_comment
     and topic_id = v_tid
     and parent_id is null
     and state <> 'applying'
  returning id into v_id;

  if v_id is null then
    raise exception 'PORTAL:APPLYING:this change is still being applied; it can be dismissed once it lands';
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Add an operator comment  -- NOTE THE DIFFERENT SEMANTICS
-- ---------------------------------------------------------------------------
-- THIS IS NOT THE LOCAL ADD-COMMENT ACTION, and the difference is the whole reason it is
-- safe. blog_edit.add_comment inserts an operator comment in state 'applying' because the
-- route immediately calls start_apply and a Claude session picks it up. A definer function
-- can insert the row and cannot start the session, so reproducing that would file a comment
-- that applies forever: it holds one of the three in-flight slots permanently, it cannot be
-- dismissed (dismiss refuses 'applying'), and it disables the stage page's editor. If a local
-- engine later boots, reconcile_stranded fails it with "the engine restarted while this
-- change was being applied", which would be a lie, because no engine ever had it.
--
-- So this inserts 'open': a QUEUED REQUEST an operator resolves with Claude from a machine
-- that has an engine, exactly as a client's suggestion already works. The UI must say so
-- rather than implying an edit was made.
create or replace function admin_add_comment(
  p_brand text, p_topic text,
  p_selected_text text, p_instruction text,
  p_context_before text default '', p_context_after text default '')
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid uuid := admin_brand_id(p_brand);
  v_tid uuid;
  v_id  uuid;
begin
  perform admin_refuse_demo(v_cid);
  v_tid := admin_done_topic(v_cid, p_topic, 'commenting');

  if coalesce(btrim(p_selected_text), '') = '' then
    raise exception 'PORTAL:BLANK:select the text this change applies to';
  end if;
  if coalesce(btrim(p_instruction), '') = '' then
    raise exception 'PORTAL:BLANK:say what should change about the selected text';
  end if;

  insert into blog_comments
    (topic_id, client_id, author, author_email, selected_text,
     context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, 'operator', coalesce(auth.jwt() ->> 'email', ''),
     p_selected_text, coalesce(p_context_before, ''), coalesce(p_context_after, ''),
     p_instruction, 'open')
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Save an operator edit as a new version
-- ---------------------------------------------------------------------------
-- p_base_version_no IS THE WHOLE RACE GUARD and is required. The local editor sends no
-- version, and blog_edit.save_content says plainly what that leaves open: it can prove the
-- record has not moved since IT read, but not that the browser's editor was opened after the
-- last commit. Hosted has many more editors and no lock, so the base version travels with the
-- body and a mismatch refuses rather than silently burying someone's work.
--
-- WHAT THIS DELIBERATELY DOES NOT REPRODUCE: commit_topic's other half. That function pushes
-- a whole scratch directory, so it also NULLs topics.review_note and deletes evaluator
-- questions when questions.json is absent from disk. Those clears are meaningful only when
-- disk is authoritative; performed here they would destroy a held blog's unanswered questions
-- on a routine typo fix. The hosted save is therefore strictly less destructive than the local
-- one, which is the correct direction, but it IS a divergence: a blog held for questions stays
-- held after a hosted edit and would be released by a local one.
create or replace function admin_save_blog_content(
  p_brand text, p_topic text, p_body text, p_base_version_no int)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid  uuid := admin_brand_id(p_brand);
  v_tid  uuid;
  v_cur  int;
  v_new  int;
  v_vid  uuid;
  v_h1   text;
begin
  perform admin_refuse_demo(v_cid);
  v_tid := admin_done_topic(v_cid, p_topic, 'editing');

  if coalesce(btrim(p_body), '') = '' then
    raise exception 'PORTAL:BLANK:an empty article cannot be saved; delete the topic instead if that is the intent';
  end if;
  if octet_length(p_body) > 1000000 then
    raise exception 'PORTAL:TOOLARGE:the article is over 1 MB, which no blog is';
  end if;

  -- A comment mid-apply is reading and rewriting this same body from an engine session. The
  -- engine holds APPLY_LOCK for that; the only lock available here is a refusal.
  if exists (select 1 from blog_comments
              where topic_id = v_tid and parent_id is null and state = 'applying') then
    raise exception 'PORTAL:APPLYING:a change is being applied to this article; save once it lands';
  end if;

  -- Lock the topic before reading max(version_no), so two browsers cannot allocate the same
  -- number and collide on unique (topic_id, version_no).
  perform 1 from topics where id = v_tid for update;

  select coalesce(max(version_no), 0) into v_cur from blog_versions where topic_id = v_tid;
  if p_base_version_no is null or p_base_version_no <> v_cur then
    raise exception 'PORTAL:STALE:this article changed while you were editing (you started from version %, it is now at %); reload and reapply your edit',
      coalesce(p_base_version_no, 0), v_cur;
  end if;

  v_new := v_cur + 1;
  v_h1 := substring(
            (select l from regexp_split_to_table(p_body, E'\n') as l
              where l like '# %' limit 1) from 3);

  insert into blog_versions
    (topic_id, client_id, version_no, iteration, body, h1_title, word_count,
     score, eval_body, shipped, committed_at)
  values
    (v_tid, v_cid, v_new,
     -- iteration mirrors what commit_topic would carry forward for an already-shipped blog;
     -- the fold's own value, clamped into the column's 1..8 check.
     greatest(least(coalesce((select iterations from topic_rollup where topic_id = v_tid), 1), 8), 1),
     p_body, v_h1, array_length(regexp_split_to_array(btrim(p_body), E'\\s+'), 1),
     -- score and eval_body stay NULL: no evaluator saw these bytes. The engine's own manual
     -- save behaves the same way, because commit_topic reads them from the fold and disk and
     -- an edited draft carries neither.
     null, null, true, now())
  returning id into v_vid;

  update topics set shipped_version_id = v_vid where id = v_tid;

  return jsonb_build_object('version_no', v_new,
                            'word_count', array_length(regexp_split_to_array(btrim(p_body), E'\\s+'), 1));
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Brand settings
-- ---------------------------------------------------------------------------
-- Partial update: null means "leave alone", empty string means "blank it", matching the
-- not-null-default-'' columns. The signature is PINNED to four safe columns.
--
-- gates, client_md, canonical_facts, demo_mode and org_id are NOT writable here, and that is
-- a security property rather than a scoping decision. 003 spent a whole migration revoking
-- READ access to gates, client_md and canonical_facts from `authenticated`; a write path into
-- a column the caller may not read would be strictly more powerful than the read path that
-- was deliberately closed.
--
-- The organisation name is excluded for a different reason: _upsert_org does
-- `on conflict (slug) do update set name = excluded.name`, which renames the org for EVERY
-- brand under it. That is a cross-tenant write wearing a brand-scoped costume, and no
-- per-brand check can scope it, because orgs has no client_id.
--
-- domain and industry ARE writable here even though update_client silently discards them
-- today while the settings page toasts "Saved". That local bug is fixed alongside this; the
-- hosted path should not reproduce a silent success.
create or replace function admin_update_client(
  p_brand text,
  p_name text default null,
  p_description text default null,
  p_domain text default null,
  p_industry text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid uuid := admin_brand_id(p_brand);
begin
  if p_name is not null and btrim(p_name) = '' then
    raise exception 'PORTAL:BLANK:a brand needs a name';
  end if;

  update clients
     set name        = coalesce(nullif(btrim(coalesce(p_name, '')), ''), name),
         description = coalesce(p_description, description),
         domain      = coalesce(p_domain, domain),
         industry    = coalesce(p_industry, industry)
   where id = v_cid;

  return (select jsonb_build_object('slug', slug, 'name', name, 'description', description,
                                    'domain', domain, 'industry', industry)
            from clients where id = v_cid);
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Delete a roadmap
-- ---------------------------------------------------------------------------
-- Archives into roadmap_uploads then deletes the sheet, cascading roadmap_rows, exactly as
-- roadmap.delete_roadmap does. roadmap_sheets.client_id is unique, so this is one atomic
-- statement and it fixes the engine's check-then-act for free.
--
-- THE DISK HALF CANNOT CROSS, AND IT IS HANDLED IN THE ENGINE, NOT HERE. delete_roadmap also
-- unlinks clients/<slug>/roadmap.csv, and its comment states the reason: a stale copy left
-- behind "would be picked up by the NEXT generation's validate step as though that session had
-- written it, silently resurrecting the sheet the operator just deleted." A hosted delete
-- cannot unlink a file on somebody's laptop. The engine therefore drops a roadmap.csv whose
-- sheet is gone from the record, so the record stays authoritative and no resurrection is
-- possible. Without that companion change this function is NOT safe to expose.
create or replace function admin_delete_roadmap(p_brand text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid   uuid := admin_brand_id(p_brand);
  v_id    uuid;
  v_csv   text;
  v_rep   text;
  v_stamp text := to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MISS"Z"');
begin
  delete from roadmap_sheets where client_id = v_cid
  returning id, raw_csv, report into v_id, v_csv, v_rep;

  if v_id is null then
    raise exception 'PORTAL:NOSHEET:this brand has no roadmap to delete';
  end if;

  insert into roadmap_uploads (client_id, filename, raw)
  values (v_cid, v_stamp || '-deleted-roadmap.csv', convert_to(coalesce(v_csv, ''), 'UTF8'));
  if v_rep is not null then
    insert into roadmap_uploads (client_id, filename, raw)
    values (v_cid, v_stamp || '-deleted-roadmap-report.md', convert_to(v_rep, 'UTF8'));
  end if;

  return jsonb_build_object('deleted', true);
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Upload a finished blog
-- ---------------------------------------------------------------------------
-- The hosted half of blog_upload.upload_blog, MINUS the gate run, which is a subprocess. The
-- caller is told the gates did not run; it must never report them as passed, because "we did
-- not check" and "we checked and it was clean" must not look the same to whoever presses Send
-- afterwards.
--
-- The topic, its title, scope and prompts are read from roadmap_rows, which already holds the
-- parsed sheet with topic_slug precomputed by the engine's own slugify. Nothing is parsed here
-- and the browser cannot name a topic the roadmap does not plan.
--
-- line_no is allocated from the record's high-water mark. commit_topic keys status_events on
-- (topic_id, line_no) with ON CONFLICT DO NOTHING, so a line inserted at an ordinal the record
-- already holds is SILENTLY SWALLOWED: the article would commit while the topic never reached
-- done, which is the one failure that leaves a blog invisible to every gate downstream.
create or replace function admin_upload_blog(
  p_brand text, p_topic text, p_body text, p_replace boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid    uuid := admin_brand_id(p_brand);
  v_row    record;
  v_tid    uuid;
  v_status topic_status;
  v_cur    int;
  v_new    int;
  v_vid    uuid;
  v_line   int;
  v_h1     text;
  v_mail   text := coalesce(auth.jwt() ->> 'email', '');
  v_words  int;
begin
  perform admin_refuse_demo(v_cid);

  if coalesce(btrim(p_body), '') = '' then
    raise exception 'PORTAL:BLANK:that file has no article in it; check you picked the right one';
  end if;
  if octet_length(p_body) > 1000000 then
    raise exception 'PORTAL:TOOLARGE:that file is over 1 MB, which no blog is';
  end if;

  select r.topic, r.covers, r.prompts, r.topic_slug into v_row
    from roadmap_rows r
   where r.client_id = v_cid and r.topic_slug = p_topic
   limit 1;
  if v_row.topic_slug is null then
    raise exception 'PORTAL:NOTFOUND:no roadmap row for this topic; a blog can only be uploaded against a topic this brand''s roadmap plans';
  end if;

  select t.id into v_tid from topics t
   where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;

  if v_tid is not null then
    select r.status into v_status from topic_rollup r where r.topic_id = v_tid;
    -- A held blog is never overwritten: writing a done line over it supersedes the hold in
    -- the fold while the question form stands, leaving a blog shipped on one surface and
    -- awaiting an answer on another.
    if v_status = 'needs_review'::topic_status then
      raise exception 'PORTAL:HELD:this topic is held for an answer the evaluator asked for; answer its questions or delete the topic before uploading an article over it';
    end if;
    if v_status = 'running'::topic_status then
      raise exception 'PORTAL:RUNNING:this topic is generating right now; upload once the run finishes';
    end if;
    select coalesce(max(version_no), 0) into v_cur from blog_versions where topic_id = v_tid;
    if v_cur > 0 and not p_replace then
      raise exception 'PORTAL:EXISTS:this topic already has a blog; uploading would replace it, so confirm the replace if that is what you meant';
    end if;
    if exists (select 1 from blog_comments
                where topic_id = v_tid and author = 'client' and parent_id is null
                  and state in ('open', 'applying')) then
      raise exception 'PORTAL:OPENSUGGESTIONS:the client''s suggestions are still open on this blog; resolve or dismiss each one before replacing the article';
    end if;
  else
    insert into topics (client_id, slug, title) values (v_cid, p_topic, v_row.topic)
    on conflict (client_id, slug) do update
      set deleted_at = null, title = coalesce(excluded.title, topics.title)
    returning id into v_tid;
    v_cur := 0;
  end if;

  perform 1 from topics where id = v_tid for update;
  select coalesce(max(version_no), 0) into v_cur from blog_versions where topic_id = v_tid;
  v_new := v_cur + 1;
  v_words := array_length(regexp_split_to_array(btrim(p_body), E'\\s+'), 1);
  v_h1 := substring(
            (select l from regexp_split_to_table(p_body, E'\n') as l
              where l like '# %' limit 1) from 3);

  insert into blog_versions
    (topic_id, client_id, version_no, iteration, body, h1_title, word_count,
     score, eval_body, shipped, committed_at)
  values (v_tid, v_cid, v_new, 1, p_body, v_h1, v_words, null, null, true, now())
  returning id into v_vid;

  update topics set shipped_version_id = v_vid where id = v_tid;

  -- The terminal line. stage='write' because writing is the stage that genuinely completed,
  -- and score stays NULL because no evaluator saw this: the DB's own
  -- score_only_on_eval_end constraint would reject a score here anyway.
  select coalesce(max(line_no) + 1, 0) into v_line from status_events where topic_id = v_tid;
  insert into status_events
    (topic_id, client_id, line_no, ts, stage, event, iter, score, status, note, slug_reported)
  values (v_tid, v_cid, v_line, now(), 'write', 'end', 1, null, 'done',
          'uploaded by ' || coalesce(nullif(v_mail, ''), 'an operator')
            || '; no engine run, no evaluator score', p_topic);

  -- The regenerate interlock. Without a ledger row the roadmap still offers this topic and a
  -- research run would spend real quota rewriting a finished article.
  insert into ledger_entries (client_id, topic_slug, topic, covers, prompts, score, generated_at, run_id)
  values (v_cid, p_topic, coalesce(v_row.topic, p_topic), coalesce(v_row.covers, ''),
          coalesce(v_row.prompts, '{}'::text[]), null, now(), null)
  on conflict (client_id, topic_slug) do nothing;

  return jsonb_build_object(
    'topic_slug', p_topic,
    'word_count', v_words,
    'version_no', v_new,
    'replaced', v_cur > 0,
    -- NEVER {ran: true}. The gates are a subprocess and did not run.
    'gates', jsonb_build_object('ran', false, 'failures', '[]'::jsonb,
                                'reason', 'the mechanical gates run in the local engine and did not run for this upload'));
end
$$;

-- ---------------------------------------------------------------------------
-- Grants. Postgres grants EXECUTE to PUBLIC by default, so every function is revoked from
-- PUBLIC and anon first and then granted to `authenticated` alone. Omitting the revoke would
-- make each of these a privilege-escalation primitive reachable by an unauthenticated
-- PostgREST call rather than a door for logged-in operators.
-- ---------------------------------------------------------------------------
revoke all on function admin_brand_id(text) from public, anon;
revoke all on function admin_refuse_demo(uuid) from public, anon;
revoke all on function admin_done_topic(uuid, text, text) from public, anon;
revoke all on function admin_send_blog_to_client(text, text) from public, anon;
revoke all on function admin_dismiss_comment(text, text, uuid) from public, anon;
revoke all on function admin_add_comment(text, text, text, text, text, text) from public, anon;
revoke all on function admin_save_blog_content(text, text, text, int) from public, anon;
revoke all on function admin_update_client(text, text, text, text, text) from public, anon;
revoke all on function admin_delete_roadmap(text) from public, anon;
revoke all on function admin_upload_blog(text, text, text, boolean) from public, anon;

grant execute on function admin_send_blog_to_client(text, text) to authenticated;
grant execute on function admin_dismiss_comment(text, text, uuid) to authenticated;
grant execute on function admin_add_comment(text, text, text, text, text, text) to authenticated;
grant execute on function admin_save_blog_content(text, text, text, int) to authenticated;
grant execute on function admin_update_client(text, text, text, text, text) to authenticated;
grant execute on function admin_delete_roadmap(text) to authenticated;
grant execute on function admin_upload_blog(text, text, text, boolean) to authenticated;
-- The three helpers are NOT granted: they are internals, and each is reachable only from a
-- granted function running as its definer. Granting them would let a caller probe brand
-- existence directly, which is the oracle the shared refusal exists to close.

commit;
