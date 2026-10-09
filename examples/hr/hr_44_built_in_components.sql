-- =====================================================================
-- HR example, part 44: built-in template components (docs/guide/
-- 04-pages-and-regions.md, "Built-in template components")
--
-- Page 39 "Team overview": every region is a Template component region on
-- one of pgkiln's built-in components, shown as "multiple" (the group):
--   - Key figures: metric cards (ut_metric_card) with a trend;
--   - Team: an avatar group (ut_avatar) of the active employees;
--   - Recent hires: a timeline (ut_timeline);
--   - Departments: a media list (ut_media_list) with a head-count badge,
--     each linking to the department form (page 5, a dialog);
--   - Latest leave requests: comments (ut_comments).
-- The queries run as hr_app, so row level security applies (leave requests:
-- your own, or your team's as a manager).
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 39, 'Team overview', 'Team overview', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, 'template_component', r.columns, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id,
  (values
  (10, 'Key figures', 12,
   $q$select 'Employees' as label, count(*)::text as value, null as unit,
       count(*) filter (where hiredate > current_date - 365) || ' hired in the last year' as change,
       case when count(*) filter (where hiredate > current_date - 365) > 0 then 'up' else 'flat' end as trend
  from hr.emp where active
union all
select 'Monthly payroll', to_char(sum(sal), 'FM999G999G990'), 'USD', null, null from hr.emp where active
union all
select 'Departments', count(*)::text, null, null, null from hr.dept
union all
select 'Pending leave', count(*)::text, 'requests', null, null from hr.leave_request where status = 'PENDING'$q$,
   $j${"component": "ut_metric_card", "display": "multiple"}$j$),
  (20, 'Team', 12,
   $q$select initcap(ename) as name, upper(left(ename, 2)) as initials from hr.emp where active order by hiredate, empno$q$,
   $j${"component": "ut_avatar", "display": "multiple", "attributes": {"SIZE": "medium"}}$j$),
  (30, 'Recent hires', 6,
   $q$select initcap(e.ename) || ' joined as ' || lower(e.job) as title, to_char(e.hiredate, 'YYYY-MM-DD') as "when",
       initcap(d.dname) as who, 'success' as state
  from hr.emp e left join hr.dept d on d.deptno = e.deptno
 order by e.hiredate desc, e.empno desc limit 6$q$,
   $j${"component": "ut_timeline", "display": "multiple"}$j$),
  (40, 'Departments', 6,
   $q$select d.deptno, initcap(d.dname) as title, initcap(d.loc) as description, left(d.dname, 2) as initials,
       count(e.empno) || ' staff' as badge, case when count(e.empno) = 0 then 'warning' else 'info' end as state
  from hr.dept d left join hr.emp e on e.deptno = d.deptno and e.active
 group by d.deptno order by d.dname$q$,
   $j${"component": "ut_media_list", "display": "multiple", "link": {"page": 5, "items": {"P5_DEPTNO": "#deptno#"}}}$j$),
  (50, 'Latest leave requests', 12,
   $q$select initcap(e.ename) as "user", upper(left(e.ename, 2)) as initials, to_char(l.created_at, 'YYYY-MM-DD HH24:MI') as date,
       coalesce(l.reason, '(no reason given)') as comment, lower(l.status) || ', ' || l.days || ' days' as actions
  from hr.leave_request l join hr.emp e on e.empno = l.empno
 order by l.created_at desc limit 5$q$,
   $j${"component": "ut_comments", "display": "multiple", "empty": "No leave requests you can see."}$j$)
  ) as r (seq, title, columns, source, config)
 where a.alias = 'hr' and p.page_no = 39;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 31, 'Team overview', 'users', 39 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Team overview', 'Teamoverzicht'),
  ('Key figures', 'Kerncijfers'),
  ('Team', 'Team'),
  ('Recent hires', 'Recent in dienst'),
  ('Departments', 'Afdelingen'),
  ('Latest leave requests', 'Laatste verlofaanvragen'),
  ('No leave requests you can see.', 'Geen verlofaanvragen die je kunt zien.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
