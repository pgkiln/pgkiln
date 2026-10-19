-- =====================================================================
-- HR example, part 67: custom task outcomes, task events and
-- notifications, a Send E-Mail step, drafts and versions of a workflow
-- (migration 123; docs/guide/06-processing.md, "Approvals" and "Workflows")
--
-- SALARY_DECISION is a task with three outcomes instead of Approve / Reject:
-- Yes, No and Undecided. Its owners (role admin) get an e-mail when a task
-- is created (notification SALARY_TASK); when one is completed an event
-- records the decision as a notification for the initiator.
--
-- SALARY_CHANGE asks for that decision and branches on its outcome:
--   1. APPROVE  the task (an administrator decides)
--   2. DECIDE   YES: apply the new salary; UNDECIDED: ask again; otherwise the end
--   3. APPLY    the new salary (SQL)
--   4. TELL     an e-mail to the employee (version 2: a send_mail step)
-- Version 1 had no TELL step and is inactive; version 2 is active; version 3
-- is in development with a draft step (BUDGET_CHECK) that is still a
-- placeholder: it is drawn dashed, and can't be activated until it is
-- replaced. Instances of version 1 can be migrated to version 2 under
-- Shared Components → Workflows → SALARY_CHANGE → Migrate running instances.
--
-- Start one from SQL (e.g. the SQL Workshop, signed in to the application):
--   select meta.start_workflow('SALARY_CHANGE', '7499', '{"ENAME": "Allen", "NEW_SAL": 1760}')
-- and decide on it under My tasks (page 14) as king.
-- =====================================================================

insert into meta.email_template (app_id, name, subject, html_body, text_body)
select id, 'SALARY_TASK', 'To decide: #SUBJECT#',
$h$<p>A salary change waits for your decision: <b>#SUBJECT#</b>.</p>
<p>Requested by #INITIATOR#. Decide under <i>My tasks</i> in HR Demo.</p>$h$,
$t$A salary change waits for your decision: #SUBJECT#.

Requested by #INITIATOR#. Decide under "My tasks" in HR Demo.$t$
  from meta.app where alias = 'hr'
union all
select id, 'SALARY_CHANGED', 'Your salary changes to #NEW_SAL#',
$h$<p>Dear #ENAME#,</p><p>Your new salary of <b>#NEW_SAL#</b> was approved by #TASK_APPROVER#.</p><p>Kind regards,<br>HR</p>$h$,
$t$Dear #ENAME#,

Your new salary of #NEW_SAL# was approved by #TASK_APPROVER#.

Kind regards,
HR$t$
  from meta.app where alias = 'hr';

insert into meta.task_definition (app_id, name, type, subject, owner_roles, admin_role, priority, due_in, outcomes, events, notifications)
select id, 'SALARY_DECISION', 'approval', 'Salary of &ENAME. to &NEW_SAL.', '{admin}'::text[], 'admin', 2, '5 days',
       $o$[{"name": "YES", "label": "Yes", "colour": "success"},
           {"name": "NO", "label": "No", "colour": "danger"},
           {"name": "UNDECIDED", "label": "Undecided", "colour": "warning"}]$o$::jsonb,
       $e$[{"on": "complete", "type": "sql", "code": "select hr.salary_decided(:DETAIL_PK::int, :OUTCOME, :INITIATOR)"}]$e$::jsonb,
       '{"create": "SALARY_TASK"}'::jsonb
  from meta.app where alias = 'hr';

-- Notifications are for other users, which RLS forbids the app: security definer, like the onboarding ones.
create function hr.salary_decided(p_empno int, p_outcome text, p_initiator text) returns void
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  insert into hr.notification (username, message)
  select p_initiator, format('Salary change of %s: %s.', initcap(e.ename), lower(p_outcome))
    from hr.emp e where e.empno = p_empno;
end
$$;
create function hr.salary_change_apply(p_empno int, p_sal numeric) returns timestamptz
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  if p_sal is null or p_sal <= 0 then
    raise exception 'A salary is more than 0.';
  end if;
  update hr.emp set sal = p_sal where empno = p_empno;
  return now();
