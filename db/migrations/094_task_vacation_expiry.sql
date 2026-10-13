-- =====================================================================
-- 094: approvals: vacation rules, and expiry, renewal and escalation of
-- overdue tasks (APEX: Task Definition → Vacation Rule, Expiration Policy)
--
-- Vacation rules: a user of an application names a delegate and a period
-- (meta.set_vacation_rule from the task list). While the rule is active the
-- delegate may act on the tasks the user may act on as a named owner
-- (owner_users) or as the actual owner, checked live in meta.task_rights:
-- when the rule ends, so does the delegate's access. Role owners are not
-- passed on: the role's other members are there for that.
--
-- Expiration policy per task definition (null: overdue tasks stay open):
--   expire    an overdue task ends with state 'expired' (no outcome)
--   renew     its due date moves on by "due in" (up to max_renewals times,
--             default 3), then it expires
--   escalate  once: escalate_role becomes a potential owner, the priority 1,
--             the task unassigned with a new due date; overdue again: expired
-- meta.task_expire_tick() applies it (the server's scheduler, every minute).
-- A workflow waiting for a task that expires goes on with the outcome
-- "expired" (or ends, like a cancelled task, without an "expired" branch).
-- =====================================================================

alter table meta.task_definition
  add column expiration text check (expiration in ('expire', 'renew', 'escalate')),
  add column max_renewals int check (max_renewals between 1 and 100),
  add column escalate_role text check (escalate_role ~ '^\S{1,100}$');
comment on column meta.task_definition.expiration is 'Expiration policy (094): expire, renew or escalate an overdue task; null: it stays open.';

alter table meta.task
  add column renewals int not null default 0,
  add column escalated_at timestamptz;
alter table meta.task drop constraint task_state_check;
alter table meta.task add constraint task_state_check check (state in ('unassigned', 'assigned', 'completed', 'cancelled', 'expired'));
alter table meta.task_event drop constraint task_event_event_check;
alter table meta.task_event add constraint task_event_event_check
  check (event in ('created', 'claimed', 'released', 'delegated', 'approved', 'rejected', 'completed', 'cancelled', 'commented', 'closed',
                   'expired', 'renewed', 'escalated'));

-- ---------------------------------------------------------------- vacation rules
create table meta.task_vacation (
  app_id      int  not null references meta.app on delete cascade,
  username    text not null check (username = lower(username) and length(username) between 1 and 100),
  delegate_to text not null check (delegate_to = lower(delegate_to) and length(delegate_to) between 1 and 100),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  created_at  timestamptz not null default now(),
  primary key (app_id, username),
  check (delegate_to <> username),
  check (ends_at > starts_at)
);
create index on meta.task_vacation (app_id, delegate_to);
revoke all on meta.task_vacation from public;
comment on table meta.task_vacation is 'Vacation rules (094): while active, delegate_to acts on the user''s tasks. User data, not exported.';

/** The users (lower case) of this application whose active vacation rule names the current user. */
create function meta.acting_for() returns text[]
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(array_agg(v.username order by v.username), '{}')
    from task_vacation v
   where v.app_id = meta.app_id() and v.delegate_to = lower(meta.app_user()) and now() >= v.starts_at and now() < v.ends_at
$$;

create function meta.set_vacation_rule(p_delegate text, p_from timestamptz, p_until timestamptz) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_user text := lower(meta.app_user());
  v_to   text := lower(btrim(coalesce(p_delegate, '')));
  v_from timestamptz := coalesce(p_from, now());
begin
  if v_user is null or v_user = 'nobody' then
    raise exception 'Sign in to set a vacation rule.';
  end if;
  if v_to = '' or length(v_to) > 100 or v_to ~ '\s' then
    raise exception 'Name the user who takes over your tasks.';
  end if;
  if v_to = v_user then
    raise exception 'You cannot delegate your tasks to yourself.';
  end if;
  if p_until is null or p_until <= v_from or p_until <= now() then
    raise exception 'The vacation rule ends after it starts, and in the future.';
  end if;
  if p_until > v_from + interval '1 year' then
    raise exception 'A vacation rule lasts at most a year.';
  end if;
  insert into task_vacation (app_id, username, delegate_to, starts_at, ends_at)
  values (meta.app_id(), v_user, v_to, v_from, p_until)
  on conflict (app_id, username) do update
    set delegate_to = excluded.delegate_to, starts_at = excluded.starts_at, ends_at = excluded.ends_at, created_at = now();
end
$$;

create function meta.clear_vacation_rule() returns void
language sql security definer set search_path = meta, pg_catalog as $$
  delete from task_vacation where app_id = meta.app_id() and username = lower(meta.app_user());
$$;

/** The current user's vacation rule in this application (none: no row). */
create function meta.vacation_rule() returns table (delegate_to text, starts_at timestamptz, ends_at timestamptz, active boolean)
language sql stable security definer set search_path = meta, pg_catalog as $$
  select v.delegate_to, v.starts_at, v.ends_at, now() >= v.starts_at and now() < v.ends_at
    from task_vacation v
   where v.app_id = meta.app_id() and v.username = lower(meta.app_user()) and v.ends_at > now()
$$;

revoke all on function meta.acting_for(), meta.set_vacation_rule(text, timestamptz, timestamptz), meta.clear_vacation_rule(), meta.vacation_rule() from public;
grant execute on function meta.acting_for(), meta.set_vacation_rule(text, timestamptz, timestamptz), meta.clear_vacation_rule(), meta.vacation_rule() to public;

-- Same as 072, plus: the delegates of users on vacation act for them (named owners and actual owners).
create or replace function meta.task_rights(t meta.task) returns meta.task_rights
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_user  text := lower(meta.app_user());
  v_for   text[] := meta.acting_for();
  d       meta.task_definition;
  r       meta.task_rights;
  v_open  boolean := t.state in ('unassigned', 'assigned');
  v_mine  boolean := lower(t.actual_owner) = v_user or lower(t.actual_owner) = any (v_for);
begin
  select * into d from task_definition where id = t.definition_id;
  r.is_initiator := lower(t.initiator) = v_user;
  r.is_owner := exists (select 1 from unnest(t.owner_users) u where lower(u) = v_user or lower(u) = any (v_for))
                or exists (select 1 from unnest(t.owner_roles) x where meta.has_role(x));
  r.is_admin := d.admin_role is not null and meta.has_role(d.admin_role);
  r.may_see := t.app_id = meta.app_id() and v_user <> 'nobody'
               and t.tenant_id is not distinct from meta.tenant_id()
               and (r.is_initiator or r.is_owner or r.is_admin or coalesce(v_mine, false));
  -- an initiator may not decide on their own request (unless the definition allows it)
  r.may_act := r.may_see and v_open and (d.initiator_can_complete or not r.is_initiator)
               and (coalesce(v_mine, false) or (t.state = 'unassigned' and r.is_owner));
  r.may_claim := r.may_see and t.state = 'unassigned' and r.is_owner and (d.initiator_can_complete or not r.is_initiator);
  r.may_release := r.may_see and t.state = 'assigned' and coalesce(v_mine, false);
  r.may_delegate := r.may_see and v_open and (coalesce(v_mine, false) or r.is_admin);
  r.may_cancel := r.may_see and v_open and (r.is_initiator or r.is_admin);
  return r;
end
$$;

-- ---------------------------------------------------------------- expiration
create function meta.task_expire_tick() returns int
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  x     record;
  n     int := 0;
  v_due interval;
begin
  for x in
    select t.id, t.due_at, t.renewals, t.escalated_at, t.owner_roles, d.expiration, d.max_renewals, d.escalate_role, d.due_in
      from task t join task_definition d on d.id = t.definition_id
     where t.state in ('unassigned', 'assigned') and t.due_at < now() and d.expiration is not null
     order by t.due_at
     limit 500
       for update of t skip locked
  loop
    v_due := case when x.due_in is not null then x.due_in::interval end;
    if x.expiration = 'renew' and v_due is not null and x.renewals < coalesce(x.max_renewals, 3) then
      update task set due_at = greatest(x.due_at + v_due, now() + v_due), renewals = renewals + 1 where id = x.id;
      insert into task_event (task_id, username, event, detail)
      values (x.id, 'system', 'renewed', format('%s of %s', x.renewals + 1, coalesce(x.max_renewals, 3)));
    elsif x.expiration = 'escalate' and x.escalated_at is null then
      update task
         set owner_roles = case when x.escalate_role is null or x.escalate_role = any (owner_roles) then owner_roles
                                else array_append(owner_roles, lower(x.escalate_role)) end,
             priority = 1, state = 'unassigned', actual_owner = null, escalated_at = now(),
             due_at = case when v_due is not null then now() + v_due end
       where id = x.id;
      insert into task_event (task_id, username, event, detail) values (x.id, 'system', 'escalated', x.escalate_role);
    else
      update task set state = 'expired', completed_at = now() where id = x.id;
      insert into task_event (task_id, username, event) values (x.id, 'system', 'expired');
    end if;
    n := n + 1;
  end loop;
  return n;
end
$$;
revoke all on function meta.task_expire_tick() from public;

-- Same as 022, plus: an expired task wakes its workflow too.
drop trigger task_wakes_workflow on meta.task;
create trigger task_wakes_workflow after update of state on meta.task
  for each row when (new.workflow_id is not null and new.state in ('completed', 'cancelled', 'expired') and old.state is distinct from new.state)
  execute function meta.task_wakes_workflow();
