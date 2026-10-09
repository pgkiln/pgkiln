-- ---------------------------------------------------------------------
-- Page logic, part 2 (APEX parity: page processes, branches, dynamic actions)
--
--  * Process types:
--      download  the process's code is a query returning a file (bytea,
--                file name, MIME type columns); one row is sent as is,
--                several rows as one zip file (config: column names, zip
--                name, disposition)
--      chain     an execution chain: runs the processes that name it in
--                parent_process, in sequence, each with its own button,
--                condition and authorization; config {"background": true}
--                queues it as a job (meta.process_job) the server runs
--      workflow  start a workflow (definition, version, detail key and
--                variables from items), or terminate / retry an instance
--  * Server-side conditions on processes (the shape of migration 029's).
--  * Branches: target_type "function" (a PL/pgSQL body returning a path in
--    the application, checked like target_url) and "app" (a page of another
--    application of this installation, with items).
--  * Dynamic action event "dialog_closed": a modal dialog opened from the
--    page was submitted and closed (trigger_element: its page number(s)).
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------- processes

do $$
declare
  v_types text[];
begin
  -- the constraint is "type = any ('{a,b,…}'::text[])" since migration 030
  select string_to_array((regexp_match(pg_get_constraintdef(k.oid), '\{([a-z_,]+)\}'))[1], ',') into v_types
    from pg_constraint k
   where k.conrelid = 'meta.process'::regclass and k.conname = 'process_type_check';
  if v_types is null then
    raise exception 'Unexpected process_type_check constraint.';
  end if;
  alter table meta.process drop constraint process_type_check;
  execute format('alter table meta.process add constraint process_type_check check (type = any (%L::text[]))',
                 array(select distinct unnest(v_types || array['download', 'chain', 'workflow']) order by 1));
end
$$;

alter table meta.process
  -- a child of the chain process of this name (same page): runs only inside the chain
  add column parent_process  text check (length(parent_process) between 1 and 200),
  add column condition_type  text check (condition_type in ('sql', 'exists', 'not_exists', 'item_null', 'item_not_null', 'item_equals', 'item_not_equals', 'request_in')),
  add column condition_expr  text,
  add column condition_value text,
  add constraint process_condition_check check (meta.condition_ok(condition_type, condition_expr, condition_value)),
  add constraint process_parent_check check (parent_process is distinct from name);

-- ---------------------------------------------------------------- background jobs of chains

create table meta.process_job (
  id          bigserial primary key,
  app_id      int  not null references meta.app on delete cascade,
  page_no     int  not null,
  process_id  int  references meta.process on delete set null,
  name        text not null,
  state       text not null default 'queued' check (state in ('queued', 'running', 'completed', 'failed')),
  -- who started it, with their roles and language when they did
  app_user    text not null,
  session_id  text,
  roles       text[] not null default '{}',
  lang        text,
  request     text,
  -- the session state when it was queued (the binds of its processes)
  binds       jsonb not null default '{}',
  steps_total int  not null default 0,
  steps_done  int  not null default 0,
  current     text,
  message     text check (length(message) <= 4000),
  error       text check (length(error) <= 4000),
  worker      text,
  queued_at   timestamptz not null default now(),
  started_at  timestamptz,
  ended_at    timestamptz,
  updated_at  timestamptz not null default now()
);
create index on meta.process_job (state, id);
create index on meta.process_job (app_id, queued_at desc);
revoke all on meta.process_job from public;

-- Queue a background chain. Called by the runtime in the submit's transaction,
-- as the app's role (application SQL may call it too: only a background chain
-- of the current application, run as the current user with the roles of the
-- current session, never roles the caller names).
create function meta.enqueue_process_job(p_process_id int, p_binds jsonb, p_lang text default null, p_request text default null) returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  p       record;
  v_id    bigint;
  v_kids  int;
  v_roles text[];
