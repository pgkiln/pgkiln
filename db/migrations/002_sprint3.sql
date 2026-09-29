-- =====================================================================
-- 002: interactive grid, calendar, dynamic content and faceted search
-- regions; more item types; shared lists of values; application theme.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Region types
--   grid     : editable table (APEX Interactive Grid) on table_name/pk_column;
--              source is the SELECT, saved by a 'grid_dml' process
--   calendar : source returns start_date, end_date (optional), title (+ any
--              columns used in config.link); month view, agenda on phones
--   dynamic  : source returns one text value that is rendered as HTML
--              (trusted developer output; escape data with meta.html_escape)
--   facets   : faceted search for the report in config.report (region id);
--              config.facets = [{"column": "job", "label": "Job"}, ...]
-- ---------------------------------------------------------------------
alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets'));

alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check
  check (type in ('form_dml', 'grid_dml', 'sql'));

-- ---------------------------------------------------------------------
-- Item types
--   checkbox_group / multiselect : several values, stored colon-separated
--                                  ("10:20:30") like APEX; split with
--                                  string_to_array(:P1_X, ':')
--   popup_lov                    : a select list with a search box
--   email / tel / url / color    : typed inputs (the right phone keyboard)
-- ---------------------------------------------------------------------
alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in
  ('text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch',
   'hidden', 'display', 'password', 'checkbox_group', 'multiselect', 'popup_lov',
   'email', 'tel', 'url', 'color'));

-- ---------------------------------------------------------------------
-- Shared lists of values: an item's lov can be 'LOV:NAME'
-- ---------------------------------------------------------------------
create table meta.lov (
  id      serial primary key,
  app_id  int  not null references meta.app on delete cascade,
  name    text not null check (name ~ '^[A-Z][A-Z0-9_]*$'),
  query   text not null,
  unique (app_id, name)
);
grant select on meta.lov to pgapex_runtime;

-- ---------------------------------------------------------------------
-- Theme ("Theme Roller"): {"accent": "#0b63c5", "header": "#13294b",
-- "nav": "side" | "top"}
-- ---------------------------------------------------------------------
alter table meta.app add column theme jsonb not null default '{}';

-- ---------------------------------------------------------------------
-- HTML escaping for dynamic content regions
-- ---------------------------------------------------------------------
create function meta.html_escape(p text) returns text
language sql immutable as $$
  select replace(replace(replace(replace(replace(p, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;
grant execute on function meta.html_escape(text) to public;

-- ---------------------------------------------------------------------
-- Export/import: include shared lists of values
-- ---------------------------------------------------------------------
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'format', 'pgapex/2',
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'nav', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.parent_id nulls first, x.seq, x.id) from meta.nav_entry x where x.app_id = a.id), '[]'),
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) - 'id' - 'app_id' || jsonb_build_object(
        'regions', coalesce((select jsonb_agg(to_jsonb(r) - 'page_id' order by r.seq, r.id) from meta.region r where r.page_id = p.id), '[]'),
        'items', coalesce((select jsonb_agg(to_jsonb(i) - 'id' - 'page_id' order by i.seq, i.id) from meta.item i where i.page_id = p.id), '[]'),
        'buttons', coalesce((select jsonb_agg(to_jsonb(b) - 'id' - 'page_id' order by b.seq, b.id) from meta.button b where b.page_id = p.id), '[]'),
        'dynamic_actions', coalesce((select jsonb_agg(to_jsonb(d) - 'id' - 'page_id' order by d.seq, d.id) from meta.dynamic_action d where d.page_id = p.id), '[]'),
        'validations', coalesce((select jsonb_agg(to_jsonb(v) - 'id' - 'page_id' order by v.seq, v.id) from meta.validation v where v.page_id = p.id), '[]'),
        'processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.process x where x.page_id = p.id), '[]')
      ) order by p.page_no)
      from meta.page p where p.app_id = a.id), '[]'))
  from meta.app a
  where a.alias = p_alias
$$;

create or replace function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql as $$
declare
  v_app_id  int;
  v_page_id int;
  v_page    jsonb;
  v_e       jsonb;
  v_rmap    jsonb;
  v_nmap    jsonb := '{}';
  v_new_id  int;
