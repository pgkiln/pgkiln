-- =====================================================================
-- 160: meta.web_request as an outbox (sprint 177)
--
-- A request queued from SQL (052) was made once, and its outcome had to be
-- polled with meta.web_response. New:
--
--   retries     a request the server delivers after the commit is tried up
--               to max_attempts times (default 5): a network error, a 5xx
--               or a 429 answer waits (exponential backoff, a Retry-After
--               header honoured, both capped) in status 'retry' and ends in
--               'gave_up'. Other answers end in 'ok' with their status code
--               as before; a request that can't be made (the allow-list,
--               a missing credential) ends in 'error' and is never retried.
--               A request a page process queues is still made at once, in
--               its transaction; it is retried afterwards only when the
--               caller gave p_max_attempts.
--   callback    p_callback => 'sales.order_sent': a function (bigint) the
--               server calls with the request's id when the request reaches
--               a final status, as the application's database role, in a
--               transaction of its own. A callback that raises is called
--               again (3 times at most); the request is never sent again.
--   NOTIFY      queueing notifies pgkiln_web_request: the server delivers
--               at once (the scheduler pass stays as the fallback).
--   leases      a request in flight holds a lease; a server that stopped
--               loses it and another one makes the next attempt.
--   ordering    p_ordering_key: requests of one application with the same
--               key are delivered one at a time in the order queued; one
--               that waits for a retry holds the later ones back.
--   idempotency every attempt of a request carries the same key in a header
--               (Idempotency-Key by default): the caller's own key, or a
--               generated one for POST, PUT, PATCH and DELETE.
--
-- The rows stay installation data (never exported).
-- =====================================================================

alter table meta.web_request_log
  drop constraint web_request_log_status_check,
  add constraint web_request_log_status_check check (status in ('queued', 'running', 'retry', 'ok', 'error', 'gave_up', 'cancelled')),
  add column attempts             int not null default 0,
  add column max_attempts         int check (max_attempts between 1 and 20),
  add column next_attempt_at      timestamptz,
  add column lease_until          timestamptz,
  add column worker               text,
  add column ordering_key         text,
  add column idempotency_key      text,
  add column idempotency_header   text,
  add column tenant_id            text,
  add column callback             text,
  add column callback_state       text check (callback_state in ('pending', 'running', 'done', 'failed')),
  add column callback_attempts    int not null default 0,
  add column callback_next_at     timestamptz,
  add column callback_lease_until timestamptz,
  add column callback_error       text;

-- requests in flight when the server was upgraded: their lease ends now
update meta.web_request_log set attempts = 1 where status in ('running', 'ok', 'error');
update meta.web_request_log set lease_until = now() where status = 'running';

create index web_request_log_due on meta.web_request_log (next_attempt_at, id) where status in ('queued', 'retry');
create index web_request_log_ordering on meta.web_request_log (app_id, ordering_key, id) where ordering_key is not null and status in ('queued', 'running', 'retry');
create index web_request_log_callback on meta.web_request_log (callback_next_at) where callback_state in ('pending', 'running');

comment on table meta.web_request_log is
  'web requests queued from SQL (meta.web_request) and their responses, made by the pgkiln server (160: with retries, callbacks, ordering); finished ones are kept 24 hours, given-up ones 7 days';
comment on column meta.web_request_log.status is 'queued · running · retry (waits for its next attempt) · ok (answered; see status_code) · error (could not be made, not retried) · gave_up (every attempt failed) · cancelled';
comment on column meta.web_request_log.max_attempts is 'null: 5 when the server delivers it after the commit, 1 when a page process makes it in its transaction';
comment on column meta.web_request_log.callback is 'schema.function called with the request''s id when it reaches a final status, as the application''s role';

-- The callback of a request: schema.function, a function of one bigint argument that the application's database
-- role may execute. Found in the catalog by its two names (the text is never parsed or run here).
create function meta.web_request_callback(p_app int, p_callback text) returns text
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_name text := lower(btrim(p_callback));
  v_role text;
  v_oid  oid;
