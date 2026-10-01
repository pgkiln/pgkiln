-- =====================================================================
-- HR example, part 17: a heat map, and a map that filters a report
-- (docs/guide/04-pages-and-regions.md, map region)
--
-- Page 16 "Locations": payroll as a heat map (weighted by salary), and a
-- map of the offices whose visible area filters the employee report below
-- it ("Show this area in the list"). An employee's position is their
-- recorded work location, or else their department's office.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 16, 'Locations', 'Locations', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, 30, 'Employees', 'report', 12, 'standard',
$q$select e.empno, e.ename, e.job, d.dname as department, initcap(d.loc) as office,
       coalesce(split_part(e.work_location, ',', 1)::numeric, d.lat) as lat,
       coalesce(split_part(e.work_location, ',', 2)::numeric, d.lng) as lng
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 where e.active$q$,
'{"page_size": 10, "headings": {"empno": "Number", "ename": "Name", "job": "Job", "department": "Department", "office": "Office", "lat": "Latitude", "lng": "Longitude"}}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 16;

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, 'map', 6, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Payroll by place',
   $q$select coalesce(split_part(e.work_location, ',', 1)::numeric, d.lat) as lat,
       coalesce(split_part(e.work_location, ',', 2)::numeric, d.lng) as lng,
       e.sal as weight, initcap(e.ename) as title
  from hr.emp e join hr.dept d on d.deptno = e.deptno
 where e.active$q$,
   '{"layer": "heat", "height": "medium"}'),
  (20, 'Offices',
   $q$select d.dname as title, initcap(d.loc) || ' · ' || count(e.empno) || ' employees' as body, d.lat, d.lng, d.deptno
  from hr.dept d left join hr.emp e on e.deptno = d.deptno and e.active
 where d.lat is not null
 group by d.deptno$q$,
   '{"height": "medium", "link": {"page": 5, "items": {"P5_DEPTNO": "#deptno#"}}}')
  ) as r (seq, title, source, config)
 where a.alias = 'hr' and p.page_no = 16;

-- the offices map filters the employee report on the same page
update meta.region m
   set config = m.config || jsonb_build_object('report', r.id)
  from meta.region r
 where m.page_id = r.page_id and m.title = 'Offices' and m.type = 'map' and r.type = 'report'
   and r.page_id = (select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 16);

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 25, 'Locations', 'map', 16
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Employees' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Locations', 'Locaties'),
  ('Payroll by place', 'Salarissen per plaats'),
  ('Offices', 'Kantoren'),
  ('Office', 'Kantoor'),
  ('Latitude', 'Breedtegraad'),
  ('Longitude', 'Lengtegraad')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
