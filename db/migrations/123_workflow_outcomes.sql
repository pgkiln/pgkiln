-- =====================================================================
-- 123: workflows and approvals (APEX 26.1 / 26.2): custom task outcomes,
-- task events and notifications, draft steps, migrating running instances
--
-- Task definitions:
--   outcomes       [{"name": "YES", "label": "Yes", "colour": "success"}, …]: the buttons of the
--                  task and the outcomes a task may end with (stored lower case in meta.task.outcome);
--                  empty or null: the type's own (approval: approved / rejected, action: completed).
--                  Colours: default, primary, success, danger, warning.
--   events         [{"on": "complete" | "expire" | "fail", "type": "sql" | "mail" | "workflow", …}]:
--                  actions when a task is completed, expires, or its completion SQL fails
--                  (src/task-events.ts runs them as the application's role).
--   fail_recovery  after a failing completion SQL: reopen (the decision is undone; the default) or
--                  complete (the decision stands without the SQL's effect).
--   notifications  {"create": "TEMPLATE", "complete": "TEMPLATE", "expire": "TEMPLATE"}: built-in
--                  e-mails from the application's e-mail templates (meta.send_mail_template) to the
--                  potential owners (create) or the initiator (complete; expire: both).
-- All are columns of meta.task_definition: they travel with export/import as they are.
--
-- meta.task_hook: the outbox of task events and notifications (create, complete, expire), filled
-- by a trigger in the task's transaction and worked off by the server after the commit. Runtime
-- data like the tasks themselves (no application foreign key: not exported, kept on replace).
--
-- Workflows:
--   a "draft" step type, a placeholder while modelling: allowed in a development version only
--   (a check on the active steps; activation refuses it);
--   a "send_mail" step (src/workflow.ts) through meta.send_mail / meta.send_mail_template;
--   meta.migrate_workflows(): running instances move to a newer version of their definition,
--   each current step mapped to a step of that version, in one transaction, logged in
--   meta.workflow_event ("migrated") and meta.workflow_migration (installation data).
-- =====================================================================

-- ---------------------------------------------------------------- outcomes
/** Why a task definition's outcomes are not valid, or null. */
create function meta.task_outcomes_problem(p jsonb) returns text
language plpgsql immutable set search_path = pg_catalog as $$
declare
  e      jsonb;
  v_seen text[] := '{}';
  v_name text;
begin
  if p is null or p = '[]'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p) <> 'array' then
    return 'Outcomes are a JSON array.';
  end if;
  if jsonb_array_length(p) > 10 then
    return 'At most 10 outcomes.';
  end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' then
      return 'Each outcome is an object {"name": …, "label": …, "colour": …}.';
    end if;
    v_name := lower(e->>'name');
    if v_name is null or v_name !~ '^[a-z][a-z0-9_]{0,29}$' then
      return format('Outcome name %s: letters, digits and underscores (at most 30), e.g. YES.', coalesce(e->>'name', '(none)'));
    end if;
    if v_name in ('cancelled', 'expired', 'default') then
      return format('Outcome name %s is reserved.', e->>'name');
    end if;
    if v_name = any (v_seen) then
      return format('Outcome %s is listed twice.', e->>'name');
    end if;
    v_seen := v_seen || v_name;
    if e ? 'label' and (jsonb_typeof(e->'label') <> 'string' or length(btrim(e->>'label')) not between 1 and 60) then
      return format('Outcome %s: the label is text of 1 to 60 characters.', e->>'name');
    end if;
    if e ? 'colour' and coalesce(e->>'colour', '') not in ('default', 'primary', 'success', 'danger', 'warning') then
      return format('Outcome %s: the colour is default, primary, success, danger or warning.', e->>'name');
    end if;
  end loop;
  return null;
end
$$;

alter table meta.task_definition
  add column outcomes jsonb constraint task_definition_outcomes_check check (meta.task_outcomes_problem(outcomes) is null),
  add column events jsonb check (events is null or (jsonb_typeof(events) = 'array' and jsonb_array_length(events) <= 20)),
  add column fail_recovery text check (fail_recovery in ('reopen', 'complete')),
  add column notifications jsonb check (notifications is null or (jsonb_typeof(notifications) = 'object'
    and notifications - 'create' - 'complete' - 'expire' = '{}'::jsonb));
comment on column meta.task_definition.outcomes is 'Custom outcomes (123): [{"name", "label", "colour"}]; empty: the type''s own.';
comment on column meta.task_definition.events is 'Task events (123): [{"on": complete|expire|fail, "type": sql|mail|workflow, …}].';
comment on column meta.task_definition.notifications is 'Built-in notifications (123): {"create"|"complete"|"expire": e-mail template name}.';

/** The outcomes a task of this definition may end with (lower case). */
create function meta.task_outcome_names(d meta.task_definition) returns text[]
language sql immutable set search_path = pg_catalog as $$
  select case when d.outcomes is not null and jsonb_array_length(d.outcomes) > 0
              then array(select lower(e->>'name') from jsonb_array_elements(d.outcomes) e)
              when d.type = 'approval' then array['approved', 'rejected']
              else array['completed'] end
$$;

alter table meta.task drop constraint task_outcome_check;
alter table meta.task add constraint task_outcome_check check (outcome ~ '^[a-z][a-z0-9_]{0,29}$');
alter table meta.task_event drop constraint task_event_event_check;
alter table meta.task_event add constraint task_event_event_check
  check (event in ('created', 'claimed', 'released', 'delegated', 'approved', 'rejected', 'completed', 'cancelled', 'commented', 'closed',
                   'expired', 'renewed', 'escalated', 'failed'));

-- Same as 021, plus: the outcomes of the definition (custom ones too). A custom outcome is logged as
-- "completed" with its label. Returns also the outcome, its label, the fail events and the recovery.
create or replace function meta.complete_task(p_id bigint, p_outcome text, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  t       meta.task;
  d       meta.task_definition;
  v_out   text := lower(btrim(coalesce(p_outcome, '')));
  v_label text;
begin
  t := meta.task_load(p_id, 'act');
  select * into d from task_definition where id = t.definition_id;
  if not v_out = any (meta.task_outcome_names(d)) then
    raise exception 'A task of % cannot end as %.', d.name, left(coalesce(p_outcome, '(none)'), 60);
  end if;
  select e->>'label' into v_label from jsonb_array_elements(coalesce(d.outcomes, '[]')) e where lower(e->>'name') = v_out;
  update task set state = 'completed', outcome = v_out, completed_at = now(), completed_by = meta.app_user(),
                  actual_owner = coalesce(actual_owner, meta.app_user())
   where id = p_id;
  if v_out in ('approved', 'rejected', 'completed') then
    perform meta.task_log(p_id, v_out, p_comment);
  else
    perform meta.task_log(p_id, 'completed', coalesce(v_label, upper(v_out)) || coalesce(': ' || nullif(btrim(p_comment), ''), ''));
  end if;
  return jsonb_build_object('action_code', d.action_code, 'detail_pk', t.detail_pk, 'params', t.params, 'initiator', t.initiator,
                            'outcome', v_out, 'label', coalesce(v_label, v_out), 'subject', t.subject, 'definition', d.name,
                            'fail_events', coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(d.events, '[]')) e where e->>'on' = 'fail'), '[]'),
                            'fail_recovery', coalesce(d.fail_recovery, 'reopen'));
