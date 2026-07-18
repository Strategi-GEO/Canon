-- 005_client_review.sql
-- Incremental, additive migration: the client review loop on a sent blog.
--
-- 004 gave the admin a one-way exit: Send to client stamps sent_to_client_at and the
-- portal shows the article. This migration adds the loop that stamp starts. The client
-- either APPROVES the article or SUGGESTS CHANGES against the exact version they read;
-- each suggestion surfaces on the admin's stage page, where the existing apply machinery
-- resolves it; and Send again re-stamps the send with any approval cleared. Three pieces:
--
--   1. topics gains sent_version_id (WHICH version the send released, so a client
--      suggestion anchors to the bytes it was written against even after the admin edits
--      on) and client_approved_at/by (the approval stamp every re-send clears).
--   2. blog_comments: selection comments move from the engine's local comments.json into
--      the record, because the client files them from the hosted portal with no engine
--      behind it, and two engines share one record: a comment teammate A resolves must
--      read as resolved on teammate B's machine, which no per-machine JSON file can do.
--   3. Two SECURITY DEFINER functions, portal_suggest_change and portal_approve_blog:
--      the client's second and third writes, gated exactly as portal_submit_answers is.
--
-- SAFE ON A LIVE DB: every object is additive, authenticated keeps SELECT-only column
-- grants, and the backfill only fills sent_version_id where a send stamp already exists,
-- pointing it at the shipped version those clients were already reading. No existing
-- blog changes visibility.
--
-- Idempotent: re-running replaces rather than duplicates. Kept in sync with schema.sql,
-- the authority for fresh builds (folded in with this change).
--
--   psql "$DATABASE_URL" -f supabase/migrations/005_client_review.sql

begin;

-- ---------------------------------------------------------------------------
-- topics: which version the client is reading, and whether they approved it
-- ---------------------------------------------------------------------------
alter table topics add column if not exists sent_version_id    uuid;
alter table topics add column if not exists client_approved_at timestamptz;
alter table topics add column if not exists client_approved_by text;

-- Composite FK, mirroring topics_shipped_version_fk: a sent_version_id pointing at
-- another topic's version is rejected by the database, not by a code path someone has to
-- remember to write. Named, and added only when absent, because Postgres has no
-- `add constraint if not exists` and a re-run must not raise on the duplicate.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'topics_sent_version_fk'
                   and conrelid = 'topics'::regclass) then
    alter table topics add constraint topics_sent_version_fk
      foreign key (sent_version_id, id) references blog_versions(id, topic_id)
      on delete set null;
  end if;
end $$;

-- 003 made topics column-scoped for `authenticated`, so a new column is invisible to the
-- portal until granted. sent_version_id is safe: it names WHICH article body the client
-- reviews, and blog_versions.body is already theirs to read. client_approved_at is safe:
-- it records the client's own act. client_approved_by stays ungranted, exactly like
-- sent_to_client_by: it is a person's email, operator/PII material no client surface reads.
grant select (sent_version_id, client_approved_at) on topics to authenticated;

