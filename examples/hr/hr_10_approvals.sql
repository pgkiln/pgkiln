-- =====================================================================
-- HR sample, part 10: approvals and the task list (docs/guide/06-processing.md)
--
-- A leave request creates a LEAVE_APPROVAL task for the employee's manager
-- (administrators see them all). Approving or rejecting it in "My tasks"
-- (page 14) calls hr.decide_leave, the same function as the buttons on the
-- leave request page; a request decided or withdrawn there closes its task.
-- =====================================================================
insert into meta.task_definition (app_id, name, type, subject, admin_role, priority, due_in, details_page, details_item, action_code)
select id, 'LEAVE_APPROVAL', 'approval', 'Leave for &ENAME.: &DAYS. day(s) from &START.', 'admin', 3, '2 days', 7, 'P7_ID',
       'select hr.decide_leave(:DETAIL_PK::int, :OUTCOME, :COMMENT)'
  from meta.app where alias = 'hr';

-- Security definer: the trigger reads the task definition (meta) and the manager's username,
-- whoever inserts the request. Requests outside the HR app (e.g. through the REST API) get no task.
create function hr.leave_task() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
declare
  v_def boolean := exists (select 1 from meta.task_definition d
                            where d.app_id = meta.app_id() and d.name = 'LEAVE_APPROVAL');
begin
  if not v_def then
    return new;
  end if;
  if tg_op = 'INSERT' then
    perform meta.create_task('LEAVE_APPROVAL', new.id::text,
              jsonb_build_object('ENAME', initcap(e.ename), 'DAYS', new.days, 'START', to_char(new.start_date, 'DD Mon YYYY')),
              array_remove(array[m.username], null))
       from hr.emp e left join hr.emp m on m.empno = e.mgr
      where e.empno = new.empno;
  elsif old.status = 'PENDING' and new.status <> 'PENDING' then
    perform meta.close_tasks('LEAVE_APPROVAL', new.id::text,
              case new.status when 'APPROVED' then 'approved' when 'REJECTED' then 'rejected' end);
  end if;
  return new;
end
$$;

create trigger leave_task after insert or update of status on hr.leave_request
  for each row execute function hr.leave_task();

-- tasks for the requests that are already pending, as if their employees had just asked
do $$
declare
  r record;
begin
  perform set_config('pgkiln.app_id', (select id::text from meta.app where alias = 'hr'), true);
  for r in select l.*, e.username from hr.leave_request l join hr.emp e on e.empno = l.empno where l.status = 'PENDING' and e.username is not null loop
    perform set_config('pgkiln.app_user', r.username, true);
    perform meta.create_task('LEAVE_APPROVAL', r.id::text,
              jsonb_build_object('ENAME', initcap(e.ename), 'DAYS', r.days, 'START', to_char(r.start_date, 'DD Mon YYYY')),
              array_remove(array[m.username], null))
       from hr.emp e left join hr.emp m on m.empno = e.mgr
      where e.empno = r.empno;
  end loop;
end $$;

-- Page 14: My tasks
insert into meta.page (app_id, page_no, name, title)
select id, 14, 'My tasks', 'My tasks' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, config)
select p.id, 10, 'Waiting for me', 'tasks', 12, '{"empty": "Nothing waiting for you."}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 14;
insert into meta.region (page_id, seq, title, type, columns, template, config)
select p.id, 20, 'Requested by me', 'tasks', 12, 'collapsible', '{"context": "initiated", "completed": true, "empty": "You have not requested anything that needs approval."}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 14;
insert into meta.region (page_id, seq, title, type, columns, template, config, authz)
select p.id, 30, 'All approvals (administrators)', 'tasks', 12, 'collapsible', '{"context": "admin", "completed": true}', 'ADMIN'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 14;

insert into meta.nav_entry (app_id, label, icon, target_page, seq)
select id, 'My tasks', 'check', 14, 5 from meta.app where alias = 'hr';