begin
  select x.id, x.name, x.type, x.config, g.page_no, g.app_id into p
    from process x join page g on g.id = x.page_id
   where x.id = p_process_id and g.app_id = meta.app_id();
  if not found or p.type <> 'chain' or coalesce((p.config->>'background')::boolean, false) is not true then
    raise exception 'Process % is not a background chain of this application.', p_process_id;
  end if;
  if jsonb_typeof(coalesce(p_binds, '{}')) <> 'object' or length(coalesce(p_binds, '{}')::text) > 1000000 then
    raise exception 'The binds of a background process must be a JSON object (at most 1 MB).';
  end if;
  select s.roles into v_roles from session s
   where s.id = nullif(current_setting('pgkiln.session_id', true), '')::uuid and s.app_id = meta.app_id();
  select count(*) into v_kids from process c join page g on g.id = c.page_id
   where g.app_id = meta.app_id() and g.page_no = p.page_no and c.parent_process = p.name;
  insert into process_job (app_id, page_no, process_id, name, app_user, session_id, roles, lang, request, binds, steps_total)
  values (p.app_id, p.page_no, p.id, p.name, meta.app_user(), nullif(current_setting('pgkiln.session_id', true), ''),
          coalesce(v_roles, '{}'), left(p_lang, 20), left(p_request, 200), coalesce(p_binds, '{}'), v_kids)
  returning id into v_id;
  perform pg_notify('pgkiln_process_job', v_id::text);
  return v_id;
end
$$;
grant execute on function meta.enqueue_process_job(int, jsonb, text, text) to public;

-- The jobs a user may see: their own (signed in), or their session's (public pages).
create view meta.process_jobs with (security_barrier) as
  select j.id, j.page_no, j.name, j.state, j.steps_total, j.steps_done, j.current, j.message, j.error,
         j.queued_at, j.started_at, j.ended_at, j.app_user
    from meta.process_job j
   where j.app_id = meta.app_id()
     and ((meta.app_user() <> 'nobody' and lower(j.app_user) = lower(meta.app_user()))
          or (j.session_id is not null and j.session_id = nullif(current_setting('pgkiln.session_id', true), '')));
grant select on meta.process_jobs to public;

-- A running background job: its starter's roles (as for automations, 015).
create or replace function meta.has_role(p_role text) returns boolean
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_session    uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
  v_automation int  := nullif(current_setting('pgkiln.automation_id', true), '')::int;
  v_job        bigint := nullif(current_setting('pgkiln.process_job_id', true), '')::bigint;
  v_claims     jsonb;
begin
  if v_session is not null then
    return exists (select 1 from meta.session s
                    where s.id = v_session and lower(p_role) = any (select lower(r) from unnest(s.roles) r));
  end if;
  if v_automation is not null then
    return exists (select 1 from meta.automation a
                    where a.id = v_automation and a.app_id = meta.app_id()
                      and lower(p_role) = any (select lower(r) from unnest(a.roles) r));
  end if;
  if v_job is not null then
    return exists (select 1 from meta.process_job j
                    where j.id = v_job and j.app_id = meta.app_id() and j.state = 'running'
                      and lower(j.app_user) = lower(meta.app_user())
                      and lower(p_role) = any (select lower(r) from unnest(j.roles) r));
  end if;
  v_claims := meta.jwt_claims();
  if v_claims is null then
    return false;
  end if;
  if v_claims ? 'client_id' then
    return exists (select 1 from meta.api_client c
                    where c.client_id = v_claims->>'client_id' and c.active and lower(p_role) = any (c.roles));
  end if;
  if jsonb_typeof(v_claims->'roles') = 'array'
     and exists (select 1 from jsonb_array_elements_text(v_claims->'roles') r where lower(r) = lower(p_role)) then
    return true;
  end if;
  return lower(p_role) = any (meta.account_roles(meta.app_id(), meta.app_user()));
end
$$;

-- ---------------------------------------------------------------- workflow processes

-- Start a given version of a workflow: the active one (null), an inactive
-- one (history) or the one in development. Otherwise as meta.start_workflow.
create function meta.start_workflow_version(p_name text, p_version text, p_detail_pk text default null, p_vars jsonb default '{}') returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  d       meta.workflow_definition;
  v_steps jsonb;
  v_ver   text;
  v_title text;
  v_vars  jsonb := '{}';
  v_id    bigint;
  kv      record;
