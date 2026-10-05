-- =====================================================================
-- HR sample, part 33: an automation with several actions, error handling
-- per row, and a run from application code (see docs/guide/06-processing.md)
--
-- "Remind managers" (part 8) gets a second action: a request that has
-- been pending for a week or more is escalated to the manager's manager.
-- The action has a condition on the row's DAYS_PENDING column. Error
-- handling "skip": a request that fails is rolled back and recorded in
-- the run history, the other requests are still reminded.
--
-- Page 6 (Leave requests) gets a "Send reminders now" button for admins:
-- its process calls meta.run_automation('Remind managers'), which runs the
-- automation at once, in the page's transaction.
-- =====================================================================
create function hr.escalate_pending_leave(p_id int) returns boolean
language plpgsql security definer set search_path = hr, pg_catalog as $$
declare
  v_message text;
  v_head    text;
begin
  select h.username, format('Escalation: %s has been waiting %s day(s) for %s''s decision on leave from %s.',
                            e.ename, current_date - l.created_at::date, m.ename, to_char(l.start_date, 'DD Mon YYYY'))
    into v_head, v_message
    from hr.leave_request l
    join hr.emp e on e.empno = l.empno
    join hr.emp m on m.empno = e.mgr
    join hr.emp h on h.empno = m.mgr
   where l.id = p_id and l.status = 'PENDING' and h.username is not null;
  if v_head is null
     or exists (select 1 from hr.notification n
                 where n.username = v_head and n.message = v_message and n.created_at > now() - interval '20 hours') then
    return false;
  end if;
  insert into hr.notification (username, message) values (v_head, v_message);
  return true;
end
$$;
revoke all on function hr.escalate_pending_leave(int) from public;
grant execute on function hr.escalate_pending_leave(int) to hr_app;

update meta.automation x
   set query = E'select id, current_date - created_at::date as days_pending\n  from hr.leave_request\n where status = ''PENDING'' and created_at < now() - interval ''2 days''',
       error_handling = 'skip',
       description = 'Remind managers of leave requests pending for more than two days; escalate after a week.'
  from meta.app a
 where a.id = x.app_id and a.alias = 'hr' and x.name = 'Remind managers';

update meta.automation_action x set name = 'Remind the manager'
  from meta.app a
 where a.id = x.app_id and a.alias = 'hr' and x.automation_name = 'Remind managers' and x.name = 'Action';

insert into meta.automation_action (app_id, automation_name, seq, name, code, condition)
select id, 'Remind managers', 20, 'Escalate after a week', 'select hr.escalate_pending_leave(:ID::int);', ':DAYS_PENDING::int >= 7'
  from meta.app where alias = 'hr';

-- page 6: run it now (admins)
insert into meta.button (page_id, region_id, seq, name, label, action, authz)
select p.id, r.id, 20, 'SEND_REMINDERS', 'Send reminders now', 'submit', 'ADMIN'
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Requests you can see'
 where a.alias = 'hr' and p.page_no = 6;

insert into meta.process (page_id, seq, name, type, code, when_button, authz, success_message)
select p.id, 50, 'Send reminders', 'sql', E'-- runs the automation now, in this transaction (as APEX_AUTOMATION.EXECUTE)\nselect meta.run_automation(''Remind managers'');',
       'SEND_REMINDERS', 'ADMIN', 'Reminders sent.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 6;
