-- 004_send_to_client.sql
-- Incremental, additive migration: the admin-review gate between "shipped" and "the client
-- sees it".
--
-- Before this, the portal derived delivered from the ledger alone, so a blog became client
-- visible the instant its run wrote the terminal done line. The new stage inserts a human:
-- a shipped blog sits in admin review (editable on the dashboard's blog stage page) until
-- an operator presses Send to client, which stamps sent_to_client_at through the engine's
-- POST /api/clients/{slug}/blogs/{topic}/send. The portal's delivered state now requires
-- the ledger row AND this stamp.
--
-- SAFE ON A LIVE DB: additive columns, and the backfill marks every blog the ledger
-- already records as shipped as sent at its ledger date. Those blogs were already visible
-- to their clients as delivered, and adding the gate must not un-deliver history: a client
-- watching an article they have already received vanish is the exact failure the portal's
-- own state model forbids.
--
-- Idempotent: add column if not exists, and both backfills only fill nulls.
-- Keep in sync with schema.sql, the authority for fresh builds (folded in with this
-- change).
--
--   psql "$DATABASE_URL" -f supabase/migrations/004_send_to_client.sql

begin;

alter table topics add column if not exists sent_to_client_at timestamptz;
alter table topics add column if not exists sent_to_client_by text;

-- 003 made topics column-scoped for `authenticated` (revoke table, grant safe columns), so
-- a new column is invisible to the portal and the hosted dashboard until it is granted.
-- sent_to_client_at is safe: it says when a blog was released, which is exactly what the
-- portal renders. sent_to_client_by stays ungranted: no client surface reads it, and an
-- operator's email is operator material.
grant select (sent_to_client_at) on topics to authenticated;

-- Backfill, pass 1: ledger rows whose topic_slug matches the topic directly.
update topics t
   set sent_to_client_at = coalesce(l.generated_at, now()),
       sent_to_client_by = coalesce(t.sent_to_client_by, 'backfill-004')
  from ledger_entries l
 where l.client_id = t.client_id
   and l.topic_slug = t.slug
   and t.sent_to_client_at is null;

-- Backfill, pass 2: ledger rows the app matches by slugifying their topic text
-- (roadmap.slugify: lowercase, non-alphanumerics to hyphens, trimmed). ONLY rows whose
-- topic_slug cell is empty, because that is the one case the app's own ledger fold falls
-- back to the slugified topic: a row with a real topic_slug is already pass 1's to match,
-- and slug-matching it here could stamp a topic its ledger row does not name.
update topics t
   set sent_to_client_at = coalesce(l.generated_at, now()),
       sent_to_client_by = coalesce(t.sent_to_client_by, 'backfill-004')
  from ledger_entries l
 where l.client_id = t.client_id
   and coalesce(l.topic_slug::text, '') = ''
   and trim(both '-' from regexp_replace(lower(l.topic), '[^a-z0-9]+', '-', 'g')) = t.slug
   and t.sent_to_client_at is null;

commit;
