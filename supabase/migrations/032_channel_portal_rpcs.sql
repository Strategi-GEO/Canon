-- Client-portal write authority for channel posts: the two SECURITY DEFINER functions a client's
-- browser calls to REQUEST CHANGES on and APPROVE a LinkedIn/Medium post. They mirror the blog
-- portal RPCs (portal_suggest_change / portal_approve_blog, migration 005) exactly: same auth
-- model (auth.uid for identity, auth.jwt email for the actor stamp, membership + role gate through
-- org_membership), same PORTAL:<CODE>:<detail> error protocol the hosted routes map to HTTP.
--
-- Two schema-forced differences from the blog versions, both already decided in migration 031:
--   * NO version anchor and NO PORTAL:STALE. channel_posts has no versions; the body is edited in
--     place, so a suggestion anchors to the current body and there are no "bytes on offer" to
--     compare an approval against. So approve takes no version.
--   * Keyed by (client slug, channel, SOURCE-BLOG slug), matching the admin URL scheme and the
--     channel_posts unique(source_topic_id, channel). Resolved to the post row inside the function.
--
-- No approved-lock trigger analog (031 declined it: a channel post has no re-generation, so the
-- only post-approval writer is the admin marking it posted, a stamp that touches no comment). If
-- approval should also freeze further client suggestions, add the marked in-function guard below.
--
-- APPLY THIS TO THE LIVE DB. The fresh-build mirror lives in schema.sql.

create or replace function portal_suggest_channel_change(
  p_client_slug text,
  p_channel     text,
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
  v_pid       uuid;
  v_sent_at   timestamptz;
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
  where c.slug = p_client_slug and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1 from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to suggest changes for this brand';
  end if;

  -- Resolve the post by (client, channel, source-blog slug). A post in another org yields no
  -- row under this client_id and answers NOTFOUND, the same parity rule the blog side uses.
  select p.id, p.sent_to_client_at into v_pid, v_sent_at
  from channel_posts p
  join topics t on t.id = p.source_topic_id
  where p.client_id = v_cid and p.channel = p_channel
    and t.slug = p_topic and t.deleted_at is null;
  if v_pid is null then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this post is not with you for review yet';
  end if;

  -- To freeze suggestions once the client has approved, uncomment:
  --   perform 1 from channel_posts where id = v_pid and client_approved_at is not null;
  --   if found then raise exception 'PORTAL:LOCKED:this post is approved and locked'; end if;

  perform 1 from channel_posts p where p.id = v_pid for update;

  select count(*) into v_open
  from channel_post_comments c
  where c.channel_post_id = v_pid and c.author = 'client'
    and c.state in ('open', 'applying');
  if v_open >= 10 then
    raise exception 'PORTAL:LIMIT:ten suggestions are already with the team; they will follow up once those are addressed';
  end if;

  insert into channel_post_comments
    (channel_post_id, client_id, author, author_email,
     selected_text, context_before, context_after, instruction, state)
  values
    (v_pid, v_cid, 'client', v_email,
     p_selected, coalesce(p_before, ''), coalesce(p_after, ''), p_instruction, 'open')
  returning id into v_id;

  return v_id;
end
$$;

create or replace function portal_approve_channel_post(
  p_client_slug text,
  p_channel     text,
  p_topic       text
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
  v_pid       uuid;
  v_sent_at   timestamptz;
  v_approved  timestamptz;
begin
  if v_uid is null then
    raise exception 'PORTAL:AUTH:not authenticated';
  end if;

  select c.id into v_cid
  from clients c
  where c.slug = p_client_slug and c.deleted_at is null;

  v_is_admin := exists (select 1 from app_admins a where a.user_id = v_uid);
  v_is_member := v_cid is not null and (
      v_is_admin
      or exists (
          select 1 from org_membership m
          join org_members om on om.org_slug = m.org_slug
          where m.client_id = v_cid and om.user_id = v_uid));

  if not v_is_member then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if not (v_is_admin or exists (
      select 1 from org_membership m
      join org_members om on om.org_slug = m.org_slug
      where m.client_id = v_cid and om.user_id = v_uid
        and om.role in ('admin', 'commenter'))) then
    raise exception 'PORTAL:ROLE:this account is not allowed to approve for this brand';
  end if;

  select p.id, p.sent_to_client_at, p.client_approved_at
    into v_pid, v_sent_at, v_approved
  from channel_posts p
  join topics t on t.id = p.source_topic_id
  where p.client_id = v_cid and p.channel = p_channel
    and t.slug = p_topic and t.deleted_at is null;
  if v_pid is null then
    raise exception 'PORTAL:NOTFOUND:no post to review for this account';
  end if;

  if v_sent_at is null then
    raise exception 'PORTAL:NOTSENT:this post is not with you for review yet';
  end if;
  if v_approved is not null then
    raise exception 'PORTAL:APPROVED:this post is already approved';
  end if;
  -- No p_version / PORTAL:STALE: channel posts have no versions (031), the body is edited in
  -- place, so there is nothing to compare an approval against.

  update channel_posts
     set client_approved_at = now(),
         client_approved_by = v_email
   where id = v_pid;
end
$$;

revoke all on function portal_suggest_channel_change(text, text, text, text, text, text, text)
  from public, anon;
grant execute on function portal_suggest_channel_change(text, text, text, text, text, text, text)
  to authenticated;
revoke all on function portal_approve_channel_post(text, text, text) from public, anon;
grant execute on function portal_approve_channel_post(text, text, text) to authenticated;
