-- =====================================================================
-- HR example, part 60: treemap, sunburst and timeline charts
-- (docs/guide/04-pages-and-regions.md, chart regions)
--
-- On page 32 "Project plan":
--   - a treemap of the salaries per department and job (node_id and
--     parent_id make the hierarchy); a department drills down to its
--     employees;
--   - a sunburst of the head count: departments, their jobs and the
--     employees in them;
--   - a timeline of the hires, a lane per department.
-- =====================================================================

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.cols, r.tpl, r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (90, 'Salaries by department and job', 'chart', 6, 'standard',
   $q$select d.dname as "Department or job", 0 as "Salary", 'd' || d.deptno as node_id, null as parent_id, d.deptno
  from hr.dept d
 where exists (select 1 from hr.emp e where e.deptno = d.deptno and e.active)
union all
select initcap(e.job), sum(e.sal), 'd' || e.deptno || '-' || e.job, 'd' || e.deptno, e.deptno
  from hr.emp e
 where e.active
 group by e.deptno, e.job
 order by 3$q$,
   '{"kind": "treemap", "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (100, 'Head count', 'chart', 6, 'standard',
   $q$select d.dname as "Name", 0 as "Employees", 'd' || d.deptno as node_id, null as parent_id
  from hr.dept d
 where exists (select 1 from hr.emp e where e.deptno = d.deptno and e.active)
union all
select distinct initcap(e.job), 0, 'd' || e.deptno || '-' || e.job, 'd' || e.deptno
  from hr.emp e where e.active
union all
select initcap(e.ename), 1, 'e' || e.empno, 'd' || e.deptno || '-' || e.job
  from hr.emp e where e.active
 order by 3$q$,
   '{"kind": "sunburst"}'),
  (110, 'Hires', 'chart', 12, 'standard',
   $q$select initcap(e.ename) as "Employee", e.hiredate as "Hired", null::date as "Until", d.dname as series
  from hr.emp e join hr.dept d using (deptno)
 order by e.hiredate$q$,
   '{"kind": "timeline"}')
  ) r(seq, title, type, cols, tpl, source, config)
 where a.alias = 'hr' and p.page_no = 32;
