-- =====================================================================
-- 200: binary request bodies for meta.web_request (sprint 243, MG-17)
--
-- meta.web_request took a text body of at most 1 MB, so a file could not be
-- sent to a file API (OneDrive, SharePoint, an object store, a scanner
-- service). New:
--
--   p_body_blob    a bytea body, for POST, PUT and PATCH (instead of p_body).
--                  Its Content-Type is the one in p_headers (default
--                  application/octet-stream). The server sends it through
--                  the same code as a text body: the host allow-list, the
--                  address checks at connect time, the workspace's network
--                  access list and the web credential's "valid for" URLs.
--                  Its size limit is the server's PGKILN_REST_MAX_UPLOAD_BYTES
--                  (default 25 MB), checked when the request is made (a
--                  larger one ends in 'error', never retried); SQL refuses
--                  anything over 256 MB at once. Retries send the same bytes:
--                  the blob stays in the row until the request succeeded
--                  ('ok'), so a given-up request can still be queued again.
--   p_chunk_bytes  PUT the blob in consecutive ranges of this many bytes
--                  (Content-Range: bytes a-b/total), as an upload session of
--                  Microsoft Graph or another resumable upload URL expects;
--                  a 202 answer's nextExpectedRanges is followed.
--   meta.web_request_source(..., p_body_blob, p_content_type): a REST data
--                  source's URL, method (POST, PUT or PATCH), headers and
--                  credential with a binary body.
--
-- meta.web_request_log gets body_blob, body_blob_bytes (the size, kept when
-- the blob is cleared) and chunk_bytes. The rows stay installation data
-- (never exported).
-- =====================================================================

alter table meta.web_request_log
  add column body_blob       bytea,
  add column body_blob_bytes bigint,
  add column chunk_bytes     int check (chunk_bytes between 65536 and 62914560),
  add constraint web_request_log_one_body check (body is null or body_blob is null),
  add constraint web_request_log_chunk_blob check (chunk_bytes is null or body_blob_bytes is not null);

comment on column meta.web_request_log.body_blob is 'a binary body (200): sent instead of body; cleared once the request succeeded (body_blob_bytes keeps its size)';
comment on column meta.web_request_log.chunk_bytes is 'PUT the blob in ranges of this many bytes (Content-Range), as an upload session expects (200)';

-- Headers of a request: a JSON object of at most 30 strings, no header the server sets itself.
create function meta.web_request_headers_check(p_headers jsonb) returns void
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  v_key   text;
  v_value jsonb;
begin
  if p_headers is null then
    return;
  end if;
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
end
$$;
revoke execute on function meta.web_request_headers_check(jsonb) from public;

-- The checks of a binary body shared by the two ways to queue a request.
create function meta.web_request_blob_check(p_method text, p_body_blob bytea, p_chunk_bytes int) returns void
language plpgsql immutable set search_path = meta, pg_catalog as $$
begin
  if p_body_blob is null then
    if p_chunk_bytes is not null then
      raise exception 'meta.web_request: p_chunk_bytes sends p_body_blob in ranges; give p_body_blob';
    end if;
    return;
  end if;
  if p_method not in ('POST', 'PUT', 'PATCH') then
    raise exception 'meta.web_request: a binary body (p_body_blob) is sent with POST, PUT or PATCH, not %', p_method;
  end if;
  -- the server's own limit (PGKILN_REST_MAX_UPLOAD_BYTES, default 25 MB) is checked when the request is made
  if octet_length(p_body_blob) > 268435456 then
    raise exception 'meta.web_request: the binary body is larger than 256 MB';
  end if;
  if p_chunk_bytes is not null then
    if p_method <> 'PUT' then
      raise exception 'meta.web_request: a body in ranges (p_chunk_bytes) is sent with PUT';
    end if;
    if p_chunk_bytes not between 65536 and 62914560 then
      raise exception 'meta.web_request: p_chunk_bytes is 65536 (64 KiB) to 62914560 (60 MiB); Microsoft Graph wants a multiple of 327680 (320 KiB)';
    end if;
  end if;
end
$$;
revoke execute on function meta.web_request_blob_check(text, bytea, int) from public;

