-- =====================================================================
-- HR example, part 39: a Data Reporter (docs/guide/04-pages-and-regions.md,
-- "Data Reporter")
--
-- Page 36 "My reports": business users build their own reports from two
-- data sources the developer offers in the region's settings:
--   - "Employees": the view hr.staff_v (employees with their department),
--     without the user name and photo columns;
--   - "Leave requests": hr.leave_request, whose row level security still
--     applies: an employee sees only their own requests, a manager their
--     team's, an administrator all.
-- Users pick columns, add filters, group with totals, sort, draw a chart,
-- and save reports privately or shared with everyone. King's shared report
-- "Salary by department" is there to start from.
-- =====================================================================

create view hr.staff_v with (security_invoker = true) as
  select e.empno, e.ename, e.job, e.hiredate, e.sal, e.comm, d.dname, d.loc, e.active, e.username
    from hr.emp e left join hr.dept d on d.deptno = e.deptno;
grant select on hr.staff_v to hr_app;

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 36, 'My reports', 'My reports', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, config)
select p.id, 10, 'Data Reporter', 'data_reporter', 12, 'standard', $j${
  "page_size": 15,
  "sources": [
    {"id": "employees", "label": "Employees", "description": "Everyone on the payroll, with their department.",
     "schema": "hr", "table": "staff_v",
     "columns": [
       {"name": "empno", "label": "No."},
       {"name": "ename", "label": "Name"},
       {"name": "job", "label": "Job"},
       {"name": "dname", "label": "Department"},
       {"name": "loc", "label": "Location"},
       {"name": "hiredate", "label": "Hire date"},
       {"name": "sal", "label": "Salary", "format": "FML999G990D00"},
       {"name": "comm", "label": "Commission", "format": "FML999G990D00"},
       {"name": "active", "label": "Active"}]},
    {"id": "leave", "label": "Leave requests", "description": "Your own leave requests, or your team's when you are a manager.",
     "schema": "hr", "table": "leave_request",
     "columns": [
       {"name": "id", "label": "Request"},
       {"name": "empno", "label": "Employee no."},
       {"name": "start_date", "label": "From"},
       {"name": "end_date", "label": "To"},
       {"name": "days", "label": "Days"},
       {"name": "status", "label": "Status"},
       {"name": "reason", "label": "Reason"}]}
  ]}$j$::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 36;

-- a shared report to start from (reports are user data: not part of the export)
insert into meta.data_report (app_id, region_id, username, name, description, shared, definition)
select a.id, r.id, 'king', 'Salary by department', 'Head count and salaries per department.', true,
       '{"source": "employees", "columns": [], "filters": [], "group": ["dname"],
         "aggregates": [{"fn": "count", "column": ""}, {"fn": "sum", "column": "sal"}, {"fn": "avg", "column": "sal"}],
         "sort": [{"column": "#2", "desc": true}], "chart": "bar"}'::jsonb
  from meta.app a join meta.page p on p.app_id = a.id and p.page_no = 36 join meta.region r on r.page_id = p.id and r.type = 'data_reporter'
 where a.alias = 'hr';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 28, 'My reports', 'chart', 36 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('My reports', 'Mijn rapporten'),
  ('Data Reporter', 'Rapportbouwer'),
  ('Everyone on the payroll, with their department.', 'Iedereen op de loonlijst, met de afdeling.'),
  ('Leave requests', 'Verlofaanvragen'),
  ('Your own leave requests, or your team''s when you are a manager.', 'Je eigen verlofaanvragen, of die van je team als je manager bent.'),
  ('Department', 'Afdeling'),
  ('Location', 'Locatie'),
  ('Hire date', 'Datum in dienst'),
  ('Salary', 'Salaris'),
  ('Commission', 'Commissie'),
  ('Active', 'Actief'),
  ('Employee no.', 'Personeelsnr.'),
  ('From', 'Van'),
  ('To', 'Tot'),
  ('Days', 'Dagen'),
  ('Reason', 'Reden'),
  ('Request', 'Aanvraag')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
