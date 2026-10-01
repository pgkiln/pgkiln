-- =====================================================================
-- HR sample, part 3: a REST API with PostgREST (see docs/guide/13-rest-api.md)
--
-- The `api` schema is the contract for outside clients: views and
-- functions only, never the base tables. Views are security_invoker, so
-- the row level security policies of hr.* apply to the API caller, with
-- the same meta.app_user() / meta.has_role() as in the web app.
-- =====================================================================

create role hr_api nologin;
grant hr_api to pgapex_authenticator;      -- PostgREST may switch to it

update meta.app set api_role = 'hr_api' where alias = 'hr';

create schema api;
grant usage on schema api to hr_api;

-- Base privileges the invoker-rights views and functions need.
grant usage on schema hr to hr_api;
-- Column privileges on hr.emp: no salary or commission, even if another
-- schema were exposed by mistake.
grant select (empno, ename, job, mgr, hiredate, deptno, active, username) on hr.emp to hr_api;
grant select on hr.dept, hr.leave_request, hr.notification to hr_api;
grant insert, update on hr.leave_request to hr_api;
grant update (read_at) on hr.notification to hr_api;
grant execute on all functions in schema hr to hr_api;

-- Employees without salary data: an API exposes only what clients need.
create view api.employees with (security_invoker = true) as
  select e.empno as id, initcap(e.ename) as name, initcap(e.job) as job, d.dname as department,
         m.empno as manager_id, e.hiredate as hired_on, e.active
    from hr.emp e
    left join hr.dept d on d.deptno = e.deptno
    left join hr.emp m on m.empno = e.mgr;

-- Leave requests the caller may see (RLS: own, team, or all for admins).
create view api.leave_requests with (security_invoker = true) as
  select l.id, l.empno as employee_id, initcap(e.ename) as employee, l.start_date, l.end_date, l.days,
         l.reason, l.status, l.decided_by, l.decided_at, l.decision_note, l.created_at
    from hr.leave_request l
    join hr.emp e on e.empno = l.empno;

create view api.my_notifications with (security_invoker = true) as
  select id, message, created_at, read_at from hr.notification;

-- RPC endpoints: POST /rpc/request_leave, POST /rpc/decide_leave
create function api.request_leave(start_date date, end_date date, reason text default null) returns int
language sql as $$ select hr.request_leave(start_date, end_date, reason) $$;

create function api.decide_leave(id int, decision text, note text default null) returns void
language sql as $$ select hr.decide_leave(id, upper(decision), note) $$;

grant select on api.employees, api.leave_requests, api.my_notifications to hr_api;
grant execute on function api.request_leave(date, date, text), api.decide_leave(int, text, text) to hr_api;

-- PostgREST reloads its schema cache on this notification.
notify pgrst, 'reload schema';
