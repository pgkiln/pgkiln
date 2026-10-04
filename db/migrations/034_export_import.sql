-- 034: export and import after sprint 26's parallel workstreams.
-- 029 (logic), 030 (REST data sources) and 031 (smart filters) each redefined meta.import_app (and 029/030
-- meta.export_app) from 028, so each dropped the others' changes. This carries all changes:
--   029: "build_options" and per page "computations" and "branches";
--   030: "web_credentials" (exported without secret_enc; secrets in a document are ignored) and "rest_sources";
--   031: smart_filters regions get their config.report remapped like facets and map regions.

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
    -- (030) secrets never leave the installation: they are entered again after an import
    'web_credentials', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'secret_enc' order by x.name) from meta.web_credential x where x.app_id = a.id), '[]'),
    'rest_sources', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.rest_source x where x.app_id = a.id), '[]'),
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
  -- (030) web credentials arrive without a secret, whatever the document holds
  insert into meta.web_credential
  select (jsonb_populate_record(null::meta.web_credential, '{"type": "basic", "valid_for": []}'::jsonb || jsonb_strip_nulls(e - 'secret_enc')
            || jsonb_build_object('id', nextval('meta.web_credential_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'web_credentials', '[]')) e;
  insert into meta.rest_source
  select (jsonb_populate_record(null::meta.rest_source, '{"method": "GET", "headers": {}, "params": [], "columns": [], "cache_seconds": 0, "timeout_s": 10, "max_rows": 1000}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.rest_source_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_sources', '[]')) e;

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
     where r.page_id = v_page_id and r.type in ('facets', 'smart_filters', 'map') and v_rmap ? (r.config->>'report');

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
