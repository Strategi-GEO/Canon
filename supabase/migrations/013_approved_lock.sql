-- 013_approved_lock.sql
-- An approved article is LOCKED. Nobody edits it, the admin included.
--
-- The approval stamp records that the client accepted THESE BYTES. Every edit after it makes
-- the record assert something the client never did: they approved v4, the article is now v6,
-- and nothing on the page distinguishes the two. Posting to the CMS is the one act left,
-- because it changes nothing about the article.
--
-- WHY TRIGGERS RATHER THAN A GUARD IN EACH FUNCTION. There are five write paths into an
-- article and they do not share a chokepoint: admin_save_blog_content and admin_upload_blog on
-- the hosted build, blog_edit.save_content and blog_upload.upload_blog in the Python engine,
-- and the runner committing a version at the end of a generate. Guarding the two SQL functions
-- would lock the hosted build and leave the engine free to overwrite an approved article, which
-- is the worse half to leave open: the engine is where the writing actually happens. A trigger
-- is the only guard all five must pass, and it is enforced by the database rather than by five
-- callers each remembering to check.
--
-- WHAT IS DELIBERATELY NOT LOCKED: replies. A reply carries parent_id, changes no bytes, and
-- resolves nothing. Migration 011 already argued this for the operator's side and the argument
-- holds for the client's: replying is the cheapest, least destructive act in the loop and it is
-- the one that keeps a person from waiting on silence. "Thanks, this reads well" is not an edit.
--
-- ALSO NOT LOCKED: dismissing a comment, which changes no bytes either, and posting to the CMS,
-- which is not a database write at all.
--
-- SAFE ON A LIVE DB: verified zero approved topics at the time of writing, so no existing row
-- becomes unwritable and no in-flight run can trip a trigger that did not exist when it started.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/013_approved_lock.sql

begin;

-- ---------------------------------------------------------------------------
-- 1. No new version of an approved article.
-- ---------------------------------------------------------------------------
-- Covers every edit path in both languages at once: the hosted save, the hosted upload, the
-- engine's save, the engine's upload, and a generate run committing at the end.
--
-- A generate run against an approved topic now dies at its commit rather than at its start,
-- which is late and wasteful. That is accepted rather than solved here, because the alternative
-- is no invariant at all: the UI refuses to offer a regenerate on an approved article, and this
-- trigger is what makes that refusal true rather than merely displayed. A wasted run is a much
-- smaller harm than an article silently diverging from what the client signed off.
create or replace function refuse_version_when_approved()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_approved timestamptz;
begin
  select t.client_approved_at into v_approved from topics t where t.id = new.topic_id;
  if v_approved is not null then
    raise exception
      'PORTAL:LOCKED:the client approved this article on %, so it is locked and cannot be '
      'changed. Posting it to the CMS is the only act left.',
      to_char(v_approved, 'DD Mon YYYY');
  end if;
  return new;
end
$$;

drop trigger if exists blog_versions_approved_lock on blog_versions;
create trigger blog_versions_approved_lock
  before insert on blog_versions
  for each row execute function refuse_version_when_approved();

-- ---------------------------------------------------------------------------
-- 2. No new change request on an approved article, from either side.
-- ---------------------------------------------------------------------------
-- TOP-LEVEL ROWS ONLY, which is what `new.parent_id is null` says: a reply hangs off a parent
-- and is exempt for the reason in the header.
--
-- This closes both sides with one object. The client's portal_suggest_change used to be allowed
-- after approval on the reasoning that an approval is not the end of the conversation; it is the
-- end of it now, because a suggestion nobody is permitted to apply is a request that can only be
-- disappointed. The operator's admin_add_comment is closed by the same rule, and it matters more
-- than it looks: an operator comment is born `applying` and runs Claude immediately, so it is an
-- edit wearing a comment's clothes.
create or replace function refuse_comment_when_approved()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_approved timestamptz;
begin
  if new.parent_id is not null then
    return new;
  end if;
  select t.client_approved_at into v_approved from topics t where t.id = new.topic_id;
  if v_approved is not null then
    raise exception
      'PORTAL:LOCKED:this article was approved on % and is locked, so it cannot take new '
      'change requests. Replies to existing threads still work.',
      to_char(v_approved, 'DD Mon YYYY');
  end if;
  return new;
end
$$;

drop trigger if exists blog_comments_approved_lock on blog_comments;
create trigger blog_comments_approved_lock
  before insert on blog_comments
  for each row execute function refuse_comment_when_approved();

-- ---------------------------------------------------------------------------
-- 3. No re-send of an approved article.
-- ---------------------------------------------------------------------------
-- admin_done_topic is the shared gate for admin_send_blog_to_client, admin_save_blog_content
-- and admin_add_comment, so the lock lands in one place for all three. The two writers are
-- already covered by the triggers above; sending is the one act that inserts nothing and would
-- otherwise slip through, and it is the most damaging of the three, because mark_sent CLEARS
-- the approval as it re-stamps. A re-send would erase the very record this migration protects.
--
-- The whole body is restated because `create or replace function` takes no patch. The only
-- change from 009 is the v_approved block.
create or replace function admin_done_topic(p_cid uuid, p_topic text, p_act text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tid      uuid;
  v_status   topic_status;
  v_approved timestamptz;
begin
  select t.id, t.client_approved_at into v_tid, v_approved from topics t
   where t.client_id = p_cid and t.slug = p_topic and t.deleted_at is null;
  if v_tid is null then
    raise exception 'PORTAL:NOTFOUND:no such blog for this account';
  end if;
  -- READ the fold, never re-derive it. See 009's header.
  select r.status into v_status from topic_rollup r where r.topic_id = v_tid;
  if v_status is distinct from 'done'::topic_status then
    raise exception 'PORTAL:NOTDONE:this blog is %, not done; % is for shipped blogs only',
      coalesce(v_status::text, 'unknown'), p_act;
  end if;
  -- The approved lock, checked AFTER the done check so the more specific message wins: a blog
  -- that is both not-done and approved cannot exist, but if one ever did, "it is locked" is the
  -- more useful sentence than "it is not done".
  if v_approved is not null then
    raise exception
      'PORTAL:LOCKED:the client approved this article on %, so it is locked. % is not available '
      'on an approved article; posting it to the CMS is the only act left.',
      to_char(v_approved, 'DD Mon YYYY'), p_act;
  end if;
  return v_tid;
end
$$;

commit;
