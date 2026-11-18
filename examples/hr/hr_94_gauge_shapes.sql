-- =====================================================================
-- HR example, part 94: gauge shapes (sprint 226; Oracle JET status meter,
-- circular status meter and LED gauges; docs/guide/04-pages-and-regions.md
-- "Chart")
--
-- Page 24 (Planner) gets three more gauges on the same numbers as
-- "Monthly payroll against budget (%)": a status meter bar per department,
-- full rings, and status lights. Each still says its status in words, with
-- an icon, and drills down to the department's employees.
-- =====================================================================
insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, 'chart', r.columns, 'standard',
       $q$select d.dname as department, round(100.0 * coalesce(sum(e.sal), 0) / 10000) as "Budget used", d.deptno
  from hr.dept d left join hr.emp e on e.deptno = d.deptno and e.active
 group by d.deptno, d.dname
 order by 1$q$, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (42, 'Budget used: status meters', 6, '{"kind": "gauge", "gauge": {"min": 0, "max": 120, "warning": 80, "critical": 100, "shape": "bar"}, "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (44, 'Budget used: rings', 6, '{"kind": "gauge", "gauge": {"min": 0, "max": 120, "warning": 80, "critical": 100, "shape": "circle"}, "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (46, 'Budget used: status lights', 12, '{"kind": "gauge", "gauge": {"warning": 80, "critical": 100, "shape": "led"}, "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}')
  ) as r (seq, title, columns, config)
 where a.alias = 'hr' and p.page_no = 24
   and not exists (select 1 from meta.region x where x.page_id = p.id and x.title = r.title);

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Budget used: status meters', 'Budget gebruikt: statusmeters'),
  ('Budget used: rings', 'Budget gebruikt: ringen'),
  ('Budget used: status lights', 'Budget gebruikt: statuslampjes')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
