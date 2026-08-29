-- 036_unpublish.sql
-- Two columns recording that a published article was taken back off a client's website.
--
-- WHY COLUMNS AND NOT A status.jsonl LINE. CLAUDE.md's Status protocol is explicit that the app
-- appends EXACTLY ONE further terminal line, the operator-promotion `done`. Carrying this fact on
-- the trail would cost a contract amendment and would route an audit fact through the terminal
-- machinery, where a mis-step becomes a wrong VERDICT. These are two facts about a push, and they
-- belong beside published_at and published_by, which 012 put here for the same reason.
--
-- unpublished_at IS ALSO LOAD-BEARING AND NOT MERELY AUDIT, which is what earns it a migration
-- rather than a log line. cms/record.py remote_article selects
-- `coalesce(published_at, unpublished_at)` as the pushed_at that wordpress._edited_since compares
-- against. record_unpublish CLEARS published_at, because that column is what every surface reads
-- to mean "this is live on their site". With nothing to coalesce to, pushed_at goes None,
-- _edited_since returns False on its first line, and the guard protecting a client's own edits
-- from being overwritten is OFF for every later push. This column is what keeps it armed.
--
-- UNGRANTED TO `authenticated`, deliberately, and unlike 035's cms_url/published_to. Those two
-- are rendered to a client in the portal (the live link and the destination label). These two are
-- an operator's email and the moment they retracted something: internal, and 003's rule is that
-- topics is column-scoped for `authenticated` with only the safe columns re-granted. The engine
-- reads them over the owner connection, which bypasses column grants entirely.
--
-- SAFE ON A LIVE DB: two additive nullable columns, no backfill, no grant, one view replaced.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/036_unpublish.sql

begin;

alter table topics add column if not exists unpublished_at timestamptz;
alter table topics add column if not exists unpublished_by text;

-- admin_topics is `select * from topics`, and a star is expanded at creation time, so a view
-- created before these columns existed does not carry them. Replaced for the same reason 035
-- replaced it, and the reloption is re-asserted below rather than trusted to survive the replace.
create or replace view admin_topics as select * from topics;

-- security_invoker = false: with true the view runs as the CALLER, whose grants 003 revoked, so
-- it returns nothing to everybody.
alter view admin_topics set (security_invoker = false);

commit;
