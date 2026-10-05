-- =====================================================================
-- 052: PL/SQL API equivalents for application SQL
--
-- meta.web_request(...)  (APEX_WEB_SERVICE.make_rest_request)
--   PostgreSQL can't make an HTTP call without an extension, so a request
--   from SQL is QUEUED in meta.web_request_log and made by the pgapex
--   server, through the same code as REST data sources: the host allow-list
--   (PGAPEX_REST_ALLOWED_HOSTS), the address checks at connect time, the
--   response size limit and the web credentials of the application (whose
--   secrets never reach SQL). meta.web_response(id) returns the result.
--   When it runs:
--   - right after the page process (type sql) that queued it, in the same
--     transaction, so the next process can read the response;
--   - otherwise (automations, workflows, computations, triggers, PostgREST)
--     after the caller's transaction commits, on the next pass of the
--     server's scheduler (SCHEDULER_INTERVAL_S, default 30 s).
--   Rows are kept 24 hours (at most 500 finished requests per application);
--   everything is limited to the current application (meta.app_id()).
--
-- meta.parse_data(...) / meta.parse_data_columns(...)  (APEX_DATA_PARSER)
--   CSV/TSV and JSON (an array of objects, an object holding one such array,
--   JSON Lines) in a bytea, parsed in SQL with the same rules as the data
--   loader (src/dataload.ts): headings, column names, inferred types.
--   Excel (.xlsx) is a zip archive whose parts are deflate-compressed, and
--   PostgreSQL has no inflate function: XLSX (and XML) are refused with a
--   message pointing to the data_load process / SQL Workshop → Load Data.
-- =====================================================================

-- ---------------------------------------------------------------- web requests