end
$$;

-- Same as 021, plus: a custom outcome of the definition.
create or replace function meta.close_tasks(p_name text, p_detail_pk text, p_outcome text default null) returns int
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_n   int := 0;
  v_id  bigint;
  d     meta.task_definition;
begin
  select * into d from task_definition where app_id = meta.app_id() and name = upper(p_name);
  if p_outcome is not null and not (found and lower(p_outcome) = any (meta.task_outcome_names(d))) then
    raise exception 'Invalid outcome %.', left(p_outcome, 60);
  end if;
  for v_id in
    update task t set state = case when p_outcome is null then 'cancelled' else 'completed' end,
                      outcome = lower(p_outcome), completed_at = now(), completed_by = meta.app_user()
     where t.definition_id = d.id and t.detail_pk = p_detail_pk and t.state in ('unassigned', 'assigned')
    returning t.id
  loop
    perform meta.task_log(v_id, 'closed', p_outcome);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- The completion SQL of a task failed and its fail events ran (the task list, as the acting user).
create function meta.log_task_failure(p_id bigint, p_detail text) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  t meta.task;
begin
  select * into t from task where id = p_id and app_id = meta.app_id();
  if not found or not ((meta.task_rights(t)).may_act or (t.state = 'completed' and lower(t.completed_by) = lower(meta.app_user()))) then
    raise exception 'Task % not found.', p_id;
  end if;
  perform meta.task_log(p_id, 'failed', left(p_detail, 4000));