-- Queue a request to a URL; returns its id (see meta.web_response). The first eleven parameters are those of 160.
drop function meta.web_request(text, text, text, jsonb, text, int, int, text, text, text, text);
create function meta.web_request(
  p_url        text,
  p_method     text  default 'GET',
  p_body       text  default null,
  p_headers    jsonb default null,
  p_credential text  default null,
  p_timeout_s  int   default 10,
  p_max_attempts       int  default null,
  p_callback           text default null,
  p_ordering_key       text default null,
  p_idempotency_key    text default null,
  p_idempotency_header text default 'Idempotency-Key',
  p_body_blob          bytea default null,
  p_chunk_bytes        int  default null
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app    int := meta.web_request_check();
  v_method text := upper(coalesce(p_method, 'GET'));
  v_id     bigint;
  o        record;
begin
  if p_url is null or length(p_url) > 4000 or p_url !~* '^https?://[^/?#@\s\\]+([/?#]|$)' or p_url ~ '[\s\x01-\x1f]' then
    raise exception 'meta.web_request: the URL must start with http:// or https:// and a host (at most 4000 characters, no spaces)';
  end if;
  if v_method not in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE') then
    raise exception 'meta.web_request: the method is one of GET, HEAD, POST, PUT, PATCH, DELETE';
  end if;
  if octet_length(p_body) > 1000000 then
    raise exception 'meta.web_request: the body is larger than 1 MB (send a file as p_body_blob)';
  end if;
  if p_body is not null and p_body_blob is not null then
    raise exception 'meta.web_request: give p_body (text) or p_body_blob (bytea), not both';
  end if;
  perform meta.web_request_blob_check(v_method, p_body_blob, p_chunk_bytes);
  perform meta.web_request_headers_check(p_headers);
  if p_credential is not null and not exists (select 1 from meta.web_credential where app_id = v_app and name = upper(p_credential)) then
    raise exception 'meta.web_request: web credential % does not exist in this application', upper(p_credential);
  end if;
  if coalesce(p_timeout_s, 10) not between 1 and 60 then
    raise exception 'meta.web_request: the time limit is 1 to 60 seconds';
  end if;
  o := meta.web_request_options(v_app, v_method, p_max_attempts, p_callback, p_ordering_key, p_idempotency_key, p_idempotency_header);
  insert into meta.web_request_log (app_id, url, method, headers, body, credential, timeout_s, requested_by, tenant_id,
                                    max_attempts, callback, ordering_key, idempotency_key, idempotency_header,
                                    body_blob, body_blob_bytes, chunk_bytes)
  values (v_app, p_url, v_method, coalesce(p_headers, '{}'), p_body, upper(p_credential), coalesce(p_timeout_s, 10), meta.app_user(), meta.tenant_id(),
          o.max_attempts, o.callback, o.ordering_key, o.idempotency_key, o.idempotency_header,
          p_body_blob, octet_length(p_body_blob), p_chunk_bytes)
  returning id into v_id;
  -- a page process's requests run right after it (src/webrequests.ts); the others when this transaction commits
  perform set_config('pgkiln.web_pending', '1', true);
  perform pg_notify('pgkiln_web_request', '');
  return v_id;
end
$$;

-- Queue a call of a REST data source of the app; (200) with a binary body: p_body_blob, its Content-Type
-- p_content_type (default: the source's own Content-Type header, else application/octet-stream).
drop function meta.web_request_source(text, jsonb, int, int, text, text);
create function meta.web_request_source(
  p_source text, p_params jsonb default null, p_timeout_s int default null,
  p_max_attempts int default null, p_callback text default null, p_ordering_key text default null,
  p_body_blob bytea default null, p_content_type text default null
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.web_request_check();
  v_id  bigint;
  v_timeout int;
  v_method text;
  o     record;
begin
  select timeout_s, upper(method) into v_timeout, v_method from meta.rest_source where app_id = v_app and name = upper(p_source);
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
  if p_content_type is not null and (p_body_blob is null or length(p_content_type) > 200 or p_content_type !~ '^[\x21-\x7e][\x20-\x7e]*$') then
    raise exception 'meta.web_request_source: p_content_type is the media type of p_body_blob (printable, at most 200 characters)';
  end if;
  perform meta.web_request_blob_check(coalesce(v_method, 'GET'), p_body_blob, null);
  o := meta.web_request_options(v_app, 'GET', p_max_attempts, p_callback, p_ordering_key, null, null);
  insert into meta.web_request_log (app_id, source, params, timeout_s, requested_by, tenant_id, max_attempts, callback, ordering_key,
                                    headers, body_blob, body_blob_bytes)
  values (v_app, upper(p_source), coalesce(p_params, '{}'), coalesce(p_timeout_s, least(greatest(v_timeout, 1), 60), 10), meta.app_user(), meta.tenant_id(),
          o.max_attempts, o.callback, o.ordering_key,
          case when p_content_type is not null then jsonb_build_object('content-type', p_content_type) else '{}' end,
          p_body_blob, octet_length(p_body_blob))
  returning id into v_id;
  perform set_config('pgkiln.web_pending', '1', true);
  perform pg_notify('pgkiln_web_request', '');
  return v_id;
end
$$;

-- For the server: (200) also the binary body and its ranges.
drop function meta.web_request_take(int);
create function meta.web_request_take(p_limit int default 5)
returns table (id bigint, source text, params jsonb, url text, method text, headers jsonb, body text, credential text, timeout_s int,
               attempts int, max_attempts int, idempotency_key text, idempotency_header text,
               body_blob bytea, body_blob_bytes bigint, chunk_bytes int)
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
begin
  if coalesce(current_setting('pgkiln.web_pending', true), '') <> '1' then
    return;
  end if;
  perform set_config('pgkiln.web_pending', '', true);
  return query
    update meta.web_request_log l set status = 'running', started_at = now(), attempts = 1
     where l.id in (select x.id from meta.web_request_log x
                     where x.status = 'queued' and x.requested_xact = pg_current_xact_id() and x.app_id = meta.app_id()
                       and x.callback is null and x.ordering_key is null
                     order by x.id limit least(greatest(p_limit, 0), 20))
    returning l.id, l.source, l.params, l.url, l.method, l.headers, l.body, l.credential, l.timeout_s,
              l.attempts, l.max_attempts, l.idempotency_key, l.idempotency_header,
              l.body_blob, l.body_blob_bytes, l.chunk_bytes;
end
$$;

-- For the server: the result of a request taken with meta.web_request_take(); (200) a request that succeeded
-- lets go of its binary body.
create or replace function meta.web_request_done(p_id bigint, p_status text, p_status_code int, p_url text, p_headers jsonb, p_body bytea, p_message text, p_next_s int default null) returns void
language sql volatile security definer set search_path = meta, pg_catalog as $$
  update meta.web_request_log
     set status = case when p_status in ('ok', 'retry', 'gave_up') then p_status else 'error' end,
         finished_at = case when p_status = 'retry' then null else now() end,
         next_attempt_at = case when p_status = 'retry' then now() + make_interval(secs => least(greatest(coalesce(p_next_s, 30), 1), 86400)) end,
         status_code = p_status_code, response_url = p_url, response_headers = p_headers, response_body = p_body, message = left(p_message, 2000),
         body_blob = case when p_status = 'ok' then null else body_blob end
   where id = p_id and status = 'running' and requested_xact = pg_current_xact_id() and app_id = meta.app_id()
$$;

-- A request of the current application: as in 160, and (200) "body_blob_bytes" (the size of its binary body) and
-- "chunk_bytes".
create or replace function meta.web_response(p_id bigint) returns jsonb
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
    'requested_at', r.requested_at, 'started_at', r.started_at, 'finished_at', r.finished_at)
    || jsonb_build_object(
    'attempts', r.attempts, 'max_attempts', r.max_attempts, 'next_attempt_at', r.next_attempt_at,
    'ordering_key', r.ordering_key, 'idempotency_key', r.idempotency_key,
    'callback', r.callback, 'callback_state', r.callback_state, 'callback_error', r.callback_error)
    || jsonb_build_object('body_blob_bytes', r.body_blob_bytes, 'chunk_bytes', r.chunk_bytes);
end
$$;

grant execute on function
  meta.web_request(text, text, text, jsonb, text, int, int, text, text, text, text, bytea, int),
  meta.web_request_source(text, jsonb, int, int, text, text, bytea, text),
  meta.web_request_take(int) to public;