end
$$;
-- the e-mail address of an employee's account (the accounts are pgkiln's, not the application's)
create function hr.employee_email(p_empno int) returns text
language sql stable security definer set search_path = hr, pg_catalog as $$
  select a.email from hr.emp e join meta.account a on lower(a.username) = lower(e.username) where e.empno = p_empno and a.active
$$;
revoke all on function hr.salary_decided(int, text, text), hr.salary_change_apply(int, numeric), hr.employee_email(int) from public;
grant execute on function hr.salary_decided(int, text, text), hr.salary_change_apply(int, numeric), hr.employee_email(int) to hr_app;

-- version 1, then version 2 (with the e-mail) becomes active, then version 3 in development (a draft step)
insert into meta.workflow_definition (app_id, name, title, description, admin_role, steps)
select id, 'SALARY_CHANGE', 'Salary of &ENAME. to &NEW_SAL.', 'A salary change, decided by an administrator (Yes, No or Undecided).', 'admin',
$s$[
  {"name": "APPROVE", "type": "task", "task": "SALARY_DECISION"},
  {"name": "DECIDE", "type": "switch", "cases": [{"outcome": "YES", "next": "APPLY"}, {"outcome": "UNDECIDED", "next": "APPROVE"}], "otherwise": "END"},
  {"name": "APPLY", "type": "sql", "code": "select hr.salary_change_apply(:DETAIL_PK::int, :NEW_SAL::numeric) as applied_at", "next": "END"},
  {"name": "END", "type": "end"}
]$s$::jsonb
  from meta.app where alias = 'hr';

select meta.new_workflow_version(d.id) from meta.workflow_definition d join meta.app a on a.id = d.app_id where a.alias = 'hr' and d.name = 'SALARY_CHANGE';
update meta.workflow_definition d set dev_steps = $s$[
  {"name": "APPROVE", "type": "task", "task": "SALARY_DECISION"},
  {"name": "DECIDE", "type": "switch", "cases": [{"outcome": "YES", "next": "APPLY"}, {"outcome": "UNDECIDED", "next": "APPROVE"}], "otherwise": "END"},
  {"name": "APPLY", "type": "sql", "code": "select hr.salary_change_apply(:DETAIL_PK::int, :NEW_SAL::numeric) as applied_at"},
  {"name": "TELL", "type": "send_mail", "to": "select hr.employee_email(:DETAIL_PK::int)", "template": "SALARY_CHANGED", "next": "END"},
  {"name": "END", "type": "end"}
]$s$::jsonb
  from meta.app a where a.id = d.app_id and a.alias = 'hr' and d.name = 'SALARY_CHANGE';
select meta.activate_workflow_version(d.id) from meta.workflow_definition d join meta.app a on a.id = d.app_id where a.alias = 'hr' and d.name = 'SALARY_CHANGE';

select meta.new_workflow_version(d.id) from meta.workflow_definition d join meta.app a on a.id = d.app_id where a.alias = 'hr' and d.name = 'SALARY_CHANGE';
update meta.workflow_definition d set dev_steps = $s$[
  {"name": "BUDGET_CHECK", "type": "draft", "note": "check the department's budget", "next": "APPROVE"},
  {"name": "APPROVE", "type": "task", "task": "SALARY_DECISION"},
  {"name": "DECIDE", "type": "switch", "cases": [{"outcome": "YES", "next": "APPLY"}, {"outcome": "UNDECIDED", "next": "APPROVE"}], "otherwise": "END"},
  {"name": "APPLY", "type": "sql", "code": "select hr.salary_change_apply(:DETAIL_PK::int, :NEW_SAL::numeric) as applied_at"},
  {"name": "TELL", "type": "send_mail", "to": "select hr.employee_email(:DETAIL_PK::int)", "template": "SALARY_CHANGED", "next": "END"},
  {"name": "END", "type": "end"}
]$s$::jsonb
  from meta.app a where a.id = d.app_id and a.alias = 'hr' and d.name = 'SALARY_CHANGE';
