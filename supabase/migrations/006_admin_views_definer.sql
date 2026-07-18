-- 006_admin_views_definer.sql
-- Make migration 003's admin-only views actually work.
--
-- THE BUG, and it is 003's own: that migration revoked table-wide SELECT from `authenticated`
-- and re-granted only the client-safe columns, which was right and closed a real leak. It then
-- created six admin_* views carrying the full column set, gated on auth_is_admin(), and said
-- plainly what they were for:
--
--   "they exist so the hosted read path has a route to eval_body / dossier / score without
--    the base-table grants that leaked"
--
-- and then set `security_invoker = true` on every one of them. A security_invoker view runs
-- with the CALLER's privileges, so those views hit the very column grants they were created to
-- get around. They cannot return a row to anyone who could not already read the base table
-- directly, which makes them inert: the escape hatch was welded shut in the same statement
-- that built it.
--
-- WHAT IT BROKE, concretely: the hosted /api/me reads listClients, which probes
-- `clients?select=slug&canonical_facts=not.is.null`. Filtering needs SELECT on the filtered
-- column, `canonical_facts` is (correctly) not granted, so PostgREST answers 401, the route
-- turns it into a 502, and the site root catches it and renders "Could not open your
-- workspace. Please refresh to try again." An operator with a perfectly good session could not
-- get into the dashboard at all.
--
-- THE FIX: security_invoker = false, so the view runs as its owner and the base-table column
-- grants do not apply, which is the whole point of a definer view. The gate is then
-- auth_is_admin() alone, and that function is sound: STABLE SECURITY DEFINER with a pinned
-- search_path, returning `exists (select 1 from app_admins where user_id = auth.uid())`. A
-- non-admin authenticated JWT gets `where false` and therefore zero rows, exactly as 003
-- described. `anon` is not granted these views at all and is unaffected.
--
-- WHAT THIS DOES NOT DO: it does not restore any base-table grant. A client's JWT still cannot
-- read score, eval_body, dossier, canonical_facts, or status internals off the base tables,
-- which is 003's actual protection and it stays exactly as strict. This migration only makes
-- the admin path that 003 designed reachable by admins.
--
-- RLS: a definer view owned by postgres bypasses row security on the base tables. That is
-- correct here and not a widening: an admin's scope is every row already (RLS shows an admin
-- everything, and the local engine reads as owner), so the rows an admin sees through these
-- views are the rows they were always entitled to. Every other caller is stopped by the
-- auth_is_admin() predicate before row security would have mattered.
--
-- Idempotent and reversible: `set (security_invoker = false)` can be flipped back with
-- `set (security_invoker = true)` if this is ever judged wrong.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/006_admin_views_definer.sql

begin;

alter view admin_blog_versions  set (security_invoker = false);
alter view admin_topics         set (security_invoker = false);
alter view admin_status_events  set (security_invoker = false);
alter view admin_review_notes   set (security_invoker = false);
alter view admin_ledger_entries set (security_invoker = false);
alter view admin_clients        set (security_invoker = false);

-- The grants 003 already made are kept as they are; re-stated so this file is complete on its
-- own and re-runnable against a database where someone revoked one by hand.
grant select on admin_blog_versions, admin_topics, admin_status_events,
  admin_review_notes, admin_ledger_entries, admin_clients to authenticated;

commit;
