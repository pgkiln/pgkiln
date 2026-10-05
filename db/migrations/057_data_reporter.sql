-- ---------------------------------------------------------------------
-- Data Reporter (APEX 26.1): business users build their own reports in the
-- running application.
--
-- The developer places a region of type 'data_reporter' and lists in its
-- settings (config.sources) the tables and views it offers, with the
-- columns users may pick and their labels. Those settings are part of the
-- region, so they travel with the application export.
--
-- A user's report is a definition (source, columns, filters, grouping,
-- aggregates, sort, chart) under a name, kept per region and user, private
-- or shared with everyone who can see the region. Reports are user data
-- (like meta.saved_report): not part of the application export.
-- Applications reach the table only through meta.data_reports (own and
-- shared reports of the current application) and the two functions; the
-- runtime checks every definition against the region's offered columns
-- before it runs, as the application's database role.
-- ---------------------------------------------------------------------
alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
                  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter'));

create table meta.data_report (
  id          serial primary key,
  app_id      int  not null references meta.app on delete cascade,
  region_id   int  not null references meta.region on delete cascade,
  username    text not null,
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text check (length(description) <= 500),
  shared      boolean not null default false,
  definition  jsonb not null check (jsonb_typeof(definition) = 'object' and length(definition::text) <= 16000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (region_id, username, name)
);
create index data_report_app_idx on meta.data_report (app_id);
revoke all on meta.data_report from public;

create view meta.data_reports with (security_barrier) as
  select id, region_id, username, name, description, shared, definition, created_at, updated_at,
         username = meta.app_user() as own
    from meta.data_report
   where app_id = meta.app_id()
     and (username = meta.app_user() or shared);
grant select on meta.data_reports to public;

-- Save a report of the current user: a new one (p_id null; a report of the
-- same name is replaced) or one of the user's own (p_id). Returns its id.
create function meta.save_data_report(p_region int, p_id int, p_name text, p_description text, p_definition jsonb, p_shared boolean default false)
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
  if not exists (select 1 from region r join page p on p.id = r.page_id where r.id = p_region and p.app_id = v_app and r.type = 'data_reporter') then
    raise exception 'unknown data reporter region %', p_region;
  end if;
  if p_id is null then
    insert into data_report (app_id, region_id, username, name, description, shared, definition)
    values (v_app, p_region, v_user, btrim(p_name), nullif(btrim(p_description), ''), coalesce(p_shared, false), p_definition)
    on conflict (region_id, username, name) do update
      set description = excluded.description, shared = excluded.shared, definition = excluded.definition, updated_at = now()
    returning id into v_id;
  else
    begin
      update data_report
         set name = btrim(p_name), description = nullif(btrim(p_description), ''), shared = coalesce(p_shared, false),
             definition = p_definition, updated_at = now()
       where id = p_id and app_id = v_app and region_id = p_region and username = v_user
      returning id into v_id;
    exception when unique_violation then
      raise exception 'You already have a report named "%".', btrim(p_name) using errcode = 'P0001';
    end;
    if v_id is null then
      raise exception 'report % is not yours', p_id;
    end if;
  end if;
  return v_id;
end
$$;

-- Delete one of the current user's reports.
create function meta.delete_data_report(p_id int) returns boolean
language sql security definer set search_path = meta, pg_catalog as $$
  with d as (delete from data_report where id = p_id and app_id = meta.app_id() and username = meta.app_user() returning 1)
  select exists (select 1 from d)
$$;

revoke all on function meta.save_data_report(int, int, text, text, jsonb, boolean), meta.delete_data_report(int) from public;
grant execute on function meta.save_data_report(int, int, text, text, jsonb, boolean), meta.delete_data_report(int) to public;
