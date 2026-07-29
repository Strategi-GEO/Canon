-- 033_client_cms_slug.sql
-- Per-brand CMS routing slug: the identifier the Strategi CMS registers this brand under, which
-- can differ from the engine's own brand slug. The publish payload's `client` field routes each
-- draft (server/cms/payload.py) and the CMS matches it against its registered client; when the
-- CMS knows a brand as "bangalore-brewing-co" but the engine's slug is "blr-brewing", the push is
-- misrouted and rejected. This column lets Settings record the CMS's own slug for the brand; the
-- payload uses it when set and falls back to the engine brand slug when blank, so every existing
-- brand keeps posting exactly as before. The workaround that prompted it (renaming the brand to
-- change what the CMS sees) never worked: the slug is immutable, so a rename moved nothing and
-- only spawned a stray org.
--
-- OPERATOR MATERIAL, so no grant to authenticated: like custom_instructions, it is not in
-- schema.sql's re-grant list, so an authenticated JWT taken straight to PostgREST cannot read it.
-- The local engine reads it over the owner connection, which bypasses column grants entirely.
--
-- Idempotent, additive, safe on a live DB. schema.sql folds the same column in for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/033_client_cms_slug.sql

begin;

alter table clients
  add column if not exists cms_client text not null default '';

commit;
