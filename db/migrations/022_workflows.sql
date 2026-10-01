-- Workflows (APEX 23.2: Workflow). A workflow definition is a list of named
-- steps; an instance runs them one after the other, each step in its own
-- transaction as the application's role, driven by the pgapex server
-- (src/workflow.ts). Step types:
--   task    create a task (meta.task_definition) and wait for its outcome
--   sql     run SQL; returned columns named like variables update them
--   switch  go to the first case whose SQL condition is true, else "otherwise"
--   wait    wait for an interval ("for": "2 days") before going on
--   end     the workflow is completed
-- Applications start workflows with meta.start_workflow(name, detail_pk, variables).

create table meta.workflow_definition (
  id          serial primary key,
  app_id      int  not null references meta.app on delete cascade,
  name        text not null check (name ~ '^[A-Z][A-Z0-9_]*$'),
  -- e.g. 'Onboarding of &ENAME.'; &VAR. from the variables at the start
  title       text not null,
  description text,
  -- sees and manages every instance: terminate, retry a faulted step
  admin_role  text,
  -- [{"name": "PREPARE", "type": "task", "task": "ONBOARD_PREPARE", "owners": "select …", "next": {"completed": "END"}}, …]
  steps       jsonb not null default '[]' check (jsonb_typeof(steps) = 'array'),
  unique (app_id, name)
);
grant select on meta.workflow_definition to pgapex_runtime;

create table meta.workflow (
  id            bigserial primary key,
  app_id        int  not null references meta.app on delete cascade,
  definition_id int  references meta.workflow_definition on delete set null,
  name          text not null,
  title         text not null,
  detail_pk     text,
  vars          jsonb not null default '{}',
  -- the definition's steps when the instance started: editing the definition doesn't change running ones
  steps         jsonb not null,
  admin_role    text,
  state         text not null default 'active' check (state in ('active', 'waiting', 'completed', 'terminated', 'faulted')),
  current_step  text,
  wait_until    timestamptz,
  waiting_task  bigint,
  error         text,
  initiator     text not null,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  updated_at    timestamptz not null default now()
);
create index on meta.workflow (state, wait_until);
create index on meta.workflow (app_id, definition_id, detail_pk);

create table meta.workflow_event (
  id          bigserial primary key,
  workflow_id bigint not null references meta.workflow on delete cascade,
  at          timestamptz not null default now(),
  step        text,
  event       text not null check (event in ('started', 'step', 'task', 'waiting', 'resumed', 'completed', 'terminated', 'faulted', 'retried')),
  detail      text check (length(detail) <= 4000)
);
create index on meta.workflow_event (workflow_id);
revoke all on meta.workflow, meta.workflow_event from public;

alter table meta.task add column workflow_id bigint references meta.workflow on delete set null;

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows'));

-- Who sees a workflow: whoever started it and its administrators.
create view meta.workflows with (security_barrier) as
  select w.id, w.app_id, w.name, w.title, w.detail_pk, w.vars, w.state, w.current_step, w.wait_until, w.waiting_task,
         w.error, w.initiator, w.started_at, w.ended_at, w.updated_at,
         lower(w.initiator) = lower(meta.app_user()) as is_initiator,
         w.admin_role is not null and meta.has_role(w.admin_role) as is_admin,
         w.state in ('active', 'waiting', 'faulted')
           and (lower(w.initiator) = lower(meta.app_user()) or (w.admin_role is not null and meta.has_role(w.admin_role))) as may_terminate,
         w.state = 'faulted' and w.admin_role is not null and meta.has_role(w.admin_role) as may_retry
    from meta.workflow w
   where w.app_id = meta.app_id() and meta.app_user() <> 'nobody'
     and (lower(w.initiator) = lower(meta.app_user()) or (w.admin_role is not null and meta.has_role(w.admin_role)));
grant select on meta.workflows to public;

create view meta.workflow_events with (security_barrier) as
  select e.id, e.workflow_id, e.at, e.step, e.event, e.detail
    from meta.workflow_event e
   where e.workflow_id in (select id from meta.workflows);
grant select on meta.workflow_events to public;

-- the tasks a workflow created are visible to its initiator and administrators too: through the workflow console

create function meta.workflow_log(p_id bigint, p_step text, p_event text, p_detail text default null) returns void
language sql security definer set search_path = meta, pg_catalog as $$
  insert into workflow_event (workflow_id, step, event, detail) values (p_id, p_step, p_event, left(nullif(btrim(p_detail), ''), 4000));
