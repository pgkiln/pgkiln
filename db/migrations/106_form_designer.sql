-- ---------------------------------------------------------------------
-- 106: Form Designer: the application's administrators build their own
-- data entry forms in the running application.
--
-- The developer places a region of type 'form_designer' and lists in its
-- settings (config.sources) the tables and views it offers: the columns
-- forms may show and change, the column that identifies a row, and what
-- forms on it may do at most (add, change, delete rows). Who may design
-- forms is an authorization scheme (config.design_authz); without one
-- nobody can. Those settings are part of the region, so they travel with
-- the application export.
--
-- A user form is a definition (source, fields with labels, help, required,
-- display and default, the columns of its row list, the actions it allows)
-- under a name, kept per region; published forms are used by everyone who
-- can see the region, drafts only by designers. User forms are data of the
-- installation (like meta.data_report): not part of the application export,
-- kept when an application is replaced. Applications reach the table only
-- through meta.user_forms and the two functions; the runtime checks every
-- definition against the region's offered columns before it renders or
-- saves, and reads and writes rows as the application's database role, so
-- grants and row level security apply.
-- ---------------------------------------------------------------------
alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
                  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant', 'plugin', 'url', 'search',
                  'login', 'form_designer'));

create table meta.user_form (
  id          serial primary key,
  app_id      int  not null references meta.app on delete cascade,
  region_id   int  not null references meta.region on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text check (length(description) <= 500),
  published   boolean not null default false,
  definition  jsonb not null check (jsonb_typeof(definition) = 'object' and length(definition::text) <= 32000),
  created_by  text not null,
  updated_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (region_id, name)
);
create index user_form_app_idx on meta.user_form (app_id);
revoke all on meta.user_form from public;

create view meta.user_forms with (security_barrier) as
  select id, region_id, name, description, published, definition, created_by, updated_by, created_at, updated_at
    from meta.user_form
   where app_id = meta.app_id();
grant select on meta.user_forms to public;

-- Save a form of a Form Designer region of the current application: a new
-- one (p_id null) or an existing one (p_id). Returns its id. Whether the
-- user may design forms (the region's authorization scheme) is checked by
-- the runtime before it calls this.
create function meta.save_user_form(p_region int, p_id int, p_name text, p_description text, p_definition jsonb, p_published boolean default false)
returns int
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_user text := meta.app_user();
  v_app  int  := meta.app_id();
  v_id   int;
begin
  if v_user is null or v_user = 'nobody' then
    raise exception 'sign in to design forms';
  end if;
  if not exists (select 1 from region r join page p on p.id = r.page_id where r.id = p_region and p.app_id = v_app and r.type = 'form_designer') then
    raise exception 'unknown form designer region %', p_region;
  end if;
  begin
    if p_id is null then
      insert into user_form (app_id, region_id, name, description, published, definition, created_by, updated_by)
      values (v_app, p_region, btrim(p_name), nullif(btrim(p_description), ''), coalesce(p_published, false), p_definition, v_user, v_user)
      returning id into v_id;
    else
      update user_form
         set name = btrim(p_name), description = nullif(btrim(p_description), ''), published = coalesce(p_published, false),
             definition = p_definition, updated_by = v_user, updated_at = now()
       where id = p_id and app_id = v_app and region_id = p_region
      returning id into v_id;
      if v_id is null then
        raise exception 'form % does not exist', p_id;
      end if;
    end if;
  exception when unique_violation then
    raise exception 'There is already a form named "%".', btrim(p_name) using errcode = 'P0001';
  end;
  return v_id;
end
$$;

-- Delete a form of a Form Designer region of the current application.
create function meta.delete_user_form(p_region int, p_id int) returns boolean
language sql security definer set search_path = meta, pg_catalog as $$
  with d as (delete from user_form where id = p_id and region_id = p_region and app_id = meta.app_id()
                and meta.app_user() is not null and meta.app_user() <> 'nobody' returning 1)
  select exists (select 1 from d)
$$;

revoke all on function meta.save_user_form(int, int, text, text, jsonb, boolean), meta.delete_user_form(int, int) from public;
grant execute on function meta.save_user_form(int, int, text, text, jsonb, boolean), meta.delete_user_form(int, int) to public;
