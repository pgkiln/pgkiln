-- Approvals and the task list (APEX: Task Definitions, Approvals component,
-- Unified Task List).
--
-- A task definition (shared component) says what a task is about (subject
-- with &PARAM. placeholders), who may act on it (owner roles, plus users
-- given when the task is created), who administers it, when it is due, the
-- details page, and the SQL that runs when it is completed.
--
-- Application SQL creates tasks:  select meta.create_task('LEAVE_APPROVAL', :P7_ID, '{"ENAME": "..."}', array['blake'])
-- Users act on them in a task list region (claim, approve or reject /
-- complete, release, delegate, cancel, comment). The meta.task_* functions
-- check the user's rights (meta.task_rights); the definition's action SQL
-- then runs as the application's role in the same transaction (Node), so
-- an error in it undoes the decision.

create table meta.task_definition (
  id                     serial primary key,
  app_id                 int  not null references meta.app on delete cascade,
  name                   text not null check (name ~ '^[A-Z][A-Z0-9_]*$'),
  -- e.g. 'Leave for &ENAME.: &DAYS. day(s)'; &KEY. from the task's parameters
  subject                text not null,
  type                   text not null default 'approval' check (type in ('approval', 'action')),
  -- potential owners by role (lower case), on top of the users given to create_task
  owner_roles            text[] not null default '{}',
  -- business administrators: see every task of this definition, delegate and cancel
  admin_role             text,
  initiator_can_complete boolean not null default false,
  priority               int  not null default 3 check (priority between 1 and 5),
  -- e.g. '2 days', '4 hours'
  due_in                 text check (due_in ~* '^\s*\d+\s*(minute|hour|day|week|month)s?\s*$'),
  details_page           int,
  details_item           text check (details_item ~ '^[A-Z][A-Z0-9_]*$'),
  -- run on completion as the app's role; binds :TASK_ID, :DETAIL_PK, :OUTCOME (APPROVED, REJECTED,
  -- COMPLETED), :COMMENT, :APPROVER, :INITIATOR and the task's parameters
  action_code            text,
  unique (app_id, name)
);
grant select on meta.task_definition to pgapex_runtime;

create table meta.task (
  id                     bigserial primary key,
  app_id                 int  not null references meta.app on delete cascade,
  definition_id          int  not null references meta.task_definition on delete cascade,
  subject                text not null,
  detail_pk              text,
  params                 jsonb not null default '{}',
  state                  text not null default 'unassigned' check (state in ('unassigned', 'assigned', 'completed', 'cancelled')),
  outcome                text check (outcome in ('approved', 'rejected', 'completed')),
  priority               int  not null,
  initiator              text not null,
  actual_owner           text,
  owner_users            text[] not null default '{}',
  owner_roles            text[] not null default '{}',
  created_at             timestamptz not null default now(),
  due_at                 timestamptz,
  completed_at           timestamptz,
  completed_by           text
);
create index on meta.task (app_id, state);
create index on meta.task (definition_id, detail_pk);

-- history and comments
create table meta.task_event (
  id       bigserial primary key,
  task_id  bigint not null references meta.task on delete cascade,
  at       timestamptz not null default now(),
  username text not null,
  event    text not null check (event in ('created', 'claimed', 'released', 'delegated', 'approved', 'rejected',
                                          'completed', 'cancelled', 'commented', 'closed')),
  detail   text check (length(detail) <= 4000)
);
create index on meta.task_event (task_id);
revoke all on meta.task, meta.task_event from public;

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks'));

-- What the signed-in user may do with a task. The task list shows exactly these.
create type meta.task_rights as (
  is_initiator boolean, is_owner boolean, is_admin boolean, may_see boolean,
  may_act boolean, may_claim boolean, may_release boolean, may_delegate boolean, may_cancel boolean
);

create function meta.task_rights(t meta.task) returns meta.task_rights
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_user  text := lower(meta.app_user());
  d       meta.task_definition;
  r       meta.task_rights;
  v_open  boolean := t.state in ('unassigned', 'assigned');