end
$$;
revoke all on function meta.log_task_failure(bigint, text) from public;
grant execute on function meta.log_task_failure(bigint, text) to public;

-- ---------------------------------------------------------------- events and notifications: the outbox
create table meta.task_hook (
  id         bigserial primary key,
  task_id    bigint not null references meta.task on delete cascade,
  event      text not null check (event in ('create', 'complete', 'expire')),
  created_at timestamptz not null default now(),
  attempts   int not null default 0,
  done_at    timestamptz,
  error      text check (length(error) <= 2000)
);
create index task_hook_pending on meta.task_hook (id) where done_at is null;
revoke all on meta.task_hook from public;
comment on table meta.task_hook is 'Task events and notifications to run after the commit (123); runtime data, not exported.';

create function meta.task_hook_enqueue() returns trigger
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  d       meta.task_definition;
  v_event text := case when tg_op = 'INSERT' then 'create' when new.state = 'completed' then 'complete' when new.state = 'expired' then 'expire' end;
begin
  if v_event is null then
    return new;
  end if;
  select * into d from task_definition where id = new.definition_id;
  if coalesce(d.notifications ? v_event, false)
     or exists (select 1 from jsonb_array_elements(coalesce(d.events, '[]')) e where e->>'on' = v_event) then
    insert into task_hook (task_id, event) values (new.id, v_event);
    perform pg_notify('pgkiln_workflow', 'task');
  end if;
  return new;
end
$$;
create trigger task_hook_create after insert on meta.task for each row execute function meta.task_hook_enqueue();
create trigger task_hook_state after update of state on meta.task
  for each row when (old.state is distinct from new.state and new.state in ('completed', 'expired')) execute function meta.task_hook_enqueue();

/**
 * The e-mail addresses of a task's people (accounts with an address): its potential owners (named users,
 * the actual owner, the application's users with one of its owner roles) and/or its initiator.
 */
create function meta.task_addresses(p_task_id bigint, p_owners boolean, p_initiator boolean) returns text[]
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(array_agg(distinct ac.email order by ac.email), '{}')
    from task t
    join account ac on ac.active and ac.email is not null
   where t.id = p_task_id
     and ((p_initiator and lower(ac.username) = lower(t.initiator))
       or (p_owners and (lower(ac.username) = any (select lower(u) from unnest(t.owner_users) u)
                         or lower(ac.username) = lower(t.actual_owner)
                         or exists (select 1 from app_access aa
                                     where aa.app_id = t.app_id and aa.account_id = ac.id
                                       and exists (select 1 from unnest(aa.roles) r where lower(r) = any (select lower(x) from unnest(t.owner_roles) x))))))
$$;
revoke all on function meta.task_addresses(bigint, boolean, boolean) from public;

-- ---------------------------------------------------------------- draft steps
alter table meta.workflow_definition add constraint workflow_definition_no_draft
  check (not jsonb_path_exists(steps, '$[*] ? (@.type == "draft")'));

