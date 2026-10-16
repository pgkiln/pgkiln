-- =====================================================================
-- HR example, part 62: a REST module built in SQL Workshop › RESTful
-- Services (sprint 104; docs/guide/13-rest-api.md → Modules, templates
-- and handlers). Module "hr" at /a/hr/rest/hr/, with a token from
-- App › REST API:
--
--   emp/                 GET   collection query: the active employees
--   emp/:id              GET   single row: one employee
--   emp/:id/photo        GET   media: the employee's photo
--   leave                POST  PL/pgSQL: request leave with
--                              {"start_date": "…", "end_date": "…", "reason": "…"}
--   payroll/:deptno      GET   collection query; managers and administrators only
-- =====================================================================
insert into meta.rest_module (app_id, name, title, description, templates, handlers)
select id, 'hr', 'HR (RESTful Services)', 'Employees and leave requests: a module of templates and handlers.',
$t$[
  {"uri": "emp", "description": "The employees"},
  {"uri": "emp/:id", "description": "One employee by number"},
  {"uri": "emp/:id/photo", "description": "An employee's photo"},
  {"uri": "leave", "description": "Leave requests of the caller"},
  {"uri": "payroll/:deptno", "description": "Payroll of a department"}
]$t$::jsonb,
$h$[
  {"method": "GET", "path": "emp", "type": "collection", "description": "The active employees",
   "source": "select empno, initcap(ename) as name, initcap(job) as job, deptno from hr.emp where active order by empno"},
  {"method": "GET", "path": "emp/:id", "type": "item", "description": "One employee",
   "source": "select empno, initcap(ename) as name, initcap(job) as job, deptno, hiredate, mgr from hr.emp where empno = :ID::int"},
  {"method": "GET", "path": "emp/:id/photo", "type": "media", "description": "The employee's photo",
   "source": "select photo_mime as content_type, photo as content, photo_name as filename from hr.emp where empno = :ID::int and photo is not null"},
  {"method": "POST", "path": "leave", "type": "plpgsql", "description": "Request leave (as the caller)",
   "params": [{"name": "start_date", "in": "body", "type": "string", "required": true, "description": "First day (YYYY-MM-DD)"},
              {"name": "end_date", "in": "body", "type": "string", "required": true, "description": "Last day (YYYY-MM-DD)"},
              {"name": "reason", "in": "body", "type": "string"}],
   "source": "declare\n  v_id int;\nbegin\n  v_id := hr.request_leave(:START_DATE::date, :END_DATE::date, :REASON);\n  perform meta.rest_reply(jsonb_build_object('id', v_id, 'status', 'requested'), 201);\nend"},
  {"method": "GET", "path": "payroll/:deptno", "type": "collection", "roles": ["manager", "admin"], "description": "Salaries of a department",
   "source": "select empno, initcap(ename) as name, sal from hr.emp where deptno = :DEPTNO::int and active order by empno"}
]$h$::jsonb
  from meta.app where alias = 'hr'
on conflict (app_id, name) do nothing;
