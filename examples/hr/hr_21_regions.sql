-- =====================================================================
-- HR example, part 21: smart filters, faceted search extensions and the
-- region display selector (docs/guide/04-pages-and-regions.md)
--
-- Page 21 "Explore" has three tabs (a display_selector region):
--   Smart filters   one search field with chips and suggestions over a
--                   report (job, department, salary ranges)
--   Faceted search  the 26.1 facet kinds: a search field, a job facet with
--                   "exclude", salary ranges with a custom from/to, a hire
--                   date range and a star rating (a demo number per row)
--   Salaries        a chart, a tab of its own
-- Without JavaScript all regions show, with links to each.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 21, 'Explore', 'Explore employees', 2 from meta.app where alias = 'hr';

with p as (select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 21),
src as (select $q$select initcap(e.ename) as name, initcap(e.job) as job, d.dname as department,
       e.sal as salary, e.hiredate, 1 + e.empno % 5 as rating
  from hr.emp e
  left join hr.dept d on d.deptno = e.deptno$q$ as sql),
smart_report as (
  insert into meta.region (page_id, seq, title, type, columns, source, config)
  select p.id, 20, 'Employees', 'report', 12, src.sql,
         '{"page_size": 10, "searchable": false, "display_selector": "Smart filters", "headings": {"rating": "Rating (demo)"}}'
    from p, src
  returning id, page_id
),
facet_report as (
  insert into meta.region (page_id, seq, title, type, columns, source, config)
  select p.id, 40, 'Employee list', 'report', 9, src.sql,
         '{"page_size": 10, "searchable": false, "display_selector": "Faceted search", "headings": {"rating": "Rating (demo)"}}'
    from p, src
  returning id, page_id
)
insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select x.page_id, x.seq, x.title, x.type, x.columns, x.template, x.source, x.config
  from (
    select p.id as page_id, 5 as seq, 'Views' as title, 'display_selector' as type, 12 as columns, 'plain' as template, null::text as source,
           '{}'::jsonb as config
      from p
    union all
    select s.page_id, 10, 'Find employees', 'smart_filters', 12, 'plain', null,
           jsonb_build_object('report', s.id, 'display_selector', 'Smart filters', 'placeholder', 'Search or filter employees…',
             'facets', jsonb_build_array(
               jsonb_build_object('column', 'job', 'label', 'Job'),
               jsonb_build_object('column', 'department', 'label', 'Department'),
               jsonb_build_object('column', 'salary', 'label', 'Salary', 'type', 'range', 'ranges', jsonb_build_array(
                 jsonb_build_object('to', 1500, 'label', 'Below 1500'),
                 jsonb_build_object('from', 1500, 'to', 3000, 'label', '1500 – 3000'),
                 jsonb_build_object('from', 3000, 'label', '3000 or more')))))
      from smart_report s
    union all
    select f.page_id, 30, 'Filter', 'facets', 3, 'standard', null,
           jsonb_build_object('report', f.id, 'search', true, 'display_selector', 'Faceted search',
             'facets', jsonb_build_array(
               jsonb_build_object('column', 'job', 'label', 'Job', 'exclude', true),
               jsonb_build_object('column', 'salary', 'label', 'Salary', 'type', 'range', 'custom', true, 'ranges', jsonb_build_array(
                 jsonb_build_object('to', 1500, 'label', 'Below 1500'),
                 jsonb_build_object('from', 1500, 'to', 3000, 'label', '1500 – 3000'),
                 jsonb_build_object('from', 3000, 'label', '3000 or more'))),
               jsonb_build_object('column', 'hiredate', 'label', 'Hired', 'type', 'range'),
               jsonb_build_object('column', 'rating', 'label', 'Rating (demo)', 'type', 'star', 'max', 5)))
      from facet_report f
    union all
    select p.id, 50, 'Average salary by job', 'chart', 12, 'standard',
           $q$select initcap(job) as job, round(avg(sal)) as "Average salary" from hr.emp group by 1 order by 2 desc$q$,
           '{"kind": "column", "display_selector": "Salaries"}'
      from p
  ) x;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 35, 'Explore', 'search', 21
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Employees' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Explore', 'Verkennen'),
  ('Explore employees', 'Medewerkers verkennen'),
  ('Views', 'Weergaven'),
  ('Find employees', 'Medewerkers zoeken'),
  ('Search or filter employees…', 'Medewerkers zoeken of filteren…'),
  ('Smart filters', 'Slimme filters'),
  ('Faceted search', 'Gefacetteerd zoeken'),
  ('Salaries', 'Salarissen'),
  ('Employee list', 'Medewerkerslijst'),
  ('Average salary by job', 'Gemiddeld salaris per functie'),
  ('Salary', 'Salaris'),
  ('Hired', 'In dienst'),
  ('Rating (demo)', 'Beoordeling (demo)'),
  ('Below 1500', 'Onder 1500'),
  ('3000 or more', '3000 of meer')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