begin
  if p_callback is null or btrim(p_callback) = '' then
    return null;
  end if;
  if v_name !~ '^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$' then
    raise exception 'meta.web_request: the callback is schema.function (lower-case names of letters, digits and _), e.g. sales.order_sent';
  end if;
  if split_part(v_name, '.', 1) in ('meta', 'pg_catalog', 'information_schema') or split_part(v_name, '.', 1) like 'pg\_%' then
    raise exception 'meta.web_request: the callback is a function of the application, not of %', split_part(v_name, '.', 1);
  end if;
  select coalesce(a.db_role, session_user::text) into v_role from meta.app a where a.id = p_app;
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = split_part(v_name, '.', 1) and p.proname = split_part(v_name, '.', 2)
     and p.prokind = 'f' and p.pronargs = 1 and p.proargtypes[0] = 'bigint'::regtype;
  if v_oid is null or v_role is null or not exists (select 1 from pg_roles where rolname = v_role)
     or not has_schema_privilege(v_role, split_part(v_name, '.', 1), 'usage') or not has_function_privilege(v_role, v_oid, 'execute') then
    raise exception 'meta.web_request: the callback %(bigint) does not exist, or the application''s database role may not execute it', v_name;
  end if;
  return v_name;
end
$$;
revoke execute on function meta.web_request_callback(int, text) from public;

-- The outbox options shared by the two ways to queue a request; the checked values come back.
create function meta.web_request_options(
  p_app int, p_method text, p_max_attempts int, p_callback text, p_ordering_key text, p_idempotency_key text, p_idempotency_header text,
  out max_attempts int, out callback text, out ordering_key text, out idempotency_key text, out idempotency_header text)
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
begin
  if p_max_attempts is not null and p_max_attempts not between 1 and 20 then
    raise exception 'meta.web_request: the number of attempts is 1 to 20';
  end if;
  max_attempts := p_max_attempts;
  callback := meta.web_request_callback(p_app, p_callback);
  ordering_key := nullif(p_ordering_key, '');
  if length(ordering_key) > 200 then
    raise exception 'meta.web_request: the ordering key is at most 200 characters';
  end if;
  if ordering_key is not null then
    -- transactions that queue for the same key commit one after the other, so the ids are in the order of the commits
    perform pg_advisory_xact_lock(hashtextextended('pgkiln.web_request:' || p_app || ':' || ordering_key, 0));
  end if;
  idempotency_header := nullif(btrim(p_idempotency_header), '');
  idempotency_key := nullif(p_idempotency_key, '');
  if idempotency_header is not null then
    if idempotency_header !~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,100}$'
       or lower(idempotency_header) in ('host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-connection', 'expect',
                                        'authorization', 'cookie', 'content-type') then
      raise exception 'meta.web_request: "%" can''t be the header of the idempotency key', left(idempotency_header, 100);
    end if;
    if idempotency_key is not null and idempotency_key !~ '^[\x21-\x7e][\x20-\x7e]{0,254}$' then
      raise exception 'meta.web_request: the idempotency key is 1 to 255 printable ASCII characters';
    end if;
    if idempotency_key is null and p_method in ('POST', 'PUT', 'PATCH', 'DELETE') then
      idempotency_key := gen_random_uuid()::text;
    end if;
  end if;
  if idempotency_key is null then
    idempotency_header := null;
  end if;
end
$$;
revoke execute on function meta.web_request_options(int, text, int, text, text, text, text) from public;

-- Queue a request to a URL; returns its id (see meta.web_response). The first six parameters are those of 052.
drop function meta.web_request(text, text, text, jsonb, text, int);
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
  p_idempotency_header text default 'Idempotency-Key'
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app    int := meta.web_request_check();
  v_method text := upper(coalesce(p_method, 'GET'));
  v_key    text;
  v_value  jsonb;
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
  o := meta.web_request_options(v_app, v_method, p_max_attempts, p_callback, p_ordering_key, p_idempotency_key, p_idempotency_header);
  insert into meta.web_request_log (app_id, url, method, headers, body, credential, timeout_s, requested_by, tenant_id,
                                    max_attempts, callback, ordering_key, idempotency_key, idempotency_header)
  values (v_app, p_url, v_method, coalesce(p_headers, '{}'), p_body, upper(p_credential), coalesce(p_timeout_s, 10), meta.app_user(), meta.tenant_id(),
          o.max_attempts, o.callback, o.ordering_key, o.idempotency_key, o.idempotency_header)
  returning id into v_id;
  -- a page process's requests run right after it (src/webrequests.ts); the others when this transaction commits
  perform set_config('pgkiln.web_pending', '1', true);
  perform pg_notify('pgkiln_web_request', '');
  return v_id;
