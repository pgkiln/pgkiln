-- =====================================================================
-- HR example, part 35: Gantt, pyramid and polar charts
-- (docs/guide/04-pages-and-regions.md, chart regions)
--
-- Page 32 "Project plan":
--   - a Gantt chart of the office move project (hr.project_task): start
--     and end dates, progress and dependencies (task_id, depends_on); a
--     task drills down to the employee list of the department in charge;
--   - a Gantt chart of the leave requests the user may see (RLS), each
--     request drilling down to its form;
--   - a pyramid of the organisation's levels (from the manager hierarchy),
--     a population-style pyramid of salary bands in Research and Sales,
--     and a polar chart of hires per month.
-- =====================================================================

create table hr.project_task (
  id         int primary key,
  name       text not null,
  starts     date not null,
  ends       date,
  progress   int not null default 0 check (progress between 0 and 100),
  depends_on int[] not null default '{}',
  deptno     int references hr.dept,
  check (ends is null or ends >= starts)
);
grant select on hr.project_task to hr_app;

-- the office move, around today (Monday of this week = d)
insert into hr.project_task (id, name, starts, ends, progress, depends_on, deptno)
select x.id, x.name, d + x.s, d + x.e, x.p, x.deps, x.dept
  from (select date_trunc('week', current_date)::date as d) w(d),
       (values (1, 'Choose the new office', -21, -10, 100, '{}'::int[], 10),
               (2, 'Sign the lease',          -9,  -7, 100, '{1}',        10),
               (3, 'Plan the floor layout',   -6,   4,  60, '{2}',        20),
               (4, 'Order furniture',          1,  12,  20, '{3}',        30),
               (5, 'Network and phones',       5,  15,   0, '{3}',        20),
               (6, 'Pack and move',           16,  19,   0, '{4,5}',      30),
               (7, 'Opening day',             20, null,  0, '{6}',        10)
       ) x(id, name, s, e, p, deps, dept);

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 32, 'Project plan', 'Project plan', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.cols, r.tpl, r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Office move', 'chart', 12, 'standard',
   $q$select t.name as "Task", t.starts as "Starts", t.ends as "Ends",
       t.progress, t.id as task_id, array_to_string(t.depends_on, ',') as depends_on, t.deptno
  from hr.project_task t
 order by t.starts, t.id$q$,
   '{"kind": "gantt", "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (20, 'Leave on the calendar', 'chart', 12, 'standard',
   $q$select e.ename || ' (' || lower(l.status) || ')' as "Employee",
       l.start_date + time '08:00' as "From", l.end_date + time '18:00' as "To",
       case l.status when 'APPROVED' then 100 when 'PENDING' then 0 end as progress,
       l.id
  from hr.leave_request l join hr.emp e using (empno)
 where l.status in ('APPROVED', 'PENDING')
 order by l.start_date$q$,
   '{"kind": "gantt", "empty": "No leave planned.", "link": {"page": 7, "items": {"P7_ID": "#id#"}}}'),
  (30, 'Organisation levels', 'chart', 4, 'standard',
   $q$with recursive org as (
  select empno, 1 as level from hr.emp where mgr is null and active
  union all
  select e.empno, o.level + 1 from hr.emp e join org o on e.mgr = o.empno where e.active
)
select case o.level when 1 then 'Management' when 2 then 'Managers' else 'Level ' || o.level end as "Level",
       count(*) as "Employees"
  from org o group by o.level order by o.level$q$,
   '{"kind": "pyramid"}'),
  (40, 'Salary bands: Research and Sales', 'chart', 4, 'standard',
   $q$select b.band as "Salary",
       count(e.empno) filter (where e.deptno = 20) as "Research",
       count(e.empno) filter (where e.deptno = 30) as "Sales"
  from (values (1, '3000+', 3000, null), (2, '2000–2999', 2000, 3000),
               (3, '1000–1999', 1000, 2000), (4, '< 1000', 0, 1000)) b(k, band, lo, hi)
  left join hr.emp e on e.active and e.sal >= b.lo and (b.hi is null or e.sal < b.hi)
 group by b.k, b.band
 order by b.k$q$,
   '{"kind": "pyramid"}'),
  (50, 'Hires per month', 'chart', 4, 'standard',
   $q$select to_char(make_date(2000, m, 1), 'Mon') as month,
       count(e.empno) as "Hires"
  from generate_series(1, 12) m
  left join hr.emp e on extract(month from e.hiredate) = m
 group by m
 order by m$q$,
   '{"kind": "polar"}')
) r(seq, title, type, cols, tpl, source, config)
 where a.alias = 'hr' and p.page_no = 32;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 4, 'Project plan', 'chart', 32 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Project plan', 'Projectplanning'),
  ('Office move', 'Verhuizing van het kantoor'),
  ('Leave on the calendar', 'Verlof in de kalender'),
  ('No leave planned.', 'Geen verlof gepland.'),
  ('Organisation levels', 'Niveaus in de organisatie'),
  ('Salary bands: Research and Sales', 'Salarisschalen: Research en Sales'),
  ('Hires per month', 'Indiensttredingen per maand')
) t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
