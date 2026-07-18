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
--      The table is THREADED: parent_id turns a comment into a conversation both sides
--      can answer, the way a document comment works.
--   3. Three SECURITY DEFINER functions, portal_suggest_change, portal_reply_comment and
--      portal_approve_blog: the client's second, third and fourth writes, gated exactly as
--      portal_submit_answers is.
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
-- One row per selection comment, operator-authored and client-authored both, PLUS the
-- replies that hang off one. The state machine: 'open' (filed, nothing running; every
-- client suggestion starts here), 'applying' (a Claude apply session is live on some
-- engine), 'resolved' (the edit landed and committed), 'failed' (the apply refused or
-- died; error says why, and Resolve retries it), 'dismissed' (closed without an edit; the
-- terminal no-op). Operator comments skip 'open': the engine auto-applies them at filing,
-- as phase 1 did.
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
  -- The thread pointer: null on a top-level comment, the parent's id on a REPLY. A reply
  -- carries its text in `instruction`, leaves selected_text and both context columns
  -- empty, and is never applied, never counted, never resolved: it is someone TALKING
  -- ABOUT the change, not a second change request. Every count and every apply path
  -- therefore filters `parent_id is null`, and getting that wrong makes a client's
  -- "thanks, looks good" reply read as an open suggestion that blocks Send again forever.
  parent_id       uuid references blog_comments(id) on delete cascade,
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
  -- When this row last entered state 'applying', stamped on EVERY transition into it (the
  -- insert of an operator comment, and every Resolve). created_at is the WRONG clock for
  -- the stranded-apply sweep and this column exists to say so: a comment filed an hour ago
  -- and retried a minute ago is a LIVE apply, and an age guard reading created_at fails it
  -- the moment any engine boots, killing a session that is still working.
  applying_since  timestamptz,
  finished_at     timestamptz,
  foreign key (topic_id, client_id) references topics(id, client_id) on delete cascade,
  -- ONE level of nesting, exactly like a document comment thread: a reply is 'open' and
  -- stays there, so nothing can resolve, apply, or dismiss it. This constraint cannot see
  -- the parent's own parent_id, so portal_reply_comment refuses a parent that is itself a
  -- reply; the two rules together are what keep a thread flat, and neither is redundant
  -- (a function check cannot stop a later UPDATE, and a row check cannot read the parent).
  constraint blog_comments_reply_open check (parent_id is null or state = 'open')
);

-- The two threading columns again, as alters, and they run BEFORE the indexes and the
-- constraint below because those READ the columns. `create table if not exists` does
-- NOTHING to a table that already exists, so a database that ran an EARLIER revision of
-- this migration holds blog_comments without them; ordering these after the index that
-- keys on parent_id is what turned that case into `column "parent_id" does not exist` on
-- a real database rather than the silent repair this block exists to perform. Both
-- spellings must stay in step; the create above is the one a fresh build uses.
alter table blog_comments add column if not exists parent_id uuid
  references blog_comments(id) on delete cascade;
alter table blog_comments add column if not exists applying_since timestamptz;

-- Named, and added only when absent, exactly like topics_sent_version_fk above: Postgres
-- has no `add constraint if not exists` and a re-run must not raise on the duplicate.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'blog_comments_reply_open'
                   and conrelid = 'blog_comments'::regclass) then
    alter table blog_comments add constraint blog_comments_reply_open
      check (parent_id is null or state = 'open');
  end if;
end $$;

create index if not exists blog_comments_topic on blog_comments (topic_id, created_at);
-- Replies are read BY PARENT, one query for a whole page of threads. Without this index
-- that read is a sequential scan of the table on every read of a stage page.
create index if not exists blog_comments_parent on blog_comments (parent_id);

