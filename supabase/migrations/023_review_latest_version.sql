-- 023_review_latest_version.sql
-- The review loop reads the LATEST committed version, and the two portal writes follow.
--
-- The portal used to pin a client in review to sent_version_id, the bytes the send
-- released. The loop is now live on both sides: the client keeps commenting, the admin
-- keeps resolving, each resolve commits a new blog_versions row, and both sides always
-- read the newest committed version, with Approve available the whole time. Two of 005's
-- SECURITY DEFINER functions are retargeted to match, with the SAME signatures
-- (PostgREST routes on signature; 005 already dropped the overload that taught us why):
--
--   1. portal_approve_blog: the STALE race guard now compares p_version to the topic's
--      LATEST committed version (the same `order by version_no desc limit 1` selection
--      admin_send_blog_to_client in 009 uses), not to sent_version_id. An approval is
--      still a signature on exact bytes: a version committed mid-read still refuses and
--      makes the portal reload. The stamp also RE-PINS sent_version_id to the approved
--      version, because server/cms/gate.py publishes an approved topic from
--      sent_version_id and refuses when it diverges from latest, and 013 locks an
--      approved article against further edits. Re-pinning at approval makes
--      sent == approved == latest from the stamp onward, so the publish gate keeps
--      meaning "nothing moved after the approval" without changing a line of it.
--   2. portal_suggest_change: the inserted blog_comments.blog_version_id anchors to the
--      topic's latest committed version at filing time, not to sent_version_id. The
--      client now reads the latest version, so a suggestion's anchor must name the
--      bytes the selection was actually made against.
--
-- Every gate from 005 is restated whole, because a `create or replace` replaces the
-- whole function and nothing can be inherited. Nothing else about either function moves.
--
-- SAFE ON A LIVE DB: function replacement only, same signatures, no table, column, or
-- grant changes. Replacement with the same signature preserves ACLs; the revoke/grant
-- pairs are restated anyway, following 005.
--
-- Idempotent: re-running replaces rather than duplicates. Kept in sync with schema.sql,
-- the authority for fresh builds (folded in with this change).
--
--   psql "$DATABASE_URL" -f supabase/migrations/023_review_latest_version.sql

begin;

-- ---------------------------------------------------------------------------
-- portal_suggest_change: the anchor is the latest committed version
-- ---------------------------------------------------------------------------
-- Every gate and the 10-open-suggestion cap are 005's, unchanged. Only the anchor moves:
-- the client in review reads the topic's latest committed version, so the suggestion's
-- blog_version_id must name those bytes, not the ones the send released.
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
  v_latest    uuid;
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

  select t.id, t.sent_to_client_at
    into v_tid, v_sent_at
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

  -- The anchor: the topic's latest committed version, the same selection
  -- admin_send_blog_to_client (009) uses. The client in review reads the latest
  -- version, so this names the bytes the selection was actually made against.
  select v.id into v_latest
  from blog_versions v
  where v.topic_id = v_tid
  order by v.version_no desc
  limit 1;

  insert into blog_comments
    (topic_id, client_id, blog_version_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, v_latest, 'client', v_email,
     p_selected, coalesce(p_before, ''), coalesce(p_after, ''), p_instruction, 'open')
  returning id into v_id;

  return v_id;
end
$$;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Strip it explicitly,
-- then grant the one caller, exactly as 005 does.
revoke all on function portal_suggest_change(text, text, text, text, text, text)
  from public, anon;
grant execute on function portal_suggest_change(text, text, text, text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- portal_approve_blog: STALE compares to latest, and the stamp re-pins the send
-- ---------------------------------------------------------------------------
-- Same gates as 005, then the stamp. p_version IS THE VERSION THE CLIENT ACTUALLY READ,
-- and that is now the topic's LATEST committed version, not sent_version_id: the race
-- the STALE refusal closes is a resolve committing a new version while the approval is
-- in flight, landing the approval on bytes nobody has seen. An approval is a statement
-- about specific text, so it refuses (PORTAL:STALE) when the version it names is no
-- longer the newest committed one, and the portal reloads and asks again.
--
-- The stamp RE-PINS sent_version_id to the approved version: server/cms/gate.py
-- publishes from sent_version_id and refuses when it diverges from latest, and 013
-- locks an approved article against further edits, so sent == approved == latest holds
-- from the stamp onward and the publish gate keeps meaning "nothing moved after the
-- approval" without changing a line of it.
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
  v_latest    uuid;
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

  -- The topic's newest committed bytes, the same `order by version_no desc limit 1`
  -- selection admin_send_blog_to_client (009) uses to pick what a send releases.
  select v.id into v_latest
  from blog_versions v
  where v.topic_id = v_tid
  order by v.version_no desc
  limit 1;

  -- `is distinct from` and not `<>`, because either side can be null: a topic with no
  -- committed version has no latest, and a portal that failed to read one sends null.
  -- Both are the same refusal, since neither can prove which bytes the client approved.
  if p_version is distinct from v_latest then
    raise exception 'PORTAL:STALE:the team updated this article while you were reading; reload and take another look';
  end if;

  update topics
     set client_approved_at = now(),
         client_approved_by = v_email,
         sent_version_id    = p_version
   where id = v_tid;
end
$$;

revoke all on function portal_approve_blog(text, text, uuid) from public, anon;
grant execute on function portal_approve_blog(text, text, uuid) to authenticated;

commit;
