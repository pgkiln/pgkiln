-- Workflows: parallel branches and versions (APEX: Workflow, workflow versions).
--
-- Parallel branches. Two new step types (src/workflow.ts runs them):
--   parallel  {"name": "SPLIT", "type": "parallel", "branches": ["IT", "WELCOME"], "join": "MEET"}
--             starts one branch per listed step; the path that reached it waits at the join
--   join      {"name": "MEET", "type": "join", "wait_for": "all" | "any", "next": "…"}
--             goes on when all branches (or the first one, "any": the others are cancelled) are done
-- Each running branch is a row in meta.workflow_branch with its own step, wait and task; the
-- instance's own columns (current_step, wait_until, waiting_task) stay the main path's.
--
-- Versions. A definition's "steps" are its ACTIVE version ("version"), which new instances start.
-- A development version ("dev_version", "dev_steps") is the copy the builder edits; activating it
-- moves the active version to "inactive_versions" (history). Instances record the version they run
-- and keep their copy of its steps. All of these are columns, so they travel with export/import.

-- ---------------------------------------------------------------- versions
alter table meta.workflow_definition
  add column version           text not null default '1' check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$'),
  add column activated_at      timestamptz,
  add column dev_version       text check (dev_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$'),
  add column dev_steps         jsonb check (jsonb_typeof(dev_steps) = 'array'),
  -- [{"version": "1", "steps": […], "activated_at": "…", "deactivated_at": "…"}, …], oldest first
  add column inactive_versions jsonb not null default '[]' check (jsonb_typeof(inactive_versions) = 'array'),
  add constraint workflow_definition_dev_check check ((dev_version is null) = (dev_steps is null) and dev_version is distinct from version);

alter table meta.workflow add column version text;
update meta.workflow set version = '1';

-- meta.import_app fills a definition with jsonb_populate_record, which leaves out the defaults:
-- an export from before this migration has no version (it becomes version 1, without history).
create function meta.workflow_definition_defaults() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
begin
  new.version := coalesce(new.version, '1');
  new.inactive_versions := coalesce(new.inactive_versions, '[]');
  return new;
end
$$;
create trigger workflow_definition_defaults before insert on meta.workflow_definition
  for each row execute function meta.workflow_definition_defaults();

-- A new development version: a copy of the active one. Returns its label.
create function meta.new_workflow_version(p_definition_id int, p_version text default null) returns text
language plpgsql set search_path = meta, pg_catalog as $$
declare
  d      meta.workflow_definition;
  v_used text[];
  v_new  text := nullif(btrim(p_version), '');
begin
  select * into d from workflow_definition where id = p_definition_id for update;
  if not found then
    raise exception 'Workflow definition % does not exist.', p_definition_id;
  end if;
  if d.dev_version is not null then
    raise exception 'Workflow % already has a version in development (%).', d.name, d.dev_version;
  end if;
  v_used := array(select x->>'version' from jsonb_array_elements(d.inactive_versions) x) || d.version;
  if v_new is null then
    -- the next whole number
    v_new := (coalesce((select max(u::int) from unnest(v_used) u where u ~ '^\d{1,9}$'), 0) + 1)::text;
  end if;
  if v_new = any(v_used) then
    raise exception 'Workflow % already has a version %.', d.name, v_new;
  end if;
  update workflow_definition set dev_version = v_new, dev_steps = steps where id = d.id;
  return v_new;
end
$$;

-- The development version becomes the active one (new instances start it); the active one becomes inactive.
create function meta.activate_workflow_version(p_definition_id int) returns text
language plpgsql set search_path = meta, pg_catalog as $$
declare
  d meta.workflow_definition;
begin
  select * into d from workflow_definition where id = p_definition_id for update;
  if not found then
    raise exception 'Workflow definition % does not exist.', p_definition_id;
  end if;
  if d.dev_version is null then
    raise exception 'Workflow % has no version in development.', d.name;
  end if;
  if jsonb_array_length(d.dev_steps) = 0 then
    raise exception 'Version % of workflow % has no steps.', d.dev_version, d.name;
  end if;
  update workflow_definition
     set inactive_versions = inactive_versions || jsonb_build_array(jsonb_build_object(
           'version', version, 'steps', steps, 'activated_at', activated_at, 'deactivated_at', now())),
         version = dev_version, steps = dev_steps, activated_at = now(),
         dev_version = null, dev_steps = null
   where id = d.id;
  return d.dev_version;
end
$$;

-- Throw the development version away.
create function meta.discard_workflow_version(p_definition_id int) returns void
language sql set search_path = meta, pg_catalog as $$
  update workflow_definition set dev_version = null, dev_steps = null where id = p_definition_id;
$$;
-- the builder (owner) manages versions; applications don't
revoke all on function meta.new_workflow_version(int, text), meta.activate_workflow_version(int), meta.discard_workflow_version(int) from public;

-- ---------------------------------------------------------------- parallel branches
create sequence meta.workflow_fork_seq;

create table meta.workflow_branch (
  id           bigserial primary key,
  workflow_id  bigint not null references meta.workflow on delete cascade,
  -- the branch that split (nested parallel steps); null: the instance's main path
  parent_id    bigint references meta.workflow_branch on delete cascade,
  -- the branches started by one parallel step share a fork number
  fork         bigint not null,
  split_step   text not null,
  join_step    text not null,
  -- the first step of the branch
  name         text not null,
  state        text not null default 'active' check (state in ('active', 'waiting', 'done', 'cancelled', 'faulted')),
  current_step text,
  wait_until   timestamptz,
  waiting_task bigint,
  error        text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  updated_at   timestamptz not null default now()
);
create index on meta.workflow_branch (workflow_id, state);
create index on meta.workflow_branch (state, wait_until);
create index on meta.workflow_branch (parent_id);
create index on meta.workflow_branch (waiting_task) where waiting_task is not null;
revoke all on meta.workflow_branch from public;

alter table meta.workflow_event drop constraint workflow_event_event_check;
alter table meta.workflow_event add constraint workflow_event_event_check
  check (event in ('started', 'step', 'task', 'waiting', 'resumed', 'completed', 'terminated', 'faulted', 'retried', 'split', 'joined', 'cancelled'));

-- Same as 022, plus the version and the steps that are running now (several with branches).
create or replace view meta.workflows with (security_barrier) as
  select w.id, w.app_id, w.name, w.title, w.detail_pk, w.vars, w.state, w.current_step, w.wait_until, w.waiting_task,
         w.error, w.initiator, w.started_at, w.ended_at, w.updated_at,
         lower(w.initiator) = lower(meta.app_user()) as is_initiator,
         w.admin_role is not null and meta.has_role(w.admin_role) as is_admin,
         w.state in ('active', 'waiting', 'faulted')
           and (lower(w.initiator) = lower(meta.app_user()) or (w.admin_role is not null and meta.has_role(w.admin_role))) as may_terminate,
         w.state = 'faulted' and w.admin_role is not null and meta.has_role(w.admin_role) as may_retry,
         w.version,
         coalesce((select array_agg(b.current_step order by b.id) from meta.workflow_branch b
                    where b.workflow_id = w.id and b.state in ('active', 'waiting', 'faulted')
                      and not exists (select 1 from meta.workflow_branch c where c.parent_id = b.id and c.state in ('active', 'waiting', 'faulted'))),
                  case when w.state in ('active', 'waiting', 'faulted') and w.current_step is not null then array[w.current_step] else '{}'::text[] end) as active_steps
    from meta.workflow w
   where w.app_id = meta.app_id() and meta.app_user() <> 'nobody'
     and (lower(w.initiator) = lower(meta.app_user()) or (w.admin_role is not null and meta.has_role(w.admin_role)));

-- Same as 022; records the active version.
create or replace function meta.start_workflow(p_name text, p_detail_pk text default null, p_vars jsonb default '{}') returns bigint
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
  insert into workflow (app_id, definition_id, name, title, detail_pk, vars, steps, admin_role, current_step, initiator, version)
  values (d.app_id, d.id, d.name, left(v_title, 500), p_detail_pk, v_vars, d.steps, d.admin_role, d.steps->0->>'name', meta.app_user(), d.version)
  returning id into v_id;
  perform meta.workflow_log(v_id, null, 'started', 'version ' || d.version);
  perform pg_notify('pgkiln_workflow', v_id::text);
  return v_id;
end
$$;

-- Same as 022; also cancels the open branches.
create or replace function meta.terminate_workflow(p_id bigint, p_comment text default null) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  w meta.workflow;
begin
  select * into w from workflow where id = p_id and app_id = meta.app_id() for update;
  if not found or not exists (select 1 from meta.workflows v where v.id = p_id and v.may_terminate) then
    raise exception 'You cannot terminate this workflow.';
  end if;
  update workflow set state = 'terminated', ended_at = now(), updated_at = now(), waiting_task = null where id = p_id;
  update workflow_branch set state = 'cancelled', ended_at = now(), updated_at = now(), waiting_task = null
   where workflow_id = p_id and state in ('active', 'waiting', 'faulted');
  update task set state = 'cancelled', completed_at = now(), completed_by = meta.app_user()
   where workflow_id = p_id and state in ('unassigned', 'assigned');
  perform meta.workflow_log(p_id, w.current_step, 'terminated', p_comment);
end
$$;

-- Same as 022; a faulted branch is retried where it failed (the main path waits at its join).
create or replace function meta.retry_workflow(p_id bigint) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  w meta.workflow;
  b record;
begin
  select * into w from workflow where id = p_id and app_id = meta.app_id() for update;
  if not found or not exists (select 1 from meta.workflows v where v.id = p_id and v.may_retry) then
    raise exception 'You cannot retry this workflow.';
  end if;
  if exists (select 1 from workflow_branch where workflow_id = p_id and state = 'faulted') then
    for b in update workflow_branch set state = 'active', error = null, updated_at = now()
              where workflow_id = p_id and state = 'faulted' returning current_step loop
      perform meta.workflow_log(p_id, b.current_step, 'retried');
    end loop;
    update workflow set state = 'waiting', error = null, updated_at = now() where id = p_id;
  else
    update workflow set state = 'active', error = null, updated_at = now() where id = p_id;
    perform meta.workflow_log(p_id, w.current_step, 'retried');
  end if;
  perform pg_notify('pgkiln_workflow', p_id::text);
end
$$;

-- Same as 022; a task of a branch wakes the branch.
create or replace function meta.task_wakes_workflow() returns trigger
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_woken boolean;
begin
  update workflow set state = 'active', updated_at = now()
   where id = new.workflow_id and state = 'waiting' and waiting_task = new.id;
  v_woken := found;
  update workflow_branch b set state = 'active', updated_at = now()
    from workflow w
   where b.workflow_id = new.workflow_id and b.state = 'waiting' and b.waiting_task = new.id
     and w.id = b.workflow_id and w.state in ('active', 'waiting', 'faulted');
  if v_woken or found then
    perform pg_notify('pgkiln_workflow', new.workflow_id::text);
  end if;
  return new;
end
$$;