begin
  select * into d from task_definition where id = t.definition_id;
  r.is_initiator := lower(t.initiator) = v_user;
  r.is_owner := v_user = any (select lower(u) from unnest(t.owner_users) u)
                or exists (select 1 from unnest(t.owner_roles) x where meta.has_role(x));
  r.is_admin := d.admin_role is not null and meta.has_role(d.admin_role);
  r.may_see := t.app_id = meta.app_id() and v_user <> 'nobody'
               and (r.is_initiator or r.is_owner or r.is_admin or lower(t.actual_owner) = v_user);
  -- an initiator may not decide on their own request (unless the definition allows it)
  r.may_act := r.may_see and v_open and (d.initiator_can_complete or not r.is_initiator)
               and (lower(t.actual_owner) = v_user or (t.state = 'unassigned' and r.is_owner));
  r.may_claim := r.may_see and t.state = 'unassigned' and r.is_owner and (d.initiator_can_complete or not r.is_initiator);
  r.may_release := r.may_see and t.state = 'assigned' and lower(t.actual_owner) = v_user;
  r.may_delegate := r.may_see and v_open and (lower(t.actual_owner) = v_user or r.is_admin);
  r.may_cancel := r.may_see and v_open and (r.is_initiator or r.is_admin);
  return r;
end
$$;

-- The tasks the signed-in user may see in the current application, with their rights.
create view meta.tasks with (security_barrier) as
  select t.id, t.app_id, d.name as definition, d.type, t.subject, t.detail_pk, t.params, t.state, t.outcome,
         t.priority, t.initiator, t.actual_owner, t.owner_users, t.owner_roles, t.created_at, t.due_at,
         t.completed_at, t.completed_by, d.details_page, d.details_item,
         t.due_at is not null and t.due_at < now() and t.state in ('unassigned', 'assigned') as overdue,
         (r).is_initiator, (r).is_owner, (r).is_admin, (r).may_act, (r).may_claim, (r).may_release, (r).may_delegate, (r).may_cancel
    from (select t, meta.task_rights(t) as r from meta.task t where t.app_id = meta.app_id()) x
    cross join lateral (select (x.t).*) t
    join meta.task_definition d on d.id = t.definition_id
   where (x.r).may_see;
grant select on meta.tasks to public;

-- The history and comments of the tasks the user may see.
create view meta.task_events with (security_barrier) as
  select e.id, e.task_id, e.at, e.username, e.event, e.detail
    from meta.task_event e
   where e.task_id in (select id from meta.tasks);
grant select on meta.task_events to public;

-- ------------------------------------------------------------------ API

create function meta.task_load(p_id bigint, p_right text) returns meta.task
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  t meta.task;
  r meta.task_rights;
begin
  select * into t from task where id = p_id and app_id = meta.app_id() for update;
  if not found then
    raise exception 'Task % not found.', p_id;
  end if;
  r := meta.task_rights(t);
  if not coalesce(case p_right when 'act' then r.may_act when 'claim' then r.may_claim when 'release' then r.may_release
                               when 'delegate' then r.may_delegate when 'cancel' then r.may_cancel else r.may_see end, false) then
    raise exception 'You cannot % this task.', case p_right when 'act' then 'complete' when 'see' then 'see' else p_right end;
  end if;
  return t;
end
$$;

create function meta.task_log(p_id bigint, p_event text, p_detail text default null) returns void
language sql security definer set search_path = meta, pg_catalog as $$
  insert into task_event (task_id, username, event, detail) values (p_id, meta.app_user(), p_event, nullif(btrim(p_detail), ''));
$$;

-- Create a task (application SQL). p_owners: usernames who may act, on top of the definition's roles.
create function meta.create_task(p_name text, p_detail_pk text default null, p_params jsonb default '{}',
                                 p_owners text[] default '{}', p_priority int default null) returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  d         meta.task_definition;
  v_subject text;
  v_id      bigint;
  kv        record;
begin
  select * into d from task_definition where app_id = meta.app_id() and name = upper(p_name);
  if not found then
    raise exception 'Task definition % does not exist in this application.', p_name;
  end if;
  if jsonb_typeof(coalesce(p_params, '{}')) <> 'object' then
    raise exception 'Task parameters must be a JSON object.';
  end if;
  v_subject := d.subject;
  for kv in select key, value from jsonb_each_text(coalesce(p_params, '{}')) loop
    v_subject := replace(v_subject, '&' || upper(kv.key) || '.', coalesce(kv.value, ''));
  end loop;
  v_subject := replace(v_subject, '&DETAIL_PK.', coalesce(p_detail_pk, ''));
  insert into task (app_id, definition_id, subject, detail_pk, params, priority, initiator, owner_users, owner_roles, due_at)
  values (d.app_id, d.id, left(v_subject, 500), p_detail_pk, coalesce(p_params, '{}'), coalesce(p_priority, d.priority),
          meta.app_user(), array(select distinct lower(u) from unnest(coalesce(p_owners, '{}')) u where u is not null),
          array(select distinct lower(r) from unnest(d.owner_roles) r), now() + d.due_in::interval)
  returning id into v_id;
  perform meta.task_log(v_id, 'created');
  return v_id;
end
$$;

