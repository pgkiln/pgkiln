-- =====================================================================
-- HR example, part 75: the item and region types of sprint 140 (AP-4;
-- migration 140; docs/guide/05-items.md, 04-pages-and-regions.md)
--
-- Page 50 "Project team" (Administration → Project team) puts a team
-- together the way an APEX page would:
--
--   - P50_DEPTNO, a Select One (a searchable single pick) of the
--     departments;
--   - P50_MEMBERS, a Shuttle of that department's employees (a cascading
--     list of values: choosing another department reloads it). The chosen
--     employees keep their order (Move up / Move down), stored
--     colon-separated like a multiselect: 7839:7566:7902;
--   - P50_SKILLS, a Select Many (chips) of a static list of values.
--   Without JavaScript the three are a plain select list and two
--   multi-selection lists, and Save works the same;
--   - "Chosen team", a Classic Report (no Actions menu) of the chosen
--     employees in the shuttle's order, and "Head count", a classic report
--     with the badges template;
--   - a Breadcrumb region in the Breadcrumb bar position (the title bar
--     then leaves its own trail out), and a Help Text region showing the
--     page's help text (Page → Help text, Markdown).
-- Save keeps the values in the session only: the page has no table.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page, help)
select id, 50, 'Project team', 'Project team', 1,
$h$Put a **project team** together:

1. Choose a *department* (type to search the list).
2. Move its employees from **Available** to **Selected** (double-click, Enter, or the › and » buttons) and put them in order with the arrow buttons.
3. Choose the skills the team needs, then **Save**.

Team lead for now: &APP_USER..$h$
  from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, position, source, config)
select p.id, r.seq, r.title, r.type, r.cols, r.template, r.position, r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (5, 'Breadcrumb', 'breadcrumb', 12, 'plain', 'breadcrumb', null, '{}'),
  (10, 'Team', 'static', 8, 'standard', null, null, '{}'),
  (20, 'How it works', 'help_text', 4, 'standard', null, null, '{}'),
  (30, 'Chosen team', 'classic_report', 8, 'standard', null,
   'select e.empno, e.ename, e.job, d.dname
  from unnest(string_to_array(:P50_MEMBERS, '':'')) with ordinality m(empno, n)
  join hr.emp e on e.empno::text = m.empno
  left join hr.dept d on d.deptno = e.deptno
 order by m.n',
   '{"headings": {"empno": "No.", "ename": "Name", "job": "Job", "dname": "Department"}, "sortable": false, "pagination": "none", "empty": "Nobody chosen yet: move employees to Selected and save."}'),
  (40, 'Head count', 'classic_report', 4, 'standard', null,
   'select d.dname as label, count(e.empno) as value
  from hr.dept d left join hr.emp e on e.deptno = d.deptno
 group by d.dname order by d.dname',
   '{"report_template": "badges", "pagination": "none"}')
  ) as r (seq, title, type, cols, template, position, source, config)
 where a.alias = 'hr' and p.page_no = 50;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.config::jsonb, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Team', (values
  (10, 'P50_DEPTNO', 'Department', 'select_one', 'LOV:DEPARTMENTS', '{"wide": true}', null),
  (20, 'P50_MEMBERS', 'Team members', 'shuttle',
   'select ename || '' ('' || coalesce(job, ''-'') || '')'' as d, empno as r from hr.emp where deptno = :P50_DEPTNO order by ename',
   '{"cascade_parents": "P50_DEPTNO", "wide": true}', 'In the order they lead the project.'),
  (30, 'P50_SKILLS', 'Skills needed', 'select_many',
   'STATIC:SQL;SQL,PL/pgSQL;PLPGSQL,TypeScript;TS,Design;DESIGN,Testing;TEST,Accessibility;A11Y',
   '{"wide": true}', null)
  ) as i (seq, name, label, type, lov, config, help)
 where a.alias = 'hr' and p.page_no = 50;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'SAVE', 'Save', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Team'
 where a.alias = 'hr' and p.page_no = 50;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 70, 'Project team', 'users', 50
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';
