-- remove_demo_brands.sql
-- Deletes the FAKE demo/sample brands and their sample org from Supabase. This is a data cleanup
-- to run ONCE, by hand, after the demo-mode feature was removed from the code.
--
-- REAL CLIENTS ARE NEVER NAMED HERE. blr-brewing, vacation-village, bout-india, sadhwani and
-- supreme-steel are untouched: they stay in the database and keep working. This script only names
-- the placeholder brands: `demo`, `acme-north`, `acme-south`, and the `acme-group` org they share.
--
-- HOW THE DELETE REACHES EVERYTHING: every per-brand table (topics, blog_versions, roadmap_sheets,
-- roadmap_rows, status_events, ledger_entries, review_notes, blog_comments, client_resources,
-- roadmap_uploads, client_members) FKs clients(id) ON DELETE CASCADE, so deleting a client row
-- takes all of its data with it. clients.org_id is ON DELETE RESTRICT, so the brands are deleted
-- BEFORE the org. org_members references orgs by slug rather than by a cascading FK, so those rows
-- are cleared explicitly. `demo` is its own single-brand org (no orgs row); only `acme-group` is a
-- real orgs row.
--
-- IDEMPOTENT AND SAFE TO RE-RUN: a slug that is absent is simply a no-op, so if a sample brand was
-- never onboarded into this database nothing happens for it.
--
--   .venv/bin/python supabase/apply.py scripts/remove_demo_brands.sql

begin;

-- The sample brands. The cascade takes all of each brand's per-brand data with the row.
delete from clients where slug in ('demo', 'acme-north', 'acme-south');

-- Membership rows for the sample org and single-brand sample orgs (no FK cascade reaches these).
delete from org_members where org_slug in ('acme-group', 'demo', 'acme-north', 'acme-south');

-- The sample multi-brand org, now that its brands are gone and org_id ON DELETE RESTRICT is clear.
delete from orgs where slug = 'acme-group';

commit;
