-- 012_publish_tracking.sql
-- What the record has never known: that a blog was pushed to the CMS.
--
-- server/cms/routes.py builds a payload, POSTs it, logs the result and returns it to the
-- browser. It writes NOTHING. So "did this article already go out?" has been answerable
-- only by opening the CMS and looking, and an operator who published on Tuesday and forgot
-- has no way to find out from this app. That is the whole gap this migration closes.
--
-- THERE IS NO BACKFILL, AND THAT IS NOT AN OVERSIGHT. 004 could backfill sent_to_client_at
-- because ledger_entries already recorded every shipped blog, so the fact existed and only
-- needed copying into a column. Here the fact does not exist anywhere: no table, no log
-- line that survives a restart, no CMS mirror. Inventing a stamp from generated_at would
-- assert a push that may never have happened, on a column whose only purpose is to be
-- trusted. History therefore starts now, and every consumer must treat a null published_at
-- as "no record of a push" rather than "not published". The UI says exactly that: it
-- renders a chip when the stamp EXISTS and renders nothing when it does not, so the app
-- never states the negative it cannot know.
--
-- SAFE ON A LIVE DB: five additive nullable columns, one grant, one view replaced.
-- Idempotent: add column if not exists, create or replace view.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/012_publish_tracking.sql

begin;

alter table topics add column if not exists published_at  timestamptz;
alter table topics add column if not exists published_by  text;
alter table topics add column if not exists cms_post_id   text;
alter table topics add column if not exists cms_slug      text;
alter table topics add column if not exists cms_status    text;

-- WHY published_at IS RE-STAMPED RATHER THAN FIRST-WRITE-WINS, matching mark_sent: a push
-- over an existing post updates the CMS draft in place (payload.source_run_id is a uuid5 of
-- the brand and topic, so it addresses the same post forever). The interesting fact is when
-- the CMS last received these bytes, not when it first received any bytes for this topic.
--
-- cms_status IS THE CMS's OWN WORD FOR THE POST, not ours, and it is the reason this is more
-- than a timestamp. A push whose result is `skipped` means a human already advanced that post
-- past draft, so the article is LIVE and pushing again will not change it. An operator
-- reading only a date cannot tell that state from an ordinary draft, and those two call for
-- opposite actions.

-- 003 made topics column-scoped for `authenticated` (revoke table, grant safe columns), so a
-- new column is invisible to the portal and the hosted dashboard until it is granted, and a
-- hosted route that selects an ungranted column gets its WHOLE request refused by PostgREST
-- (a 502 for every caller of that route, not a missing field).
--
-- ONLY published_at is granted. It is the one fact a surface renders, and it is the same
-- shape of fact as sent_to_client_at: a date something happened to this article.
--
-- The other four stay ungranted, each for a reason 004 and 005 already established:
--   published_by  is an operator's email, exactly like sent_to_client_by and
--                 client_approved_by, both deliberately withheld for that reason.
--   cms_post_id, cms_slug, cms_status are OUR CMS's internals. No client surface renders
--                 them, and a client has no use for the id of a row in a system they do not
--                 have an account on. The hosted admin reads them through admin_topics
--                 below, which is gated on auth_is_admin().
grant select (published_at) on topics to authenticated;

-- admin_topics is `select * from topics`, and a star in a view is NOT dynamic: Postgres
-- expands it at creation time into a fixed column list stored in the rewrite rule, so the
-- view created in 003 does not know these five columns exist. Replacing it re-expands the
-- star. This is legal for `create or replace view` because the added columns land at the END
-- of the list, and appending is the one column-list change that form permits.
create or replace view admin_topics as
  select * from topics where auth_is_admin();

-- 006 flipped every admin_* view to definer semantics, and this re-asserts it rather than
-- trusting the replace to carry the reloption. Getting it wrong is silent and total: with
-- security_invoker = true the view runs as the CALLER, whose grants 003 revoked, so it
-- returns nothing to everybody and the routes reading it 502. That is precisely the bug 006
-- existed to fix, and it is not worth re-earning to save a line.
alter view admin_topics set (security_invoker = false);

commit;
