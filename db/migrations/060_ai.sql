-- =====================================================================
-- 060: AI services, "Generate text with AI" (process and dynamic action),
--      usage log and AI requests from SQL
--
-- meta.ai_service: an instance-level connection to a large language model
--   provider (APEX: Workspace → Generative AI services). Provider
--   "anthropic" (Claude) or "openai", a model, an optional API key (stored
--   encrypted by the server with PGKILN_SECRET_KEY, write-only, never
--   exported; without one the server's ANTHROPIC_API_KEY / OPENAI_API_KEY
--   is used), an optional base URL (set by administrators only), output
--   limits and a time limit. Only the owner reads it: the server loads
--   services through the owner pool, so application code can't see keys.
--
-- meta.app_ai_service: which services an application may use, with
--   optional limits per day (requests, input + output tokens). An app
--   without a row can't use a service. Installation data: not exported.
--
-- meta.ai_usage: one row per call (app, page, user, service, model, tokens,
--   duration, status). Never the prompt or the response.
--
-- meta.ai_request: AI requests queued from SQL with meta.ai_generate(...)
--   (like meta.web_request, migration 052): made by the server right after
--   the page process (type sql) that queued them, or by the scheduler for
--   committed ones; meta.ai_result(id) returns the answer. Kept 24 hours.
--   meta.ai_available(service) tells application code whether it may use
--   a service.
--
-- Process type "ai_generate" and dynamic action "ai_generate" (the latter
-- runs a page process of that type through AJAX: its name is in "code").
-- =====================================================================