begin
  select * into d from workflow_definition where app_id = meta.app_id() and name = upper(p_name);
  if not found then
    raise exception 'Workflow definition % does not exist in this application.', p_name;
  end if;
  v_ver := nullif(btrim(p_version), '');
  if v_ver is null or v_ver = d.version then
    v_ver := d.version;
    v_steps := d.steps;
  elsif v_ver = d.dev_version then
    v_steps := d.dev_steps;
  else
    select x->'steps' into v_steps from jsonb_array_elements(d.inactive_versions) x where x->>'version' = v_ver limit 1;
    if v_steps is null then
      raise exception 'Workflow % has no version %.', d.name, v_ver;
    end if;
  end if;
  if jsonb_typeof(v_steps) <> 'array' or jsonb_array_length(v_steps) = 0 then
    raise exception 'Workflow % has no steps.', d.name;
  end if;
  if jsonb_typeof(coalesce(p_vars, '{}')) <> 'object' then
    raise exception 'Workflow variables must be a JSON object.';
  end if;
  for kv in select key, value from jsonb_each(coalesce(p_vars, '{}')) loop
    v_vars := v_vars || jsonb_build_object(upper(kv.key), kv.value);
  end loop;
  v_title := d.title;
  for kv in select key, value from jsonb_each_text(v_vars) loop
    v_title := replace(v_title, '&' || kv.key || '.', coalesce(kv.value, ''));
  end loop;
  v_title := replace(v_title, '&DETAIL_PK.', coalesce(p_detail_pk, ''));
  insert into workflow (app_id, definition_id, name, title, detail_pk, vars, steps, admin_role, current_step, initiator, version)
  values (d.app_id, d.id, d.name, left(v_title, 500), p_detail_pk, v_vars, v_steps, d.admin_role, v_steps->0->>'name', meta.app_user(), v_ver)
  returning id into v_id;
  perform meta.workflow_log(v_id, null, 'started', 'version ' || v_ver);
  perform pg_notify('pgkiln_workflow', v_id::text);
  return v_id;
end
$$;
grant execute on function meta.start_workflow_version(text, text, text, jsonb) to public;

-- ---------------------------------------------------------------- branches

-- A path inside an application, as branch target_url allows (029): no scheme,
-- no "//", "\", "..", control characters.
create function meta.branch_path_ok(p_path text) returns boolean
language sql immutable set search_path = meta, pg_catalog as $$
  select coalesce(p_path ~ '^[A-Za-z0-9_&.?=%#,:~+-][A-Za-z0-9_&.?=%#,:~+/ -]*$'
                  and p_path !~ '(//|\.\./|\.\.$|^\.|[\\[:cntrl:]])'
                  and p_path !~* '^[a-z][a-z0-9+.-]*:'
                  and length(p_path) <= 2000, false)
$$;
grant execute on function meta.branch_path_ok(text) to public;

alter table meta.branch drop constraint branch_target_type_check;
alter table meta.branch add constraint branch_target_type_check check (target_type in ('page', 'url', 'function', 'app'));
alter table meta.branch
  -- function: a PL/pgSQL body returning the path (null: the branch doesn't apply)
  add column target_function text,
  -- app: the alias of another application of this installation (target_page there, with target_items)
  add column target_app      text check (target_app ~ '^[a-z][a-z0-9_-]{0,99}$'),
  add constraint branch_function_check check (target_type <> 'function' or coalesce(btrim(target_function), '') <> ''),
  add constraint branch_app_check check (target_type <> 'app' or (target_app is not null and target_page is not null));

-- ---------------------------------------------------------------- dynamic actions

alter table meta.dynamic_action drop constraint dynamic_action_event_check;
alter table meta.dynamic_action add constraint dynamic_action_event_check check (event in ('change', 'click', 'load', 'dialog_closed'));