create table meta.web_request_log (
  id               bigserial primary key,
  app_id           int  not null references meta.app on delete cascade,
  status           text not null default 'queued' check (status in ('queued', 'running', 'ok', 'error')),
  -- a REST data source of the app (its URL, method, credential, parameters) …
  source           text,
  params           jsonb,
  -- … or a URL with a method, headers, a body and a web credential (by name)
  url              text,
  method           text not null default 'GET' check (method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  headers          jsonb not null default '{}',
  body             text,
  credential       text,
  timeout_s        int  not null default 10 check (timeout_s between 1 and 60),
  requested_by     text,
  -- the transaction that queued it: a page process's requests run before it commits
  requested_xact   xid8 not null default pg_current_xact_id(),
  requested_at     timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  status_code      int,
  response_url     text,
  response_headers jsonb,
  response_body    bytea,
  message          text,
  check ((source is null) <> (url is null))
);
create index on meta.web_request_log (app_id, id desc);
create index on meta.web_request_log (id) where status = 'queued';
create index on meta.web_request_log (finished_at);
revoke all on meta.web_request_log from public;
comment on table meta.web_request_log is
  'web requests queued from SQL (meta.web_request) and their responses, made by the pgapex server; kept 24 hours';

-- Checks shared by the two ways to queue a request; returns the app id.
create function meta.web_request_check() returns int
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.app_id();
begin
  if v_app is null then
    raise exception 'meta.web_request: no current application (call it from application code)';
  end if;
  if (select count(*) from meta.web_request_log where app_id = v_app and status = 'queued') >= 100 then
    raise exception 'meta.web_request: this application has 100 requests waiting already';
  end if;
  return v_app;
end
$$;
revoke execute on function meta.web_request_check() from public;

-- Queue a request to a URL; returns its id (see meta.web_response).
create function meta.web_request(
  p_url        text,
  p_method     text  default 'GET',
  p_body       text  default null,
  p_headers    jsonb default null,
  p_credential text  default null,
  p_timeout_s  int   default 10
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app    int := meta.web_request_check();
  v_method text := upper(coalesce(p_method, 'GET'));
  v_key    text;
  v_value  jsonb;
  v_id     bigint;
begin
  if p_url is null or length(p_url) > 4000 or p_url !~* '^https?://[^/?#@\s\\]+([/?#]|$)' or p_url ~ '[\s\x01-\x1f]' then
    raise exception 'meta.web_request: the URL must start with http:// or https:// and a host (at most 4000 characters, no spaces)';
  end if;
  if v_method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE') then
    raise exception 'meta.web_request: the method is one of GET, HEAD, POST, PUT, PATCH, DELETE';
  end if;
  if octet_length(p_body) > 1000000 then
    raise exception 'meta.web_request: the body is larger than 1 MB';
  end if;
  if p_headers is not null then
    if jsonb_typeof(p_headers) <> 'object' then
      raise exception 'meta.web_request: the headers are a JSON object of strings ({"Accept": "text/csv"})';
    end if;
    if (select count(*) from jsonb_object_keys(p_headers)) > 30 then
      raise exception 'meta.web_request: at most 30 headers';
    end if;
    for v_key, v_value in select key, value from jsonb_each(p_headers) loop
      if v_key !~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,100}$' then
        raise exception 'meta.web_request: "%" is not a valid header name', left(v_key, 100);
      end if;
      if lower(v_key) in ('host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-connection', 'expect') then
        raise exception 'meta.web_request: the header % is set by the server', v_key;
      end if;
      if jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') > 8000 or (v_value #>> '{}') ~ '[\r\n\x00]' then
        raise exception 'meta.web_request: the value of header % is a string of at most 8000 characters without line breaks', v_key;
      end if;
    end loop;
  end if;
  if p_credential is not null and not exists (select 1 from meta.web_credential where app_id = v_app and name = upper(p_credential)) then
    raise exception 'meta.web_request: web credential % does not exist in this application', upper(p_credential);
  end if;
  if coalesce(p_timeout_s, 10) not between 1 and 60 then
    raise exception 'meta.web_request: the time limit is 1 to 60 seconds';
  end if;
  insert into meta.web_request_log (app_id, url, method, headers, body, credential, timeout_s, requested_by)
  values (v_app, p_url, v_method, coalesce(p_headers, '{}'), p_body, upper(p_credential), coalesce(p_timeout_s, 10), meta.app_user())
  returning id into v_id;
  -- a page process's requests run right after it (src/webrequests.ts)
  perform set_config('pgapex.web_pending', '1', true);
  return v_id;
end
$$;

-- Queue a call of a REST data source of the app (its URL, method, headers,
-- credential; parameter values as text, missing ones take their default).
create function meta.web_request_source(p_source text, p_params jsonb default null, p_timeout_s int default null) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.web_request_check();
  v_id  bigint;
  v_timeout int;
begin
  select timeout_s into v_timeout from meta.rest_source where app_id = v_app and name = upper(p_source);
  if not found then
    raise exception 'meta.web_request_source: REST data source % does not exist in this application', upper(p_source);
  end if;
  if p_params is not null and (jsonb_typeof(p_params) <> 'object'
      or exists (select 1 from jsonb_each(p_params) where jsonb_typeof(value) <> 'string' or length(value #>> '{}') > 8000)) then
    raise exception 'meta.web_request_source: the parameters are a JSON object of strings ({"city": "Utrecht"})';
  end if;
  if p_timeout_s is not null and p_timeout_s not between 1 and 60 then
    raise exception 'meta.web_request_source: the time limit is 1 to 60 seconds';
  end if;
  insert into meta.web_request_log (app_id, source, params, timeout_s, requested_by)
  values (v_app, upper(p_source), coalesce(p_params, '{}'), coalesce(p_timeout_s, least(greatest(v_timeout, 1), 60), 10), meta.app_user())
  returning id into v_id;
  perform set_config('pgapex.web_pending', '1', true);
  return v_id;
end
$$;

-- The response body as text (UTF-8, or Latin-1 when it isn't valid UTF-8;
-- null for binary content with NUL bytes).
create function meta.web_response_text(p_body bytea) returns text
language plpgsql immutable set search_path = pg_catalog as $$
begin
  if p_body is null or position('\x00'::bytea in p_body) > 0 then
    return null;  -- binary: see meta.web_response_blob
  end if;
  begin
    return convert_from(p_body, 'UTF8');
  exception when others then
    return convert_from(p_body, 'LATIN1');
  end;
end
$$;

-- A request of the current application: {"id", "status" (queued, running,
-- ok, error), "status_code", "headers", "content_type", "body" (text),
-- "json" (the body parsed, when it is JSON), "url", "message", times}.
-- "ok" means a response came back, whatever its status code (APEX:
-- apex_web_service.g_status_code); "error": no response (see "message").
create function meta.web_response(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  r      meta.web_request_log;
  v_text text;
  v_json jsonb;
begin
  select * into r from meta.web_request_log where id = p_id and app_id = meta.app_id();
  if not found then
    return null;
  end if;
  v_text := meta.web_response_text(r.response_body);
  if v_text is not null and (r.response_headers ->> 'content-type' ~* 'json' or v_text ~ '^\s*[\[{]') then
    begin
      v_json := v_text::jsonb;
    exception when others then
      v_json := null;
    end;
  end if;
  return jsonb_build_object(
    'id', r.id, 'status', r.status, 'status_code', r.status_code, 'method', r.method,
    'url', coalesce(r.response_url, r.url), 'source', r.source,
    'headers', r.response_headers, 'content_type', r.response_headers ->> 'content-type',
    'body', v_text, 'json', v_json, 'size', octet_length(r.response_body), 'message', r.message,
    'requested_at', r.requested_at, 'started_at', r.started_at, 'finished_at', r.finished_at);
end
$$;

-- The response body as bytes (files, images).
create function meta.web_response_blob(p_id bigint) returns bytea
language sql stable security definer set search_path = meta, pg_catalog as $$
  select response_body from meta.web_request_log where id = p_id and app_id = meta.app_id()
$$;

-- For the server (src/webrequests.ts), on the application's connection:
-- the requests this transaction queued, marked running (at most p_limit).
-- Only the caller's own transaction's requests, so application code calling
-- it can do no more than run its own requests.
create function meta.web_request_take(p_limit int default 5)
returns table (id bigint, source text, params jsonb, url text, method text, headers jsonb, body text, credential text, timeout_s int)
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
begin
  if coalesce(current_setting('pgapex.web_pending', true), '') <> '1' then
    return;
  end if;
  perform set_config('pgapex.web_pending', '', true);
  return query
    update meta.web_request_log l set status = 'running', started_at = now()
     where l.id in (select x.id from meta.web_request_log x
                     where x.status = 'queued' and x.requested_xact = pg_current_xact_id() and x.app_id = meta.app_id()
                     order by x.id limit least(greatest(p_limit, 0), 20))
    returning l.id, l.source, l.params, l.url, l.method, l.headers, l.body, l.credential, l.timeout_s;
  -- more than the limit: the rest stay queued for the scheduler
end
$$;

-- For the server: the result of a request taken with meta.web_request_take().
create function meta.web_request_done(p_id bigint, p_status text, p_status_code int, p_url text, p_headers jsonb, p_body bytea, p_message text) returns void
language sql volatile security definer set search_path = meta, pg_catalog as $$
  update meta.web_request_log
     set status = case when p_status = 'ok' then 'ok' else 'error' end, finished_at = now(), status_code = p_status_code,
         response_url = p_url, response_headers = p_headers, response_body = p_body, message = left(p_message, 2000)
   where id = p_id and status = 'running' and requested_xact = pg_current_xact_id() and app_id = meta.app_id()
$$;

grant execute on function meta.web_request(text, text, text, jsonb, text, int), meta.web_request_source(text, jsonb, int),
  meta.web_response(bigint), meta.web_response_blob(bigint), meta.web_response_text(bytea),
  meta.web_request_take(int), meta.web_request_done(bigint, text, int, text, jsonb, bytea, text) to public;

-- ---------------------------------------------------------------- data parser

-- A SQL column name for a heading, as the data loader makes them
-- ("Hire Date" → hire_date, "2024" → c_2024, "" → column).
create function meta.parse_data_name(p_heading text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select case when n ~ '^[0-9]' then 'c_' || n else n end
    from (select coalesce(nullif(left(btrim(regexp_replace(
                   replace(lower(replace(regexp_replace(normalize(coalesce(p_heading, ''), NFKD), '[̀-ͯ]', '', 'g'), 'ß', 'ss')), 'ß', 'ss'),
                   '[^a-z0-9_]+', '_', 'g'), '_'), 60), ''), 'column') as n) x
$$;

-- Unique column names for the headings (blank ones: column_<n>), `p_width` long.
create function meta.parse_data_names(p_headings text[], p_width int) returns text[]
language plpgsql immutable parallel safe set search_path = meta, pg_catalog as $$
declare
  v_out  text[] := '{}';
  v_name text;
  v_try  text;
  n      int;
begin
  for i in 1 .. coalesce(p_width, 0) loop
    v_name := meta.parse_data_name(coalesce(nullif(btrim(p_headings[i]), ''), 'column_' || i));
    v_try := v_name;
    n := 2;
    while v_try = any (v_out) loop
      v_try := v_name || '_' || n;
      n := n + 1;
    end loop;
    v_out := v_out || v_try;
  end loop;
  return v_out;
end
$$;

-- The narrowest type that fits every value (as the data loader infers it):
-- integer, bigint, numeric, boolean, date, timestamp or text.
create function meta.parse_data_type(p_values text[]) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  with v as (select btrim(x, E' \t\r\n\f\v') as x from unnest(p_values) x where x is not null)
  select case
    when not exists (select 1 from v) then 'text'
    when bool_and(x ~ '^[-+]?[0-9]+$') then
      case when bool_and(case when x ~ '^[-+]?[0-9]+$' then abs(x::numeric) <= 2147483647 else false end) then 'integer' else 'bigint' end
    when bool_and(x ~ '^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$') then 'numeric'
    when bool_and(x ~* '^(true|false|t|f|yes|no|y|n)$') then 'boolean'
    when bool_and(x ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then 'date'
    when bool_and(x ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or x ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?([+-][0-9]{2}(:?[0-9]{2})?|Z)?$') then 'timestamp'
    else 'text' end
  from v
$$;

-- The rows of a file: line_number 0 is the heading row (CSV with headings,
-- JSON), the data rows are numbered from 1; values as text, blank → null.
create function meta.parse_data_rows(
  p_content      bytea,
  p_file_name    text    default null,
  p_format       text    default 'auto',
  p_headers      boolean default true,
  p_delimiter    text    default null,
  p_row_selector text    default null,
  p_skip_rows    int     default 0,
  p_max_rows     int     default 100000
) returns table (line_number int, cols text[])
language plpgsql stable set search_path = meta, pg_catalog as $$
declare
  v_format text := lower(coalesce(nullif(p_format, ''), 'auto'));
  v_text   text;
  v_head   text;
  v_d      text;
  v_re     text;
  v_json   json;
  v_keys   text[];
  v_count  int;
  v_skip   int := greatest(coalesce(p_skip_rows, 0), 0);
  v_max    int := least(greatest(coalesce(p_max_rows, 100000), 1), 1000000);
  v_part   text;
  v_arrays json[];
begin
  if v_format not in ('auto', 'csv', 'tsv', 'json', 'xlsx', 'xml') then
    raise exception 'meta.parse_data: the format is auto, csv, tsv or json';
  end if;
  if p_content is null then
    return;
  end if;
  -- Excel files are zip archives of deflate-compressed parts: no inflate in SQL
  if v_format = 'xlsx' or (v_format = 'auto' and (p_file_name ~* '\.(xlsx|xlsm|xls|ods)$'
      or substring(p_content from 1 for 4) = '\x504b0304'::bytea)) then
    raise exception using errcode = 'feature_not_supported',
      message = 'meta.parse_data: Excel (.xlsx) files can''t be parsed in SQL (they are compressed).',
      hint = 'Load them into a table with a data_load page process, a data load definition or SQL Workshop → Load Data; or save the sheet as CSV.';
  end if;
  if position('\x00'::bytea in p_content) > 0 then
    raise exception 'meta.parse_data: this is not a text (CSV or JSON) file';
  end if;
  -- UTF-8 (with or without BOM); not valid UTF-8: Windows-1252, else Latin-1
  begin
    v_text := convert_from(p_content, 'UTF8');
  exception when others then
    begin
      v_text := convert_from(p_content, 'WIN1252');
    exception when others then
      v_text := convert_from(p_content, 'LATIN1');
    end;
  end;
  v_text := regexp_replace(v_text, '^﻿', '');
  v_head := left(v_text, 64);
  if v_format = 'xml' or (v_format = 'auto' and (p_file_name ~* '\.xml$' or v_head ~ '^\s*<[?!A-Za-z_]')) then
    raise exception using errcode = 'feature_not_supported',
      message = 'meta.parse_data: XML is not parsed by meta.parse_data.',
      hint = 'Use PostgreSQL''s xmltable(), or a data_load page process (it reads XML).';
  end if;

  if v_format = 'json' or (v_format = 'auto' and (p_file_name ~* '\.(json|jsonl|ndjson)$' or v_head ~ '^\s*[\[{]')) then
    begin
      v_json := btrim(v_text, E' \t\r\n')::json;
    exception when others then
      -- JSON Lines: one value per line
      begin
        select json_agg(l::json order by o) into v_json
          from regexp_split_to_table(btrim(v_text, E' \t\r\n'), '\r?\n') with ordinality s(l, o) where btrim(l, E' \t\r') <> '';
      exception when others then
        raise exception 'meta.parse_data: this is not valid JSON (%)', sqlerrm;
      end;
    end;
    if nullif(p_row_selector, '') is not null then
      -- a path to the array of records: "data" or "result.items"
      foreach v_part in array string_to_array(p_row_selector, '.') loop
        v_json := case when v_part ~ '^[0-9]+$' and json_typeof(v_json) = 'array' then v_json -> v_part::int else v_json -> v_part end;
      end loop;
      if v_json is null then
        raise exception 'meta.parse_data: the row selector % finds nothing', p_row_selector;
      end if;
    end if;
    if json_typeof(v_json) = 'object' then
      -- an object with one array of records ({"employees": [...]}), else one record
      select array_agg(value) into v_arrays from json_each(v_json) where json_typeof(value) = 'array';
      v_json := case when cardinality(v_arrays) = 1 then v_arrays[1] else json_build_array(v_json) end;
    end if;
    if json_typeof(v_json) is distinct from 'array' or json_array_length(v_json) = 0 then
      raise exception 'meta.parse_data: the JSON holds no records (expected an array of objects)';
    end if;
    v_count := json_array_length(v_json);
    if v_count > v_max then
      raise exception 'meta.parse_data: the file has % rows; at most % can be parsed at once', v_count, v_max;
    end if;
    if exists (select 1 from json_array_elements(v_json) e where json_typeof(e) <> 'object') then
      raise exception 'meta.parse_data: every JSON record must be an object ({"column": value, …})';
    end if;
    -- the keys in the order they first appear
    select array_agg(key order by ro, ko) into v_keys
      from (select k.key, r.o as ro, k.o as ko, row_number() over (partition by k.key order by r.o, k.o) as rn
              from json_array_elements(v_json) with ordinality r(v, o), json_each(r.v) with ordinality k(key, value, o)) x
     where rn = 1;
    line_number := 0;
    cols := coalesce(v_keys, '{}');
    return next;
    return query
      select r.o::int, array(select nullif(r.v ->> h.k, '') from unnest(coalesce(v_keys, '{}')) with ordinality h(k, i) order by h.i)
        from json_array_elements(v_json) with ordinality r(v, o)
       order by r.o;
    return;
  end if;

  -- CSV / TSV: RFC 4180 (quoted fields with "" escapes and line breaks, CRLF or LF)
  v_d := coalesce(p_delimiter, case when v_format = 'tsv' or p_file_name ~* '\.tsv$' then E'\t' end);
  if v_d is null then
    -- the delimiter that splits the first line into the most fields (outside quotes)
    declare
      q boolean := false;
      n_comma int := 0; n_semi int := 0; n_tab int := 0; n_bar int := 0;
      ch text;
    begin
      foreach ch in array regexp_split_to_array(left(v_text, 10000), '') loop
        if ch = '"' then q := not q;
        elsif not q and ch in (E'\n', E'\r') then exit;
        elsif not q and ch = ',' then n_comma := n_comma + 1;
        elsif not q and ch = ';' then n_semi := n_semi + 1;
        elsif not q and ch = E'\t' then n_tab := n_tab + 1;
        elsif not q and ch = '|' then n_bar := n_bar + 1;
        end if;
      end loop;
      v_d := ',';
      if n_semi > n_comma then v_d := ';'; end if;
      if n_tab > greatest(n_comma, n_semi) then v_d := E'\t'; end if;
      if n_bar > greatest(n_comma, n_semi, n_tab) then v_d := '|'; end if;
    end;
  end if;
  if length(v_d) <> 1 or v_d in ('"', E'\r', E'\n') then
    raise exception 'meta.parse_data: the delimiter is one character (not a quote or a line break)';
  end if;
  v_re := case when v_d = E'\t' then '\t' when v_d ~ '[A-Za-z0-9]' then v_d else '\' || v_d end;
  v_re := '(?:"([^"]*(?:""[^"]*)*)"|([^' || v_re || '\r\n]*))(' || v_re || '|\r\n|\n|\r|$)';
  return query
    with m as (
      select x.m, x.o from regexp_matches(v_text, v_re, 'g') with ordinality x(m, o)
    ), f as (
      select o, case when m[1] is not null then replace(m[1], '""', '"') else m[2] end as v,
             coalesce(sum(case when m[3] = v_d then 0 else 1 end)
                        over (order by o rows between unbounded preceding and 1 preceding), 0) as r
        from m
    ), rows_ as (
      select r, array_agg(case when v ~ '^\s*$' then null else v end order by o) as c from f group by r
    ), kept as (
      -- completely empty lines are skipped
      select r, c, row_number() over (order by r) as n from rows_ where exists (select 1 from unnest(c) x where x is not null)
    )
    select (k.n - v_skip - case when p_headers then 1 else 0 end)::int, k.c
      from kept k where k.n > v_skip order by k.r;
  get diagnostics v_count = row_count;
  v_count := v_count - (case when p_headers then 1 else 0 end);
  if v_count > v_max then
    raise exception 'meta.parse_data: the file has % rows; at most % can be parsed at once', v_count, v_max;
  end if;
end
$$;

-- APEX_DATA_PARSER.parse: the data rows of a CSV/TSV or JSON file in a
-- bytea. `cols` holds the values by position, `data` by column name (as
-- meta.parse_data_columns names them), so
--   select d.* from meta.parse_data(:file) p, jsonb_populate_record(null::app.emp, p.data) d
-- reads them into a table's row type. Values are text; blank values are null.
create function meta.parse_data(
  p_content      bytea,
  p_file_name    text    default null,
  p_format       text    default 'auto',
  p_headers      boolean default true,
  p_delimiter    text    default null,
  p_row_selector text    default null,
  p_skip_rows    int     default 0,
  p_max_rows     int     default 100000
) returns table (line_number int, cols text[], data jsonb)
language sql stable set search_path = meta, pg_catalog as $$
  with raw as materialized (
    select * from meta.parse_data_rows(p_content, p_file_name, p_format, p_headers, p_delimiter, p_row_selector, p_skip_rows, p_max_rows)
  ), w as (
    select coalesce(max(cardinality(cols)), 0) as n from raw
  ), names as (
    select meta.parse_data_names((select cols from raw where raw.line_number = 0), w.n) as names, w.n from w
  )
  select r.line_number, p.c, jsonb_object(names.names, p.c)
    from raw r cross join names
    cross join lateral (select array(select r.cols[i] from generate_series(1, names.n) i) as c) p
   where r.line_number > 0
   order by r.line_number
$$;

-- APEX_DATA_PARSER.get_columns: the columns of the file: position, the
-- column name (a SQL name, the key in parse_data's `data`), the heading as
-- written, and the inferred type (integer, bigint, numeric, boolean, date,
-- timestamp or text).
create function meta.parse_data_columns(
  p_content      bytea,
  p_file_name    text    default null,
  p_format       text    default 'auto',
  p_headers      boolean default true,
  p_delimiter    text    default null,
  p_row_selector text    default null,
  p_skip_rows    int     default 0,
  p_max_rows     int     default 100000
) returns table (column_position int, column_name text, heading text, data_type text)
language sql stable set search_path = meta, pg_catalog as $$
  with raw as materialized (
    select * from meta.parse_data_rows(p_content, p_file_name, p_format, p_headers, p_delimiter, p_row_selector, p_skip_rows, p_max_rows)
  ), w as (
    select coalesce(max(cardinality(cols)), 0) as n from raw
  ), h as (
    select (select cols from raw where raw.line_number = 0) as headings, w.n from w
  )
  select i, (meta.parse_data_names(h.headings, h.n))[i], coalesce(nullif(btrim(h.headings[i]), ''), 'column_' || i),
         meta.parse_data_type(array(select raw.cols[i] from raw where raw.line_number > 0))
    from h cross join generate_series(1, h.n) i
   order by i
$$;

grant execute on function meta.parse_data_name(text), meta.parse_data_names(text[], int), meta.parse_data_type(text[]),
  meta.parse_data_rows(bytea, text, text, boolean, text, text, int, int),
  meta.parse_data(bytea, text, text, boolean, text, text, int, int),
  meta.parse_data_columns(bytea, text, text, boolean, text, text, int, int) to public;
