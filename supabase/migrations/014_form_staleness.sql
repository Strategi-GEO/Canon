-- ---------------------------------------------------------------------------
-- 014: form staleness is VERSION **OR** ITERATION, in all four twins at once
-- ---------------------------------------------------------------------------
-- WHAT THIS CHANGES. portal_submit_answers refused a submission as PORTAL:STALE on ONE
-- signal: the form's asked_iter against the topic's high-water status_events iter. It now
-- refuses on that OR on the form's version anchor no longer being the topic's current
-- version. Nothing else about the function moves; this file re-states it whole because
-- plpgsql has no way to replace one arm of a body.
--
-- WHY THE ANCHOR LEADS. review_notes.blog_version_id is NOT NULL with a composite FK to
-- blog_versions(id, topic_id), so "these questions are about that exact draft" is a fact the
-- database enforces. schema.sql says as much at the table itself: the anchor is what makes
-- staleness an FK comparison rather than an integer that resembles one. An iteration is a
-- per-topic counter, and a revise that commits a new version while the iteration lands on the
-- same number leaves the old check reporting a form as current when the draft it describes is
-- gone. The anchor was available to this function all along and went unread.
--
-- WHY THE ITERATION ARM STAYS, which is the part a reader is tempted to drop. A RESTORE
-- COMMITS NO NEW VERSION. The stop-mid-revise path puts blog.md and eval.md back byte for
-- byte, so no blog_versions row is added and the form's anchor still points at the topic's
-- current version, while the iteration has moved past it. A version-only check reads that
-- form as current and accepts answers about a draft the blog has moved on from. This is why
-- the rule is OR and not the pure anchor comparison the FK would otherwise justify, and it is
-- the case the comments in 002 and server/questions.py were both recording.
--
-- ATOMICITY, and the DEPLOY ORDER THIS FILE REQUIRES. The same verdict is computed in four
-- places: server/questions.py (describe_questions), dashboard portal-data.ts (foldTopics),
-- server/client_answers.py (_PENDING_SQL, which computes the COMPLEMENT and so reads
-- "version matches AND iteration matches"), and here. Tightening some but not all deadlocks
-- the loop in one of two directions, so this migration DEPLOYS LAST, after the app twins:
--
--   * App first, then SQL: strictly safe. The app twins only ever SHRINK the set of forms
--     offered for answering, and this RPC is reachable only through a form the portal
--     offered. A still-loose RPC behind an already-strict portal is unreachable-permissive,
--     which is invisible rather than harmful, and the sweep has already stopped dispatching
--     for the same forms.
--   * SQL first, then app: NOT safe. A portal still rating a form answerable while this
--     function refuses it puts a client in front of a box that accepts their typing and then
--     always errors, with no way for them to tell why.
--
-- NO BACKFILL, and none is possible to need. A live survey found 0 forms whose anchor and
-- iteration disagree, so this reclassifies nothing that exists today: it closes the case
-- before it happens rather than repairing one that already did. Staleness is computed at read
-- time from rows that already carry both signals, so there is no stored verdict to correct.
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
  v_demo            boolean;
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

  if v_demo then
    raise exception 'PORTAL:DEMO:demo brands never run a real revise, so answers are not accepted';
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

-- Postgres grants EXECUTE on a REPLACED function's new definition from the existing ACL, but
-- re-stating both lines costs nothing and makes this file safe to run against a database where
-- the function was created by hand rather than by 002/003.
revoke all on function portal_submit_answers(text, text, jsonb) from public, anon;
grant execute on function portal_submit_answers(text, text, jsonb) to authenticated;