end
$$;

-- Queue a call of a REST data source of the app (its URL, method, headers, credential; parameter values as text,
-- missing ones take their default). No idempotency header: the source defines its headers.
drop function meta.web_request_source(text, jsonb, int);
create function meta.web_request_source(
  p_source text, p_params jsonb default null, p_timeout_s int default null,
  p_max_attempts int default null, p_callback text default null, p_ordering_key text default null
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.web_request_check();
  v_id  bigint;
  v_timeout int;
  o     record;
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
  o := meta.web_request_options(v_app, 'GET', p_max_attempts, p_callback, p_ordering_key, null, null);
  insert into meta.web_request_log (app_id, source, params, timeout_s, requested_by, tenant_id, max_attempts, callback, ordering_key)
  values (v_app, upper(p_source), coalesce(p_params, '{}'), coalesce(p_timeout_s, least(greatest(v_timeout, 1), 60), 10), meta.app_user(), meta.tenant_id(),
          o.max_attempts, o.callback, o.ordering_key)
  returning id into v_id;
  perform set_config('pgkiln.web_pending', '1', true);
  perform pg_notify('pgkiln_web_request', '');
  return v_id;
end
$$;

-- A request of the current application: as in 052, and (160) "attempts", "max_attempts", "next_attempt_at",
-- "ordering_key", "idempotency_key", "callback", "callback_state" (pending, running, done, failed) and
-- "callback_error". Status: queued, running, retry, ok, error, gave_up, cancelled.
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
    'callback', r.callback, 'callback_state', r.callback_state, 'callback_error', r.callback_error);
end
$$;

-- Cancel a request of the current application that still waits (queued, or between two attempts). True when it did.
create function meta.web_request_cancel(p_id bigint) returns boolean
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
begin
  update meta.web_request_log
     set status = 'cancelled', finished_at = now(), next_attempt_at = null, message = coalesce(message, 'Cancelled.')
   where id = p_id and app_id = meta.app_id() and status in ('queued', 'retry');
  return found;
end
$$;

-- For the server (src/webrequests.ts), on the application's connection: the requests this transaction queued,
-- marked running (at most p_limit). Requests with a callback or an ordering key are the outbox's: they wait for
-- the commit.
drop function meta.web_request_take(int);
create function meta.web_request_take(p_limit int default 5)
returns table (id bigint, source text, params jsonb, url text, method text, headers jsonb, body text, credential text, timeout_s int,
               attempts int, max_attempts int, idempotency_key text, idempotency_header text)
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
              l.attempts, l.max_attempts, l.idempotency_key, l.idempotency_header;
  -- more than the limit: the rest stay queued for the server
end
$$;

-- For the server: the result of a request taken with meta.web_request_take(). p_status 'retry' with p_next_s:
-- the server makes the next attempt after the commit.
drop function meta.web_request_done(bigint, text, int, text, jsonb, bytea, text);
create function meta.web_request_done(p_id bigint, p_status text, p_status_code int, p_url text, p_headers jsonb, p_body bytea, p_message text, p_next_s int default null) returns void
language sql volatile security definer set search_path = meta, pg_catalog as $$
  update meta.web_request_log
     set status = case when p_status in ('ok', 'retry', 'gave_up') then p_status else 'error' end,
         finished_at = case when p_status = 'retry' then null else now() end,
         next_attempt_at = case when p_status = 'retry' then now() + make_interval(secs => least(greatest(coalesce(p_next_s, 30), 1), 86400)) end,
         status_code = p_status_code, response_url = p_url, response_headers = p_headers, response_body = p_body, message = left(p_message, 2000)
   where id = p_id and status = 'running' and requested_xact = pg_current_xact_id() and app_id = meta.app_id()
$$;

grant execute on function meta.web_request(text, text, text, jsonb, text, int, int, text, text, text, text),
  meta.web_request_source(text, jsonb, int, int, text, text), meta.web_request_cancel(bigint),
  meta.web_request_take(int), meta.web_request_done(bigint, text, int, text, jsonb, bytea, text, int) to public;
