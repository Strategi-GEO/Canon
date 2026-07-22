-- 025_remove_replies_add_instruction_stamp.sql
-- The reply feature is REMOVED, and comments gain the brand-instructions stamp.
--
-- Comments are not threads any more: a client files a note, the team resolves it with Claude
-- or dismisses it, and that is the whole conversation. Both reply write doors close:
--
--   portal_reply_comment  (002, hardened in 005)  the client's reply from the portal
--   admin_reply_comment   (011)                   the operator's reply from the hosted console
--
-- Dropping the functions is the enforcement: both were granted to `authenticated`, so hiding
-- the buttons alone would leave the doors callable straight through PostgREST. NOTHING ELSE
-- MOVES. Historic reply rows stay (they render as thread history), the parent_id column stays,
-- and the blog_comments_reply_open constraint stays, because portal_submit_answers stores a
-- client's question answers as parent_id rows and must keep doing so. Migration 013's
-- parent_id exemption in refuse_comment_when_approved also stays, for those same answer rows.
--
-- added_to_instructions stamps a comment the engine has reframed into a standing brand
-- instruction (the "Add to brand instructions" button). Stamped once, by the engine over the
-- owner connection; authenticated needs no new grant to read it because the engine serves
-- comments to the dashboard itself.
--
-- Idempotent, additive apart from the two drops, safe on a live DB. schema.sql carries the
-- same shape for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/025_remove_replies_add_instruction_stamp.sql

begin;

drop function if exists portal_reply_comment(text, text, uuid, text);
drop function if exists admin_reply_comment(text, text, uuid, text);

alter table blog_comments
  add column if not exists added_to_instructions timestamptz;

commit;
