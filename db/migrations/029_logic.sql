-- ---------------------------------------------------------------------
-- Logic and processing (APEX parity):
--
--  * Build options: named include/exclude switches of an application
--    (Shared Components). Pages, regions, items, buttons, dynamic actions,
--    validations, processes, computations, branches, navigation entries and
--    application processes name one in "build_option" ("!NAME": only while
--    the option is excluded). An excluded component is left out when the
--    runtime loads the application (meta.build_option_on), so it is neither
--    rendered nor run nor accepted on submit. A name that does not exist
--    excludes the component (fail closed); the Advisor reports it.
--  * Computations: set a page or application item from a static value,
--    another item, a SQL query (first column of the first row), a SQL
--    expression or a PL/pgSQL function body, before the page is rendered
--    (before_header) or after it is submitted (after_submit, before the
--    validations). They run as the application's database role.
--  * Branches: where the browser goes after processing (or before the page
--    is rendered), in sequence, optionally for one button and on a
--    condition: a page of the application with items (signed URL), or a
--    path inside the application. A button's target page remains the
--    simple case and applies when no branch does.
--  * Dynamic actions: set focus, add / remove CSS classes (validated
--    names), show a success or error message, clear errors.
--  * Buttons: action "menu" (a menu of links and submit requests) and a
--    badge (static text with &ITEM. substitutions, or a SQL query).
--
-- Conditions of computations and branches share one shape:
--   condition_type  sql            condition_expr is a boolean expression
--                   exists         condition_expr is a query that returns a row
--                   not_exists     ... that returns no row
--                   item_null      the item named in condition_expr is empty
--                   item_not_null  ... is not empty
--                   item_equals    ... equals condition_value
--                   item_not_equals
--                   request_in     REQUEST (the button pressed) is one of condition_value (comma separated)
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------- build options

