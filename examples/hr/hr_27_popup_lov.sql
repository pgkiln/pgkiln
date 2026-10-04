-- =====================================================================
-- HR example, part 27: popup LOV (docs/guide/05-items.md, "Popup LOV")
--
-- Page 26 "Pick an employee": two popup LOVs. The employee list has
-- extra columns (job, department) that the dialog shows; the search runs
-- on the server, page by page. The department list is the shared LOV
-- DEPARTMENTS. Without JavaScript both are plain select lists.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 26, 'Pick an employee', 'Pick an employee', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Pick an employee', 'static', 6, null),
  (20, 'Chosen employee', 'report', 6,
   'select initcap(e.ename) as name, initcap(e.job) as job, d.dname as department, e.sal as salary
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 where e.empno = :P26_EMPNO::int or (:P26_EMPNO is null and e.deptno = :P26_DEPTNO::int)
 order by e.ename')
  ) as r (seq, title, type, columns, source)
 where a.alias = 'hr' and p.page_no = 26;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config, help)
select p.id, r.id, i.seq, i.name, i.label, 'popup_lov', i.lov, i.config::jsonb, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Pick an employee', (values
  (10, 'P26_EMPNO', 'Employee',
   'select initcap(e.ename) as name, e.empno, initcap(e.job) as job, d.dname as department
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 order by e.ename',
   '{"page_size": 5}', 'Search by name, job or department; the dialog shows five employees per page.'),
  (20, 'P26_DEPTNO', 'Department', 'LOV:DEPARTMENTS', '{}', 'A shared list of values.')
  ) as i (seq, name, label, lov, config, help)
 where a.alias = 'hr' and p.page_no = 26;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'SHOW', 'Show', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Pick an employee'
 where a.alias = 'hr' and p.page_no = 26;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 27, 'Pick an employee', 'search', 26 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Pick an employee', 'Kies een medewerker'),
  ('Chosen employee', 'Gekozen medewerker'),
  ('Show', 'Tonen'),
  ('Job', 'Functie'),
  ('Department', 'Afdeling')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
