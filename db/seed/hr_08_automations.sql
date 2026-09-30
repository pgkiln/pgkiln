-- =====================================================================
-- HR sample, part 8: automations (see docs/guide/06-processing.md)
--
-- "Remind managers" runs at 08:00 on weekdays (Amsterdam time): for every
-- leave request that has been pending for more than two days it reminds
-- the employee's manager, at most once a day per request. It runs as
-- hr_app with the role admin, so the leave_visible policy lets it see all
-- requests; the reminder itself is written by a security definer function,
-- like the other notifications.
-- =====================================================================
create function hr.remind_pending_leave(p_id int) returns boolean
language plpgsql security definer set search_path = hr, pg_catalog as $$
declare
  v_message text;
  v_manager text;
begin
  select m.username, format('Reminder: %s is waiting for your decision on leave from %s (%s day(s)).',
                            e.ename, to_char(l.start_date, 'DD Mon YYYY'), l.days)
    into v_manager, v_message
    from hr.leave_request l
    join hr.emp e on e.empno = l.empno
    join hr.emp m on m.empno = e.mgr
   where l.id = p_id and l.status = 'PENDING' and m.username is not null;
  if v_manager is null
     or exists (select 1 from hr.notification n
                 where n.username = v_manager and n.message = v_message and n.created_at > now() - interval '20 hours') then
    return false;
  end if;
  insert into hr.notification (username, message) values (v_manager, v_message);
  return true;
end
$$;
revoke all on function hr.remind_pending_leave(int) from public;
grant execute on function hr.remind_pending_leave(int) to hr_app;

insert into meta.automation (app_id, name, description, enabled, schedule, time_zone, query, code, roles)
select id, 'Remind managers', 'Remind managers of leave requests pending for more than two days.', true,
       '0 8 * * 1-5', 'Europe/Amsterdam',
       E'select id from hr.leave_request\n where status = ''PENDING'' and created_at < now() - interval ''2 days''',
       'select hr.remind_pending_leave(:ID::int);',
       '{admin}'
  from meta.app where alias = 'hr';
