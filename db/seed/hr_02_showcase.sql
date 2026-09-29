-- =====================================================================
-- HR sample, part 2: charts, interactive grid, faceted search, calendar,
-- dynamic content, shared lists of values and more item types.
-- =====================================================================

-- A few leave requests around today so the calendar has something to show
-- (inserted as the owner, so RLS and the request_leave rules don't apply).
insert into hr.leave_request (empno, start_date, end_date, days, reason, status, decided_by, decided_at)
select e.empno, current_date + x.s, current_date + x.e, hr.business_days(current_date + x.s, current_date + x.e),
       x.reason, x.status, case when x.status <> 'PENDING' then 'king' end, case when x.status <> 'PENDING' then now() end
  from (values ('SCOTT', -3, 1, 'Conference', 'APPROVED'),
               ('FORD', 2, 6, 'Holiday', 'APPROVED'),
               ('JONES', 9, 10, 'Family', 'PENDING'),
               ('WARD', 12, 16, 'Holiday', 'APPROVED'),
               ('CLARK', -10, -8, 'Training', 'APPROVED')) x(ename, s, e, reason, status)
  join hr.emp e on e.ename = x.ename;

-- Shared lists of values -------------------------------------------------
insert into meta.lov (app_id, name, query)
select a.id, x.name, x.query from meta.app a, (values
  ('DEPARTMENTS', 'select dname, deptno from hr.dept order by 1'),
  ('JOBS', 'STATIC:President;PRESIDENT,Manager;MANAGER,Analyst;ANALYST,Salesman;SALESMAN,Clerk;CLERK')
) x(name, query) where a.alias = 'hr';

update meta.item i set lov = 'LOV:DEPARTMENTS'
  from meta.page p, meta.app a
 where i.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and i.name in ('P2_DEPTNO', 'P3_DEPTNO');
update meta.item i set lov = 'LOV:JOBS'
  from meta.page p, meta.app a
 where i.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and i.name = 'P3_JOB';
-- the manager list gets a search box
update meta.item i set type = 'popup_lov'
  from meta.page p, meta.app a
 where i.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and i.name = 'P3_MGR';

-- Dashboard: chart kinds + dynamic content --------------------------------
update meta.region r set config = r.config || '{"kind": "column"}', title = 'Headcount by department'
  from meta.page p, meta.app a
 where r.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and p.page_no = 1 and r.title = 'Headcount by department';
update meta.region r set config = r.config || '{"kind": "donut"}', columns = 6,
       source = E'select initcap(job) as job, sum(sal) as "Salary budget" from hr.emp group by job order by 2 desc'
  from meta.page p, meta.app a
 where r.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and p.page_no = 1 and r.title = 'Salary budget by job';

insert into meta.region (page_id, seq, title, type, columns, source, config)
select p.id, x.seq, x.title, x.type, x.cols, x.source, x.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (42, 'Hires per year', 'chart', 6,
   E'select extract(year from hiredate)::int::text as year, count(*) as "Hires"\n  from hr.emp group by 1 order by 1',
   '{"kind": "area"}'),
  (44, 'Salary and commission by department', 'chart', 6,
   E'select d.dname as department, coalesce(sum(e.sal), 0) as "Salary", coalesce(sum(e.comm), 0) as "Commission"\n  from hr.dept d left join hr.emp e using (deptno)\n group by d.dname order by 1',
   '{"kind": "column"}'),
  (46, 'Who''s out this week', 'dynamic', 12,
   E'select coalesce(\n  ''<ul class="out-list">'' || string_agg(format(''<li><b>%s</b> %s – %s <span class="muted">(%s)</span></li>'',\n      meta.html_escape(initcap(e.ename)), to_char(l.start_date, ''Dy DD Mon''), to_char(l.end_date, ''Dy DD Mon''), meta.html_escape(lower(l.status))),\n    '''' order by l.start_date) || ''</ul>'',\n  ''<p class="muted">Nobody is out this week.</p>'')\n  from hr.leave_request l join hr.emp e using (empno)\n where l.status in (''APPROVED'', ''PENDING'')\n   and daterange(l.start_date, l.end_date, ''[]'') && daterange(date_trunc(''week'', current_date)::date, date_trunc(''week'', current_date)::date + 6, ''[]'')',
   '{}')
) x(seq, title, type, cols, source, config)
 where a.alias = 'hr' and p.page_no = 1;

-- Page 10: department grid (ADMIN) -----------------------------------------
select meta.generate_grid('hr', 'hr.dept', 10, 'Department grid', 'grid');
update meta.page p set authz = 'ADMIN', parent_page = 4
  from meta.app a where a.id = p.app_id and a.alias = 'hr' and p.page_no = 10;
update meta.nav_entry n
   set parent_id = (select x.id from meta.nav_entry x where x.app_id = n.app_id and x.label = 'Administration'),
       seq = 20, authz = 'ADMIN'
  from meta.app a where a.id = n.app_id and a.alias = 'hr' and n.target_page = 10;
update meta.region r set config = r.config || '{"headings": {"deptno": "No.", "dname": "Name", "loc": "Location"}}'
  from meta.page p, meta.app a
 where r.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and p.page_no = 10;

-- Page 11: employee directory with faceted search --------------------------
insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 11, 'Directory', 'Employee directory', 2 from meta.app where alias = 'hr';

with p as (select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 11),
rep as (
  insert into meta.region (page_id, seq, title, type, columns, source, config)
  select p.id, 20, 'Employees', 'report', 9,
         E'select initcap(e.ename) as name, initcap(e.job) as job, d.dname as department,\n       m.ename as manager, e.hiredate, case when e.active then ''Active'' else ''Inactive'' end as status\n  from hr.emp e\n  left join hr.dept d on d.deptno = e.deptno\n  left join hr.emp m on m.empno = e.mgr',
         '{"page_size": 10}'
    from p returning id, page_id
)
insert into meta.region (page_id, seq, title, type, columns, template, config)
select rep.page_id, 10, 'Filter', 'facets', 3, 'collapsible',
       jsonb_build_object('report', rep.id, 'facets', jsonb_build_array(
         jsonb_build_object('column', 'job', 'label', 'Job'),
         jsonb_build_object('column', 'department', 'label', 'Department'),
         jsonb_build_object('column', 'status', 'label', 'Status')))
  from rep;

-- Page 12: leave calendar ----------------------------------------------------
insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 12, 'Leave calendar', 'Leave calendar', 6 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, source, config)
select p.id, 10, 'Leave (as far as you may see it)', 'calendar',
       E'select l.start_date, l.end_date,\n       initcap(e.ename) || case when l.status = ''PENDING'' then '' (pending)'' else '''' end as title,\n       l.id\n  from hr.leave_request l join hr.emp e using (empno)\n where l.status in (''APPROVED'', ''PENDING'')',
       '{"link": {"page": 7, "items": {"P7_ID": "#id#"}}}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 12;

-- Menu entries for the new pages
with a as (select id from meta.app where alias = 'hr')
insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, (select n.id from meta.nav_entry n where n.app_id = a.id and n.label = x.parent and n.parent_id is null), x.seq, x.label, x.icon, x.page
  from a, (values ('Employees', 15, 'Directory', 'filter', 11)) x(parent, seq, label, icon, page);

-- "Leave requests" becomes a parent with the list and the calendar
with a as (select id from meta.app where alias = 'hr'),
leave as (select n.id, n.app_id from meta.nav_entry n, a where n.app_id = a.id and n.label = 'Leave requests' and n.parent_id is null)
insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select leave.app_id, leave.id, x.seq, x.label, x.icon, x.page
  from leave, (values (10, 'Requests', 'list', 6), (20, 'Calendar', 'calendar', 12)) x(seq, label, icon, page);
update meta.nav_entry n set target_page = null
  from meta.app a where a.id = n.app_id and a.alias = 'hr' and n.label = 'Leave requests' and n.parent_id is null;
