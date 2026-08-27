-- 034_admin_notifications.sql
-- One row per admin email the engine has already sent, so it is never sent twice.
--
-- WHY A TABLE AND NOT A TIMESTAMP WATERMARK. Three of the four notified events are things a
-- CLIENT did, and the engine learns about them by polling Postgres rather than by being told:
-- the portal writes through SECURITY DEFINER RPCs over PostgREST and never touches uvicorn, so
-- there is no call site in server/ to hook. A poller needs to remember what it has already
-- reported, and a "last seen" clock is the wrong memory for it: the engine is a desktop app that
-- is stopped and started at will, so a clock either re-sends everything after a restart or skips
-- whatever landed while the machine was off. A key per event answers "did I send this one" with
-- no reference to when the process was alive.
--
-- THE KEY IS THE DEDUPE RULE, and each producer picks one that names the EVENT rather than the
-- ROW that revealed it. This matters most for a change request: the review round is what the
-- operator needs telling about, while the client may file up to ten suggestions inside it
-- (the cap at schema.sql:1605), so the key is the topic plus the send stamp that opened the
-- round and nine of those ten rows find the key already taken. server/notify.py holds the
-- shapes; they are deliberately not encoded here, because a key format is not a schema.
--
-- CLAIM BEFORE SEND, never after. server/notify.py inserts here first and mails only if the
-- insert won the row. A crash between the two therefore drops one email, and the alternative
-- crashes into a loop that mails the same event on every poll until someone kills the process.
-- Dropping one notification is recoverable by looking at the dashboard; a mail loop is not.
--
-- SERVICE ROLE ONLY, matching engine_secrets (028): RLS on with NO policy denies every JWT,
-- anon and authenticated alike, and the engine reaches it through DATABASE_URL as the owner.
-- Nothing a browser can call has any business reading or writing the engine's own outbox log.
--
-- SAFE ON A LIVE DB: creates one table, grants nothing, and adds no policy that widens any
-- existing read.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/034_admin_notifications.sql

begin;

create table if not exists admin_notifications (
  dedupe_key text primary key,
  kind       text        not null,
  sent_at    timestamptz not null default now()
);

-- The sweep asks "has anything ever been claimed" once per process to decide whether it is
-- looking at a fresh install (see notify.backfill). Nothing else reads by kind or by time, so
-- the primary key is the only index this table earns.
alter table admin_notifications enable row level security;
revoke all on admin_notifications from anon, authenticated;

commit;