-- RLS mirrors review_notes (001): membership-scoped SELECT for authenticated, nothing
-- for anon. No INSERT or UPDATE policy or grant exists ON PURPOSE: client writes pass
-- through portal_suggest_change below, operator writes ride the engine's owner
-- connection, and a third path would be a write the state machine never sees.
alter table blog_comments enable row level security;
revoke all on blog_comments from anon, authenticated;
drop policy if exists read_scoped on blog_comments;
create policy read_scoped on blog_comments for select to authenticated
  using (auth_can_read_client(client_id));

-- Column-scoped like every 003 table. TWO columns stay out. author_email is a person's
-- email address, operator material on operator rows and another user's PII on client
-- rows; a client surface renders "you" or "the team" from author alone. applying_since is
-- engine timing on an operator's Claude session, which no client surface has any business
-- reading: the portal says "with the team" from state, and a visible apply clock would
-- turn an internal retry into something the client watches. parent_id IS granted, because
-- the portal cannot draw a thread without knowing which comment a reply hangs off.
grant select (id, topic_id, client_id, blog_version_id, parent_id, author, selected_text,
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
--
-- AN APPROVED TOPIC IS NO LONGER REFUSED. Approving is the client saying the article
-- reads right, not signing away their voice: someone who approves and then spots a wrong
-- figure must still be able to say so, and the alternative is a client emailing the team a
-- correction the record never sees. The admin gets a changes-requested chip on an approved
-- blog and decides what to do with it. Only the send stamp still gates: an article nobody
-- released has nothing to comment on.
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

  select t.id, t.sent_to_client_at, t.sent_version_id
    into v_tid, v_sent_at, v_sent_ver
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;

  -- Serialize concurrent suggests on the topic row: two racing submits would otherwise
  -- both count nine open suggestions and both insert past the guard below.
  perform 1 from topics t where t.id = v_tid for update;

  -- The spam guard, counting TOP-LEVEL suggestions only. Ten unresolved suggestions on
  -- one article is not a review, it is a rewrite request, and every open row blocks Send
  -- again on the admin side: without a cap, one client could wedge an article's delivery
  -- indefinitely at zero cost. Replies are excluded because they ask for nothing: a thread
  -- of ten "thank you" notes must never spend the suggestion budget.
  select count(*) into v_open
  from blog_comments c
  where c.topic_id = v_tid and c.author = 'client'
    and c.parent_id is null and c.state in ('open', 'applying');
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
-- portal_reply_comment: the client's half of the conversation
-- ---------------------------------------------------------------------------
-- A suggestion is not a one-shot form, it is the start of a thread: the admin resolves or
-- dismisses it and the client answers that, the admin answers back, and both sides read
-- the same rows. Same gate stack as portal_suggest_change, with three refusals of its own.
--
-- A reply is DELIBERATELY NOT a change request. It inserts with parent_id set, state
-- 'open', its text in `instruction`, and empty selected_text, so no apply path can ever
-- pick it up and no count can ever see it. The reply-of-a-reply refusal is what keeps the
-- thread one level deep: the row constraint above cannot read the parent's parent_id, so
-- the check lives here, and a client who somehow held a reply's id would otherwise nest a
-- conversation the rail has no way to draw.
create or replace function portal_reply_comment(
  p_brand  text,
  p_topic  text,
  p_parent uuid,
  p_body   text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid          uuid := auth.uid();
  v_email        text := coalesce(auth.jwt() ->> 'email', '');
  v_is_admin     boolean;
  v_is_member    boolean;
  v_cid          uuid;
  v_tid          uuid;
  v_sent_at      timestamptz;
  v_parent_topic uuid;
  v_parent_of    uuid;
  v_replies      int;
  v_id           uuid;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;
  if btrim(coalesce(p_body, '')) = '' then
    raise exception 'PORTAL:BLANK:a reply needs something in it';
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

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to reply for this brand';
  end if;

  select t.id, t.sent_to_client_at
    into v_tid, v_sent_at
  from topics t
  where t.client_id = v_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no blog to review for this account';
  end if;

  -- An unsent article has no conversation to join. It refuses here rather than at the
  -- parent lookup so the client reads why, not "that comment does not exist".
  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this article is not with you for review yet';
  end if;

  -- Serialize on the parent row, for the reason suggest serializes on the topic: two
  -- racing replies would otherwise both count nineteen and both insert past the cap.
  select c.topic_id, c.parent_id into v_parent_topic, v_parent_of
  from blog_comments c
  where c.id = p_parent
  for update;

  -- An unknown comment, another topic's comment, and a REPLY all answer identically. The
  -- last one is not a lookup failure, it is the flat-thread rule: distinguishing it would
  -- also hand a caller a probe for which ids are replies.
  if v_parent_topic is null or v_parent_topic <> v_tid or v_parent_of is not null then
    raise exception 'PORTAL:NOTFOUND:no comment to reply to on this article';
  end if;

  -- Twenty replies on one comment is not a conversation any more. The suggestion cap
  -- above does not bind here (replies are excluded from it on purpose), so without this
  -- one the thread is an unbounded write channel behind an authenticated login.
  select count(*) into v_replies
  from blog_comments c
  where c.parent_id = p_parent;
  if v_replies >= 20 then
    raise exception 'PORTAL:LIMIT:this conversation is long enough; the team will follow up directly';
  end if;

  insert into blog_comments
    (topic_id, client_id, parent_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, p_parent, 'client', v_email,
     '', '', '', p_body, 'open')
  returning id into v_id;

  return v_id;
end
$$;

revoke all on function portal_reply_comment(text, text, uuid, text) from public, anon;
grant execute on function portal_reply_comment(text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- portal_approve_blog: the client's approval
-- ---------------------------------------------------------------------------
-- Same gates as portal_suggest_change, then the stamp. Approval stays available while
-- the client's own suggestions are open (the state machine keeps Approve live in the
-- 'ready' state), so there is deliberately no open-comment refusal here: approving over
-- an open suggestion is the client saying it no longer matters, and the admin dismisses
-- it with that context. Already-approved refuses rather than re-stamps, because the
-- stamp records WHEN the client accepted the release and a moving date falsifies that.
--
-- p_version IS THE VERSION THE CLIENT ACTUALLY READ, and it closes a real race: the team
-- presses Send again while the client's approval is in flight, mark_sent moves
-- sent_version_id to bytes nobody has seen, and the approval lands on them as though the
-- client had read them. An approval is a statement about specific text, so it refuses
-- (PORTAL:STALE) when the version it names is no longer the one on offer, and the portal
-- reloads and asks again. The client sees a refresh; the alternative is a signature on a
-- document that changed underneath it.
create or replace function portal_approve_blog(
  p_brand   text,
  p_topic   text,
  p_version uuid
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
  v_sent_ver  uuid;
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
    raise exception 'PORTAL:APPROVED:this article is already approved';
  end if;
  -- `is distinct from` and not `<>`, because either side can be null: a pre-005 send has
  -- no sent_version_id, and a portal that failed to read one sends null. Both are the
  -- same refusal, since neither can prove which bytes the client approved.
  if p_version is distinct from v_sent_ver then
    raise exception 'PORTAL:STALE:the team sent a newer version while you were reading; reload and take another look';
  end if;

  update topics
     set client_approved_at = now(),
         client_approved_by = v_email
   where id = v_tid;
end
$$;

-- The two-argument form is DROPPED, not left beside this one. An earlier revision of this
-- same (unapplied) migration created portal_approve_blog(text, text), and `create or
-- replace` cannot change a signature: it adds an overload. A developer database that ran
-- that revision would keep a second, version-blind door open forever, and PostgREST would
-- happily route a two-argument call to it.
drop function if exists portal_approve_blog(text, text);

revoke all on function portal_approve_blog(text, text, uuid) from public, anon;
grant execute on function portal_approve_blog(text, text, uuid) to authenticated;

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
