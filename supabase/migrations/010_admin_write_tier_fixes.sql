-- 010_admin_write_tier_fixes.sql
-- Three defects in 009, all found by an adversarial review of it and all reproduced against a
-- live database before being fixed here. 009 is left in history rather than rewritten, because
-- it is already applied and a migration that quietly changes what an applied migration did is
-- a migration nobody can audit.
--
-- ============================================================================
-- 1. HIGH: admin_dismiss_comment DELETED the row. It must DISMISS it.
-- ============================================================================
-- blog_edit.dismiss_comment does `update ... set state = 'dismissed', finished_at = now()`,
-- and its docstring states the rule in capitals: "DISMISSED, NEVER DELETED, since the record
-- went shared: the client can see their own suggestion, and a row that silently vanished reads
-- as lost while a dismissed one reads as reviewed." 009 issued a hard DELETE over a
-- character-identical WHERE clause, which breaks that rule twice over.
--
-- The second breakage is worse than the first and is why this is HIGH rather than a cosmetic
-- divergence. blog_comments.parent_id carries `on delete cascade`, so deleting a top-level
-- comment destroys EVERY REPLY on it: the client's own follow-ups and the operator's written
-- answer, gone with the parent. Two independent reviewers reproduced it on a fixture topic: a
-- parent plus one reply, delete the parent, both rows gone.
--
-- Downstream, three consumers read the surviving row. portal-data.ts maps 'dismissed' to the
-- client-facing word "reviewed", the portal's comment rail renders it as "Reviewed, no change",
-- and the stage page fetches dismissed rows and filters them. A deleted row reaches none of
-- them, so the client sees their suggestion and the whole conversation vanish rather than read
-- as reviewed, and there is no audit row left and nothing to recover from.
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

  -- The engine's statement, verbatim in behaviour. topic_id in the WHERE remains the scope
  -- check: a comment id belonging to another brand matches nothing.
  update blog_comments
     set state = 'dismissed', finished_at = now()
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

-- ============================================================================
-- 2. HIGH: admin_save_blog_content dropped the score and the eval body.
-- ============================================================================
-- 009 wrote both as NULL with a comment claiming the engine's manual save does the same. It
-- does not. sync.commit_topic's insert passes `score, eval_body` on every version it writes:
-- the score comes from the status fold, which an edit does not touch, and eval_body is read
-- from the eval.md still sitting in scratch. So a locally saved edit KEEPS the number the
-- draft earned and the audit that justified it.
--
-- Nulling them costs more than the two columns, and this is the part worth spelling out. The
-- `uploaded` flag every surface reads is inferred as "status is done AND the latest version has
-- no score" (see _blog_history in server/app.py). A hosted edit that nulled the score would
-- therefore flip a generated blog that scored 96 into reading as UPLOADED everywhere: the
-- library would show "uploaded" instead of its score, and the stage page would replace its
-- score trail with a provenance chip and tell the operator no evaluator ever saw it. One typo
-- fix would rewrite the blog's history.
--
-- Carried forward from the previous latest version rather than recomputed, because that row is
-- exactly what the engine reads: the same number, from the same place, for the same bytes.
create or replace function admin_save_blog_content(
  p_brand text, p_topic text, p_body text, p_base_version_no int)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid   uuid := admin_brand_id(p_brand);
  v_tid   uuid;
  v_cur   int;
  v_new   int;
  v_vid   uuid;
  v_h1    text;
  v_words int;
  v_score int;
  v_eval  text;
