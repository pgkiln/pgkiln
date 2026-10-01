-- ---------------------------------------------------------------------
-- Template components (APEX 23.1+) and plug-ins.
--
-- A template component is a shared component of an application: an HTML
-- template with #PLACEHOLDER# substitutions (always escaped) and {if}/
-- {case}/{loop} directives, custom attributes the developer sets where it
-- is used, and optional layout classes from a fixed set. It is used as a
-- region type ("template_component": one instance per row of the region's
-- query, or all rows in the component's wrapper) and as a report column
-- template (region config "column_templates").
--
-- Regions and report columns refer to a component by its static id, so
-- nothing needs remapping on import. A component travels between
-- applications and installations as a single JSON plug-in file
-- (format "pgapex-plugin/1"): meta.export_template_component() and
-- meta.import_template_component().
--
-- The template language is checked in full by the server (an allow-list of
-- tags and attributes, src/runtime/template-components.ts) when a template
-- is saved, imported in the builder and rendered; the trigger below is a
-- coarse first line for SQL inserts and imports.
-- ---------------------------------------------------------------------

create table meta.template_component (
  id          serial primary key,
  app_id      int  not null references meta.app on delete cascade,
  static_id   text not null check (static_id ~ '^[a-z][a-z0-9_]{0,39}$'),
  name        text not null check (length(name) between 1 and 100),
  description text,
  -- the plug-in's version, free text (e.g. 1.0.0)
  version     text check (length(version) <= 20),
  -- one instance (a row); wrapper: the "multiple" frame around all rows, with #APEX$ROWS#
  template    text not null check (length(template) <= 20000),
  wrapper     text check (length(wrapper) <= 5000),
  -- layout of the instances in a region, from a fixed set (see app.css, "template components")
  css_classes text[] not null default '{}'
              check (css_classes <@ array['tc-list', 'tc-grid', 'tc-inline', 'tc-divided', 'tc-compact']::text[]),
  -- [{"name": "STATUS", "label": "Status", "type": "text", "default": "", "options": ["A", "B"]}]
  attributes  jsonb not null default '[]' check (jsonb_typeof(attributes) = 'array'),
  unique (app_id, static_id)
);
grant select on meta.template_component to pgapex_runtime;

create function meta.template_component_check() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_html text := new.template || ' ' || coalesce(new.wrapper, '');
  v_a    jsonb;
begin
  if v_html ~* '<\s*/?\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base|svg|math|template|frame|frameset|noscript)\M' then
    raise exception 'Template component %: this element is not allowed in a template', new.static_id using errcode = 'P0001';
  end if;
  if v_html ~* '\s(on[a-z]+|style|srcdoc|formaction)\s*=' then
    raise exception 'Template component %: event handler and style attributes are not allowed', new.static_id using errcode = 'P0001';
  end if;
  if v_html ~* '(j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|vbscript)\s*:' then
    raise exception 'Template component %: javascript: URLs are not allowed', new.static_id using errcode = 'P0001';
  end if;
  if v_html ~* '#[A-Za-z][A-Za-z0-9_$]*!RAW#' then
    raise exception 'Template component %: raw (unescaped) substitutions are not allowed', new.static_id using errcode = 'P0001';
  end if;
  if new.wrapper is not null and new.wrapper !~ '#APEX\$ROWS#' then
    raise exception 'Template component %: the wrapper needs #APEX$ROWS# where the rows go', new.static_id using errcode = 'P0001';
  end if;
  if jsonb_array_length(new.attributes) > 30 then
    raise exception 'Template component %: at most 30 attributes', new.static_id using errcode = 'P0001';
  end if;
  for v_a in select * from jsonb_array_elements(new.attributes) loop
    if jsonb_typeof(v_a) <> 'object' or coalesce(v_a->>'name', '') !~ '^[A-Z][A-Z0-9_]{0,29}$' or v_a->>'name' = 'LINK'
       or coalesce(v_a->>'type', 'text') not in ('text', 'number', 'select', 'checkbox') then
      raise exception 'Template component %: attribute % is not valid (name: upper case letters, digits and _, not LINK; type: text, number, select or checkbox)',
        new.static_id, coalesce(v_a->>'name', v_a::text) using errcode = 'P0001';
    end if;
  end loop;
  return new;
end
$$;

create trigger template_component_check before insert or update on meta.template_component
  for each row execute function meta.template_component_check();

-- ---------------------------------------------------------------- plug-in files

-- One template component as a plug-in document.
create function meta.export_template_component(p_app_id int, p_static_id text) returns jsonb
language sql stable set search_path = meta, pg_catalog as $$
  select jsonb_build_object('format', 'pgapex-plugin/1', 'type', 'template_component')
         || (to_jsonb(t) - 'id' - 'app_id')
    from meta.template_component t
   where t.app_id = p_app_id and t.static_id = p_static_id
$$;

-- A plug-in document into an application; p_replace overwrites a component
-- with the same static id (otherwise that is an error). Returns its id.
create function meta.import_template_component(p_app_id int, p_doc jsonb, p_replace boolean default false) returns int
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_row meta.template_component;
  v_id  int;
begin
  if p_doc->>'format' is distinct from 'pgapex-plugin/1' then
    raise exception 'unsupported plug-in format %', coalesce(p_doc->>'format', '(none)') using errcode = 'P0001';
  end if;
  if p_doc->>'type' is distinct from 'template_component' then
    raise exception 'unsupported plug-in type %', coalesce(p_doc->>'type', '(none)') using errcode = 'P0001';
  end if;
  if not exists (select 1 from meta.app where id = p_app_id) then
    raise exception 'application % does not exist', p_app_id using errcode = 'P0001';
  end if;
  v_row := jsonb_populate_record(null::meta.template_component,
             (p_doc - 'format' - 'type') || jsonb_build_object('id', 0, 'app_id', p_app_id));
  select id into v_id from meta.template_component where app_id = p_app_id and static_id = v_row.static_id;
  if v_id is not null and not p_replace then
    raise exception 'Template component % already exists in this application', v_row.static_id using errcode = 'P0001';
  end if;
  if v_id is not null then
    update meta.template_component
       set name = v_row.name, description = v_row.description, version = v_row.version, template = v_row.template,
           wrapper = v_row.wrapper, css_classes = coalesce(v_row.css_classes, '{}'), attributes = coalesce(v_row.attributes, '[]')
     where id = v_id;
    return v_id;
  end if;
  insert into meta.template_component (app_id, static_id, name, description, version, template, wrapper, css_classes, attributes)
  values (p_app_id, v_row.static_id, v_row.name, v_row.description, v_row.version, v_row.template, v_row.wrapper,
          coalesce(v_row.css_classes, '{}'), coalesce(v_row.attributes, '[]'))
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function meta.export_template_component(int, text), meta.import_template_component(int, jsonb, boolean) from public;

-- ---------------------------------------------------------------- region type

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree', 'template_component'));

-- ---------------------------------------------------------------- export and import

-- Same as 024, plus "template_components".
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable set search_path = meta, pg_catalog as $$
  select jsonb_build_object(
    'format', 'pgapex/2',
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'group_roles', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.group_name, x.role) from meta.app_group_role x where x.app_id = a.id), '[]'),
    'text_messages', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.name, x.language) from meta.text_message x where x.app_id = a.id), '[]'),
    'translations', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.language, x.source) from meta.translation x where x.app_id = a.id), '[]'),
    'report_layouts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'logo' || jsonb_build_object('logo', encode(x.logo, 'base64')) order by x.name)
                                  from meta.report_layout x where x.app_id = a.id), '[]'),
    'automations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'next_run_at' - 'last_run_at' - 'last_status' order by x.name)
                               from meta.automation x where x.app_id = a.id), '[]'),
    'document_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.document_template x where x.app_id = a.id), '[]'),
    'task_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.task_definition x where x.app_id = a.id), '[]'),
    'workflow_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.workflow_definition x where x.app_id = a.id), '[]'),
    'rest_modules', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.rest_module x where x.app_id = a.id), '[]'),
    'template_components', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.static_id) from meta.template_component x where x.app_id = a.id), '[]'),
    -- nav entries and regions keep their ids, so parents and references can be remapped on import
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

