-- =====================================================================
-- 072: tenants for workflows and tasks (APEX: APEX_SESSION.SET_TENANT_ID,
-- multi-tenant workflows and approvals)
--
-- An application that serves several customers from one set of tables sets
-- the session's tenant once the user signed in: select meta.set_tenant('acme').
-- Workflows and tasks started in that session carry the tenant; the task
-- list, the workflow console, meta.tasks / meta.workflows and every task and
-- workflow action then only reach the ones of the session's tenant (a
-- session without a tenant: only those without one). Tasks a workflow
-- creates get the workflow's tenant (the server runs its steps with it).
-- The runtime sets pgapex.tenant_id from meta.session.tenant_id at the
-- start of every transaction (src/db.ts appTx).
-- =====================================================================

alter table meta.session add column tenant_id text check (length(tenant_id) between 1 and 200);

/** The current session's tenant, or null. */
create function meta.tenant_id() returns text
language sql stable as $$
  select nullif(current_setting('pgapex.tenant_id', true), '')
$$;

/** Set (or with null clear) the current session's tenant; it applies at once and to the session's next requests. */
create function meta.set_tenant(p_tenant text) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_tenant text := nullif(btrim(p_tenant), '');
begin
  if length(v_tenant) > 200 then
    raise exception 'A tenant id is at most 200 characters.';
  end if;
  update session set tenant_id = v_tenant
   where id = nullif(current_setting('pgapex.session_id', true), '')::uuid
     and app_id = meta.app_id();
  perform set_config('pgapex.tenant_id', coalesce(v_tenant, ''), true);
end
$$;
revoke all on function meta.set_tenant(text) from public;
grant execute on function meta.tenant_id(), meta.set_tenant(text) to public;

alter table meta.workflow add column tenant_id text default meta.tenant_id();
alter table meta.task add column tenant_id text default meta.tenant_id();
create index on meta.workflow (app_id, tenant_id);
create index on meta.task (app_id, tenant_id);

-- Same as 021, plus: only tasks of the session's tenant.
create or replace function meta.task_rights(t meta.task) returns meta.task_rights
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
               and t.tenant_id is not distinct from meta.tenant_id()
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

-- Same as 021, plus the tenant (the rows are already the session's tenant's).
create or replace view meta.tasks with (security_barrier) as
  select t.id, t.app_id, d.name as definition, d.type, t.subject, t.detail_pk, t.params, t.state, t.outcome,
         t.priority, t.initiator, t.actual_owner, t.owner_users, t.owner_roles, t.created_at, t.due_at,
         t.completed_at, t.completed_by, d.details_page, d.details_item,
         t.due_at is not null and t.due_at < now() and t.state in ('unassigned', 'assigned') as overdue,
         (r).is_initiator, (r).is_owner, (r).is_admin, (r).may_act, (r).may_claim, (r).may_release, (r).may_delegate, (r).may_cancel,
         t.tenant_id
    from (select t, meta.task_rights(t) as r from meta.task t where t.app_id = meta.app_id()) x
    cross join lateral (select (x.t).*) t
    join meta.task_definition d on d.id = t.definition_id
   where (x.r).may_see;

-- Same as 027, plus: only workflows of the session's tenant (terminate and retry check this view).
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
                  case when w.state in ('active', 'waiting', 'faulted') and w.current_step is not null then array[w.current_step] else '{}'::text[] end) as active_steps,
         w.tenant_id
    from meta.workflow w
   where w.app_id = meta.app_id() and meta.app_user() <> 'nobody'
     and w.tenant_id is not distinct from meta.tenant_id()
     and (lower(w.initiator) = lower(meta.app_user()) or (w.admin_role is not null and meta.has_role(w.admin_role)));

-- An execution chain in the background runs for the tenant of the session that queued it.
alter table meta.process_job add column tenant_id text default meta.tenant_id();