create table meta.build_option (
  id          serial primary key,
  app_id      int  not null references meta.app on delete cascade,
  name        text not null check (name ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  status      text not null default 'include' check (status in ('include', 'exclude')),
  description text,
  unique (app_id, name)
);
grant select on meta.build_option to pgapex_runtime;

-- Is a component with this build option reference part of the application?
-- null: always; NAME: while the option is included; !NAME: while it is
-- excluded; an unknown name: never.
create function meta.build_option_on(p_app_id int, p_ref text) returns boolean
language sql stable set search_path = meta, pg_catalog as $$
  select case
    when coalesce(p_ref, '') = '' then true
    else coalesce((select (o.status = 'include') = (left(p_ref, 1) <> '!')
                     from meta.build_option o
                    where o.app_id = p_app_id and o.name = ltrim(p_ref, '!')), false)
  end
$$;
grant execute on function meta.build_option_on(int, text) to pgapex_runtime;

do $$
declare
  t text;
begin
  foreach t in array array['page', 'region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'nav_entry', 'app_process'] loop
    execute format('alter table meta.%I add column build_option text check (build_option ~ ''^!?[A-Z][A-Z0-9_]{0,59}$'')', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- conditions

create function meta.condition_ok(p_type text, p_expr text, p_value text) returns boolean
language sql immutable set search_path = meta, pg_catalog as $$
  select case
    when p_type is null then true
    when p_type in ('sql', 'exists', 'not_exists') then coalesce(trim(p_expr), '') <> ''
    when p_type in ('item_null', 'item_not_null', 'item_equals', 'item_not_equals') then coalesce(p_expr, '') ~ '^[A-Z][A-Z0-9_]*$'
    when p_type = 'request_in' then coalesce(p_value, '') ~ '^ *[A-Z][A-Z0-9_]* *(, *[A-Z][A-Z0-9_]* *)*$'
    else false
  end
$$;

-- ---------------------------------------------------------------- computations

create table meta.computation (
  id              serial primary key,
  page_id         int  not null references meta.page on delete cascade,
  seq             int  not null default 10,
  -- a page item or an application item
  item_name       text not null check (item_name ~ '^[A-Z][A-Z0-9_]*$'),
  -- before_header: GET, after the form fetch, before the "load" processes
  -- after_submit : POST, after the posted values, before the validations
  point           text not null default 'before_header' check (point in ('before_header', 'after_submit')),
  -- static         : expression is a value (&ITEM. substitutions)
  -- item           : expression is the name of an item whose value is copied
  -- sql_query      : expression is a SELECT; the first column of the first row (null without rows)
  -- sql_expression : expression is a SQL expression
  -- function_body  : expression is a PL/pgSQL function body that returns the value
  type            text not null default 'static' check (type in ('static', 'item', 'sql_query', 'sql_expression', 'function_body')),
  expression      text,
  condition_type  text check (condition_type in ('sql', 'exists', 'not_exists', 'item_null', 'item_not_null', 'item_equals', 'item_not_equals', 'request_in')),
  condition_expr  text,
  condition_value text,
  authz           text,
  build_option    text check (build_option ~ '^!?[A-Z][A-Z0-9_]{0,59}$'),
  check (type = 'static' or coalesce(trim(expression), '') <> ''),
  check (type <> 'item' or expression ~ '^[A-Z][A-Z0-9_]*$'),
  check (meta.condition_ok(condition_type, condition_expr, condition_value))
);
create index on meta.computation (page_id, seq);
grant select on meta.computation to pgapex_runtime;

-- ---------------------------------------------------------------- branches

create table meta.branch (
  id              serial primary key,
  page_id         int  not null references meta.page on delete cascade,
  seq             int  not null default 10,
  name            text not null,
  -- after_processing: after a submit's processes; before_header: before the page is shown (GET)
  point           text not null default 'after_processing' check (point in ('before_header', 'after_processing')),
  -- after_processing only: the request (button) it is for; null = any
  when_button     text check (when_button ~ '^[A-Z][A-Z0-9_]*$'),
  condition_type  text check (condition_type in ('sql', 'exists', 'not_exists', 'item_null', 'item_not_null', 'item_equals', 'item_not_equals', 'request_in')),
  condition_expr  text,
  condition_value text,
  -- page: target_page (null = this page) with target_items, as a signed URL
  -- url : target_url, a path inside the application such as "10?tab=2" or
  --       "10?P10_ID=&P2_ID." ; never another site (no scheme, no //, no \, no ..)
  target_type     text not null default 'page' check (target_type in ('page', 'url')),
  target_page     int check (target_page > 0),
  target_items    jsonb check (jsonb_typeof(target_items) = 'object'),
  target_url      text check (target_url ~ '^[A-Za-z0-9_&.?=%#,:~+-][A-Za-z0-9_&.?=%#,:~+/ -]*$'
                              and target_url !~ '(//|\.\./|\.\.$|^\.|[\\[:cntrl:]])'
                              and target_url !~* '^[a-z][a-z0-9+.-]*:'),
  authz           text,
  build_option    text check (build_option ~ '^!?[A-Z][A-Z0-9_]{0,59}$'),
  check (target_type <> 'url' or target_url is not null),
  check (meta.condition_ok(condition_type, condition_expr, condition_value))
);
create index on meta.branch (page_id, seq);
grant select on meta.branch to pgapex_runtime;

-- ---------------------------------------------------------------- dynamic actions

alter table meta.dynamic_action drop constraint dynamic_action_action_check;
alter table meta.dynamic_action add constraint dynamic_action_action_check
  check (action in ('show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit',
                    'set_focus', 'add_class', 'remove_class', 'show_success', 'show_error', 'clear_errors'));
-- add_class / remove_class: up to five class names (lower case letters, digits, - and _)
alter table meta.dynamic_action add column css_classes text
  check (css_classes ~ '^[a-z][a-z0-9_-]{0,39}( [a-z][a-z0-9_-]{0,39}){0,4}$');

-- ---------------------------------------------------------------- menu buttons and badges

-- A menu entry: {"label": "…", "page": 3, "items": {"P3_ID": "&P2_ID."}} (a link) or
-- {"label": "…", "request": "ARCHIVE"} (submits the page with that request);
-- optional "confirm", "authz" and "icon". At most 20 entries.
create function meta.button_menu_ok(p_menu jsonb) returns boolean
language sql immutable set search_path = meta, pg_catalog as $$
  select jsonb_typeof(p_menu) = 'array' and jsonb_array_length(p_menu) <= 20
     and not exists (
       select 1 from jsonb_array_elements(p_menu) e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e->'label') is distinct from 'string' or length(e->>'label') not between 1 and 100
           or ((e ? 'page') = (e ? 'request'))
           or (e ? 'page' and (jsonb_typeof(e->'page') <> 'number' or (e->>'page')::numeric <= 0 or (e->>'page')::numeric <> floor((e->>'page')::numeric)))
           or (e ? 'request' and coalesce(e->>'request', '') !~ '^[A-Z][A-Z0-9_]*$')
           or (e ? 'items' and jsonb_typeof(e->'items') <> 'object')
           or (e ? 'confirm' and jsonb_typeof(e->'confirm') <> 'string')
           or (e ? 'icon' and coalesce(e->>'icon', '') !~ '^[a-z][a-z0-9-]{0,40}$')
           or (e ? 'authz' and coalesce(e->>'authz', '') !~ '^!?[A-Z][A-Z0-9_]*$'))
$$;

alter table meta.button drop constraint button_action_check;
alter table meta.button add constraint button_action_check check (action in ('submit', 'redirect', 'da', 'document', 'menu'));
-- nullable on purpose: import_app (jsonb_populate_record) skips column defaults for older exports
alter table meta.button add column menu jsonb check (meta.button_menu_ok(menu));
-- badge: static text with &ITEM. substitutions; badge_query: a SELECT whose first column of the first row is shown (wins)
alter table meta.button add column badge text check (length(badge) <= 100);
alter table meta.button add column badge_query text;

-- ---------------------------------------------------------------- export and import
-- Same as 028, plus "build_options" and per page "computations" and "branches".
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
    'build_options', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.build_option x where x.app_id = a.id), '[]'),
    -- nav entries and regions keep their ids, so parents and references can be remapped on import
    'nav', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.parent_id nulls first, x.seq, x.id) from meta.nav_entry x where x.app_id = a.id), '[]'),
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) - 'id' - 'app_id' || jsonb_build_object(
        'regions', coalesce((select jsonb_agg(to_jsonb(r) - 'page_id' order by r.seq, r.id) from meta.region r where r.page_id = p.id), '[]'),
        'items', coalesce((select jsonb_agg(to_jsonb(i) - 'id' - 'page_id' order by i.seq, i.id) from meta.item i where i.page_id = p.id), '[]'),
        'buttons', coalesce((select jsonb_agg(to_jsonb(b) - 'id' - 'page_id' order by b.seq, b.id) from meta.button b where b.page_id = p.id), '[]'),
        'dynamic_actions', coalesce((select jsonb_agg(to_jsonb(d) - 'id' - 'page_id' order by d.seq, d.id) from meta.dynamic_action d where d.page_id = p.id), '[]'),
        'validations', coalesce((select jsonb_agg(to_jsonb(v) - 'id' - 'page_id' order by v.seq, v.id) from meta.validation v where v.page_id = p.id), '[]'),
        'processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.process x where x.page_id = p.id), '[]'),
        'computations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.computation x where x.page_id = p.id), '[]'),
        'branches', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.branch x where x.page_id = p.id), '[]')
      ) order by p.page_no)
      from meta.page p where p.app_id = a.id), '[]'))
  from meta.app a
  where a.alias = p_alias
$$;

-- Same as 028, plus build options and per page computations and branches.
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
  -- (029) build options (components name them by name)
  insert into meta.build_option
  select (jsonb_populate_record(null::meta.build_option, e || jsonb_build_object('id', nextval('meta.build_option_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'build_options', '[]')) e;

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
    insert into meta.computation
    select (jsonb_populate_record(null::meta.computation, e || jsonb_build_object('id', nextval('meta.computation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'computations', '[]')) e;
    insert into meta.branch
    select (jsonb_populate_record(null::meta.branch, e || jsonb_build_object('id', nextval('meta.branch_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'branches', '[]')) e;
  end loop;

  return v_app_id;
end
$$;
