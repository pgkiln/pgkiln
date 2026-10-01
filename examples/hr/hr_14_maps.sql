-- =====================================================================
-- HR example, part 14: a map and a tree (docs/guide/04-pages-and-regions.md)
--
-- Departments (page 4) get a map of the offices and of employees' work
-- locations (recorded with "Use my location" on the employee form); the
-- org chart (page 8) gets the reporting lines as an expandable tree.
-- =====================================================================
alter table hr.dept add column lat numeric(8, 5), add column lng numeric(8, 5);
update hr.dept set (lat, lng) = (40.71280, -74.00600) where loc = 'NEW YORK';
update hr.dept set (lat, lng) = (32.77670, -96.79700) where loc = 'DALLAS';
update hr.dept set (lat, lng) = (41.87810, -87.62980) where loc = 'CHICAGO';
update hr.dept set (lat, lng) = (42.36010, -71.05890) where loc = 'BOSTON';

insert into meta.region (page_id, seq, title, type, columns, source, config)
select p.id, 5, 'Where we work', 'map', 12,
$q$select deptno::text as id, dname as title, initcap(loc) as body, lat, lng, null as location, deptno
  from hr.dept where lat is not null
union all
select 'e' || empno, initcap(ename), 'Works here (' || initcap(job) || ')', null, null, work_location, deptno
  from hr.emp where work_location is not null$q$,
'{"link": {"page": 5, "items": {"P5_DEPTNO": "#deptno#"}}}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 4;

insert into meta.region (page_id, seq, title, type, columns, source, config)
select p.id, 5, 'Organisation', 'tree', 12,
$q$select empno as id, mgr as parent_id, initcap(ename) || ' · ' || initcap(job) as label,
       case when job = 'PRESIDENT' then 'building' when exists (select 1 from hr.emp r where r.mgr = e.empno) then 'users' else 'user' end as icon
  from hr.emp e order by ename$q$,
'{"link": {"page": 3, "items": {"P3_EMPNO": "#id#"}}, "expanded": 2}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 8;
