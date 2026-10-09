-- =====================================================================
-- 007: globalization (like APEX Shared Components → Globalization)
--
--   * a primary language per application plus translated languages
--   * how the language is chosen: the primary language, the browser
--     (Accept-Language) or the user's preference (then the browser);
--     ?lang=xx switches for the session (APEX: p_lang / SET_SESSION_LANG)
--   * text messages (APEX_LANG.MESSAGE, &APP_TEXT$NAME.), also used to
--     override pgkiln's own texts
--   * translations of the application's texts (labels, titles, headings,
--     messages) within one application, like APEX 26.1's text-message-based
--     translation: no copy of the app per language
--   * date and timestamp formats per application
-- =====================================================================

alter table meta.app
  add column language      text not null default 'en' check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$'),
  add column languages     text[] not null default '{}',
  add column language_from text not null default 'browser' check (language_from in ('primary', 'browser', 'user')),
  add column date_format   text,
  add column timestamp_format text;

-- Text messages: name + language → text, with %0 … %9 placeholders.
create table meta.text_message (
  app_id   int  not null references meta.app on delete cascade,
  name     text not null check (name ~ '^[A-Za-z][A-Za-z0-9_.$-]{0,99}$'),
  language text not null,
  text     text not null,
  primary key (app_id, name, language)
);

-- Translations of application texts: the primary-language text → the text
-- in another language. Every place that shows that text uses it.
create table meta.translation (
  app_id   int  not null references meta.app on delete cascade,
  language text not null,
  source   text not null,
  target   text not null,
  primary key (app_id, language, source)
);

-- The language of the current request (set by the runtime).
create function meta.app_language() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('pgkiln.lang', true), ''),
                  (select a.language from meta.app a where a.id = meta.app_id()), 'en')
$$;

-- A text message in the current language (falling back to the primary
-- language, then to the name), with %0 … %9 replaced by the parameters.
create function meta.message(p_name text, variadic p_params text[] default '{}') returns text
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.app_id();
  v_lang text := meta.app_language();
  v_text text;
begin
  select coalesce(
           (select m.text from meta.text_message m where m.app_id = v_app and upper(m.name) = upper(p_name) and m.language = v_lang),
           (select m.text from meta.text_message m where m.app_id = v_app and upper(m.name) = upper(p_name)
                                                   and m.language = split_part(v_lang, '-', 1)),
           (select m.text from meta.text_message m join meta.app a on a.id = m.app_id
             where m.app_id = v_app and upper(m.name) = upper(p_name) and m.language = a.language),
           p_name)
    into v_text;
  for i in 1 .. least(coalesce(array_length(p_params, 1), 0), 10) loop
    v_text := replace(v_text, '%' || (i - 1), coalesce(p_params[i], ''));
  end loop;
  return v_text;
end
$$;

grant execute on function meta.app_language(), meta.message(text, text[]) to public;
grant select on meta.text_message, meta.translation to pgkiln_runtime;

-- Export and import include text messages and translations.
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'format', 'pgkiln/2',
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'group_roles', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.group_name, x.role) from meta.app_group_role x where x.app_id = a.id), '[]'),
    'text_messages', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.name, x.language) from meta.text_message x where x.app_id = a.id), '[]'),
    'translations', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.language, x.source) from meta.translation x where x.app_id = a.id), '[]'),
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

-- import_app: same as 004, plus text messages and translations.
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
  if p_doc->>'format' is distinct from 'pgkiln/2' then
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
  insert into meta.app_group_role
  select (jsonb_populate_record(null::meta.app_group_role, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'group_roles', '[]')) e;

  insert into meta.text_message
  select (jsonb_populate_record(null::meta.text_message, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'text_messages', '[]')) e;
  insert into meta.translation
  select (jsonb_populate_record(null::meta.translation, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'translations', '[]')) e;

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