-- Same as 026, plus "template_components" (after the REST modules, before the pages that use them).
create or replace function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql set search_path = meta, pg_catalog as $$
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
    raise exception 'unsupported export format %', coalesce(p_doc->>'format', '(none)');
  end if;

  insert into meta.app
  select (jsonb_populate_record(null::meta.app, p_doc->'app' || jsonb_build_object(
            'id', nextval('meta.app_id_seq'),
            'alias', coalesce(p_alias, p_doc->'app'->>'alias'),
            'created_at', now(), 'updated_at', now()))).*
  returning id into v_app_id;

  insert into meta.authz_scheme
  select (jsonb_populate_record(null::meta.authz_scheme, e || jsonb_build_object('id', nextval('meta.authz_scheme_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'authz_schemes', '[]')) e;
  insert into meta.app_item
  select (jsonb_populate_record(null::meta.app_item, e || jsonb_build_object('id', nextval('meta.app_item_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_items', '[]')) e;
  insert into meta.app_process
  select (jsonb_populate_record(null::meta.app_process, e || jsonb_build_object('id', nextval('meta.app_process_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_processes', '[]')) e;
  insert into meta.lov
  select (jsonb_populate_record(null::meta.lov, e || jsonb_build_object('id', nextval('meta.lov_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lovs', '[]')) e;
  insert into meta.app_group_role
  select (jsonb_populate_record(null::meta.app_group_role, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'group_roles', '[]')) e;
  insert into meta.text_message
  select (jsonb_populate_record(null::meta.text_message, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'text_messages', '[]')) e;
  insert into meta.translation
  select (jsonb_populate_record(null::meta.translation, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'translations', '[]')) e;
  insert into meta.report_layout
  select (jsonb_populate_record(null::meta.report_layout, (e - 'logo') || jsonb_build_object(
            'id', nextval('meta.report_layout_id_seq'), 'app_id', v_app_id,
            'logo', null))).*
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e;
  update meta.report_layout l
     set logo = decode(e->>'logo', 'base64')
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e
   where l.app_id = v_app_id and l.name = e->>'name' and e->>'logo' is not null;
  -- imported automations start switched off: the copy must not run the original's jobs unasked
  insert into meta.automation
  select (jsonb_populate_record(null::meta.automation, e || jsonb_build_object(
            'id', nextval('meta.automation_id_seq'), 'app_id', v_app_id, 'enabled', false))).*
    from jsonb_array_elements(coalesce(p_doc->'automations', '[]')) e;
  insert into meta.document_template
  select (jsonb_populate_record(null::meta.document_template, e || jsonb_build_object('id', nextval('meta.document_template_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'document_templates', '[]')) e;
  insert into meta.task_definition
  select (jsonb_populate_record(null::meta.task_definition, e || jsonb_build_object('id', nextval('meta.task_definition_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'task_definitions', '[]')) e;
  insert into meta.workflow_definition
  select (jsonb_populate_record(null::meta.workflow_definition, e || jsonb_build_object('id', nextval('meta.workflow_definition_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'workflow_definitions', '[]')) e;
  insert into meta.rest_module
  select (jsonb_populate_record(null::meta.rest_module, e || jsonb_build_object('id', nextval('meta.rest_module_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_modules', '[]')) e;
  -- (028) template components: regions and report columns refer to them by static id
  insert into meta.template_component
  select (jsonb_populate_record(null::meta.template_component, e || jsonb_build_object('id', nextval('meta.template_component_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'template_components', '[]')) e;

  for v_e in select * from jsonb_array_elements(coalesce(p_doc->'nav', '[]')) loop
    insert into meta.nav_entry
    select (jsonb_populate_record(null::meta.nav_entry, v_e || jsonb_build_object(
              'id', nextval('meta.nav_entry_id_seq'), 'app_id', v_app_id,
              'parent_id', v_nmap->>(v_e->>'parent_id')))).*
    returning id into v_new_id;
    v_nmap := v_nmap || jsonb_build_object(v_e->>'id', v_new_id);
  end loop;

  for v_page in select * from jsonb_array_elements(coalesce(p_doc->'pages', '[]')) loop
    insert into meta.page
    select (jsonb_populate_record(null::meta.page, v_page || jsonb_build_object('id', nextval('meta.page_id_seq'), 'app_id', v_app_id))).*
    returning id into v_page_id;

    v_rmap := '{}';
    for v_e in select * from jsonb_array_elements(coalesce(v_page->'regions', '[]')) loop
      insert into meta.region
      select (jsonb_populate_record(null::meta.region, v_e || jsonb_build_object('id', nextval('meta.region_id_seq'), 'page_id', v_page_id))).*
      returning id into v_new_id;
      v_rmap := v_rmap || jsonb_build_object(v_e->>'id', v_new_id);
    end loop;
    -- facet and map regions point at their report region by id
    update meta.region r
       set config = jsonb_set(r.config, '{report}', to_jsonb((v_rmap->>(r.config->>'report'))::int))
     where r.page_id = v_page_id and r.type in ('facets', 'map') and v_rmap ? (r.config->>'report');

    insert into meta.item
    select (jsonb_populate_record(null::meta.item, e || jsonb_build_object('id', nextval('meta.item_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'items', '[]')) e;
    insert into meta.button
    select (jsonb_populate_record(null::meta.button, e || jsonb_build_object('id', nextval('meta.button_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'buttons', '[]')) e;
    insert into meta.dynamic_action
    select (jsonb_populate_record(null::meta.dynamic_action, e || jsonb_build_object('id', nextval('meta.dynamic_action_id_seq'), 'page_id', v_page_id, 'affected_region_id', v_rmap->>(e->>'affected_region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'dynamic_actions', '[]')) e;
    insert into meta.validation
    select (jsonb_populate_record(null::meta.validation, e || jsonb_build_object('id', nextval('meta.validation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'validations', '[]')) e;
    insert into meta.process
    select (jsonb_populate_record(null::meta.process, e || jsonb_build_object('id', nextval('meta.process_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'processes', '[]')) e;
  end loop;

  return v_app_id;
end
$$;
