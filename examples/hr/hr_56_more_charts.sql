-- =====================================================================
-- HR example, part 56: range, box plot and stock charts
-- (docs/guide/04-pages-and-regions.md, chart regions)
--
-- On page 32 "Project plan":
--   - a range chart of the salary range per department (lowest and
--     highest salary), drilling down to the department's employees;
--   - a box plot of the salaries per job, computed from one row per
--     employee;
--   - a stock chart of a made-up share price over the last 30 working
--     days (open, high, low and close), generated in the query.
-- =====================================================================

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.cols, r.tpl, r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (60, 'Salary range per department', 'chart', 4, 'standard',
   $q$select d.dname as "Department", min(e.sal) as "Lowest", max(e.sal) as "Highest", d.deptno
  from hr.dept d join hr.emp e on e.deptno = d.deptno and e.active
 group by d.deptno, d.dname
 order by d.dname$q$,
   '{"kind": "range", "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (70, 'Salaries per job', 'chart', 4, 'standard',
   $q$select e.job as "Job", e.sal as "Salary"
  from hr.emp e
 where e.active
 order by e.job$q$,
   '{"kind": "boxplot"}'),
  (80, 'Share price (demo data)', 'chart', 4, 'standard',
   $q$with days as (
  select d::date as day, row_number() over (order by d) as n
    from generate_series(current_date - 41, current_date - 1, interval '1 day') d
   where extract(isodow from d) < 6
   order by d desc limit 30
), price as (
  select day, n, 100 + 8 * sin(n / 4.0) + n / 3.0 as mid from days
)
select to_char(day, 'DD Mon') as "Day",
       round((mid - 1.5 * cos(n))::numeric, 2) as "Open",
       round((mid + 2 + abs(sin(n * 1.7)))::numeric, 2) as "High",
       round((mid - 2 - abs(cos(n * 1.3)))::numeric, 2) as "Low",
       round((mid + 1.5 * cos(n))::numeric, 2) as "Close"
  from price
 order by day$q$,
   '{"kind": "stock"}')
) r(seq, title, type, cols, tpl, source, config)
 where a.alias = 'hr' and p.page_no = 32;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Salary range per department', 'Salarisbereik per afdeling'),
  ('Salaries per job', 'Salarissen per functie'),
  ('Share price (demo data)', 'Aandelenkoers (voorbeeldgegevens)')
) t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
