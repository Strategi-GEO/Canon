-- 029_releases_bucket.sql
-- A private Storage bucket that holds the code-only app-update packages the desktop app pulls.
--
-- WHY A BUCKET AND NOT THE GITHUB RELEASE. The repo is private, so a GitHub release asset needs
-- a token on every user's machine to download. The app already fetches the Supabase service key
-- at login (028), and that key reads a private bucket with no extra secret, so updates ride the
-- credential the app already has. CI (build-canon-app.yml) uploads on each version tag:
--   releases/latest/<platform>/manifest.json   {"version","sha256","published"}
--   releases/latest/<platform>/canon-update.tar.gz
-- <platform> is 'macos' or 'windows'. app_update.py reads the manifest, compares versions, and
-- downloads the package when a newer one exists.
--
-- PRIVATE ON PURPOSE: public = false, and NO policy is added for anon or authenticated, so the
-- only reader is the service role (the engine) and the only writer is CI (also the service role).
-- This mirrors 028_engine_secrets: the sensitive path is reachable by the service key alone.
--
-- SAFE ON A LIVE DB: one bucket row, idempotent, no policy that widens any existing access.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/029_releases_bucket.sql

begin;

insert into storage.buckets (id, name, public)
values ('releases', 'releases', false)
on conflict (id) do nothing;

commit;
