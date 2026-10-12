-- =====================================================================
-- 086: data and settings (sprint 53)
--
-- meta.app_setting (APEX: Application Settings, APEX_APP_SETTING): named
--   values of an application that an administrator changes after
--   deployment, read and written from SQL with meta.get_app_setting(name) and
--   meta.set_app_setting(name, value). Exported with the application; an
--   import over an existing application keeps the installed values of the
--   settings marked keep_on_upgrade.
--
-- meta.user_preference (APEX: APEX_UTIL.GET/SET/REMOVE_PREFERENCE): values
--   kept per user and application across sessions. Items with
--   {"persist": "user"} (APEX: Maintain session state: Per User) are read
--   from and saved to them by the runtime. Installation data: not exported.
--
-- meta.dynamic_translation (APEX: Dynamic Translations, APEX_LANG.LANG):
--   translations of values from tables (e.g. list of values entries):
--   meta.lang(text) returns the text in the session's language.
--
-- meta.data_export(query, format, options) (APEX: APEX_DATA_EXPORT): a
--   query's rows as a CSV, JSON, XML or HTML file (bytea), run with the
--   caller's privileges. The download process makes Excel and PDF too.
--
-- Item types image (APEX: Display Image: a URL, or a BLOB from a query) and
--   address (APEX: Geocoded Address: an address checked against the
--   installation's geocoder, its position into another item).
--
-- export_app / import_app are redefined from 083 / 081 to carry
-- app_settings and dynamic_translations.
-- =====================================================================

-- The current application, when called as its own database role (application code).
create function meta.caller_app(p_fn text) returns int
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.app_id();
  v_role text;
begin
  if v_app is null then
    raise exception '%: no current application (call it from application code)', p_fn;
  end if;
  select a.db_role into v_role from meta.app a where a.id = v_app;
  if not found then
    raise exception '%: no current application (call it from application code)', p_fn;
  end if;
  -- an application without a role of its own runs as the runtime's login role (no SET ROLE):
  -- another application's role can't claim it
  if current_setting('role') is distinct from coalesce(v_role, 'none') then
    raise exception '%: called outside the application''s own database role', p_fn;
  end if;
  return v_app;
end
$$;
revoke all on function meta.caller_app(text) from public;

-- ---------------------------------------------------------------- application settings
create table meta.app_setting (
  id              serial primary key,
  app_id          int  not null references meta.app on delete cascade,
  name            text not null check (name ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  value           text check (octet_length(value) <= 4000),
  description     text,
  -- a value is required (an empty one is refused)
  required        boolean not null default false,
  -- the values allowed (null: any)
  valid_values    text[] check (valid_values is null or cardinality(valid_values) between 1 and 100),
  -- an import over an installed application keeps the installed value
  keep_on_upgrade boolean not null default true,
  unique (app_id, name),
  constraint app_setting_required check (not required or coalesce(value, '') <> ''),
  constraint app_setting_valid check (value is null or valid_values is null or value = any(valid_values))
);
revoke all on meta.app_setting from public;
comment on table meta.app_setting is 'Application settings (086): named values changed after deployment; meta.get_app_setting / meta.set_app_setting';

-- an export made before 086 (or a document written by hand) may leave the flags out
create function meta.app_setting_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.required := coalesce(new.required, false);
  new.keep_on_upgrade := coalesce(new.keep_on_upgrade, true);
  return new;
end $$;
create trigger app_setting_defaults before insert on meta.app_setting
  for each row execute function meta.app_setting_defaults();

-- APEX_APP_SETTING.GET_VALUE
create function meta.get_app_setting(p_name text) returns text
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.caller_app('meta.get_app_setting');
  v     meta.app_setting;
begin
  select * into v from meta.app_setting where app_id = v_app and name = upper(p_name);
  if not found then
    raise exception 'meta.get_app_setting: the application has no setting %', upper(p_name);
  end if;
  return v.value;
end
$$;
grant execute on function meta.get_app_setting(text) to public;

-- APEX_APP_SETTING.SET_VALUE
create function meta.set_app_setting(p_name text, p_value text) returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.caller_app('meta.set_app_setting');
  v     meta.app_setting;
begin
  select * into v from meta.app_setting where app_id = v_app and name = upper(p_name) for update;
  if not found then
    raise exception 'meta.set_app_setting: the application has no setting %', upper(p_name);
  end if;
  if v.required and coalesce(p_value, '') = '' then
    raise exception 'meta.set_app_setting: % needs a value', v.name;
  end if;
  if p_value is not null and v.valid_values is not null and not p_value = any(v.valid_values) then
    raise exception 'meta.set_app_setting: % is one of %', v.name, array_to_string(v.valid_values, ', ');
  end if;
  update meta.app_setting set value = p_value where id = v.id;
end
$$;
grant execute on function meta.set_app_setting(text, text) to public;

-- ---------------------------------------------------------------- user preferences
create table meta.user_preference (
  app_id     int  not null references meta.app on delete cascade,
  username   text not null,
  name       text not null check (name ~ '^[A-Za-z][A-Za-z0-9_.-]{0,99}$'),
  value      text check (octet_length(value) <= 32000),
  updated_at timestamptz not null default now(),
  primary key (app_id, username, name)
);
revoke all on meta.user_preference from public;
comment on table meta.user_preference is 'User preferences (086): values kept per user across sessions; meta.get_preference / set_preference / remove_preference';

-- The user a preference belongs to: the given one, or the signed-in user.
create function meta.preference_user(p_fn text, p_user text) returns text
language plpgsql stable set search_path = meta, pg_catalog as $$
declare
  v_user text := coalesce(nullif(btrim(p_user), ''), nullif(current_setting('pgkiln.app_user', true), ''));
begin
  if v_user is null or v_user = 'nobody' then
    raise exception '%: no signed-in user', p_fn;
  end if;
  return v_user;
end
$$;
revoke all on function meta.preference_user(text, text) from public;

-- APEX_UTIL.GET_PREFERENCE: null when the user has none
create function meta.get_preference(p_name text, p_user text default null) returns text
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.caller_app('meta.get_preference');
  v_user text := coalesce(nullif(btrim(p_user), ''), nullif(current_setting('pgkiln.app_user', true), ''));
begin
  if v_user is null or v_user = 'nobody' then
    return null;
  end if;
  return (select value from meta.user_preference where app_id = v_app and username = v_user and name = p_name);
end
$$;
grant execute on function meta.get_preference(text, text) to public;

-- APEX_UTIL.SET_PREFERENCE: at most 500 preferences per user and application
create function meta.set_preference(p_name text, p_value text, p_user text default null) returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.caller_app('meta.set_preference');
  v_user text := meta.preference_user('meta.set_preference', p_user);
begin
  if p_name is null or p_name !~ '^[A-Za-z][A-Za-z0-9_.-]{0,99}$' then
    raise exception 'meta.set_preference: a name of letters, digits, _ . and - (at most 100)';
  end if;
  if not exists (select 1 from meta.user_preference where app_id = v_app and username = v_user and name = p_name)
     and (select count(*) from meta.user_preference where app_id = v_app and username = v_user) >= 500 then
    raise exception 'meta.set_preference: at most 500 preferences per user';
  end if;
  insert into meta.user_preference (app_id, username, name, value) values (v_app, v_user, p_name, p_value)
  on conflict (app_id, username, name) do update set value = excluded.value, updated_at = now();
end
$$;
grant execute on function meta.set_preference(text, text, text) to public;

-- APEX_UTIL.REMOVE_PREFERENCE
create function meta.remove_preference(p_name text, p_user text default null) returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.caller_app('meta.remove_preference');
  v_user text := meta.preference_user('meta.remove_preference', p_user);
begin
  delete from meta.user_preference where app_id = v_app and username = v_user and name = p_name;
end
$$;
grant execute on function meta.remove_preference(text, text) to public;

-- ---------------------------------------------------------------- dynamic translations
create table meta.dynamic_translation (
  id       serial primary key,
  app_id   int  not null references meta.app on delete cascade,
  language text not null check (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
  source   text not null check (length(source) between 1 and 4000),
  target   text not null check (length(target) <= 4000),
  unique (app_id, language, source)
);
revoke all on meta.dynamic_translation from public;
comment on table meta.dynamic_translation is 'Dynamic translations (086): values from tables in other languages; meta.lang(text)';

-- APEX_LANG.LANG: the text in the session's language (or p_language): an exact
-- match, then the base language (nl for nl-BE), else the text as it is.
create function meta.lang(p_text text, p_language text default null) returns text
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.app_id();
  v_lang text := lower(coalesce(nullif(btrim(p_language), ''), meta.app_language()));
  v_out  text;
begin
  if p_text is null or v_app is null then
    return p_text;
  end if;
  select t.target into v_out from meta.dynamic_translation t
   where t.app_id = v_app and t.source = p_text and t.language in (v_lang, split_part(v_lang, '-', 1))
   order by t.language = v_lang desc
   limit 1;
  return coalesce(v_out, p_text);
end
$$;
grant execute on function meta.lang(text, text) to public;

-- ---------------------------------------------------------------- data export
-- A CSV field, as the report download writes it: quoted when it holds the
-- separator, a quote or a line break; text that looks like a formula
-- (= + - @ tab CR) gets a leading apostrophe so a spreadsheet doesn't run it.
create function meta.csv_field(p_value text, p_sep text default ',', p_text boolean default true) returns text
language sql immutable set search_path = pg_catalog as $$
  select case
           when v is null then ''
           when strpos(v, p_sep) > 0 or v ~ '["\r\n]' then '"' || replace(v, '"', '""') || '"'
           else v
         end
    from (select case when p_text and p_value ~ '^[=+\-@\t\r]' then '''' || p_value else p_value end as v) x
$$;
grant execute on function meta.csv_field(text, text, boolean) to public;

-- APEX_DATA_EXPORT.EXPORT: the rows of a query as a file. Formats: csv,
-- json (an array of objects), xml (query_to_xml) and html (a table).
-- Options: {"separator": ";", "header": false, "bom": false, "title": "…"}.
-- Runs with the caller's privileges (security invoker): row level security
-- and grants apply as to the query itself.
create function meta.data_export(p_query text, p_format text default 'csv', p_options jsonb default '{}') returns bytea
language plpgsql volatile as $$
declare
  v_format text := lower(coalesce(nullif(btrim(p_format), ''), 'csv'));
  v_opts   jsonb := coalesce(p_options, '{}');
  v_query  text := regexp_replace(coalesce(p_query, ''), '[\s;]+$', '');
  v_sep    text := coalesce(v_opts->>'separator', ',');
  v_header boolean := coalesce((v_opts->>'header')::boolean, true);
  v_cols   text[];
  v_rows   text;
  v_title  text := v_opts->>'title';
begin
  if btrim(v_query) = '' then
    raise exception 'meta.data_export: a query is required';
  end if;
  if v_format not in ('csv', 'json', 'xml', 'html') then
    raise exception 'meta.data_export: the format is csv, json, xml or html (Excel and PDF: the download process)';
  end if;
  if length(v_sep) <> 1 or v_sep ~ '["\r\n]' then
    raise exception 'meta.data_export: the separator is one character';
  end if;
  if v_format = 'json' then
    execute format(E'select coalesce(json_agg(q), ''[]'')::text from (\n%s\n) q', v_query) into v_rows;
    return convert_to(v_rows, 'UTF8');
  end if;
  if v_format = 'xml' then
    return convert_to(query_to_xml(v_query, true, false, '')::text, 'UTF8');
  end if;
  -- the column names, in order, also when there are no rows (the outer join on false reads no row)
  execute format(E'select array(select json_object_keys(row_to_json(x))) from (select q.* from (select 1) d left join (\n%s\n) q on false) x', v_query)
    into v_cols;
  if v_format = 'csv' then
    execute format(E'select string_agg((select string_agg(meta.csv_field(e.value #>> ''{}'', %L, json_typeof(e.value) = ''string''), %L order by e.n) from json_each(row_to_json(q)) with ordinality e(k, value, n)), E''\\r\\n'') from (\n%s\n) q',
                   v_sep, v_sep, v_query)
      into v_rows;
    return convert_to(
      case when coalesce((v_opts->>'bom')::boolean, true) then chr(65279) else '' end
      || case when v_header then (select string_agg(meta.csv_field(c, v_sep), v_sep order by n) from unnest(v_cols) with ordinality u(c, n)) || E'\r\n' else '' end
      || coalesce(v_rows || E'\r\n', ''),
      'UTF8');
  end if;
  -- html
  execute format(E'select string_agg(''<tr>'' || (select string_agg(''<td>'' || coalesce(meta.html_escape(e.value), '''') || ''</td>'', '''' order by e.n) from json_each_text(row_to_json(q)) with ordinality e(k, value, n)) || ''</tr>'', E''\\n'') from (\n%s\n) q',
                 v_query)
    into v_rows;
  return convert_to(
    '<!doctype html>' || E'\n' || '<html><head><meta charset="utf-8"><title>' || coalesce(meta.html_escape(v_title), 'Export') || '</title></head><body>' || E'\n'
    || case when v_title is not null then '<h1>' || meta.html_escape(v_title) || '</h1>' || E'\n' else '' end
    || '<table>' || E'\n'
    || case when v_header then '<thead><tr>' || coalesce((select string_agg('<th>' || meta.html_escape(c) || '</th>', '' order by n) from unnest(v_cols) with ordinality u(c, n)), '') || '</tr></thead>' || E'\n' else '' end
    || '<tbody>' || E'\n' || coalesce(v_rows || E'\n', '') || '</tbody></table>' || E'\n' || '</body></html>' || E'\n',
    'UTF8');
end
$$;
grant execute on function meta.data_export(text, text, jsonb) to public;

-- ---------------------------------------------------------------- items
alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in (
  'text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch', 'hidden', 'display', 'password',
  'checkbox_group', 'multiselect', 'popup_lov', 'email', 'tel', 'url', 'color', 'file', 'location', 'richtext', 'markdown',
  'rating', 'combobox', 'daterange', 'qrcode', 'plugin', 'image', 'address'));

-- ---------------------------------------------------------------- export
-- Same as 083, plus app_settings and dynamic_translations.
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable set search_path = meta, pg_catalog as $$
  select jsonb_build_object(
    'format', 'pgkiln/2',
    -- (083) availability and build status belong to the installation
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at' - 'availability' - 'availability_message' - 'availability_users' - 'build_status',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'group_roles', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.group_name, x.role) from meta.app_group_role x where x.app_id = a.id), '[]'),
    'text_messages', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.name, x.language) from meta.text_message x where x.app_id = a.id), '[]'),
    'translations', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.language, x.source) from meta.translation x where x.app_id = a.id), '[]'),
    'report_layouts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'logo' || jsonb_build_object('logo', encode(x.logo, 'base64')) order by x.name)
                                  from meta.report_layout x where x.app_id = a.id), '[]'),
    'automations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'next_run_at' - 'last_run_at' - 'last_status' - 'code' order by x.name)
                               from meta.automation x where x.app_id = a.id), '[]'),
    -- (044) the actions of the automations, by automation name
    'automation_actions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.automation_name collate "C", x.seq, x.name collate "C")
                                      from meta.automation_action x where x.app_id = a.id), '[]'),
    'document_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.document_template x where x.app_id = a.id), '[]'),
    'task_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.task_definition x where x.app_id = a.id), '[]'),
    'workflow_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.workflow_definition x where x.app_id = a.id), '[]'),
    'rest_modules', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.rest_module x where x.app_id = a.id), '[]'),
    'template_components', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.static_id) from meta.template_component x where x.app_id = a.id), '[]'),
    'build_options', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.build_option x where x.app_id = a.id), '[]'),
    -- (030) secrets never leave the installation: they are entered again after an import
    -- (050) nor do the password and refresh token of the OAuth2 flows, or the token state
    'web_credentials', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'secret_enc' - 'password_enc' - 'refresh_token_enc' - 'token_refreshed_at' order by x.name)
                                   from meta.web_credential x where x.app_id = a.id), '[]'),
    -- (050) the synchronisation's state (next and last run) belongs to the installation
    'rest_sources', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'sync_next_at' - 'sync_last_at' - 'sync_last_status' order by x.name)
                                from meta.rest_source x where x.app_id = a.id), '[]'),
    -- (041) data load definitions
    'data_load_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.data_load_def x where x.app_id = a.id), '[]'),
    -- (042) lists; entries keep their ids so parents can be remapped on import
    'lists', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.list x where x.app_id = a.id), '[]'),
    'list_entries', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.list_name, x.parent_id nulls first, x.seq, x.id) from meta.list_entry x where x.app_id = a.id), '[]'),
    -- (042) supporting objects: install, upgrade and deinstall scripts (never run on import)
    'supporting_scripts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.supporting_script x where x.app_id = a.id), '[]'),
    -- (069) plug-ins (their files are static files, their templates template components)
    'plugins', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.plugin x where x.app_id = a.id), '[]'),
    -- (080) search configurations
    'search_configs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.search_config x where x.app_id = a.id), '[]'),
    -- (081) e-mail templates
    'email_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.email_template x where x.app_id = a.id), '[]'),
    -- (086) application settings (with their values) and dynamic translations
    'app_settings', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_setting x where x.app_id = a.id), '[]'),
    'dynamic_translations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.language, x.source collate "C") from meta.dynamic_translation x where x.app_id = a.id), '[]'),
    -- (068) static application files (JavaScript, CSS, images, fonts) as base64
    'static_files', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'content' - 'updated_at' || jsonb_build_object('content', translate(encode(x.content, 'base64'), E'\n', '')) order by x.name)
                                from meta.static_file x where x.app_id = a.id), '[]'),
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

-- ---------------------------------------------------------------- import
-- Same as 081, plus app_settings and dynamic_translations.
create or replace function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_app_id  int;
  v_page_id int;
  v_page    jsonb;
  v_e       jsonb;
  v_rmap    jsonb;
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