create function meta.claim_task(p_id bigint) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  perform meta.task_load(p_id, 'claim');
  update task set state = 'assigned', actual_owner = meta.app_user() where id = p_id;
  perform meta.task_log(p_id, 'claimed');
end
$$;

create function meta.release_task(p_id bigint) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  perform meta.task_load(p_id, 'release');
  update task set state = 'unassigned', actual_owner = null where id = p_id;
  perform meta.task_log(p_id, 'released');
end
$$;

-- To another account with access to the application.
create function meta.delegate_task(p_id bigint, p_to text) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  t      meta.task;
  v_to   text;
begin
  t := meta.task_load(p_id, 'delegate');
  select ac.username into v_to
    from account ac join app a on a.id = t.app_id
   where lower(ac.username) = lower(btrim(p_to)) and ac.active
     and (a.access_control = 'any_user' or exists (select 1 from app_access aa where aa.app_id = a.id and aa.account_id = ac.id));
  if v_to is null then
    raise exception '% is not a user of this application.', p_to;
  end if;
  if lower(v_to) = lower(t.initiator) and not (select initiator_can_complete from task_definition where id = t.definition_id) then
    raise exception 'The task cannot go to the person who requested it.';
  end if;
  update task set state = 'assigned', actual_owner = v_to,
                  owner_users = array(select distinct u from unnest(owner_users || lower(v_to)) u)
   where id = p_id;
  perform meta.task_log(p_id, 'delegated', v_to);
end
$$;

create function meta.cancel_task(p_id bigint, p_comment text default null) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  perform meta.task_load(p_id, 'cancel');
  update task set state = 'cancelled', completed_at = now(), completed_by = meta.app_user() where id = p_id;
  perform meta.task_log(p_id, 'cancelled', p_comment);
end
$$;

create function meta.add_task_comment(p_id bigint, p_text text) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  if coalesce(btrim(p_text), '') = '' then
    raise exception 'The comment is empty.';
  end if;
  perform meta.task_load(p_id, 'see');
  perform meta.task_log(p_id, 'commented', left(p_text, 4000));
end
$$;

-- Approve, reject (approvals) or complete (action tasks). Returns what the definition's action needs
-- ({"action_code", "detail_pk", "params", "initiator"}): pgapex runs that SQL next, in the same
-- transaction, as the application's role.
create function meta.complete_task(p_id bigint, p_outcome text, p_comment text default null) returns jsonb
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  t meta.task;
  d meta.task_definition;
begin
  t := meta.task_load(p_id, 'act');
  select * into d from task_definition where id = t.definition_id;
  if not (d.type = 'approval' and lower(p_outcome) in ('approved', 'rejected') or d.type = 'action' and lower(p_outcome) = 'completed') then
    raise exception 'A % task cannot end as %.', d.type, p_outcome;
  end if;
  update task set state = 'completed', outcome = lower(p_outcome), completed_at = now(), completed_by = meta.app_user(),
                  actual_owner = coalesce(actual_owner, meta.app_user())
   where id = p_id;
  perform meta.task_log(p_id, lower(p_outcome), p_comment);
  return jsonb_build_object('action_code', d.action_code, 'detail_pk', t.detail_pk, 'params', t.params, 'initiator', t.initiator);
end
$$;

-- Application SQL: close the open tasks of a record that was decided elsewhere (no action SQL runs).
create function meta.close_tasks(p_name text, p_detail_pk text, p_outcome text default null) returns int
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_n int := 0;
  v_id bigint;
begin
  if p_outcome is not null and lower(p_outcome) not in ('approved', 'rejected', 'completed') then
    raise exception 'Invalid outcome %.', p_outcome;
  end if;
  for v_id in
    update task t set state = case when p_outcome is null then 'cancelled' else 'completed' end,
                      outcome = lower(p_outcome), completed_at = now(), completed_by = meta.app_user()
      from task_definition d
     where d.id = t.definition_id and d.app_id = meta.app_id() and d.name = upper(p_name)
       and t.detail_pk = p_detail_pk and t.state in ('unassigned', 'assigned')
    returning t.id
  loop
    perform meta.task_log(v_id, 'closed', p_outcome);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

revoke all on function meta.task_load(bigint, text), meta.task_log(bigint, text, text) from public;
grant execute on function meta.create_task(text, text, jsonb, text[], int), meta.claim_task(bigint), meta.release_task(bigint),
  meta.delegate_task(bigint, text), meta.cancel_task(bigint, text), meta.add_task_comment(bigint, text),
  meta.complete_task(bigint, text, text), meta.close_tasks(text, text, text), meta.task_rights(meta.task) to public;

-- Export and import: task definitions travel with the application (tasks don't). Same as 020, plus "task_definitions".
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
