-- =====================================================================
-- HR example, part 28: interactive grid features
-- (docs/guide/04-pages-and-regions.md, "Interactive grid")
--
-- Page 27 "Departments and staff" (managers):
--   * a master grid of departments: the radio button in front of a row puts
--     its number into P27_DEPTNO (a signed link; app.js refreshes the
--     details without reloading the page);
--   * a detail grid of the department's employees: totals in the footer
--     (computed over all its rows), the name column frozen while the grid
--     scrolls sideways, a row actions menu (edit, duplicate, delete, show),
--     new rows get the selected department; users can move, resize and hide
--     columns (Actions → Columns), save grid reports and paste cells from a
--     spreadsheet;
--   * a detail report: the department's jobs.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page, authz)
select id, 27, 'Departments and staff', 'Departments and staff', 4, 'MANAGER' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, table_name, pk_column, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.table_name, r.pk_column, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Departments', 'grid', 12,
   'select deptno, dname, loc from hr.dept',
   'hr.dept', 'deptno',
   '{"page_size": 10, "select_row": {"column": "deptno", "item": "P27_DEPTNO"},
     "headings": {"deptno": "No.", "dname": "Name", "loc": "Location"},
     "columns": {"dname": {"required": true}},
     "aggregates": {"dname": "count"},
     "row_actions": {"duplicate": false}}'),
  (20, 'Staff', 'grid', 12,
   'select empno, ename, job, mgr, hiredate, sal, comm, active, work_location
  from hr.emp
 where deptno = :P27_DEPTNO::int',
   'hr.emp', 'empno',
   '{"page_size": 10, "master": {"item": "P27_DEPTNO", "column": "deptno"},
     "headings": {"empno": "No.", "ename": "Name", "mgr": "Manager", "hiredate": "Hired", "sal": "Salary", "comm": "Commission", "work_location": "Works at"},
     "columns": {"ename": {"required": true}, "job": {"lov": "LOV:JOBS"}},
     "aggregates": {"sal": ["sum", "avg", "max"], "ename": "count"},
     "layout": {"frozen": 1, "order": ["ename", "job", "sal", "comm", "hiredate", "active", "mgr", "work_location", "empno"], "widths": {"ename": 170}},
     "public_reports": "ADMIN",
     "row_actions": {"edit": {"page": 3, "items": {"P3_EMPNO": "#empno#"}}, "duplicate": true, "delete": true,
                     "links": [{"label": "Show employee", "page": 26, "items": {"P26_EMPNO": "#empno#"}}]}}'),
  (30, 'Jobs in the department', 'report', 12,
   'select initcap(job) as job, count(*) as people, sum(sal) as salaries
  from hr.emp
 where deptno = :P27_DEPTNO::int
 group by job
 order by 1',
   null, null,
   '{"master": {"item": "P27_DEPTNO"}, "searchable": false}')
  ) as r (seq, title, type, columns, source, table_name, pk_column, config)
 where a.alias = 'hr' and p.page_no = 27;

insert into meta.item (page_id, region_id, seq, name, label, type)
select p.id, r.id, 10, 'P27_DEPTNO', 'Department', 'hidden'
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Departments'
 where a.alias = 'hr' and p.page_no = 27;

insert into meta.process (page_id, seq, name, type, region_id)
select p.id, r.seq, 'Save ' || r.title, 'grid_dml', r.id
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type = 'grid'
 where a.alias = 'hr' and p.page_no = 27;

insert into meta.nav_entry (app_id, seq, label, icon, target_page, authz)
select id, 28, 'Departments and staff', 'grid', 27, 'MANAGER' from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Departments and staff', 'Afdelingen en personeel'),
  ('Staff', 'Personeel'),
  ('Jobs in the department', 'Functies in de afdeling'),
  ('Show employee', 'Medewerker tonen'),
  ('Hired', 'In dienst'),
  ('Salary', 'Salaris'),
  ('Commission', 'Commissie'),
  ('Works at', 'Werkplek'),
  ('Manager', 'Leidinggevende')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
