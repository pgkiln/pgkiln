-- Sprint 229 (parity AX-8): a Global Page (APEX: page 0, page type Global Page).
--
-- An application can have one page number 0. It is never opened by itself (/a/<app>/0 is not found); its
-- regions, items, buttons, dynamic actions, computations, validations and processes are part of every other
-- page of the application (src/metadata.ts loadPage merges them; branches stay the page's own). Its own
-- settings: Authorization and Page requires sign-in decide for whom its components are added (src/runtime/
-- global-page.ts); title, alias, mode and the like have no effect. It is always a normal page (never a modal
-- dialog). Item names follow APEX: P0_NAME.
--
-- Exports, imports, the one-file-per-component layout (pages/0000-…) and working copies carry page 0 like any
-- page: only the checks below change. The builder's own page_no 0 rows (meta.builder_lock, meta.dev_comment:
-- the application) are left as they are: the Global Page's lock and comments are the application's.

alter table meta.page drop constraint page_page_no_check;
alter table meta.page add constraint page_page_no_check check (page_no >= 0);
alter table meta.page add constraint page_global_normal check (page_no > 0 or mode = 'normal');
comment on column meta.page.page_no is
  'The page number; 0 is the Global Page (187): its components are part of every page, it is not opened by itself';

alter table meta.page_change drop constraint page_change_page_no_check;
alter table meta.page_change add constraint page_change_page_no_check check (page_no >= 0);

-- meta.copy_page (137, 172): page 0 may be copied (a Global Page into another application) or made (a page copied
-- as the Global Page, always a normal page). Otherwise as in 137.
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
  if p_new is null or p_new < 0 then
    raise exception 'a page number must be a whole number, 0 for the Global Page';
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
            'mode', case when p_new = 0 then 'normal' else v_src.mode end,
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
revoke all on function meta.copy_page(int, int, int, int, text, jsonb) from public;
