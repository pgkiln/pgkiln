-- =====================================================================
-- HR example, part 90: sub regions (migration 172, sprint 195;
-- docs/guide/04-pages-and-regions.md "Sub regions")
--
-- Page 53 "Department overview" (Administration):
--   - a tabs container "Department" with four sub regions: the
--     department's employees (an interactive report with a Refresh
--     button that refreshes only that sub region), a form that edits the
--     department (Save in the bottom bar's Next position), a chart of
--     salaries by job and a sub region for administrators only;
--   - a flexbox container "Key figures" with three sub regions side by
--     side (one under the other on a phone);
--   - a collapsible region "About this page" with two sub regions on its
--     12-column grid.
-- The department to show is a select list above them. Until one is
-- chosen, the two containers are not shown: their condition (item not
-- null) applies to every sub region in them.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 53, 'Department overview', 'Department overview', 1 from meta.app where alias = 'hr';

-- the containers and the region that chooses the department
insert into meta.region (page_id, seq, title, type, columns, template, source, static_id, condition_type, condition)
select p.id, r.seq, r.title, 'static', 12, r.template, r.source, r.static_id, r.cond, case when r.cond is not null then 'P53_DEPTNO' end
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (5, 'Choose a department', 'plain', null, 'choose', null),
  (100, 'Department', 'tabs_container', null, 'department', 'item_not_null'),
  (200, 'Key figures', 'flex_container', null, 'key-figures', 'item_not_null'),
  (300, 'About this page', 'collapsible', '<p>The regions above are <strong>sub regions</strong>: each sits inside a container region.</p>', 'about', null)
  ) as r (seq, title, template, source, static_id, cond)
 where a.alias = 'hr' and p.page_no = 53;

-- the sub regions, each with its parent (by static id); sequences unique on the page, so the exported files list
-- the regions in the order the database does
insert into meta.region (page_id, parent_id, seq, title, type, columns, template, source, table_name, pk_column, pk_item, config, authz, static_id)
select p.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = r.parent), r.seq, r.title, r.type, r.columns, r.template,
       r.source, r.table_name, r.pk_column, r.pk_item, r.config::jsonb, r.authz, r.static_id
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('department', 110, 'Employees', 'report', 12, 'plain',
   'select empno, initcap(ename) as name, initcap(job) as job, sal from hr.emp where deptno = :P53_DEPTNO::int order by ename', null, null, null, '{}', null, 'dept-employees'),
  ('department', 120, 'Edit department', 'form', 12, 'plain', null, 'hr.dept', 'deptno', 'P53_DEPTNO', '{}', null, 'dept-form'),
  ('department', 130, 'Salaries by job', 'chart', 12, 'plain',
   'select initcap(job) as job, sum(sal) as salaries from hr.emp where deptno = :P53_DEPTNO::int group by job order by 2 desc', null, null, null, '{"kind": "bar"}', null, 'dept-salaries'),
  ('department', 140, 'Administration', 'static', 12, 'plain',
   '<p>Only administrators see this tab: a sub region has its own authorization, and the container''s applies to it too.</p>', null, null, null, '{}', 'ADMIN', 'dept-admin'),
  ('key-figures', 210, 'Headcount', 'dynamic', 12, 'standard',
   'select ''<p class="metric-value">'' || count(*) || ''</p>'' from hr.emp where deptno = :P53_DEPTNO::int', null, null, null, '{}', null, 'kf-headcount'),
  ('key-figures', 220, 'Monthly salaries', 'dynamic', 12, 'standard',
   'select ''<p class="metric-value">'' || coalesce(sum(sal), 0) || ''</p>'' from hr.emp where deptno = :P53_DEPTNO::int', null, null, null, '{}', null, 'kf-salaries'),
  ('key-figures', 230, 'Location', 'static', 12, 'standard', '<p class="metric-value">&P53_LOC.</p>', null, null, null, '{}', null, 'kf-location'),
  ('about', 310, 'How it is built', 'static', 6, 'standard',
   '<p>In the Page Designer, drop regions into a region''s <em>Sub regions</em> slot, or set their <em>Parent region</em>. The parent''s template decides how they show: tabs, side by side, or on its grid.</p>', null, null, null, '{}', null, 'about-built'),
  ('about', 320, 'Keyboard', 'static', 6, 'standard',
   '<p>The tabs follow the ARIA tabs pattern: Tab reaches the current tab, the arrow keys, Home and End move between them.</p>', null, null, null, '{}', null, 'about-keyboard')
  ) as r (parent, seq, title, type, columns, template, source, table_name, pk_column, pk_item, config, authz, static_id)
 where a.alias = 'hr' and p.page_no = 53;

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, lov, required, config)
select p.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = i.region), i.seq, i.name, i.label, i.type, i.source_column, i.lov, i.required, i.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('choose', 10, 'P53_DEPTNO', 'Department', 'select', null, 'select meta.lang(dname), deptno from hr.dept order by 1', false, '{"submit_on_change": true, "null_label": "- Choose a department -"}'),
  ('dept-form', 10, 'P53_DNAME', 'Name', 'text', 'dname', null, true, '{}'),
  ('dept-form', 20, 'P53_LOC', 'Location', 'text', 'loc', null, false, '{}')
  ) as i (region, seq, name, label, type, source_column, lov, required, config)
 where a.alias = 'hr' and p.page_no = 53;

-- Refresh in the report's header (button position Create), Save at the end of the form's bottom bar (Next)
insert into meta.button (page_id, region_id, seq, name, label, action, hot, slot)
select p.id, (select x.id from meta.region x where x.page_id = p.id and x.static_id = b.region), b.seq, b.name, b.label, b.action, b.hot, b.slot
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('dept-employees', 10, 'REFRESH_EMPLOYEES', 'Refresh', 'da', false, 'create'),
  ('dept-form', 10, 'SAVE', 'Save', 'submit', true, 'next')
  ) as b (region, seq, name, label, action, hot, slot)
 where a.alias = 'hr' and p.page_no = 53;

insert into meta.process (page_id, seq, name, type, region_id, when_button, success_message)
select p.id, 10, 'Save the department', 'form_dml', (select x.id from meta.region x where x.page_id = p.id and x.static_id = 'dept-form'), 'SAVE', 'Department saved.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 53;

-- a partial refresh of one sub region: the report, inside its tab
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select p.id, 10, 'Refresh the employees', 'click', 'REFRESH_EMPLOYEES', 'refresh_region', (select x.id from meta.region x where x.page_id = p.id and x.static_id = 'dept-employees')
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 53;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 55, 'Department overview', 'layers', 53
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';