begin
  perform admin_refuse_demo(v_cid);
  v_tid := admin_done_topic(v_cid, p_topic, 'editing');

  -- `!~ '\S'` rather than btrim: btrim's DEFAULT trim set is the space character alone, so
  -- `btrim(E'\n\t\n') = ''` is FALSE and 009's guard accepted an article of nothing but
  -- newlines and tabs, saving it as a version. This tests for the absence of any
  -- non-whitespace character, which is what "blank" means and cannot be misread.
  if p_body is null or p_body !~ '\S' then
    raise exception 'PORTAL:BLANK:an empty article cannot be saved; delete the topic instead if that is the intent';
  end if;
  if octet_length(p_body) > 1000000 then
    raise exception 'PORTAL:TOOLARGE:the article is over 1 MB, which no blog is';
  end if;

  if exists (select 1 from blog_comments
              where topic_id = v_tid and parent_id is null and state = 'applying') then
    raise exception 'PORTAL:APPLYING:a change is being applied to this article; save once it lands';
  end if;

  perform 1 from topics where id = v_tid for update;

  select coalesce(max(version_no), 0) into v_cur from blog_versions where topic_id = v_tid;
  if p_base_version_no is null or p_base_version_no <> v_cur then
    raise exception 'PORTAL:STALE:this article changed while you were editing (you started from version %, it is now at %); reload and reapply your edit',
      coalesce(p_base_version_no, 0), v_cur;
  end if;

  -- The score and the audit the previous version carried. An edit does not re-score a draft
  -- and does not invalidate the evaluator's report of it, which is precisely why the engine
  -- carries both across.
  select score, eval_body into v_score, v_eval
    from blog_versions where topic_id = v_tid order by version_no desc limit 1;

  v_new := v_cur + 1;
  v_h1 := substring(
            (select l from regexp_split_to_table(p_body, E'\n') as l
              where l like '# %' limit 1) from 3);
  -- len(body.split()) in Python: split on runs of ANY whitespace, ignore the empties that
  -- leading and trailing whitespace produce. 009 used
  -- array_length(regexp_split_to_array(btrim(body), '\s+'), 1), which counts a trailing empty
  -- token for any body ending in a newline, so every article was one word over: 3 where the
  -- engine says 2. Counting non-empty tokens cannot produce that.
  select count(*) into v_words from regexp_split_to_table(p_body, E'\\s+') w where w <> '';

  insert into blog_versions
    (topic_id, client_id, version_no, iteration, body, h1_title, word_count,
     score, eval_body, shipped, committed_at)
  values
    (v_tid, v_cid, v_new,
     greatest(least(coalesce((select iterations from topic_rollup where topic_id = v_tid), 1), 8), 1),
     p_body, v_h1, v_words, v_score, v_eval, true, now())
  returning id into v_vid;

  update topics set shipped_version_id = v_vid where id = v_tid;

  return jsonb_build_object('version_no', v_new, 'word_count', v_words);
end
$$;

-- ============================================================================
-- 3. MEDIUM: the same blank test and the same word count in admin_upload_blog.
-- ============================================================================
-- Same two defects, same fixes. score and eval_body stay NULL here and that is CORRECT rather
-- than an oversight: an upload is an article no evaluator ever saw, so the null score is the
-- honest record and is what makes the `uploaded` inference true for it.
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

  if p_body is null or p_body !~ '\S' then
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
  select count(*) into v_words from regexp_split_to_table(p_body, E'\\s+') w where w <> '';
  v_h1 := substring(
            (select l from regexp_split_to_table(p_body, E'\n') as l
              where l like '# %' limit 1) from 3);

  insert into blog_versions
    (topic_id, client_id, version_no, iteration, body, h1_title, word_count,
     score, eval_body, shipped, committed_at)
  values (v_tid, v_cid, v_new, 1, p_body, v_h1, v_words, null, null, true, now())
  returning id into v_vid;

  update topics set shipped_version_id = v_vid where id = v_tid;

  select coalesce(max(line_no) + 1, 0) into v_line from status_events where topic_id = v_tid;
  insert into status_events
    (topic_id, client_id, line_no, ts, stage, event, iter, score, status, note, slug_reported)
  values (v_tid, v_cid, v_line, now(), 'write', 'end', 1, null, 'done',
          'uploaded by ' || coalesce(nullif(v_mail, ''), 'an operator')
            || '; no engine run, no evaluator score', p_topic);

  insert into ledger_entries (client_id, topic_slug, topic, covers, prompts, score, generated_at, run_id)
  values (v_cid, p_topic, coalesce(v_row.topic, p_topic), coalesce(v_row.covers, ''),
          coalesce(v_row.prompts, '{}'::text[]), null, now(), null)
  on conflict (client_id, topic_slug) do nothing;

  return jsonb_build_object(
    'topic_slug', p_topic,
    'word_count', v_words,
    'version_no', v_new,
    'replaced', v_cur > 0,
    'gates', jsonb_build_object('ran', false, 'failures', '[]'::jsonb,
                                'reason', 'the mechanical gates run in the local engine and did not run for this upload'));
end
$$;

-- Same blank fix for the comment text, for the same reason.
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

  if p_selected_text is null or p_selected_text !~ '\S' then
    raise exception 'PORTAL:BLANK:select the text this change applies to';
  end if;
  if p_instruction is null or p_instruction !~ '\S' then
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

-- Signatures are unchanged, so 009's grants still stand. Restated anyway, because a migration
-- that redefines a function and assumes the old grant survives is one `drop function` away
-- from an outage nobody can explain.
revoke all on function admin_dismiss_comment(text, text, uuid) from public, anon;
revoke all on function admin_save_blog_content(text, text, text, int) from public, anon;
revoke all on function admin_upload_blog(text, text, text, boolean) from public, anon;
revoke all on function admin_add_comment(text, text, text, text, text, text) from public, anon;

grant execute on function admin_dismiss_comment(text, text, uuid) to authenticated;
grant execute on function admin_save_blog_content(text, text, text, int) to authenticated;
grant execute on function admin_upload_blog(text, text, text, boolean) to authenticated;
grant execute on function admin_add_comment(text, text, text, text, text, text) to authenticated;

commit;
