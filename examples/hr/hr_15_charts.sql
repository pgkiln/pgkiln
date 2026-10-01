-- =====================================================================
-- HR example, part 15: more chart types (docs/guide/04-pages-and-regions.md)
--
-- An Analytics page (15) with a stacked column, a column-and-line combo,
-- a scatter and a pie chart.
-- =====================================================================
insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 15, 'Analytics', 'Analytics', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.cols, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Headcount by department and job', 'chart', 6,
   E'select d.dname as department,\n       count(e.empno) filter (where e.job = ''CLERK'') as "Clerk",\n       count(e.empno) filter (where e.job = ''SALESMAN'') as "Salesman",\n       count(e.empno) filter (where e.job = ''ANALYST'') as "Analyst",\n       count(e.empno) filter (where e.job in (''MANAGER'', ''PRESIDENT'')) as "Management"\n  from hr.dept d left join hr.emp e using (deptno)\n group by d.dname order by 1',
   '{"kind": "stacked"}'),
  (20, 'Salary budget and average by job', 'chart', 6,
   E'select initcap(job) as job, sum(sal) as "Salary budget", round(avg(sal)) as "Average salary"\n  from hr.emp group by job order by 2 desc',
   '{"kind": "combo"}'),
  (30, 'Salary by years of service', 'chart', 6,
   E'select extract(year from age(current_date, hiredate))::int as "Years of service", sal as "Salary"\n  from hr.emp where active order by 1',
   '{"kind": "scatter"}'),
  (40, 'Employees by location', 'chart', 6,
   E'select initcap(d.loc) as location, count(*) as "Employees"\n  from hr.emp e join hr.dept d using (deptno) group by d.loc order by 2 desc',
   '{"kind": "pie"}')
) r(seq, title, type, cols, source, config)
 where a.alias = 'hr' and p.page_no = 15;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 2, 'Analytics', 'chart', 15 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Analytics', 'Analyse'),
  ('Headcount by department and job', 'Medewerkers per afdeling en functie'),
  ('Salary budget and average by job', 'Salarisbudget en gemiddelde per functie'),
  ('Salary by years of service', 'Salaris naar dienstjaren'),
  ('Employees by location', 'Medewerkers per locatie')
) t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
