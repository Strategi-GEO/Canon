-- 011_admin_reply_comment.sql
-- The operator's reply, which 009 left out and which the UI already offers.
--
-- WHY THIS IS NOT OPTIONAL: the stage page renders a Reply control on every comment, and it
-- posts to /api/clients/{slug}/blogs/{topic}/comments/{id}/reply. That route exists only on
-- the local engine. On the hosted build the control rendered, the operator typed an answer to
-- a client, pressed send, and got a 404 for a route that was never written. Hiding the control
-- would have been the smaller fix and the wrong one: replying is the cheapest, least
-- destructive thing an operator does in the review loop, and it is the one that keeps a client
-- from waiting on silence.
--
-- REPLYING IS NOT RESOLVING, and this function keeps those doors apart exactly as the engine
-- does. The parent's state is untouched, nothing is applied, no count moves. An operator
-- saying "we cut that line, it was a duplicate" is telling the client something; turning that
-- sentence into a Claude session or into a dismissal would decide the request on their behalf.
--
-- ITS GUARDS ARE DELIBERATELY NARROWER THAN EVERY OTHER admin_* FUNCTION. The engine's reply
-- route carries no demo refusal and no done gate, and says why: those exist because an apply
-- spends real API credits on an article worth polishing, and a reply spends neither. Copying
-- the fuller guard stack here would refuse replies the local build allows, which is the same
-- mistake in the opposite direction from 009's dismiss.
--
-- THE ONE-LEVEL RULE IS ENFORCED IN SQL, not assumed. A reply is not addressable as a comment:
-- the parent must be a top-level row on THIS topic, so `parent_id is null` sits in the lookup.
-- Without it a reply could be hung off another reply, and every consumer that renders a thread
-- as parent-plus-children would quietly lose the grandchild.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/011_admin_reply_comment.sql

begin;

create or replace function admin_reply_comment(
  p_brand text, p_topic text, p_comment uuid, p_body text)
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

  -- `!~ '\S'` rather than btrim, for the reason 010 gives: btrim's default trim set is the
  -- space character alone, so a reply of newlines would pass a btrim test.
  if p_body is null or p_body !~ '\S' then
    raise exception 'PORTAL:BLANK:a reply needs something in it';
  end if;

  -- The parent must be a TOP-LEVEL comment on THIS topic. topic_id scopes it to the brand,
  -- so a comment id guessed from another tenant matches nothing, and parent_id is null
  -- refuses a reply to a reply. Both conditions answer the same NOTFOUND, because a reply
  -- and an unknown id are equally not-a-comment to the person who pressed the button.
  if not exists (select 1 from blog_comments
                  where id = p_comment and topic_id = v_tid and parent_id is null) then
    raise exception 'PORTAL:NOTFOUND:no such change request on this blog';
  end if;

  insert into blog_comments
    (topic_id, client_id, parent_id, author, author_email, selected_text,
     context_before, context_after, instruction, state)
  values
    (v_tid, v_cid, p_comment, 'operator', coalesce(auth.jwt() ->> 'email', ''),
     '', '', '', p_body, 'open')
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function admin_reply_comment(text, text, uuid, text) from public, anon;
grant execute on function admin_reply_comment(text, text, uuid, text) to authenticated;

commit;
