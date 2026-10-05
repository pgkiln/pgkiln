-- =====================================================================
-- HR example, part 32: lists and supporting objects
-- (docs/guide/04-pages-and-regions.md "Lists", docs/guide/03-builder.md
-- "Supporting objects")
--
-- Page 31 "Shortcuts": the same lists shown with each list template.
--   HR_SHORTCUTS   a static list: entries with icons, a badge from an item,
--                  child entries, a manager-only entry (authorization), an
--                  entry with a condition and one of an excluded build option
--   HR_DEPARTMENTS a list from a query: one entry per department with its
--                  head count as the badge, linking to the employee list
--   HR_NAVBAR      shown as the navigation bar in the header
-- Supporting objects: an install script that checks the sample data, run
-- only when a developer chooses to (Supporting objects in the builder).
-- =====================================================================

insert into meta.list (app_id, name, type, query, description)
select a.id, l.name, l.type, l.query, l.description
  from meta.app a, (values
  ('HR_SHORTCUTS', 'static', null, 'Shortcuts to the main pages'),
  ('HR_DEPARTMENTS', 'sql',
   'select d.dname as label, 2 as page, null::jsonb as items, ''building'' as icon,
       (select count(*) from hr.emp e where e.deptno = d.deptno)::text as badge,
       initcap(d.loc) as description
  from hr.dept d
 order by d.dname', 'Departments with their head count'),
  ('HR_NAVBAR', 'static', null, 'Links in the header')
  ) as l (name, type, query, description)
 where a.alias = 'hr';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, badge, description, condition, authz, build_option)
select a.id, e.list_name, e.seq, e.label, e.icon, e.target_page, e.badge, e.description, e.condition, e.authz, e.build_option
  from meta.app a, (values
  ('HR_SHORTCUTS', 10, 'Employees', 'users', 2, '&P31_HEADCOUNT.', 'Everyone in the company', null, null, null),
  ('HR_SHORTCUTS', 20, 'Leave', 'calendar', null, null, null, null, null, null),
  ('HR_SHORTCUTS', 30, 'Audit trail', 'history', 9, null, 'Changes to employees (managers only)', null, 'MANAGER', null),
  ('HR_SHORTCUTS', 40, 'Leave forecast', 'chart', 22, null, 'Only while the LEAVE_FORECAST build option is included', null, null, 'LEAVE_FORECAST'),
  ('HR_SHORTCUTS', 50, 'Pending requests', 'inbox', 6, null, 'Shown while there are pending leave requests',
   'exists (select 1 from hr.leave_request where status = ''PENDING'')', null, null),
  ('HR_NAVBAR', 10, 'Shortcuts', 'list', 31, null, null, null, null, null)
  ) as e (list_name, seq, label, icon, target_page, badge, description, condition, authz, build_option)
 where a.alias = 'hr';

-- children of "Leave"
insert into meta.list_entry (app_id, list_name, parent_id, seq, label, icon, target_page, description)
select a.id, 'HR_SHORTCUTS', p.id, c.seq, c.label, c.icon, c.target_page, c.description
  from meta.app a
  join meta.list_entry p on p.app_id = a.id and p.list_name = 'HR_SHORTCUTS' and p.label = 'Leave', (values
  (10, 'Leave requests', 'file', 6, 'Request and approve leave'),
  (20, 'Leave calendar', 'calendar', 12, 'Who is away when')
  ) as c (seq, label, icon, target_page, description)
 where a.alias = 'hr';

update meta.app set navbar_list = 'HR_NAVBAR' where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 31, 'Shortcuts', 'Shortcuts', 1 from meta.app where alias = 'hr';

insert into meta.item (page_id, seq, name, label, type)
select p.id, 10, 'P31_HEADCOUNT', 'Head count', 'hidden'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 31;

insert into meta.computation (page_id, seq, item_name, point, type, expression)
select p.id, 10, 'P31_HEADCOUNT', 'before_header', 'sql_query', 'select count(*)::text from hr.emp'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 31;

insert into meta.region (page_id, seq, title, type, columns, config)
select p.id, r.seq, r.title, 'list', r.columns, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Shortcuts (tabs)', 12, '{"list": "HR_SHORTCUTS", "template": "tabs"}'),
  (20, 'Shortcuts (links)', 4, '{"list": "HR_SHORTCUTS"}'),
  (30, 'Shortcuts (cards)', 8, '{"list": "HR_SHORTCUTS", "template": "cards"}'),
  (40, 'Departments (badge list)', 12, '{"list": "HR_DEPARTMENTS", "template": "badges"}')
  ) as r (seq, title, columns, config)
 where a.alias = 'hr' and p.page_no = 31;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 28, 'Shortcuts', 'list', 31 from meta.app where alias = 'hr';

-- supporting objects: never run on install or import; a developer runs them in the builder
insert into meta.supporting_script (app_id, name, kind, seq, script)
select a.id, s.name, s.kind, s.seq, s.script
  from meta.app a, (values
  ('Check the sample data', 'install', 10,
   'do $$
begin
  if not exists (select 1 from hr.dept) then
    raise exception ''The HR tables are empty: run examples/hr/hr.sql first'';
  end if;
end
$$;
select count(*) as departments from hr.dept;'),
  ('Count employees', 'upgrade', 10, 'select count(*) as employees from hr.emp;')
  ) as s (name, kind, seq, script)
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Shortcuts', 'Snelkoppelingen'),
  ('Shortcuts (tabs)', 'Snelkoppelingen (tabbladen)'),
  ('Shortcuts (links)', 'Snelkoppelingen (links)'),
  ('Shortcuts (cards)', 'Snelkoppelingen (kaarten)'),
  ('Departments (badge list)', 'Afdelingen (badgelijst)'),
  ('Leave', 'Verlof'),
  ('Pending requests', 'Openstaande aanvragen'),
  ('Leave forecast', 'Verlofprognose'),
  ('Everyone in the company', 'Iedereen in het bedrijf')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