-- ---------------------------------------------------------------------------
-- blog_comments: selection comments, one table for both surfaces
-- ---------------------------------------------------------------------------
-- One row per selection comment, operator-authored and client-authored both. The state
-- machine: 'open' (filed, nothing running; every client suggestion starts here),
-- 'applying' (a Claude apply session is live on some engine), 'resolved' (the edit landed
-- and committed), 'failed' (the apply refused or died; error says why, and Resolve
-- retries it), 'dismissed' (closed without an edit; the terminal no-op). Operator
-- comments skip 'open': the engine auto-applies them at filing, as phase 1 did.
create table if not exists blog_comments (
  id              uuid primary key default gen_random_uuid(),
  topic_id        uuid not null,
  client_id       uuid not null,
  -- The version the selection was made against: topics.sent_version_id at filing time
  -- for client suggestions, null for engine-filed operator comments (their apply always
  -- runs against the record's latest body). Informational anchor with deliberately NO
  -- FK: a comment must outlive the version it quotes, the way ledger_entries outlive
  -- the topics they record, or pruning history silently deletes a client's request.
  blog_version_id uuid,
  author          text not null check (author in ('operator','client')),
  author_email    text not null default '',
  selected_text   text not null,
  context_before  text not null default '',
  context_after   text not null default '',
  instruction     text not null,
  state           text not null default 'open'
                    check (state in ('open','applying','resolved','failed','dismissed')),
  error           text,
  edits           jsonb,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  foreign key (topic_id, client_id) references topics(id, client_id) on delete cascade
);

create index if not exists blog_comments_topic on blog_comments (topic_id, created_at);

-- RLS mirrors review_notes (001): membership-scoped SELECT for authenticated, nothing
-- for anon. No INSERT or UPDATE policy or grant exists ON PURPOSE: client writes pass
-- through portal_suggest_change below, operator writes ride the engine's owner
-- connection, and a third path would be a write the state machine never sees.
alter table blog_comments enable row level security;
revoke all on blog_comments from anon, authenticated;
drop policy if exists read_scoped on blog_comments;
create policy read_scoped on blog_comments for select to authenticated
  using (auth_can_read_client(client_id));

-- Column-scoped like every 003 table: everything except author_email, which is a
-- person's email address, operator material on operator rows and another user's PII on
-- client rows. A client surface renders "you" or "the team" from author alone.
grant select (id, topic_id, client_id, blog_version_id, author, selected_text,
              context_before, context_after, instruction, state, error, edits,
              created_at, finished_at)
  on blog_comments to authenticated;

-- ---------------------------------------------------------------------------
-- portal_suggest_change: the client's "suggest changes" write
-- ---------------------------------------------------------------------------
-- Mirrors portal_submit_answers (002, hardened in 003) gate for gate: caller, body,
-- membership parity, role, then the topic's own state. SECURITY DEFINER because
-- authenticated deliberately holds zero INSERT grants on blog_comments, and this
-- function is the one door a client write may pass through. Unlike a comment the admin
-- files, NOTHING runs on insert: the suggestion lands in state 'open' and waits for an
-- operator's Resolve, because an apply is a real Claude session on an engine the client
-- does not have. Every error leaves as 'PORTAL:<CODE>:<detail>' so the portal's route
-- handler maps codes to HTTP statuses without parsing prose.
create or replace function portal_suggest_change(
  p_brand       text,
  p_topic       text,
  p_selected    text,
  p_before      text,
  p_after       text,
  p_instruction text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text := coalesce(auth.jwt() ->> 'email', '');
  v_is_admin  boolean;
  v_is_member boolean;
  v_cid       uuid;
  v_tid       uuid;
  v_sent_at   timestamptz;
  v_sent_ver  uuid;
  v_approved  timestamptz;
  v_open      int;
  v_id        uuid;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if btrim(coalesce(p_selected, '')) = '' or btrim(coalesce(p_instruction, '')) = '' then
    raise exception 'PORTAL:BADBODY:a suggestion needs both the selected text and an instruction';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_brand and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  -- The 003 parity rule: a non-member learns nothing, because a brand that does not
  -- exist and a brand in someone else's org answer identically.
  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  -- A member without the writing role is told so plainly: they can already see the
  -- brand, so this reveals nothing, and role vocabulary stays out of the message.
  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to suggest changes for this brand';
  end if;

  select t.id, t.sent_to_client_at, t.sent_version_id, t.client_approved_at
    into v_tid, v_sent_at, v_sent_ver, v_approved
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;
  if v_approved is not null then
    raise exception 'PORTAL:APPROVED:this article is already approved; the team takes it from here';
  end if;

  -- Serialize concurrent suggests on the topic row: two racing submits would otherwise
  -- both count nine open suggestions and both insert past the guard below.
  perform 1 from topics t where t.id = v_tid for update;

  -- The spam guard. Ten unresolved suggestions on one article is not a review, it is a
  -- rewrite request, and every open row blocks Send again on the admin side: without a
  -- cap, one client could wedge an article's delivery indefinitely at zero cost.
  select count(*) into v_open
  from blog_comments c
  where c.topic_id = v_tid and c.author = 'client' and c.state in ('open', 'applying');
  if v_open >= 10 then
    raise exception 'PORTAL:LIMIT:ten suggestions are already with the team; they will follow up once those are addressed';
  end if;

  insert into blog_comments
    (topic_id, client_id, blog_version_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, v_sent_ver, 'client', v_email,
     p_selected, coalesce(p_before, ''), coalesce(p_after, ''), p_instruction, 'open')
  returning id into v_id;

  return v_id;
end
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Strip it explicitly,
-- then grant the one caller, exactly as 002 does.
revoke all on function portal_suggest_change(text, text, text, text, text, text)
  from public, anon;
grant execute on function portal_suggest_change(text, text, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- portal_approve_blog: the client's approval
-- ---------------------------------------------------------------------------
-- Same gates as portal_suggest_change, then the stamp. Approval stays available while
-- the client's own suggestions are open (the state machine keeps Approve live in the
-- 'ready' state), so there is deliberately no open-comment refusal here: approving over
-- an open suggestion is the client saying it no longer matters, and the admin dismisses
-- it with that context. Already-approved refuses rather than re-stamps, because the
-- stamp records WHEN the client accepted the release and a moving date falsifies that.
create or replace function portal_approve_blog(
  p_brand text,
  p_topic text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid := auth.uid();
  v_email     text := coalesce(auth.jwt() ->> 'email', '');
  v_is_admin  boolean;
  v_is_member boolean;
  v_cid       uuid;
  v_tid       uuid;
  v_sent_at   timestamptz;
  v_approved  timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_brand and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1
          from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to approve for this brand';
  end if;

  select t.id, t.sent_to_client_at, t.client_approved_at
    into v_tid, v_sent_at, v_approved
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;
  if v_approved is not null then
    raise exception 'PORTAL:APPROVED:this article is already approved';
  end if;

  update topics
     set client_approved_at = now(),
         client_approved_by = v_email
   where id = v_tid;
end
$$;

revoke all on function portal_approve_blog(text, text) from public, anon;
grant execute on function portal_approve_blog(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Backfill: blogs 004 released predate the version pointer
-- ---------------------------------------------------------------------------
-- Every already-sent blog was released before sent_version_id existed, and what those
-- clients were reading is the shipped version (the portal's delivered view rendered
-- exactly that). Filling nulls only, so a re-run and a post-005 send both keep the
-- pointer the send itself stamped.
update topics
   set sent_version_id = shipped_version_id
 where sent_to_client_at is not null
   and sent_version_id is null;

commit;
