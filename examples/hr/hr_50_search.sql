-- =====================================================================
-- HR example, part 50: search configurations and the search region
-- (migration 080; docs/guide/04-pages-and-regions.md, search region)
--
-- Page 42 "Search": one field searches three sources as you type:
--   - EMPLOYEES: a query (employees with their department), each result
--     opens the employee's form (page 3);
--   - DEPARTMENTS: the table hr.dept, each result opens page 5;
--   - SHORTCUTS: the entries of the list HR_SHORTCUTS the user may see.
-- =====================================================================

insert into meta.search_config (app_id, name, label, seq, source_type, source, searchable_columns,
                                title_column, subtitle_column, badge_column, icon, link)
select a.id, c.name, c.label, c.seq, c.source_type, c.source, c.searchable, c.title, c.subtitle, c.badge, c.icon, c.link::jsonb
  from meta.app a, (values
  ('EMPLOYEES', 'Employees', 10, 'sql',
   $q$select e.empno, initcap(e.ename) as name, initcap(e.job) as job, initcap(d.dname) as department
  from hr.emp e left join hr.dept d on d.deptno = e.deptno$q$,
   '{name,job,department}'::text[], 'name', 'job', 'department', 'user', '{"page": 3, "items": {"P3_EMPNO": "#EMPNO#"}}'),
  ('DEPARTMENTS', 'Departments', 20, 'table', 'hr.dept', '{dname,loc}'::text[], 'dname', 'loc', null, 'building',
   '{"page": 5, "items": {"P5_DEPTNO": "#DEPTNO#"}}'),
  ('SHORTCUTS', 'Shortcuts', 30, 'list', 'HR_SHORTCUTS', '{}'::text[], null, null, null, 'link', null)
  ) as c (name, label, seq, source_type, source, searchable, title, subtitle, badge, icon, link)
 where a.alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 42, 'Search', 'Search', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, config)
select p.id, 10, 'Search', 'search', 12, 'standard',
       '{"configs": ["EMPLOYEES", "DEPARTMENTS", "SHORTCUTS"], "placeholder": "Search employees, departments and shortcuts…"}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 42;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 2, 'Search', 'search', 42 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Search', 'Zoeken'),
  ('Employees', 'Medewerkers'),
  ('Departments', 'Afdelingen'),
  ('Shortcuts', 'Snelkoppelingen'),
  ('Search employees, departments and shortcuts…', 'Zoek medewerkers, afdelingen en snelkoppelingen…')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