-- Same as 027, plus: a version with draft steps is not activated.
create or replace function meta.activate_workflow_version(p_definition_id int) returns text
language plpgsql set search_path = meta, pg_catalog as $$
declare
  d meta.workflow_definition;
  v_drafts text;
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
  select string_agg(s->>'name', ', ') into v_drafts from jsonb_array_elements(d.dev_steps) s where s->>'type' = 'draft';
  if v_drafts is not null then
    raise exception 'Version % of workflow % has draft steps (%): replace them before activating it.', d.dev_version, d.name, v_drafts;
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
revoke all on function meta.activate_workflow_version(int) from public;

-- ---------------------------------------------------------------- migrating running instances
alter table meta.workflow_event drop constraint workflow_event_event_check;
alter table meta.workflow_event add constraint workflow_event_event_check
  check (event in ('started', 'step', 'task', 'waiting', 'resumed', 'completed', 'terminated', 'faulted', 'retried', 'split', 'joined', 'cancelled', 'migrated'));

create table meta.workflow_migration (
  id              bigserial primary key,
  app_id          int  not null references meta.app on delete cascade,
  definition_name text not null,
  to_version      text not null,
  -- current step → step of the new version
  mapping         jsonb not null,
  workflow_ids    bigint[] not null,
  -- per instance: {"id", "from_version", "from_step", "to_step"}
  detail          jsonb not null default '[]',
  migrated_by     text not null,
  migrated_at     timestamptz not null default now()
);
create index on meta.workflow_migration (app_id, migrated_at);
revoke all on meta.workflow_migration from public;
comment on table meta.workflow_migration is 'Log of migrations of running workflow instances to a newer version (123); installation data, not exported.';

/**
 * Move running instances (p_ids) of a definition to a newer version (p_to_version: the active version or a
 * later inactive one), each at the step p_map gives for its current step. Returns one row per instance with
 * the problem that stops it (null: it can move). With p_apply, nothing changes unless every instance can
 * move; then all move in this transaction, with a "migrated" event each and a row in meta.workflow_migration.
 */
create function meta.migrate_workflows(p_definition_id int, p_to_version text, p_ids bigint[], p_map jsonb, p_apply boolean, p_by text)
returns table (workflow_id bigint, from_version text, from_step text, to_step text, problem text)
language plpgsql set search_path = meta, pg_catalog as $$
declare
  d        meta.workflow_definition;
  v_order  text[];
  v_target int;
  v_steps  jsonb;
  v_to     jsonb;
  v_from   jsonb;
  w        record;
  v_rows   jsonb := '[]';
  v_bad    text[] := '{}';
  v_id     bigint;
  r        jsonb;
