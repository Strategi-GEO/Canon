-- 039: the org/brand slug triggers name the client portal, which is what they protect.
--
-- NOTHING ABOUT THE INVARIANT MOVES. Both functions are replaced body for body with the same
-- predicate, the same errcode and the same scoping to live rows; the triggers themselves are not
-- touched, so their DEFERRABLE INITIALLY DEFERRED timing and their UPDATE OF fire lists stand as
-- 017 wrote them. What changes is the sentence a human reads when one fires.
--
-- WHY THEY WERE WRONG. 017 argued the invariant entirely from the CMS write key: a brand with
-- org_id null synthesises its own slug as its org, server/cms/routes.py turned that into
-- STRATEGI_CMS_WRITE_KEY_<ORG>, and the Strategi CMS derived the destination tenant FROM THE KEY,
-- so one client's blog landed in another's CMS. Commit 5d80403 replaced the per-org keys with one
-- shared key and migration 038 removed the CMS outright, so these messages now tell an operator
-- their write is refused to protect a system that does not exist. A guard nobody can act on is
-- most of the way to a guard somebody works around.
--
-- WHY THE INVARIANT SURVIVED ITS OWN JUSTIFICATION. A larger harm was underneath it the whole
-- time. `org_membership` derives org_slug as COALESCE(orgs.slug, clients.slug), which IS this
-- synthesis, and every client-portal RLS policy in schema.sql joins
-- `org_members om on om.org_slug = m.org_slug`. So a real org and a self-org brand sharing a slug
-- resolve to ONE org_slug, and a single grant on it reaches both tenants: the client signs in and
-- reads a stranger's brand, its blogs, its comments and its roadmap. Measured on the live record
-- inside a rolled-back transaction, an org `vilvah` created beside the existing self-org brand
-- `vilvah` made one grant on `vilvah` return both brands.
--
-- A misrouted draft was one article in the wrong tenant. This is standing read access to another
-- client's whole workspace, so the guard is load-bearing rather than legacy.
--
-- THE READ-TIME NET MOVED WITH THE HARM, and 017's closing paragraph is now stale about where it
-- lives. It said a collision already in the record is "caught at read time by
-- server/clients.py's synthesised_org_collides, immediately before a key is resolved". Nothing
-- has called that since 5d80403 orphaned it. It is now `clients.org_slug_collides`, called by
-- `clients.refuse_grant_on_collision` from the two doors that write an `org_members` row:
-- portal_login.provision_one and seed_org_users. That is the last moment a collision is still
-- inert, because a collision with no grant on it leaks nothing.
--
-- STILL NOT VALIDATED AGAINST EXISTING ROWS, exactly as 017 said: Postgres checks a trigger only
-- on rows written after it exists. Query for a pre-existing collision rather than assuming:
--
--   select c.slug from clients c join orgs o on o.slug = c.slug
--    where c.org_id is null and c.deleted_at is null;
--
-- Measured 2026-08-31: that query returns no rows. The refusals below are preventive.
--
-- Idempotent (create or replace), rewrites no row, alters no column.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/039_org_slug_guard_names_the_portal.sql

begin;

create or replace function refuse_org_slug_collision() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  v_brand text;
begin
  -- Fires on orgs. The offending party is any LIVE brand carrying this slug with no org of its
  -- own, which is exactly the set org_membership resolves under this same slug. A brand that HAS
  -- an org is not in the set however its slug reads: the org_id is the operator's own statement
  -- that these are one tenant, which is the flagship case 017 defends.
  select c.slug into v_brand
    from clients c
   where c.slug = new.slug
     and c.org_id is null
     and c.deleted_at is null
   limit 1;

  if v_brand is not null then
    raise exception using
      errcode = '23514',
      message = format(
        'the organisation slug %L is already the slug of the brand %L, which has no '
        'organisation of its own', new.slug, v_brand),
      detail  = 'org_membership derives org_slug as coalesce(orgs.slug, clients.slug), so both '
                'would resolve to this one slug and a single client-portal grant on it would '
                'read both tenants.',
      hint    = 'Rename the organisation, or give that brand this organisation first.';
  end if;
  return null;
end $$;

create or replace function refuse_self_org_collision() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  -- Only a LIVE brand with NO org can break the invariant, so an org-bearing or soft-deleted
  -- brand leaves here. That early exit is what makes watching deleted_at cheap.
  if new.org_id is not null or new.deleted_at is not null then
    return null;
  end if;

  if exists (select 1 from orgs o where o.slug = new.slug) then
    raise exception using
      errcode = '23514',
      message = format(
        'the brand slug %L is already an organisation slug, so a brand with no organisation '
        'of its own would share that organisation''s client-portal login', new.slug),
      detail  = 'org_membership derives org_slug as coalesce(orgs.slug, clients.slug), so this '
                'brand and that organisation''s brands would resolve to one slug and each '
                'client could read the other.',
      hint    = 'Give this brand an explicit organisation, or rename the organisation holding '
                'that slug. If this is an undelete, the collision was inert only while the '
                'brand was deleted.';
  end if;
  return null;
end $$;

commit;