begin
  if p_doc->>'format' is distinct from 'pgapex/2' then
    raise exception 'unsupported export format %', p_doc->>'format';
  end if;

  insert into meta.app
  select (jsonb_populate_record(null::meta.app, p_doc->'app' || jsonb_build_object(
            'id', nextval('meta.app_id_seq'),
            'alias', coalesce(p_alias, p_doc->'app'->>'alias'),
            'created_at', now(), 'updated_at', now()))).*
  returning id into v_app_id;

  insert into meta.authz_scheme
  select (jsonb_populate_record(null::meta.authz_scheme, e || jsonb_build_object('id', nextval('meta.authz_scheme_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(p_doc->'authz_schemes') e;
  insert into meta.app_item
  select (jsonb_populate_record(null::meta.app_item, e || jsonb_build_object('id', nextval('meta.app_item_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(p_doc->'app_items') e;
  insert into meta.app_process
  select (jsonb_populate_record(null::meta.app_process, e || jsonb_build_object('id', nextval('meta.app_process_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(p_doc->'app_processes') e;
  insert into meta.lov
  select (jsonb_populate_record(null::meta.lov, e || jsonb_build_object('id', nextval('meta.lov_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lovs', '[]')) e;

  for v_e in select * from jsonb_array_elements(p_doc->'nav') loop
    insert into meta.nav_entry
    select (jsonb_populate_record(null::meta.nav_entry, v_e || jsonb_build_object(
              'id', nextval('meta.nav_entry_id_seq'), 'app_id', v_app_id,
              'parent_id', v_nmap->>(v_e->>'parent_id')))).*
    returning id into v_new_id;
    v_nmap := v_nmap || jsonb_build_object(v_e->>'id', v_new_id);
  end loop;

  for v_page in select * from jsonb_array_elements(p_doc->'pages') loop
    insert into meta.page
    select (jsonb_populate_record(null::meta.page, v_page || jsonb_build_object('id', nextval('meta.page_id_seq'), 'app_id', v_app_id))).*
    returning id into v_page_id;

    v_rmap := '{}';
    for v_e in select * from jsonb_array_elements(v_page->'regions') loop
      insert into meta.region
      select (jsonb_populate_record(null::meta.region, v_e || jsonb_build_object('id', nextval('meta.region_id_seq'), 'page_id', v_page_id))).*
      returning id into v_new_id;
      v_rmap := v_rmap || jsonb_build_object(v_e->>'id', v_new_id);
    end loop;
    -- facets regions point at their report region by id: re-link
    update meta.region r
       set config = jsonb_set(r.config, '{report}', to_jsonb((v_rmap->>(r.config->>'report'))::int))
     where r.page_id = v_page_id and r.type = 'facets' and v_rmap ? (r.config->>'report');

    insert into meta.item
    select (jsonb_populate_record(null::meta.item, e || jsonb_build_object('id', nextval('meta.item_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(v_page->'items') e;
    insert into meta.button
    select (jsonb_populate_record(null::meta.button, e || jsonb_build_object('id', nextval('meta.button_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(v_page->'buttons') e;
    insert into meta.dynamic_action
    select (jsonb_populate_record(null::meta.dynamic_action, e || jsonb_build_object('id', nextval('meta.dynamic_action_id_seq'), 'page_id', v_page_id, 'affected_region_id', v_rmap->>(e->>'affected_region_id')))).*
      from jsonb_array_elements(v_page->'dynamic_actions') e;
    insert into meta.validation
    select (jsonb_populate_record(null::meta.validation, e || jsonb_build_object('id', nextval('meta.validation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(v_page->'validations') e;
    insert into meta.process
    select (jsonb_populate_record(null::meta.process, e || jsonb_build_object('id', nextval('meta.process_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(v_page->'processes') e;
  end loop;

  return v_app_id;
end
$$;

-- ---------------------------------------------------------------------
-- Wizard: an interactive grid page for a table (single-column PK).
--   select meta.generate_grid('hr', 'hr.dept', 10);
-- ---------------------------------------------------------------------
create function meta.generate_grid(
  p_app   text,
  p_table regclass,
  p_page  int,
  p_label text default null,
  p_icon  text default 'grid'
) returns void
language plpgsql as $$
declare
  v_app     meta.app;
  v_label   text;
  v_pk      text;
  v_count   int;
  v_page_id int;
  v_region  int;
  v_columns jsonb := '{}';
  c         record;
begin
  select * into v_app from meta.app where alias = p_app;
  if v_app.id is null then
    raise exception 'application "%" does not exist', p_app;
  end if;
  v_label := coalesce(p_label, initcap(replace((select relname from pg_class where oid = p_table), '_', ' ')));

  select min(a.attname), count(*) into v_pk, v_count
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = p_table and i.indisprimary;
  if v_count <> 1 then
    raise exception 'table % needs a single-column primary key', p_table;
  end if;

  -- foreign keys become select lists showing the parent's first text column
  for c in
    select a.attname, con.confrelid,
           (select attname from pg_attribute where attrelid = con.confrelid and attnum = con.confkey[1]) as refcol
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.conrelid = p_table and con.contype = 'f' and array_length(con.conkey, 1) = 1
  loop
    v_columns := v_columns || jsonb_build_object(c.attname, jsonb_build_object('lov',
      format('select %I, %I from %s order by 1',
        coalesce((select attname from pg_attribute pa join pg_type pt on pt.oid = pa.atttypid
                   where pa.attrelid = c.confrelid and pa.attnum > 0 and not pa.attisdropped and pt.typcategory = 'S'
                   order by pa.attnum limit 1), c.refcol),
        c.refcol, c.confrelid::regclass)));
  end loop;
  -- NOT NULL columns without a default are required
  select v_columns || coalesce(jsonb_object_agg(a.attname, coalesce(v_columns -> a.attname, '{}') || '{"required": true}'), '{}')
    into v_columns
    from pg_attribute a
   where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attnotnull
     and not a.atthasdef and a.attidentity = '' and a.attname <> v_pk;

  insert into meta.page (app_id, page_no, name, title, parent_page)
  values (v_app.id, p_page, v_label, v_label, nullif(v_app.home_page, p_page))
  returning id into v_page_id;

  insert into meta.nav_entry (app_id, seq, label, icon, target_page)
  values (v_app.id, (select coalesce(max(seq), 0) + 10 from meta.nav_entry where app_id = v_app.id and parent_id is null),
          v_label, p_icon, p_page);

  insert into meta.region (page_id, seq, title, type, source, table_name, pk_column, config)
  values (v_page_id, 10, v_label, 'grid',
          format(E'select %s\n  from %s',
            (select string_agg(quote_ident(attname), ', ' order by attnum) from pg_attribute
              where attrelid = p_table and attnum > 0 and not attisdropped), p_table),
          p_table::text, v_pk,
          jsonb_build_object('columns', v_columns, 'page_size', 25))
  returning id into v_region;

  insert into meta.process (page_id, seq, name, type, region_id)
  values (v_page_id, 10, 'Save ' || v_label, 'grid_dml', v_region);
end
$$;