begin
  select * into d from workflow_definition where id = p_definition_id;
  if not found then
    raise exception 'Workflow definition % does not exist.', p_definition_id;
  end if;
  if coalesce(cardinality(p_ids), 0) = 0 then
    raise exception 'Choose the instances to migrate.';
  end if;
  if jsonb_typeof(coalesce(p_map, '{}')) <> 'object' then
    raise exception 'The step mapping is a JSON object.';
  end if;
  -- versions from the oldest to the active one
  v_order := array(select x->>'version' from jsonb_array_elements(d.inactive_versions) with ordinality o(x, i) order by i) || d.version;
  v_target := array_position(v_order, p_to_version);
  if v_target is null then
    raise exception 'Workflow % has no version % to migrate to (the active version or an inactive one).', d.name, p_to_version;
  end if;
  v_steps := case when p_to_version = d.version then d.steps
                  else (select x->'steps' from jsonb_array_elements(d.inactive_versions) x where x->>'version' = p_to_version limit 1) end;

  foreach v_id in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    select wf.id, wf.app_id, wf.definition_id, coalesce(wf.version, '1') as version, wf.state, wf.current_step, wf.steps, wf.waiting_task, wf.wait_until,
           (select td.name from task tk join task_definition td on td.id = tk.definition_id where tk.id = wf.waiting_task) as task_name,
           exists (select 1 from workflow_branch b where b.workflow_id = wf.id and b.state in ('active', 'waiting', 'faulted')) as branches
      into w from workflow wf where wf.id = v_id for update;
    workflow_id := v_id;
    from_version := w.version;
    from_step := w.current_step;
    to_step := case when w.current_step is not null then p_map->>w.current_step end;
    problem := null;
    v_to := (select s from jsonb_array_elements(v_steps) s where s->>'name' = to_step limit 1);
    v_from := (select s from jsonb_array_elements(w.steps) s where s->>'name' = w.current_step limit 1);
    if w.id is null or w.definition_id is distinct from d.id or w.app_id <> d.app_id then
      problem := 'not an instance of this workflow';
      from_version := null;
      from_step := null;
      to_step := null;
    elsif w.state not in ('active', 'waiting', 'faulted') then
      problem := format('is %s', w.state);
    elsif coalesce(array_position(v_order, w.version), 0) >= v_target then
      problem := format('runs version %s, which is not older than %s', w.version, p_to_version);
    elsif w.branches then
      problem := 'runs parallel branches: let them reach their join first';
    elsif to_step is null or to_step = '' then
      problem := format('no step of version %s is mapped to %s', p_to_version, coalesce(w.current_step, '(none)'));
    elsif v_to is null then
      problem := format('version %s has no step %s', p_to_version, to_step);
    elsif v_to->>'type' = 'draft' then
      problem := format('%s is a draft step', to_step);
    elsif w.waiting_task is not null and v_to->>'type' <> 'task' then
      problem := format('waits for a task: %s must be a task step', to_step);
    elsif w.waiting_task is not null and upper(v_to->>'task') is distinct from w.task_name then
      problem := format('waits for a task of %s, but %s creates %s', w.task_name, to_step, coalesce(v_to->>'task', '(none)'));
    elsif w.state = 'waiting' and w.waiting_task is null and v_from->>'type' = 'invoke_api' then
      problem := 'is calling a web service: try again when the call is done';
    elsif w.state = 'waiting' and w.waiting_task is null and v_from->>'type' = 'wait' and v_to->>'type' <> 'wait' then
      problem := format('waits at a wait step: %s must be a wait step', to_step);
    elsif w.state = 'waiting' and w.waiting_task is null and v_from->>'type' = 'join' and v_to->>'type' <> 'join' then
      problem := format('waits at a join: %s must be a join step', to_step);
    end if;
    if problem is not null then
      v_bad := v_bad || format('%s %s', v_id, problem);
    end if;
    v_rows := v_rows || jsonb_build_object('id', v_id, 'from_version', from_version, 'from_step', from_step, 'to_step', to_step);
    return next;
  end loop;

  if not p_apply then
    return;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'Nothing was migrated: instance %.', array_to_string(v_bad, '; instance ');
  end if;
  for r in select * from jsonb_array_elements(v_rows) loop
    update workflow set steps = v_steps, version = p_to_version, current_step = r->>'to_step', updated_at = now()
     where id = (r->>'id')::bigint;
    perform meta.workflow_log((r->>'id')::bigint, r->>'to_step', 'migrated',
      format('version %s → %s: %s → %s (by %s)', r->>'from_version', p_to_version, r->>'from_step', r->>'to_step', p_by));
  end loop;
  insert into workflow_migration (app_id, definition_name, to_version, mapping, workflow_ids, detail, migrated_by)
  values (d.app_id, d.name, p_to_version, coalesce(p_map, '{}'), array(select (x->>'id')::bigint from jsonb_array_elements(v_rows) x), v_rows, p_by);
  -- active ones go on with their new step
  perform pg_notify('pgkiln_workflow', 'migrated');
end
$$;
revoke all on function meta.migrate_workflows(int, text, bigint[], jsonb, boolean, text) from public;
