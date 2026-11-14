-- =====================================================================
-- 172: sub regions (sprint 195, NX-F2; APEX: Parent Region)
--
-- A region may sit inside another region of its page: one level of
-- nesting. The parent's template decides how its sub regions show:
--
--   tabs_container   one tab per sub region (its title), ARIA tabs
--   flex_container   the sub regions side by side, wrapping (flexbox)
--   collapsible      inside the region's body, which opens and closes
--   (any other)      a 12-column grid under the region's own content
--
-- A sub region shows only where its parent shows: the parent's
-- authorization, condition and build option apply to it too (the
-- runtime's computeVisibility). Its own position is not used while it
-- has a parent.
--
-- Deleting a region with sub regions keeps them: the Page Designer moves
-- them up to the page, into the deleted region's position; a delete by
-- SQL leaves them at page level (on delete set null).
--
-- meta.import_app and meta.copy_page set the parent once every region of
-- the page has its new id.
-- =====================================================================

alter table meta.region add column parent_id int references meta.region (id) on delete set null;
alter table meta.region add constraint region_parent_not_self check (parent_id <> id);
create index region_parent_id_idx on meta.region (parent_id) where parent_id is not null;

alter table meta.region drop constraint region_template_check;
alter table meta.region add constraint region_template_check
  check (template in ('standard', 'plain', 'collapsible', 'hero', 'title_bar', 'buttons_container', 'inline_dialog', 'inline_drawer', 'wizard',
                      'tabs_container', 'flex_container'));

comment on column meta.region.parent_id is
  'The region this one sits in (a sub region; APEX: Parent Region): a region of the same page that has no parent itself.';

-- the parent is on the same page, and nesting is one level deep (checked at the end of the statement)
create function meta.region_parent_check() returns trigger
language plpgsql as $$
declare
  v_parent meta.region;
begin
  if new.parent_id is not null then
    select * into v_parent from meta.region where id = new.parent_id;
    if v_parent.id is not null then
      if v_parent.page_id <> new.page_id then
        raise exception 'the parent region of "%" is on another page', coalesce(new.title, new.type) using errcode = '23514';
      end if;
      if v_parent.parent_id is not null then
        raise exception 'region "%" is a sub region itself, so it cannot hold "%": regions nest one level deep',
          coalesce(v_parent.title, v_parent.type), coalesce(new.title, new.type) using errcode = '23514';
      end if;
    end if;
    if exists (select 1 from meta.region c where c.parent_id = new.id) then
      raise exception 'region "%" has sub regions, so it cannot go inside another region: regions nest one level deep',
        coalesce(new.title, new.type) using errcode = '23514';
    end if;
  end if;
  if exists (select 1 from meta.region c where c.parent_id = new.id and c.page_id <> new.page_id) then
    raise exception 'region "%" has sub regions on another page', coalesce(new.title, new.type) using errcode = '23514';
  end if;
  return null;
end
$$;

create constraint trigger region_parent_check after insert or update of parent_id, page_id on meta.region
  for each row execute function meta.region_parent_check();

CREATE OR REPLACE FUNCTION meta.import_app(p_doc jsonb, p_alias text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'meta', 'pg_catalog'
AS $function$
declare
  v_app_id  int;
  v_page_id int;
  v_page    jsonb;
  v_e       jsonb;
  v_rmap    jsonb;
  v_pmap    jsonb;
  v_nmap    jsonb := '{}';
  v_lmap    jsonb := '{}';
  v_new_id  int;
begin
  if p_doc->>'format' is distinct from 'pgkiln/2' then
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
  -- imported automations start switched off: the copy must not run the original's jobs unasked.
  -- (044) a file with actions: the automations' code is ignored; an older file: code becomes the single action
  insert into meta.automation
  select (jsonb_populate_record(null::meta.automation, '{"error_handling": "stop"}'::jsonb
            || jsonb_strip_nulls(case when p_doc ? 'automation_actions' then e - 'code' else e end)
            || jsonb_build_object('id', nextval('meta.automation_id_seq'), 'app_id', v_app_id, 'enabled', false))).*
    from jsonb_array_elements(coalesce(p_doc->'automations', '[]')) e;
  insert into meta.automation_action
  select (jsonb_populate_record(null::meta.automation_action, '{"seq": 10}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.automation_action_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'automation_actions', '[]')) e;
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
  -- (050) nor a password or refresh token
  insert into meta.web_credential
  select (jsonb_populate_record(null::meta.web_credential, '{"type": "basic", "valid_for": [], "grant_type": "client_credentials"}'::jsonb
            || jsonb_strip_nulls(e - 'secret_enc' - 'password_enc' - 'refresh_token_enc' - 'token_refreshed_at')
            || jsonb_build_object('id', nextval('meta.web_credential_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'web_credentials', '[]')) e;
  -- (050) write-back operations and synchronisation; an imported synchronisation starts switched off
  insert into meta.rest_source
  select (jsonb_populate_record(null::meta.rest_source, '{"method": "GET", "headers": {}, "params": [], "columns": [], "cache_seconds": 0, "timeout_s": 10, "max_rows": 1000,
                                                          "operations": {}, "key_columns": [], "sync_mode": "merge", "sync_delete": false, "sync_time_zone": "UTC"}'::jsonb
            || jsonb_strip_nulls(e - 'sync_next_at' - 'sync_last_at' - 'sync_last_status')
            || jsonb_build_object('id', nextval('meta.rest_source_id_seq'), 'app_id', v_app_id, 'sync_enabled', false))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_sources', '[]')) e;

  -- (041) data load definitions (the data_load process names them)
  insert into meta.data_load_def
  select (jsonb_populate_record(null::meta.data_load_def, '{"format": "auto", "headers": true, "mode": "append", "skip_errors": false, "columns": []}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.data_load_def_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'data_load_definitions', '[]')) e;

  -- (042) lists and their entries, supporting scripts. Entries are inserted
  -- without a parent first and the parents set afterwards, so the order of
  -- the entries in the document doesn't matter (a moved entry may have a
  -- higher id than its children).
  insert into meta.list
  select (jsonb_populate_record(null::meta.list, '{"type": "static"}'::jsonb || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.list_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lists', '[]')) e;
  for v_e in select * from jsonb_array_elements(coalesce(p_doc->'list_entries', '[]')) loop
    insert into meta.list_entry
    select (jsonb_populate_record(null::meta.list_entry, '{"target_items": {}}'::jsonb || jsonb_strip_nulls(v_e) || jsonb_build_object(
              'id', nextval('meta.list_entry_id_seq'), 'app_id', v_app_id, 'parent_id', null))).*
    returning id into v_new_id;
    if v_e->>'id' is not null then
      v_lmap := v_lmap || jsonb_build_object(v_e->>'id', v_new_id);
    end if;
  end loop;
  update meta.list_entry x
     set parent_id = (v_lmap->>(e->>'parent_id'))::int
    from jsonb_array_elements(coalesce(p_doc->'list_entries', '[]')) e
   where e->>'parent_id' is not null and v_lmap ? (e->>'parent_id') and v_lmap ? (e->>'id')
     and x.id = (v_lmap->>(e->>'id'))::int;
  insert into meta.supporting_script
  select (jsonb_populate_record(null::meta.supporting_script, '{"kind": "install", "seq": 10, "script": ""}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.supporting_script_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'supporting_scripts', '[]')) e;

  -- (069) plug-ins
  insert into meta.plugin
  select (jsonb_populate_record(null::meta.plugin, e || jsonb_build_object('id', nextval('meta.plugin_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'plugins', '[]')) e;

  -- (080) search configurations (search regions name them)
  insert into meta.search_config
  select (jsonb_populate_record(null::meta.search_config, '{"seq": 10, "source_type": "table", "searchable_columns": [], "max_results": 10}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.search_config_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'search_configs', '[]')) e;

  -- (081) e-mail templates (meta.send_mail_template and the send_email process name them)
  insert into meta.email_template
  select (jsonb_populate_record(null::meta.email_template, e || jsonb_build_object('id', nextval('meta.email_template_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'email_templates', '[]')) e;

  -- (105) component groups
  insert into meta.component_group
  select (jsonb_populate_record(null::meta.component_group, '{"members": []}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.component_group_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'component_groups', '[]')) e;

  -- (104) report queries
  insert into meta.report_query
  select (jsonb_populate_record(null::meta.report_query, '{"format": "pdf"}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.report_query_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'report_queries', '[]')) e;

  -- (103) shortcuts
  insert into meta.shortcut
  select (jsonb_populate_record(null::meta.shortcut, '{"type": "text"}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.shortcut_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'shortcuts', '[]')) e;

  -- (102) application computations
  insert into meta.app_computation
  select (jsonb_populate_record(null::meta.app_computation, '{"seq": 10, "point": "before_header", "type": "static"}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.app_computation_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_computations', '[]')) e;

  -- (089) page groups
  insert into meta.page_group
  select (jsonb_populate_record(null::meta.page_group, e || jsonb_build_object('id', nextval('meta.page_group_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'page_groups', '[]')) e;

  -- (086) application settings and dynamic translations
  insert into meta.app_setting
  select (jsonb_populate_record(null::meta.app_setting, e || jsonb_build_object('id', nextval('meta.app_setting_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_settings', '[]')) e;
  insert into meta.dynamic_translation
  select (jsonb_populate_record(null::meta.dynamic_translation, e || jsonb_build_object('id', nextval('meta.dynamic_translation_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'dynamic_translations', '[]')) e;

  -- (068) static application files
  insert into meta.static_file (app_id, name, mime, content, updated_at)
  select v_app_id, e->>'name', e->>'mime', decode(coalesce(e->>'content', ''), 'base64'), now()
    from jsonb_array_elements(coalesce(p_doc->'static_files', '[]')) e;

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
    v_pmap := '{}';
    for v_e in select * from jsonb_array_elements(coalesce(v_page->'regions', '[]')) loop
      -- (172) the parent region is set below, once every region of the page has its new id
      insert into meta.region
      select (jsonb_populate_record(null::meta.region, v_e || jsonb_build_object('id', nextval('meta.region_id_seq'), 'page_id', v_page_id, 'parent_id', null))).*
      returning id into v_new_id;
      v_rmap := v_rmap || jsonb_build_object(v_e->>'id', v_new_id);
      if v_e->>'parent_id' is not null then
        v_pmap := v_pmap || jsonb_build_object(v_new_id::text, v_e->>'parent_id');
      end if;
    end loop;
    -- (172) sub regions: a parent that is not on the page leaves the region at page level
    update meta.region r
       set parent_id = (v_rmap->>(v_pmap->>r.id::text))::int
     where r.page_id = v_page_id and v_pmap ? r.id::text and v_rmap ? (v_pmap->>r.id::text);
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
$function$;

CREATE OR REPLACE FUNCTION meta.copy_page(p_from integer, p_page integer, p_to integer, p_new integer, p_name text DEFAULT NULL::text, p_map jsonb DEFAULT '{}'::jsonb)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_src     meta.page;
  v_page_id int;
  v_old     text;
  v_new     text;
  v_rmap    jsonb := '{}';
  v_pmap    jsonb := '{}';
  v_map     jsonb := '{}';
  v_target  text;
  v_id      int;
  v_newid   int;
  v_e       jsonb;
  v_lmap    jsonb;
  t         text;
  r         record;
  x         record;
begin
  select * into v_src from meta.page where app_id = p_from and page_no = p_page;
  if v_src.id is null then
    raise exception 'page % does not exist', p_page;
  end if;
  if not exists (select 1 from meta.app where id = p_to) then
    raise exception 'the target application does not exist';
  end if;
  if p_new is null or p_new < 1 then
    raise exception 'a page number must be a positive whole number';
  end if;
  if exists (select 1 from meta.page where app_id = p_to and page_no = p_new) then
    raise exception 'page % already exists', p_new;
  end if;
  if p_map is null or jsonb_typeof(p_map) <> 'object' then
    p_map := '{}';
  end if;

  -- the shared components: mapped, the same name, or copied
  for r in select * from meta.page_shared_refs(v_src.id, p_to) loop
    v_target := nullif(p_map ->> (r.kind || ':' || r.name), '');
    if v_target is null and (p_from = p_to or r.in_target) then
      v_target := r.name;
    end if;
    if v_target is not null then
      if not meta.shared_component_exists(r.kind, p_to, v_target) then
        raise exception 'the target application has no % %', replace(r.kind, '_', ' '), v_target;
      end if;
      v_map := v_map || jsonb_build_object(r.kind || ':' || r.name, v_target);
      continue;
    end if;
    -- copy the component into the target application, under its own name
    t := case r.kind when 'authz_scheme' then 'authz_scheme' when 'build_option' then 'build_option' when 'lov' then 'lov'
                     when 'list' then 'list' when 'template_component' then 'template_component'
                     when 'search_config' then 'search_config' when 'data_load_def' then 'data_load_def' end;
    execute format(
      'insert into meta.%1$I select (jsonb_populate_record(null::meta.%1$I, to_jsonb(x) || jsonb_build_object(''id'', nextval(''meta.%1$s_id_seq''), ''app_id'', $2))).* from meta.%1$I x where x.app_id = $1 and x.%2$I = $3',
      t, case when t = 'template_component' then 'static_id' else 'name' end)
      using p_from, p_to, r.name;
    if r.kind = 'list' then
      -- and its entries, with their parents
      v_lmap := '{}';
      for x in select * from meta.list_entry where app_id = p_from and list_name = r.name order by parent_id nulls first, id loop
        v_e := to_jsonb(x) || jsonb_build_object('id', nextval('meta.list_entry_id_seq'), 'app_id', p_to,
                                                'parent_id', v_lmap ->> x.parent_id::text);
        insert into meta.list_entry select (jsonb_populate_record(null::meta.list_entry, v_e)).* returning id into v_id;
        v_lmap := v_lmap || jsonb_build_object(x.id::text, v_id);
      end loop;
    end if;
    v_map := v_map || jsonb_build_object(r.kind || ':' || r.name, r.name);
  end loop;

  -- the page
  insert into meta.page
  select (jsonb_populate_record(null::meta.page, to_jsonb(v_src) || jsonb_build_object(
            'id', nextval('meta.page_id_seq'), 'app_id', p_to, 'page_no', p_new,
            'name', coalesce(nullif(btrim(p_name), ''), v_src.name),
            'parent_page', case when v_src.parent_page = p_page then null
                                when exists (select 1 from meta.page where app_id = p_to and page_no = v_src.parent_page) then v_src.parent_page
                                else (select home_page from meta.app where id = p_to) end,
            'authz', v_map ->> ('authz_scheme:' || v_src.authz),
            'build_option', case when v_src.build_option is not null
                                 then case when left(v_src.build_option, 1) = '!' then '!' else '' end
                                      || (v_map ->> ('build_option:' || ltrim(v_src.build_option, '!'))) end))).*
  returning id into v_page_id;
  -- an authorization or build option that is not a shared component (e.g. a built-in) stays as it was
  update meta.page p set authz = coalesce(p.authz, v_src.authz), build_option = coalesce(p.build_option, v_src.build_option) where p.id = v_page_id;
  -- a page group the target application doesn't have is left out
  update meta.page p set page_group = null
   where p.id = v_page_id and p.page_group is not null and p_from <> p_to
     and not exists (select 1 from meta.page_group g where g.app_id = p_to and g.name = p.page_group);

  v_old := 'P' || p_page || '_';
  v_new := 'P' || p_new || '_';
  -- every component: items renamed P<old>_ → P<new>_ (also where code refers to them), links to the page itself
  -- to the copy, shared components mapped
  for t in select unnest(array['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch']) loop
    for v_e in execute format('select to_jsonb(x) from meta.%I x where x.page_id = $1 order by x.id', t) using v_src.id loop
      v_id := (v_e ->> 'id')::int;
      if p_page <> p_new then
        v_e := regexp_replace(v_e::text, '\m' || v_old, v_new, 'g')::jsonb;
      end if;
      if v_e ? 'config' then
        v_e := jsonb_set(v_e, '{config}', coalesce(meta.copy_page_json(v_e -> 'config', p_page, p_new), 'null'));
      end if;
      if v_e ? 'target_page' and (v_e ->> 'target_page')::int = p_page and coalesce(v_e ->> 'target_type', 'page') = 'page' then
        v_e := v_e || jsonb_build_object('target_page', p_new);
      end if;
      if v_e ->> 'authz' is not null and v_map ? ('authz_scheme:' || (v_e ->> 'authz')) then
        v_e := v_e || jsonb_build_object('authz', v_map ->> ('authz_scheme:' || (v_e ->> 'authz')));
      end if;
      if v_e ->> 'build_option' is not null and v_map ? ('build_option:' || ltrim(v_e ->> 'build_option', '!')) then
        v_e := v_e || jsonb_build_object('build_option', case when left(v_e ->> 'build_option', 1) = '!' then '!' else '' end
                                                         || (v_map ->> ('build_option:' || ltrim(v_e ->> 'build_option', '!'))));
      end if;
      if t = 'item' and v_e ->> 'lov' ~ '^LOV:' and v_map ? ('lov:' || substr(v_e ->> 'lov', 5)) then
        v_e := v_e || jsonb_build_object('lov', 'LOV:' || (v_map ->> ('lov:' || substr(v_e ->> 'lov', 5))));
      end if;
      if t = 'region' and v_e ->> 'type' = 'list' and v_map ? ('list:' || (v_e #>> '{config,list}')) then
        v_e := jsonb_set(v_e, '{config,list}', to_jsonb(v_map ->> ('list:' || (v_e #>> '{config,list}'))));
      end if;
      if t = 'region' and v_e ->> 'type' = 'template_component' and v_map ? ('template_component:' || (v_e #>> '{config,component}')) then
        v_e := jsonb_set(v_e, '{config,component}', to_jsonb(v_map ->> ('template_component:' || (v_e #>> '{config,component}'))));
      end if;
      if t = 'region' and v_e ->> 'type' = 'search' and jsonb_typeof(v_e #> '{config,configs}') = 'array' then
        v_e := jsonb_set(v_e, '{config,configs}', (select coalesce(jsonb_agg(coalesce(v_map ->> ('search_config:' || upper(c)), c) order by n), '[]')
                                                     from jsonb_array_elements_text(v_e #> '{config,configs}') with ordinality a(c, n)));
      end if;
      if t = 'process' and v_e ->> 'type' = 'data_load' and v_map ? ('data_load_def:' || (v_e #>> '{config,definition}')) then
        v_e := jsonb_set(v_e, '{config,definition}', to_jsonb(v_map ->> ('data_load_def:' || (v_e #>> '{config,definition}'))));
      end if;
      v_e := v_e || jsonb_build_object('id', null, 'page_id', v_page_id);
      if v_e ? 'region_id' then
        v_e := v_e || jsonb_build_object('region_id', v_rmap -> (v_e ->> 'region_id'));
      end if;
      -- (172) a sub region's parent is set after the regions are copied
      if t = 'region' and v_e->>'parent_id' is not null then
        v_pmap := v_pmap || jsonb_build_object(v_id::text, v_e->>'parent_id');
        v_e := v_e || jsonb_build_object('parent_id', null);
      end if;
      if v_e ? 'affected_region_id' then
        v_e := v_e || jsonb_build_object('affected_region_id', v_rmap -> (v_e ->> 'affected_region_id'));
      end if;
      execute format('insert into meta.%1$I select (jsonb_populate_record(null::meta.%1$I, $1 || jsonb_build_object(''id'', nextval(''meta.%1$s_id_seq'')))).* returning id', t)
        using v_e into v_newid;
      if t = 'region' then
        v_rmap := v_rmap || jsonb_build_object(v_id::text, v_newid);
      end if;
    end loop;
    if t = 'region' then
      -- (172) sub regions in the copy's container regions
      update meta.region g
         set parent_id = (v_rmap ->> (v_pmap ->> s.old))::int
        from jsonb_each_text(v_rmap) s(old, neu)
       where g.id = s.neu::int and g.page_id = v_page_id and v_pmap ? s.old and v_rmap ? (v_pmap ->> s.old);
      -- facets, smart filters and maps point at their report region by id
      update meta.region g
         set config = jsonb_set(g.config, '{report}', v_rmap -> (g.config ->> 'report'))
       where g.page_id = v_page_id and g.config ? 'report' and v_rmap ? (g.config ->> 'report');
    end if;
  end loop;
  return v_page_id;
end
$function$;
