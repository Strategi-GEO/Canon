-- 021_client_custom_instructions.sql
-- Per-brand custom blog instructions: the operator's standing directives for every blog this
-- brand produces, edited from the Settings tab and obeyed by the research/write/eval agents as
-- a MAJOR priority. They rank above house style defaults and the roadmap guidance, and NEVER
-- above canonical_facts (the fact base and do-not-claim list stay binding), so this is a plain
-- text column beside client_md rather than anything the fact base reads.
--
-- MATERIALIZED, not read from the record at run time: sync.materialize_client writes it to
-- clients/<slug>/custom-instructions.md every run (empty string when the brand set none), the
-- same record-wins pattern description.md already uses, so the agents read a real file by path.
--
-- OPERATOR MATERIAL, so it is protected by DEFAULT and needs no revoke here. schema.sql already
-- "revoke select on clients from authenticated" then re-grants SELECT on the identity + flag
-- columns ONLY (id, slug, name, domain, industry, description, ...). A column added after that
-- re-grant is not in the list, so an authenticated JWT taken straight to PostgREST cannot read
-- it, exactly like client_md and canonical_facts. The local engine reads it over the owner
-- connection, which bypasses column grants entirely.
--
-- Idempotent, additive, safe on a live DB. schema.sql folds the same column in for fresh builds.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/021_client_custom_instructions.sql

begin;

alter table clients
  add column if not exists custom_instructions text not null default '';

commit;
