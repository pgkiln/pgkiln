-- =====================================================================
-- HR example, part 13: REST endpoints defined in the builder
-- (docs/guide/13-rest-api.md → REST modules)
--
-- /a/hr/rest/v1/… served by pgkiln with a token from App → REST API:
--   GET  employees            the active employees (paged)
--   GET  employees/:empno     one employee
--   GET  my/leave             the caller's own leave requests (row level security)
--   POST leave                request leave: {"start_date": "…", "end_date": "…", "reason": "…"}
--   GET  departments          public: no token
--   GET  reports/payroll      managers and administrators only
-- =====================================================================
insert into meta.rest_module (app_id, name, title, description, handlers)
select id, 'v1', 'HR API', 'Employees, departments and leave requests of the HR example.',
$h$[
  {"method": "GET", "path": "employees", "type": "collection", "description": "The active employees",
   "source": "select empno, initcap(ename) as name, initcap(job) as job, deptno from hr.emp where active order by empno"},
  {"method": "GET", "path": "employees/:empno", "type": "item", "description": "One employee",
   "source": "select empno, initcap(ename) as name, initcap(job) as job, deptno, hiredate, mgr from hr.emp where empno = :EMPNO::int"},
  {"method": "GET", "path": "my/leave", "type": "collection", "description": "My leave requests",
   "source": "select id, start_date, end_date, days, status, reason from hr.leave_request where empno = hr.current_empno() order by start_date desc"},
  {"method": "POST", "path": "leave", "type": "sql", "description": "Request leave (as the caller)",
   "source": "select hr.request_leave(:START_DATE::date, :END_DATE::date, :REASON) as id"},
  {"method": "GET", "path": "departments", "type": "collection", "auth": "public", "description": "The departments (no token needed)",
   "source": "select deptno, dname, initcap(loc) as location from hr.dept order by deptno"},
  {"method": "GET", "path": "reports/payroll", "type": "collection", "roles": ["manager", "admin"], "description": "Payroll per department",
   "source": "select d.dname, count(e.empno)::int as employees, coalesce(sum(e.sal), 0) as payroll from hr.dept d left join hr.emp e on e.deptno = d.deptno group by d.dname order by d.dname"}
]$h$::jsonb
  from meta.app where alias = 'hr';