$$;
revoke all on function meta.workflow_log(bigint, text, text, text) from public;

-- Start a workflow (application SQL). The server runs its steps right away.
create function meta.start_workflow(p_name text, p_detail_pk text default null, p_vars jsonb default '{}') returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  d       meta.workflow_definition;
  v_title text;
  v_vars  jsonb := '{}';
  v_id    bigint;
  kv      record;
begin
  select * into d from workflow_definition where app_id = meta.app_id() and name = upper(p_name);
  if not found then
    raise exception 'Workflow definition % does not exist in this application.', p_name;
  end if;
  if jsonb_array_length(d.steps) = 0 then
    raise exception 'Workflow % has no steps.', d.name;
  end if;
  if jsonb_typeof(coalesce(p_vars, '{}')) <> 'object' then
    raise exception 'Workflow variables must be a JSON object.';
  end if;
  -- variable names are upper case, like binds
  for kv in select key, value from jsonb_each(coalesce(p_vars, '{}')) loop
    v_vars := v_vars || jsonb_build_object(upper(kv.key), kv.value);
  end loop;
  v_title := d.title;
  for kv in select key, value from jsonb_each_text(v_vars) loop
    v_title := replace(v_title, '&' || kv.key || '.', coalesce(kv.value, ''));
  end loop;
  v_title := replace(v_title, '&DETAIL_PK.', coalesce(p_detail_pk, ''));
  insert into workflow (app_id, definition_id, name, title, detail_pk, vars, steps, admin_role, current_step, initiator)
  values (d.app_id, d.id, d.name, left(v_title, 500), p_detail_pk, v_vars, d.steps, d.admin_role, d.steps->0->>'name', meta.app_user())
  returning id into v_id;
  perform meta.workflow_log(v_id, null, 'started');
  perform pg_notify('pgapex_workflow', v_id::text);
  return v_id;
end
$$;

-- Initiator or administrator: stop it, and cancel the task it waits for.
create function meta.terminate_workflow(p_id bigint, p_comment text default null) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  w meta.workflow;
begin
  select * into w from workflow where id = p_id and app_id = meta.app_id() for update;
  if not found or not exists (select 1 from meta.workflows v where v.id = p_id and v.may_terminate) then
    raise exception 'You cannot terminate this workflow.';
  end if;
  update workflow set state = 'terminated', ended_at = now(), updated_at = now(), waiting_task = null where id = p_id;
  update task set state = 'cancelled', completed_at = now(), completed_by = meta.app_user()
   where workflow_id = p_id and state in ('unassigned', 'assigned');
  perform meta.workflow_log(p_id, w.current_step, 'terminated', p_comment);
end
$$;

-- Administrator: run a faulted step again.
create function meta.retry_workflow(p_id bigint) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  w meta.workflow;
begin
  select * into w from workflow where id = p_id and app_id = meta.app_id() for update;
  if not found or not exists (select 1 from meta.workflows v where v.id = p_id and v.may_retry) then
    raise exception 'You cannot retry this workflow.';
  end if;
  update workflow set state = 'active', error = null, updated_at = now() where id = p_id;
  perform meta.workflow_log(p_id, w.current_step, 'retried');
  perform pg_notify('pgapex_workflow', p_id::text);
end
$$;

grant execute on function meta.start_workflow(text, text, jsonb), meta.terminate_workflow(bigint, text), meta.retry_workflow(bigint) to public;

-- A task of a workflow ends: wake the workflow (the server goes on with the next step).
create function meta.task_wakes_workflow() returns trigger
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  update workflow set state = 'active', updated_at = now()
   where id = new.workflow_id and state = 'waiting' and waiting_task = new.id;
  if found then
    perform pg_notify('pgapex_workflow', new.workflow_id::text);
  end if;
  return new;
end
$$;
create trigger task_wakes_workflow after update of state on meta.task
  for each row when (new.workflow_id is not null and new.state in ('completed', 'cancelled') and old.state is distinct from new.state)
  execute function meta.task_wakes_workflow();

-- Export and import: workflow definitions travel with the application (instances don't). Same as 021, plus "workflow_definitions".
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
    -- nav entries and regions keep their ids, so parents and references can be remapped on import
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
    -- facet regions point at their report region by id
    update meta.region r
       set config = jsonb_set(r.config, '{report}', to_jsonb((v_rmap->>(r.config->>'report'))::int))
     where r.page_id = v_page_id and r.type = 'facets' and v_rmap ? (r.config->>'report');

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
  end loop;

  return v_app_id;
end
$$;
