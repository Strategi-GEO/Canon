-- 026_client_market.sql
-- The brand's market: geography + language, e.g. "India, English". DataForSEO keyword
-- validation needs a location and language, and Agent R prefers sources local to this market,
-- but no screen ever collected it: client.md's template told "an operator" to hand-edit a file
-- the product never surfaces, so every brand still carried the placeholder and DataForSEO was
-- skipped on every run. The column makes it a record field the onboarding dialog and the
-- Settings tab both write; sync.materialize_client splices it into the Market section of the
-- client.md it lays down, which is where the research agent reads it.
--
-- Granted to authenticated alongside domain/industry: it is identity-tier brand metadata, not
-- operator material, so the hosted read-only mirror may show it.
--
-- Idempotent, additive, safe on a live DB. schema.sql folds the same column in for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/026_client_market.sql

begin;

alter table clients
  add column if not exists market text not null default '';

grant select (market) on clients to authenticated;

commit;
