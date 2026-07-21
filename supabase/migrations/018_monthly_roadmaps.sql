-- 018_monthly_roadmaps.sql
-- A brand may now hold MORE THAN ONE roadmap: one per "month", numbered 1, 2, 3, ... in the
-- order they were added. The operator names them "Month N Roadmap" and can view or delete each
-- independently; "Add New Month Roadmap" always creates the next number. There is NO calendar
-- date in this: `month` is a sequence label, not a timestamp.
--
-- WHAT CHANGES:
--   1. roadmap_sheets gains `month int not null default 1`. Every existing sheet becomes Month 1,
--      which is exactly "set all current roadmaps to month 1".
--   2. The UNIQUE that made one-sheet-per-brand (roadmap_sheets_client_id_key) is dropped and
--      replaced by UNIQUE (client_id, month). That single swap is what lifts the "one roadmap per
--      brand" rule the app enforced with 409s on upload and generate.
--   3. `month` is granted to `authenticated` so the hosted dashboard can list a brand's months
--      over PostgREST, exactly as it already reads filename/columns/modified.
--   4. admin_delete_roadmap gains a p_month argument: the hosted delete now names WHICH month to
--      remove, since client_id alone no longer identifies one sheet.
--
-- Idempotent guards throughout (`if not exists`, `if exists`): schema.sql folds this same final
-- state in for fresh local builds, so this migration must be safe to apply whether or not the
-- column is already present.
--
--   .venv/bin/python supabase/apply.py supabase/migrations/018_monthly_roadmaps.sql

begin;

-- 1 + 2: the column, then the constraint swap. Default 1 backfills every existing row to Month 1.
alter table roadmap_sheets add column if not exists month int not null default 1;

alter table roadmap_sheets drop constraint if exists roadmap_sheets_client_id_key;
-- Guarded so the whole migration is safely re-runnable (add-constraint has no IF NOT EXISTS form).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'roadmap_sheets_client_month_key') then
    alter table roadmap_sheets add constraint roadmap_sheets_client_month_key unique (client_id, month);
  end if;
end $$;

-- 3: the harmless identity column the portal may read. raw_csv and report stay ungranted.
grant select (month) on roadmap_sheets to authenticated;

-- admin_roadmap_sheets (migration 008) was created as `select *`, and Postgres freezes a view's
-- column list at creation, so the view built before this column existed does NOT carry `month`.
-- The hosted sheet and report routes filter and order by month against this view, so recreate it
-- to pick the column up. CREATE OR REPLACE VIEW only appends `month` at the end of the existing
-- column list, which it permits, and the 008 grant to `authenticated` survives the replace.
create or replace view admin_roadmap_sheets as
  select * from roadmap_sheets where auth_is_admin();

-- 4: the hosted delete, now month-scoped. Same authorisation rule as every other admin_* write:
-- gate on auth_is_admin() via admin_brand_id, resolve the brand from the text slug, archive the
-- sheet's CSV and report into roadmap_uploads, then delete THAT month's sheet and let the cascade
-- take its roadmap_rows. The old single-argument form is dropped so no caller can reach the
-- month-blind delete by accident.
drop function if exists admin_delete_roadmap(text);

create or replace function admin_delete_roadmap(p_brand text, p_month int)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cid   uuid := admin_brand_id(p_brand);
  v_id    uuid;
  v_csv   text;
  v_rep   text;
  v_stamp text := to_char(now() at time zone 'utc', 'YYYYMMDD"T"HH24MISS"Z"');
begin
  delete from roadmap_sheets where client_id = v_cid and month = p_month
  returning id, raw_csv, report into v_id, v_csv, v_rep;

  if v_id is null then
    raise exception 'PORTAL:NOSHEET:this brand has no Month % roadmap to delete', p_month;
  end if;

  insert into roadmap_uploads (client_id, filename, raw)
  values (v_cid, v_stamp || '-deleted-roadmap.csv', convert_to(coalesce(v_csv, ''), 'UTF8'));
  if v_rep is not null then
    insert into roadmap_uploads (client_id, filename, raw)
    values (v_cid, v_stamp || '-deleted-roadmap-report.md', convert_to(v_rep, 'UTF8'));
  end if;

  return jsonb_build_object('deleted', true);
end
$$;

revoke all on function admin_delete_roadmap(text, int) from public, anon;
grant execute on function admin_delete_roadmap(text, int) to authenticated;

commit;