create table meta.ai_service (
  id          serial primary key,
  name        text not null unique check (name ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  description text,
  provider    text not null check (provider in ('anthropic', 'openai')),
  model       text not null check (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$'),
  -- Claude: how much effort (thinking depth); null = the model's default
  effort      text check (effort in ('low', 'medium', 'high', 'xhigh', 'max')),
  -- Claude: re-run a declined request on Anthropic's recommended fallback model (server side)
  refusal_fallback boolean not null default true,
  max_tokens  int  not null default 4000 check (max_tokens between 1 and 128000),
  timeout_s   int  not null default 120 check (timeout_s between 5 and 600),
  -- e.g. a proxy or gateway; administrators only (the builder checks)
  base_url    text check (base_url ~ '^https?://[^\s]+$' and length(base_url) <= 500),
  -- "v1:" + base64(iv, tag, ciphertext); written by the server only (src/secrets.ts)
  api_key_enc text,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
revoke all on meta.ai_service from public;
comment on table meta.ai_service is 'AI services (Claude, OpenAI) of this installation; the API key is encrypted and never readable by applications';

create table meta.app_ai_service (
  app_id       int not null references meta.app on delete cascade,
  service_id   int not null references meta.ai_service on delete cascade,
  -- per day (UTC); null = no limit
  max_requests int check (max_requests >= 0),
  max_tokens   bigint check (max_tokens >= 0),
  primary key (app_id, service_id)
);
revoke all on meta.app_ai_service from public;

create table meta.ai_usage (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  app_id        int references meta.app on delete cascade,
  page_no       int,
  username      text,
  service_id    int references meta.ai_service on delete set null,
  service       text not null,
  provider      text not null,
  model         text not null,
  -- process, dynamic_action, sql, builder (a test from the builder)
  source        text not null,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  duration_ms   int not null default 0,
  status        text not null check (status in ('ok', 'refused', 'error', 'limited')),
  -- an error class or a short reason; never prompt or response text
  message       text
);
create index on meta.ai_usage (app_id, service_id, at);
create index on meta.ai_usage (at);
revoke all on meta.ai_usage from public;

-- ---------------------------------------------------------------- process type and dynamic action

do $$
declare
  v_types text[];
begin
  select string_to_array((regexp_match(pg_get_constraintdef(k.oid), '\{([a-z_,]+)\}'))[1], ',') into v_types
    from pg_constraint k
   where k.conrelid = 'meta.process'::regclass and k.conname = 'process_type_check';
  if v_types is null then
    raise exception 'Unexpected process_type_check constraint.';
  end if;
  alter table meta.process drop constraint process_type_check;
  execute format('alter table meta.process add constraint process_type_check check (type = any (%L::text[]))',
                 array(select distinct unnest(v_types || array['ai_generate']) order by 1));
end
$$;

alter table meta.dynamic_action drop constraint dynamic_action_action_check;
alter table meta.dynamic_action add constraint dynamic_action_action_check
  check (action in ('show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit',
                    'set_focus', 'add_class', 'remove_class', 'show_success', 'show_error', 'clear_errors', 'ai_generate'));

-- ---------------------------------------------------------------- AI requests from SQL

create table meta.ai_request (
  id             bigserial primary key,
  app_id         int  not null references meta.app on delete cascade,
  status         text not null default 'queued' check (status in ('queued', 'running', 'ok', 'refused', 'error')),
  service        text not null,
  system_prompt  text,
  prompt         text not null,
  -- structured output: a JSON schema (object); the answer is then JSON
  schema         jsonb,
  requested_by   text,
  requested_xact xid8 not null default pg_current_xact_id(),
  requested_at   timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  response       text,
  message        text
);
create index on meta.ai_request (app_id, id desc);
create index on meta.ai_request (id) where status = 'queued';
create index on meta.ai_request (finished_at);
revoke all on meta.ai_request from public;
comment on table meta.ai_request is 'AI requests queued from SQL (meta.ai_generate) and their answers, made by the pgkiln server; kept 24 hours';

-- Queue a request to an AI service the current application may use; returns its id (see meta.ai_result).
create function meta.ai_generate(p_service text, p_prompt text, p_system text default null, p_schema jsonb default null) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.app_id();
  v_id  bigint;
begin
  if v_app is null then
    raise exception 'meta.ai_generate: no current application (call it from application code)';
  end if;
  if not exists (select 1 from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = v_app
                  where s.name = upper(p_service) and s.enabled) then
    raise exception 'meta.ai_generate: AI service % does not exist or this application may not use it', upper(p_service);
  end if;
  if p_prompt is null or length(p_prompt) = 0 or length(p_prompt) > 200000 or length(coalesce(p_system, '')) > 50000 then
    raise exception 'meta.ai_generate: the prompt is 1 to 200000 characters, the system prompt at most 50000';
  end if;
  if p_schema is not null and (jsonb_typeof(p_schema) <> 'object' or p_schema ->> 'type' is distinct from 'object' or octet_length(p_schema::text) > 50000) then
    raise exception 'meta.ai_generate: the schema is a JSON schema of an object ({"type": "object", "properties": {…}})';
  end if;
  if (select count(*) from meta.ai_request where app_id = v_app and status = 'queued') >= 20 then
    raise exception 'meta.ai_generate: this application has 20 AI requests waiting already';
  end if;
  insert into meta.ai_request (app_id, service, system_prompt, prompt, schema, requested_by)
  values (v_app, upper(p_service), p_system, p_prompt, p_schema, meta.app_user())
  returning id into v_id;
  perform set_config('pgkiln.ai_pending', '1', true);
  return v_id;
end
$$;

-- A request of the current application: {"id", "status" (queued, running, ok, refused, error),
-- "text" (the answer), "json" (the answer parsed, for a schema), "message", times}.
create function meta.ai_result(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  r      meta.ai_request;
  v_json jsonb;
begin
  select * into r from meta.ai_request where id = p_id and app_id = meta.app_id();
  if not found then
    return null;
  end if;
  if r.schema is not null and r.status = 'ok' then
    begin
      v_json := r.response::jsonb;
    exception when others then
      v_json := null;
    end;
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'service', r.service, 'text', r.response, 'json', v_json,
    'message', r.message, 'requested_at', r.requested_at, 'started_at', r.started_at, 'finished_at', r.finished_at);
end
$$;

-- For the server, on the application's connection: the requests this
-- transaction queued, marked running (only the caller's own transaction's).
create function meta.ai_request_take(p_limit int default 3)
returns table (id bigint, service text, system_prompt text, prompt text, schema jsonb)
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
begin
  if coalesce(current_setting('pgkiln.ai_pending', true), '') <> '1' then
    return;
  end if;
  perform set_config('pgkiln.ai_pending', '', true);
  return query
    update meta.ai_request l set status = 'running', started_at = now()
     where l.id in (select x.id from meta.ai_request x
                     where x.status = 'queued' and x.requested_xact = pg_current_xact_id() and x.app_id = meta.app_id()
                     order by x.id limit least(greatest(p_limit, 0), 10))
    returning l.id, l.service, l.system_prompt, l.prompt, l.schema;
end
$$;

-- For the server: the result of a request taken with meta.ai_request_take().
create function meta.ai_request_done(p_id bigint, p_status text, p_response text, p_message text) returns void
language sql volatile security definer set search_path = meta, pg_catalog as $$
  update meta.ai_request
     set status = case when p_status in ('ok', 'refused') then p_status else 'error' end, finished_at = now(),
         response = p_response, message = left(p_message, 2000)
   where id = p_id and status = 'running' and requested_xact = pg_current_xact_id() and app_id = meta.app_id()
$$;

-- True when the current application may use the AI service (it exists, is enabled and the
-- application is allowed). Whether the provider accepts the key shows only when a request is
-- made. For conditions, e.g. a region that says no AI service is configured yet.
create function meta.ai_available(p_service text) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select exists (select 1 from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = meta.app_id()
                  where s.name = upper(p_service) and s.enabled)
$$;

-- like meta.web_request: application roles call them (each checks meta.app_id())
grant execute on function meta.ai_available(text), meta.ai_generate(text, text, text, jsonb), meta.ai_result(bigint),
  meta.ai_request_take(int), meta.ai_request_done(bigint, text, text, text) to public;
