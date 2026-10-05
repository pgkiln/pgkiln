-- ---------------------------------------------------------------------
-- Interactive grid: saved grid reports and each user's column layout
--
-- A grid region's saved reports live in meta.saved_report like an
-- interactive report's (search, filters, aggregates, rows per page as the
-- r<id>_* parameters), plus the column layout as r<id>_lay (JSON: order,
-- hidden, widths, frozen). Besides the named reports, every user has one
-- row of kind 'layout' per grid: the layout they last arranged (column
-- order, widths, hidden and frozen columns), applied whenever they open the
-- grid. Reset deletes it, so the developer's default (config.layout) shows.
--
-- Like saved reports these are user data: not part of the application export
-- (src/cli/replace.ts already keeps meta.saved_report and repoints its regions).
-- ---------------------------------------------------------------------
alter table meta.saved_report add column kind text not null default 'report' check (kind in ('report', 'layout'));
alter table meta.saved_report drop constraint saved_report_region_id_username_name_key;
alter table meta.saved_report add constraint saved_report_region_kind_name_key unique (region_id, username, kind, name);

create or replace view meta.saved_reports with (security_barrier) as
  select id, region_id, username, name, public, params, created_at,
         username = meta.app_user() as own, kind
    from meta.saved_report
   where app_id = meta.app_id()
     and (username = meta.app_user() or (public and kind = 'report'));
grant select on meta.saved_reports to public;

-- Save (or replace) a report of the current user; returns its id. Report and grid regions.
create or replace function meta.save_report(p_region int, p_name text, p_params text, p_public boolean default false)
returns int
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_user text := meta.app_user();
  v_app  int  := meta.app_id();
  v_id   int;
begin
  if v_user is null or v_user = 'nobody' then
    raise exception 'sign in to save reports';
  end if;
  if not exists (select 1 from region r join page p on p.id = r.page_id where r.id = p_region and p.app_id = v_app and r.type in ('report', 'grid')) then
    raise exception 'unknown report region %', p_region;
  end if;
  insert into saved_report (app_id, region_id, username, name, public, params, kind)
  values (v_app, p_region, v_user, btrim(p_name), coalesce(p_public, false), coalesce(p_params, ''), 'report')
  on conflict (region_id, username, kind, name) do update set public = excluded.public, params = excluded.params, created_at = now()
  returning id into v_id;
  return v_id;
end
$$;

-- Delete one of the current user's saved reports (not the layout row).
create or replace function meta.delete_saved_report(p_id int) returns boolean
language sql security definer set search_path = meta, pg_catalog as $$
  with d as (delete from saved_report where id = p_id and app_id = meta.app_id() and username = meta.app_user() and kind = 'report' returning 1)
  select exists (select 1 from d)
$$;

-- The current user's column layout of a grid region (params: r<id>_lay=<json>).
create function meta.save_grid_layout(p_region int, p_params text) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_user text := meta.app_user();
  v_app  int  := meta.app_id();
begin
  if v_user is null or v_user = 'nobody' then
    raise exception 'sign in to keep a grid layout';
  end if;
  if not exists (select 1 from region r join page p on p.id = r.page_id where r.id = p_region and p.app_id = v_app and r.type = 'grid') then
    raise exception 'unknown grid region %', p_region;
  end if;
  insert into saved_report (app_id, region_id, username, name, public, params, kind)
  values (v_app, p_region, v_user, 'current', false, coalesce(p_params, ''), 'layout')
  on conflict (region_id, username, kind, name) do update set params = excluded.params, created_at = now();
end
$$;

-- Back to the developer's default layout.
create function meta.reset_grid_layout(p_region int) returns boolean
language sql security definer set search_path = meta, pg_catalog as $$
  with d as (delete from saved_report where region_id = p_region and app_id = meta.app_id() and username = meta.app_user() and kind = 'layout' returning 1)
  select exists (select 1 from d)
$$;

grant execute on function meta.save_grid_layout(int, text), meta.reset_grid_layout(int) to public;
