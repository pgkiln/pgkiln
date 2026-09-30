-- ---------------------------------------------------------------------
-- Saved interactive reports (APEX: Actions → Report → Save Report)
--
-- A saved report is the state of one report region (search, filters,
-- sort, rows per page, control break, aggregates, highlights, facets) as
-- the r<id>_* URL parameters, under a name. Private reports belong to one
-- user; public ones are shown to everyone who can see the report (the
-- runtime lets only users that pass the region's "public_reports"
-- authorization scheme save them).
--
-- Applications reach the table only through meta.saved_reports (own and
-- public reports of the current application) and the two functions.
-- Saved reports are user data: not part of the application export.
-- ---------------------------------------------------------------------
create table meta.saved_report (
  id          serial primary key,
  app_id      int  not null references meta.app on delete cascade,
  region_id   int  not null references meta.region on delete cascade,
  username    text not null,
  name        text not null check (length(name) between 1 and 80),
  public      boolean not null default false,
  params      text not null check (length(params) <= 8000),
  created_at  timestamptz not null default now(),
  unique (region_id, username, name)
);
revoke all on meta.saved_report from public;

create view meta.saved_reports with (security_barrier) as
  select id, region_id, username, name, public, params, created_at,
         username = meta.app_user() as own
    from meta.saved_report
   where app_id = meta.app_id()
     and (username = meta.app_user() or public);
grant select on meta.saved_reports to public;

-- Save (or replace) a report of the current user; returns its id.
create function meta.save_report(p_region int, p_name text, p_params text, p_public boolean default false)
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
  if not exists (select 1 from region r join page p on p.id = r.page_id where r.id = p_region and p.app_id = v_app and r.type = 'report') then
    raise exception 'unknown report region %', p_region;
  end if;
  insert into saved_report (app_id, region_id, username, name, public, params)
  values (v_app, p_region, v_user, btrim(p_name), coalesce(p_public, false), coalesce(p_params, ''))
  on conflict (region_id, username, name) do update set public = excluded.public, params = excluded.params, created_at = now()
  returning id into v_id;
  return v_id;
end
$$;

-- Delete one of the current user's saved reports.
create function meta.delete_saved_report(p_id int) returns boolean
language sql security definer set search_path = meta, pg_catalog as $$
  with d as (delete from saved_report where id = p_id and app_id = meta.app_id() and username = meta.app_user() returning 1)
  select exists (select 1 from d)
$$;

grant execute on function meta.save_report(int, text, text, boolean), meta.delete_saved_report(int) to public;
