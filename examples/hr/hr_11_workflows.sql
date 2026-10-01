-- =====================================================================
-- HR example, part 11: a workflow (docs/guide/06-processing.md)
--
-- Creating an employee on the employee form starts ONBOARDING:
--   1. PREPARE      the manager (or an administrator) prepares the workplace (a task)
--   2. NEEDS_ACCESS employees with a salary of 2500 or more also need access to HR Demo …
--   3. ACCESS       … which an administrator gives (a task)
--   4. WELCOME      the manager gets a notification (SQL)
-- Follow it under My tasks (page 14): "Workflows I started" and, for administrators, all of them.
-- =====================================================================
insert into meta.task_definition (app_id, name, type, subject, owner_roles, admin_role, initiator_can_complete, priority, due_in)
select id, 'ONBOARD_PREPARE', 'action', 'Prepare the workplace of &ENAME.', '{admin}'::text[], 'admin', true, 2, '3 days' from meta.app where alias = 'hr'
union all
select id, 'ONBOARD_ACCESS', 'action', 'Give &ENAME. access to HR Demo', '{admin}'::text[], 'admin', true, 3, '5 days' from meta.app where alias = 'hr';

-- Notifications are for other users, which RLS forbids the app: security definer, like the leave notifications.
create function hr.onboarding_done(p_empno int) returns timestamptz
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  insert into hr.notification (username, message)
  select m.username, format('%s is ready to start.', initcap(e.ename))
    from hr.emp e join hr.emp m on m.empno = e.mgr
   where e.empno = p_empno and m.username is not null;
  return now();
end
$$;
revoke all on function hr.onboarding_done(int) from public;
grant execute on function hr.onboarding_done(int) to hr_app;

insert into meta.workflow_definition (app_id, name, title, description, admin_role, steps)
select id, 'ONBOARDING', 'Onboarding of &ENAME.', 'From a new employee record to a prepared workplace.', 'admin',
$s$[
  {"name": "PREPARE", "type": "task", "task": "ONBOARD_PREPARE",
   "owners": "select m.username from hr.emp e join hr.emp m on m.empno = e.mgr where e.empno = :DETAIL_PK::int and m.username is not null"},
  {"name": "NEEDS_ACCESS", "type": "switch", "cases": [{"when": ":SAL::numeric >= 2500", "next": "ACCESS"}], "otherwise": "WELCOME"},
  {"name": "ACCESS", "type": "task", "task": "ONBOARD_ACCESS"},
  {"name": "WELCOME", "type": "sql", "code": "select hr.onboarding_done(:DETAIL_PK::int) as welcomed_at"},
  {"name": "END", "type": "end"}
]$s$::jsonb
  from meta.app where alias = 'hr';

-- the employee form's Create button starts it, after the row is inserted (P3_EMPNO is then known)
insert into meta.process (page_id, seq, name, type, code, when_button)
select p.id, 15, 'Start onboarding', 'sql',
       $c$select meta.start_workflow('ONBOARDING', :P3_EMPNO, jsonb_build_object('ENAME', initcap(:P3_ENAME), 'SAL', :P3_SAL))$c$, 'CREATE'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 3;

insert into meta.region (page_id, seq, title, type, columns, template, config)
select p.id, 25, 'Workflows I started', 'workflows', 12, 'collapsible', '{"completed": true}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 14;
insert into meta.region (page_id, seq, title, type, columns, template, config, authz)
select p.id, 40, 'All workflows (administrators)', 'workflows', 12, 'collapsible', '{"context": "admin", "completed": true}', 'ADMIN'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 14;
